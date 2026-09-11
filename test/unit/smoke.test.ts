import { test } from "node:test";
import assert from "node:assert/strict";
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
	const s = parseSessionText(
		[user("hi"), '{"type":"message","mess'].join("\n"),
	);
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

test("nested path safety", () => {
	assert.equal(isSafeNestedPathId("../../etc"), false);
	assert.equal(isSafeNestedPathId("/abs"), false);
	assert.equal(
		sanitizeNestedPath(
			Array.from({ length: 9 }, (_, i) => ({ runId: `r${i}` })),
		).length,
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
	const r = parseHerdrResponse(
		'{"result":{"pane":{"pane_id":"w1:p1"}}}',
		"",
		0,
	);
	assert.equal(r.ok, true);
});
