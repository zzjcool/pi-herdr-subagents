/**
 * W4 tests for src/shared/session.ts — written from IMPLEMENTATION.md's spec
 * (docs/design.md §3.4, findings F12/F26–F31), not from the implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	deriveOutcome,
	extractVerdict,
	paneHasLiveReply,
	paneLooksStuck,
	parseSessionFile,
	parseSessionText,
	stripPromptEcho,
} from "../../src/shared/session.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	tornLine,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";
import { withTempDir } from "../helpers/tmp.ts";

const parseLines = (...lines: string[]) => parseSessionText(lines.filter(Boolean).join("\n"));

// ── Required test cases (session) ─────────────────────────────────────────────

test("success turn → status success", () => {
	const parsed = parseLines(sessionHeader(), modelChange("cb/glm-5.3-flash"), userMsg("do it"), assistantMsg({ stopReason: "stop", text: "done" }));
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("stopReason error + message → failed, errorMessage preserved", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "400 bad model: nope" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.errorMessage, "400 bad model: nope");
	assert.equal(outcome.stopReason, "error");
});

test("stopReason error + message containing aborted → aborted (F29)", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "This operation was aborted" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "aborted");
});

test("stopReason length → truncated", () => {
	const parsed = parseLines(userMsg("write a lot"), assistantMsg({ stopReason: "length", text: "partial..." }));
	assert.equal(deriveOutcome(parsed).status, "truncated");
});

test("stopReason toolUse as last assistant → aborted (killed mid-tool)", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] }));
	assert.equal(deriveOutcome(parsed).status, "aborted");
});

test("user msg with no assistant reply → aborted, lastTurnMissing true (F29)", () => {
	const parsed = parseLines(userMsg("do it"));
	assert.equal(parsed.lastTurnMissing, true);
	assert.equal(deriveOutcome(parsed).status, "aborted");
});

test("no messages at all → unknown", () => {
	assert.equal(deriveOutcome(parseLines()).status, "unknown");
	assert.equal(deriveOutcome(parseSessionText("")).status, "unknown");
});

test("turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)", () => {
	const parsed = parseLines(
		userMsg("run bash"),
		assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
		toolResult({ isError: true }),
		assistantMsg({ stopReason: "stop", text: "recovered and finished" }),
		userMsg("continue"),
		assistantMsg({ stopReason: "stop", text: "all done" }),
	);
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "success");
	assert.equal(parsed.toolErrors, 1);
	assert.equal(outcome.toolErrors, 1);
	// F31: only the LAST turn decides; lastTurn reflects turn 2.
	assert.equal(outcome.lastTurn?.stopReason, "stop");
	assert.equal(outcome.lastTurn?.toolErrors, 0);
});

test("torn/truncated JSON line → counted in tornLines, does not throw (F12)", () => {
	const parsed = parseLines(userMsg("do it"), tornLine(), assistantMsg({ stopReason: "stop" }));
	assert.equal(parsed.tornLines, 1);
	assert.doesNotThrow(() => deriveOutcome(parsed));
	// The good assistant message after the torn line still counts.
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("usage accumulation across 3 assistant messages", () => {
	const parsed = parseLines(
		userMsg("multi"),
		assistantMsg({
			stopReason: "toolUse",
			tools: ["bash"],
			usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 7, cost: { total: 0.01 } },
		}),
		toolResult(),
		assistantMsg({
			stopReason: "toolUse",
			tools: ["read"],
			usage: { input: 200, output: 20, cacheRead: 6, cacheWrite: 8, cost: { total: 0.02 } },
		}),
		toolResult(),
		assistantMsg({
			stopReason: "stop",
			text: "final",
			usage: { input: 300, output: 30, cacheRead: 9, cacheWrite: 11, cost: { total: 0.03 } },
		}),
	);
	assert.deepEqual(parsed.usage, {
		input: 600,
		output: 60,
		cacheRead: 20,
		cacheWrite: 26,
		cost: 0.06,
	});
});

test("unknown stopReason value → failed with a reason", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "warp-drive" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "failed");
	assert.match(outcome.reason ?? "", /unknown stopReason/);
});

test('extractVerdict(\'{"ok":false,"reason":"x"}\') → {ok:false, reason:"x"} (F33)', () => {
	assert.deepEqual(extractVerdict('{"ok":false,"reason":"x"}'), { ok: false, reason: "x" });
});

test('extractVerdict("plain text") → null', () => {
	assert.equal(extractVerdict("plain text"), null);
});

test("extractVerdict on fenced ```json block parses the JSON inside", () => {
	assert.deepEqual(
		extractVerdict('Here is my verdict:\n```json\n{"ok":true,"reason":"all green"}\n```'),
		{ ok: true, reason: "all green" },
	);
	// Fence without the `json` tag also works.
	assert.deepEqual(extractVerdict('```\n{"ok":false}\n```'), { ok: false });
});

// ── Supplementary behaviour required by the spec text ─────────────────────────

test("model_change header populates parsed.model before any assistant message", () => {
	const parsed = parseLines(sessionHeader(), modelChange("cb/glm-5.3-flash"));
	assert.equal(parsed.model, "cb/glm-5.3-flash");
	assert.equal(parsed.turns.length, 0);
	assert.equal(deriveOutcome(parsed).status, "unknown");
});

test("assistant model overrides an earlier model_change", () => {
	const parsed = parseLines(
		modelChange("cb/old"),
		userMsg("go"),
		assistantMsg({ stopReason: "stop", text: "ok", model: "cb/new" }),
	);
	assert.equal(parsed.model, "cb/new");
});

test("parseSessionFile: missing file → empty ParsedSession (no throw)", () => {
	const parsed = parseSessionFile("/nonexistent/path/session.jsonl");
	assert.equal(parsed.output, "");
	assert.equal(parsed.model, null);
	assert.equal(parsed.stopReason, null);
	assert.equal(parsed.turns.length, 0);
	assert.equal(parsed.tornLines, 0);
	assert.equal(parsed.lastTurnMissing, false);
});

test("parseSessionFile: real file round-trips like text", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "worker-1.jsonl");
		fs.writeFileSync(
			file,
			[sessionHeader(), userMsg("go"), assistantMsg({ stopReason: "stop", text: "ok", model: "cb/glm-5.3-flash" })].join("\n"),
		);
		const parsed = parseSessionFile(file);
		assert.equal(parsed.output, "ok");
		assert.equal(parsed.model, "cb/glm-5.3-flash");
		assert.equal(parsed.stopReason, "stop");
		assert.equal(parsed.turns.length, 1);
	});
});

test("F32: agent self-reporting failure still has stopReason stop → mechanically success", () => {
	const parsed = parseLines(userMsg("task"), assistantMsg({ stopReason: "stop", text: 'FAILED: could not complete. {"ok": false, "reason": "missing input file"}' }));
	assert.equal(deriveOutcome(parsed).status, "success");
	// L2: the verdict extractor is what catches this.
	assert.deepEqual(extractVerdict(parsed.output), { ok: false, reason: "missing input file" });
});

test("extractVerdict ignores non-verdict JSON objects", () => {
	assert.equal(extractVerdict('{"result": 1, "ok": "yes"}'), null);
	assert.equal(extractVerdict('[1,2,3]'), null);
	assert.equal(extractVerdict(""), null);
});

const SEARCH_PROMPT = `你是 search。

\`\`\`json
{"ok": true, "reason": "search complete, N sourced facts"}
\`\`\`
`;

test("stripPromptEcho drops the launch prompt once but keeps a later verdict", () => {
	const reply = '杭州常住人口 1270 万\n{"ok": true, "reason": "search complete, 4 sourced facts"}';
	assert.deepEqual(
		extractVerdict(stripPromptEcho(`${SEARCH_PROMPT}\n${reply}`, SEARCH_PROMPT)),
		extractVerdict(reply),
	);
	assert.equal(
		extractVerdict(stripPromptEcho(SEARCH_PROMPT, SEARCH_PROMPT)),
		null,
	);
});

test("paneLooksStuck detects Cursor trust and paste-preview chrome", () => {
	assert.equal(paneLooksStuck("Workspace Trust Required\nDo you trust", SEARCH_PROMPT), true);
	assert.equal(paneLooksStuck("[Pasted text #1 +55 lines]\nWorking", SEARCH_PROMPT), true);
	assert.equal(
		paneLooksStuck(`${SEARCH_PROMPT}\n杭州 1270 万人，城镇化率 85%。\n{"ok": true, "reason": "done"}`, SEARCH_PROMPT),
		false,
	);
});

test("paneLooksStuck ignores leftover paste chrome once a live reply exists", () => {
	const pane = `[Pasted text #1 +58 lines]\n${SEARCH_PROMPT}\n杭州常住人口约 1270 万。\n{"ok": true, "reason": "4 sourced facts"}`;
	assert.equal(paneLooksStuck(pane, SEARCH_PROMPT), false);
	assert.equal(
		paneHasLiveReply(
			"cursor-agent --model cursor-grok-4.6-xhigh\n➜  mqtt-workspace\n[Pasted text #1 +58 lines]\nWorking",
		),
		false,
	);
});

/**
 * The launch banner is chrome, not a reply. Reading it as one recycled a live
 * cursor child ~3s after launch, before its pasted prompt was submitted.
 *
 * The `Tip:` line ROTATES between runs, so every observed wording is pinned
 * here: a blacklist that enumerates wording passes on the variant it was
 * written against and rots on the next release.
 */
const CURSOR_TIP_LINES = [
	"Tip: Try Cursor Grok 4.6 via /model, frontier intelligence at a fraction of the cost.",
	"Tip: Use /debug to instrument and debug complex problems.",
	"Tip: Type ? in the prompt bar to show in-app hints.",
];

const CURSOR_STATUS_BARS = [
	"Cursor Grok 4.6 Extra High",
	"Auto Balance",
	"Cursor Grok 4.6 Extra High · 80.4% · 8 files edited",
];

function cursorBanner(tip: string, status: string): string {
	return [
		"cursor-agent --model cursor-grok-4.6-xhigh --trust --force",
		"➜  herdr-subagents cursor-agent --model cursor-grok-4.6-xhigh --trust --force",
		"  Cursor Agent",
		"  v2026.09.18-9a7762b",
		`  ${tip}`,
		"",
		"  → [Pasted text #1 +84 lines]",
		"",
		`  ${status}                                                                  Run Everything`,
		"  ~/code/herdr-subagents · master",
	].join("\n");
}

test("paneHasLiveReply reads every rotating cursor banner variant as not-yet-replied", () => {
	for (const tip of CURSOR_TIP_LINES) {
		for (const status of CURSOR_STATUS_BARS) {
			const pane = cursorBanner(tip, status);
			assert.equal(
				paneHasLiveReply(pane),
				false,
				`banner must not count as a reply:\n${pane}`,
			);
			// The whole point of the fix: the nudge path must stay reachable.
			assert.equal(paneLooksStuck(pane, SEARCH_PROMPT), true);
		}
	}
});

test("paneHasLiveReply still sees a real reply under the banner", () => {
	const pane = cursorBanner(CURSOR_TIP_LINES[2]!, CURSOR_STATUS_BARS[0]!).replace(
		"  → [Pasted text #1 +84 lines]",
		`  ${SEARCH_PROMPT}\n  杭州常住人口约 1270 万。\n  {"ok": true, "reason": "4 sourced facts"}`,
	);
	assert.equal(paneHasLiveReply(pane), true);
});

test("turn boundaries are split by user messages; per-turn stats are independent", () => {
	const parsed = parseLines(
		userMsg("t1"),
		assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
		toolResult({ isError: true }),
		toolResult({ isError: true }),
		assistantMsg({ stopReason: "error", errorMessage: "boom" }),
		userMsg("t2"),
		assistantMsg({ stopReason: "stop", text: "fixed" }),
	);
	assert.equal(parsed.turns.length, 2);
	const t1 = parsed.turns[0];
	const t2 = parsed.turns[1];
	assert.ok(t1 && t2);
	assert.equal(t1.toolErrors, 2);
	assert.equal(t2.toolErrors, 0);
	assert.equal(t1.assistants.length, 2);
	assert.equal(t2.userText, "t2");
	// F31: overall outcome comes from t2.
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("hard kill mid-turn: user msg then only toolResult, no assistant → aborted", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] }));
	// In reality the file would be cut here — model the truncation:
	const truncated = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse" }));
	assert.equal(deriveOutcome(truncated).status, "aborted");
	assert.ok(parsed);
});

test("toolResult before any user message does not crash", () => {
	const parsed = parseLines(toolResult({ isError: true }), assistantMsg({ stopReason: "stop" }));
	assert.equal(parsed.toolErrors, 0); // dropped (no turn to attach to)
	assert.doesNotThrow(() => deriveOutcome(parsed));
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 18: `JSON.parse` succeeds on bare scalars, so a session line of `null`
// produced `null`, and reading `null.type` threw — taking down the entire parse
// (and therefore `collect`). The session file is external input: a pane can be
// closed mid-write, and a file can be truncated or hand-edited.
// ─────────────────────────────────────────────────────────────────────────────

test("scalar JSON lines are treated as damaged, never crash the parse", () => {
	const scalars = ["null", "42", "true", "false", '"a string"', "[]", "[1,2]"];
	for (const scalar of scalars) {
		// Each scalar is counted as a torn line; the parse must not throw.
		const parsed = parseSessionText(`${scalar}\n`);
		assert.equal(
			parsed.turns.length,
			0,
			`${scalar} must not produce a turn`,
		);
		assert.equal(
			parsed.tornLines,
			1,
			`${scalar} must be counted as a damaged line`,
		);
	}
});

test("a null line does not prevent the valid lines around it from parsing", () => {
	const text = [
		sessionHeader(),
		userMsg("go"),
		"null",
		assistantMsg({ stopReason: "stop", text: "done" }),
	].join("\n");
	const parsed = parseSessionText(text);
	assert.equal(parsed.tornLines, 1, "the null line is counted as damaged");
	assert.equal(parsed.turns.length, 1, "the surrounding turn still parses");
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("parseSessionText never throws on hostile input", () => {
	const cases = [
		"",
		"\n\n\n",
		"not json at all",
		'{"type":"message","mess',
		"null",
		"[1,2,3]",
		'"x"',
		"42",
		'{"type":"message","message":null}',
		'{"type":"message","message":{"role":"assistant","content":null}}',
		'{"type":"message","message":{"role":"assistant","content":[null]}}',
		'{"type":"message","message":{"role":"user","content":[{"type":"text"}]}}',
		'{"type":"message","message":{"role":"assistant","usage":{"cost":null}}}',
		'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"🎉"}]}}',
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${"x".repeat(100_000)}"}]}}`,
	];
	for (const input of cases) {
		assert.doesNotThrow(
			() => deriveOutcome(parseSessionText(input)),
			`must not throw on: ${input.slice(0, 60)}`,
		);
	}
});
