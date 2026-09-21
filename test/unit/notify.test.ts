import { test } from "node:test";
import assert from "node:assert/strict";
import {
	completionDeliveryOptions,
	completionStatusOf,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	formatNoticeHeadline,
	previewOutput,
	sanitizeNoticeField,
	SUBAGENT_NOTIFY_TYPE,
} from "../../src/extension/notify.ts";

test("completionStatusOf: success is completed, abort is stopped, else failed", () => {
	assert.equal(completionStatusOf("success"), "completed");
	assert.equal(completionStatusOf("aborted"), "stopped");
	assert.equal(completionStatusOf("failed"), "failed");
	assert.equal(completionStatusOf("truncated"), "failed");
	assert.equal(completionStatusOf("running"), "failed");
});

test("formatCompletionNotice: success is displayed and carries renderer details", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done the thing",
		sessionFile: "/tmp/worker-0.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	assert.equal(notice.status, "completed");
	// display: true — the transcript records the finish; the renderer keeps
	// it to one line instead of hiding it.
	assert.equal(notice.display, true);
	assert.equal(notice.details.status, "completed");
	assert.equal(notice.details.name, "worker-0");
	assert.equal(notice.details.agent, "worker");
	assert.equal(notice.details.execution.status, "success");
	assert.equal(notice.details.acceptance?.level, "attested");
	assert.equal(notice.details.sessionFile, "/tmp/worker-0.jsonl");
	assert.equal(notice.details.outputBytes, Buffer.byteLength("done the thing"));
	assert.match(notice.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.match(notice.content, /execution: success/);
	assert.match(notice.content, /done the thing/);
	assert.match(notice.content, /Session file: \/tmp\/worker-0\.jsonl/);
	assert.match(notice.content, /Pane recycled/);
});

test("formatCompletionNotice: failure is displayed", () => {
	const notice = formatCompletionNotice({
		name: "reviewer-1",
		execution: { status: "failed", reason: "model error" },
		output: "boom",
	});
	assert.equal(notice.status, "failed");
	assert.equal(notice.display, true);
	assert.match(notice.content, /Background task failed: \*\*reviewer-1\*\*/);
	assert.match(notice.content, /execution: failed \(model error\)/);
});

test("formatCompletionNotice: aborted maps to stopped and is displayed", () => {
	const notice = formatCompletionNotice({
		name: "w1",
		execution: { status: "aborted", reason: "killed" },
		output: "",
	});
	assert.equal(notice.status, "stopped");
	assert.equal(notice.display, true);
	assert.match(notice.content, /\(no output\)/);
});

test("formatNoticeHeadline: one line with glyph, verdict and size", () => {
	assert.equal(
		formatNoticeHeadline({
			status: "completed",
			name: "worker-0",
			agent: "worker",
			execution: { status: "success" },
			acceptance: { status: "accepted", level: "verified" },
			outputBytes: 4096,
		}),
		"✓ worker-0 (worker) · success · acceptance accepted (verified) · 4.0 KB",
	);
	assert.equal(
		formatNoticeHeadline({
			status: "failed",
			name: "reviewer-1",
			execution: { status: "failed", reason: "model error" },
			outputBytes: 0,
		}),
		"✗ reviewer-1 · failed (model error) · 0 B",
	);
	assert.equal(
		formatNoticeHeadline({
			status: "stopped",
			name: "w1",
			execution: { status: "aborted" },
			outputBytes: 3,
		}),
		"■ w1 · aborted · 3 B",
	);
});

test("formatNoticeHeadline: hostile fields cannot break the one-line contract", () => {
	// Child names go through src/shared/name.ts, but `agent` labels and
	// non-pi pane titles do not; the headline must strip what would split a
	// row or inject raw escapes into the TUI.
	const headline = formatNoticeHeadline({
		status: "completed",
		name: "w\x1b[41mEVIL\x1b[0m\r\nnext",
		agent: "a\x1b]2;pwn\x07gent",
		execution: { status: "su\nccess", reason: "r\teason\x1b[31m" },
		outputBytes: 1,
	});
	assert.doesNotMatch(headline, /[\x00-\x08\x0b-\x1f\x7f]/);
	assert.equal(headline.includes("\x1b"), false);
	assert.equal(headline.includes("\n"), false);
	assert.equal(headline.includes("\r"), false);
	// ESC removed; the printable remainder stays readable.
	assert.match(headline, /w\[41mEVIL\[0mnext/);
	assert.match(headline, /a\]2;pwngent/);
});

test("sanitizeNoticeField strips control characters only", () => {
	assert.equal(sanitizeNoticeField("a\nb\tc"), "abc");
	assert.equal(sanitizeNoticeField("\x1b[31mred\x1b[0m"), "[31mred[0m");
	assert.equal(sanitizeNoticeField("plain"), "plain");
});

test("formatCompletionNotice: details survive a JSON round-trip (session reload)", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
		sessionFile: "/tmp/w.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	// The persisted entry is details-as-JSON; the renderer's guard must
	// accept what comes back.
	const reloaded = JSON.parse(JSON.stringify(notice.details));
	assert.equal(reloaded.status, "completed");
	assert.equal(reloaded.name, "worker-0");
	assert.equal(reloaded.agent, "worker");
	assert.equal(reloaded.acceptance.level, "attested");
	assert.equal(reloaded.sessionFile, "/tmp/w.jsonl");
	assert.equal(typeof reloaded.outputBytes, "number");
	// Details never leak into content: the LLM payload is unchanged.
	assert.doesNotMatch(notice.content, /outputBytes/);
	assert.doesNotMatch(notice.content, /"status": "completed"/);
});

test("formatCollectFailure wraps an exception as a failed notice", () => {
	const notice = formatCollectFailure("w1", new Error("gone"));
	assert.equal(notice.status, "failed");
	assert.match(notice.content, /gone/);
	assert.doesNotMatch(notice.content, /Pane recycled/);
});

test("completionDeliveryOptions follows up instead of steering", () => {
	assert.deepEqual(completionDeliveryOptions(true), {
		triggerTurn: true,
		deliverAs: "followUp",
	});
	assert.deepEqual(completionDeliveryOptions(false), { triggerTurn: false });
});

test("previewOutput truncates long text", () => {
	const long = "x".repeat(5000);
	const preview = previewOutput(long, 100);
	assert.equal(preview.length < long.length, true);
	assert.match(preview, /…$/);
	assert.equal(previewOutput("  hi  "), "hi");
	assert.equal(previewOutput("   "), "(no output)");
});

test("deliverCompletion sends subagent-notify with followUp wakeup", () => {
	const sent: unknown[] = [];
	const ok = deliverCompletion(
		{
			sendMessage(message, options) {
				sent.push({ message, options });
			},
		},
		formatCompletionNotice({
			name: "w1",
			execution: { status: "success" },
			output: "ok",
		}),
		true,
	);
	assert.equal(ok, true);
	assert.equal(sent.length, 1);
	const payload = sent[0] as {
		message: {
			customType: string;
			display: boolean;
			details: { status: string };
		};
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(payload.message.customType, SUBAGENT_NOTIFY_TYPE);
	// display: true — success is part of the transcript now.
	assert.equal(payload.message.display, true);
	assert.equal(payload.message.details.status, "completed");
	assert.equal(payload.options.triggerTurn, true);
	assert.equal(payload.options.deliverAs, "followUp");
});

test("deliverCompletion returns false when sendMessage throws", () => {
	const ok = deliverCompletion(
		{
			sendMessage() {
				throw new Error("session gone");
			},
		},
		formatCompletionNotice({
			name: "w1",
			execution: { status: "success" },
			output: "ok",
		}),
	);
	assert.equal(ok, false);
});

test("completionStatusOf: unknown with a parsed verdict is completed, not failed", () => {
	// A finished cursor child reports `unknown` (F7: no stopReason) even when
	// its own verdict JSON was parsed from the pane. The old blanket mapping
	// labelled those answers "Background task failed".
	assert.equal(completionStatusOf("unknown", "accepted"), "completed");
	assert.equal(completionStatusOf("unknown", "rejected"), "completed");
	// Without a witnessed verdict, unknown stays failed (pi kind wrote nothing).
	assert.equal(completionStatusOf("unknown"), "failed");
	assert.equal(completionStatusOf("unknown", "unknown"), "failed");
});

test("formatCompletionNotice: settled cursor answer reports completed with its verdict", () => {
	const notice = formatCompletionNotice({
		name: "advisor-0",
		agent: "advisor",
		execution: { status: "unknown", reason: "no session jsonl; collected from pane" },
		output: "1+1 等于 2。\n{\"ok\": true, \"reason\": \"arithmetic\"}",
		acceptance: { status: "accepted", level: "attested" },
	});
	assert.equal(notice.status, "completed");
	assert.match(notice.content, /Background task completed: \*\*advisor-0 \(advisor\)\*\*/);
	assert.match(notice.content, /acceptance: accepted/);
});
