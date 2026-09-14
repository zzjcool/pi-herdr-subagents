import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseSessionText,
	deriveOutcome,
	extractVerdict,
} from "../../src/shared/session.ts";
import { makeName, isValidAgentName } from "../../src/shared/name.ts";
import {
	sanitizeNestedPath,
	isSafeNestedPathId,
} from "../../src/shared/nested-path.ts";
import { parseHerdrResponse } from "../../src/herdr/client.ts";
import { buildPiArgs } from "../../src/runs/args.ts";

const user = (t: string) =>
	JSON.stringify({ type: "message", message: { role: "user", content: t } });
const asst = (o: Record<string, unknown>) =>
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: o.text ?? "" }],
			...o,
		},
	});

test("success", () => {
	const s = parseSessionText(
		[user("hi"), asst({ stopReason: "stop", text: "ok" })].join("\n"),
	);
	assert.equal(deriveOutcome(s).status, "success");
});

test("error", () => {
	const s = parseSessionText(
		[user("hi"), asst({ stopReason: "error", errorMessage: "400 boom" })].join(
			"\n",
		),
	);
	const o = deriveOutcome(s);
	assert.equal(o.status, "failed");
	assert.equal(o.errorMessage, "400 boom");
});

test("aborted via missing reply", () => {
	const s = parseSessionText([user("hi")].join("\n"));
	const o = deriveOutcome(s);
	assert.equal(o.status, "aborted");
	assert.equal(s.lastTurnMissing, true);
});

test("toolUse as final => aborted", () => {
	const s = parseSessionText(
		[user("hi"), asst({ stopReason: "toolUse" })].join("\n"),
	);
	assert.equal(deriveOutcome(s).status, "aborted");
});

test("tool error then clean stop => success with toolErrors", () => {
	const s = parseSessionText(
		[
			user("hi"),
			asst({ stopReason: "toolUse", tools: ["bash"] }),
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", isError: true },
			}),
			asst({ stopReason: "stop", text: "recovered" }),
		].join("\n"),
	);
	const o = deriveOutcome(s);
	assert.equal(o.status, "success");
	assert.equal(o.toolErrors, 1);
});

test("torn line tolerated", () => {
	const s = parseSessionText([user("hi"), '{"type":"message","mess'].join("\n"));
	assert.equal(s.tornLines, 1);
	assert.doesNotThrow(() => deriveOutcome(s));
});

test("verdict", () => {
	assert.deepEqual(extractVerdict('{"ok":false,"reason":"x"}'), {
		ok: false,
		reason: "x",
	});
	assert.equal(extractVerdict("plain"), null);
	assert.deepEqual(extractVerdict('```json\n{"ok":true}\n```'), { ok: true });
});

test("names", () => {
	assert.equal(makeName("Review Agent", 1), "review-agent-1");
	assert.ok(isValidAgentName(makeName("9bad", 0)));
	assert.ok(makeName("x".repeat(50), 3).length <= 32);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 21: `Math.trunc(NaN)` is NaN and `Math.max(0, NaN)` is NaN, so a
// non-finite index produced `agent-NaN` — uppercase, and not a valid herdr name.
// `allocateName` only ever passes 0..999, so this was unreachable in practice,
// but `makeName` is exported and must never emit an invalid name.
// ─────────────────────────────────────────────────────────────────────────────
test("names: a non-finite index still yields a valid name", () => {
	for (const index of [NaN, Infinity, -Infinity]) {
		for (const agent of ["worker", "", "!!!", "9", "Review Agent"]) {
			const name = makeName(agent, index);
			assert.ok(
				isValidAgentName(name),
				`makeName(${JSON.stringify(agent)}, ${index}) produced invalid ${JSON.stringify(name)}`,
			);
		}
	}
});

test("names: every generated name is valid, across hostile inputs", () => {
	const agents = [
		"",
		"   ",
		"!!!",
		"9",
		"-",
		"_",
		"a".repeat(200),
		"Review Agent",
		"Ünïcödé",
		"a/b",
		"a\\b",
		"\u0000",
		"..",
		"CON",
		"🎉",
	];
	const indexes = [0, 1, 999, -1, 1e9, NaN, Infinity, -Infinity, 1.5, -0.5];
	for (const agent of agents) {
		for (const index of indexes) {
			const name = makeName(agent, index);
			assert.ok(
				isValidAgentName(name),
				`invalid name ${JSON.stringify(name)} from agent=${JSON.stringify(agent)} index=${index}`,
			);
			assert.ok(name.length <= 32, `name too long: ${name}`);
		}
	}
});

test("names: distinct indexes yield distinct names", () => {
	const names = new Set(
		Array.from({ length: 50 }, (_, i) => makeName("worker", i)),
	);
	assert.equal(names.size, 50, "indexes must not collide");
});

test("nested path safety", () => {
	assert.equal(isSafeNestedPathId("../../etc"), false);
	assert.equal(isSafeNestedPathId("/abs"), false);
	assert.equal(
		sanitizeNestedPath(Array.from({ length: 9 }, (_, i) => ({ runId: `r${i}` })))
			.length,
		4,
	);
});

test("herdr error on stderr", () => {
	const r = parseHerdrResponse(
		"",
		'{"error":{"code":"agent_pane_busy","message":"not an available shell"}}',
		1,
	);
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.error.code, "PANE_BUSY");
});

test("herdr success on stdout", () => {
	const r = parseHerdrResponse('{"result":{"pane":{"pane_id":"w1:p1"}}}', "", 0);
	assert.equal(r.ok, true);
});

// F38: a multi-line task must never travel as an argv element — herdr rejects
// any argument containing a control character. `buildPiArgs` writes the task to
// a file and passes `@path` instead, so the text still reaches the child.
test("buildPiArgs: a multi-line task goes through a file, not argv", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-f38-"));
	try {
		const task = "line one\nline two\ttabbed";
		const built = buildPiArgs({
			agent: {
				name: "a",
				description: "d",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				kind: "pi",
				source: "user",
				filePath: "/f.md",
			},
			task,
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});

		for (const arg of built.args) {
			assert.doesNotMatch(
				arg,
				/[\n\r\t]/,
				`control character leaked into argv: ${JSON.stringify(arg)}`,
			);
		}

		const taskArg = built.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg, "the task must be passed as an @file reference");
		assert.match(
			readFileSync(taskArg.slice(1), "utf8"),
			/line one\nline two\ttabbed/,
			"the file must carry the task text verbatim",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs: a short single-line task also uses the file (no context switch)", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-f38b-"));
	try {
		const built = buildPiArgs({
			agent: {
				name: "a",
				description: "d",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				kind: "pi",
				source: "user",
				filePath: "/f.md",
			},
			task: "short",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		assert.ok(
			built.args.some((a) => a.startsWith("@")),
			"even a short task must use the file transport",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
