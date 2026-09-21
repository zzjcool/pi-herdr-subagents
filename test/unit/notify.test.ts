import { test } from "node:test";
import assert from "node:assert/strict";
import {
	completionDeliveryOptions,
	completionStatusOf,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	formatGroupedNotice,
	type GroupedEntry,
	previewOutput,
	SUBAGENT_NOTIFY_TYPE,
} from "../../src/extension/notify.ts";

test("completionStatusOf: success is completed, abort is stopped, else failed", () => {
	assert.equal(completionStatusOf("success"), "completed");
	assert.equal(completionStatusOf("aborted"), "stopped");
	assert.equal(completionStatusOf("failed"), "failed");
	assert.equal(completionStatusOf("truncated"), "failed");
	// B: `running` is a progress signal, not a completion — it no longer falls
	// through to `failed` (that mislabelled every collect timeout on a live
	// child "Background task failed" while the body said "still alive").
	assert.equal(completionStatusOf("running"), "running");
});

test("formatCompletionNotice: success is quiet in the transcript but still sent", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done the thing",
		sessionFile: "/tmp/worker-0.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	assert.equal(notice.status, "completed");
	assert.equal(notice.display, false);
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

test("previewOutput truncates long text", () => {
	const long = "x".repeat(5000);
	const preview = previewOutput(long, 100);
	assert.equal(preview.length < long.length, true);
	assert.match(preview, /…$/);
	assert.equal(previewOutput("  hi  "), "hi");
	assert.equal(previewOutput("   "), "(no output)");
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
		message: { customType: string; display: boolean };
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(payload.message.customType, SUBAGENT_NOTIFY_TYPE);
	assert.equal(payload.message.display, false);
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

// ────────────────── U3: a running snapshot is never a completion (B) ──────────────────

test("U3: completionStatusOf reports `running` as itself (never folded into failed)", () => {
	assert.equal(completionStatusOf("running"), "running");
	// The other statuses keep their existing mapping.
	assert.equal(completionStatusOf("success"), "completed");
	assert.equal(completionStatusOf("aborted"), "stopped");
});

test("U3: formatCompletionNotice fails loud on a running snapshot (B)", () => {
	assert.throws(
		() =>
			formatCompletionNotice({
				name: "worker-1",
				execution: {
					status: "running",
					reason: "collect timed out after 900000ms; the agent is still alive",
				},
				output: "",
			}),
		/running snapshot is not a completion/,
	);
});

test("U3: a running snapshot never surfaces as a failed notice by accident (B regression)", () => {
	// The old blanket mapping made this the most dangerous case: a live child
	// announced as `failed` while its body said "still alive".
	let thrown: unknown;
	try {
		formatCompletionNotice({
			name: "worker-1",
			execution: { status: "running" },
			output: "still working",
		});
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof Error, "running must not format into a notice");
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

// ─────────────────────────── grouped notices (smart join) ───────────────────────────

function groupedEntry(over: Partial<GroupedEntry> = {}): GroupedEntry {
	return {
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "accepted", level: "attested" },
		status: "completed",
		...over,
	};
}

test("formatGroupedNotice: multiple entries merge into one notice with a header", () => {
	const notice = formatGroupedNotice({
		runId: "r-1",
		entries: [
			groupedEntry({ name: "worker-0", agent: "worker" }),
			groupedEntry({ name: "worker-1", agent: "worker" }),
		],
	});
	assert.equal(notice.status, "completed");
	assert.equal(notice.display, false);
	assert.match(notice.content, /Background tasks completed \(2\):/);
	assert.match(notice.content, /Run: r-1/);
	assert.match(notice.content, /- worker-0 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(notice.content, /- worker-1 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(notice.content, /\(pane recycled\)/);
});

test("formatGroupedNotice: recycle markers are per-entry, not a blanket footer", () => {
	// A wait()-released sibling can race the flush window: the blanket
	// "Pane recycled" footer used to lie about panes that were still open.
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "kept", recycled: false }),
			groupedEntry({ name: "gone" }),
		],
	});
	assert.match(notice.content, /- gone \(worker\): completed .*\(pane recycled\)/);
	assert.doesNotMatch(notice.content, /- kept \(worker\): completed .*pane recycled/);
	assert.doesNotMatch(notice.content, /Pane recycled\. Resume from session files/);
});

test("formatGroupedNotice: any failed → failed aggregate and display", () => {
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "worker-0" }),
			groupedEntry({
				name: "reviewer-1",
				agent: undefined,
				execution: { status: "failed", reason: "model error" },
				acceptance: undefined,
				status: "failed",
				output: "boom",
			}),
		],
	});
	assert.equal(notice.status, "failed");
	assert.equal(notice.display, true);
	assert.match(notice.content, /- reviewer-1: failed \(model error\)/);
});

test("formatGroupedNotice: no runId omits the run header; stillRunning line appended", () => {
	const notice = formatGroupedNotice({
		entries: [groupedEntry({ name: "worker-0" })],
		stillRunning: ["slow-2"],
	});
	assert.doesNotMatch(notice.content, /^Run:/m);
	assert.match(notice.content, /Background tasks completed \(1 of 2\):/);
	assert.match(
		notice.content,
		/Still running: slow-2 \(notifies separately when it finishes\)/,
	);
});

test("formatGroupedNotice: a single entry still uses the grouped shape", () => {
	const notice = formatGroupedNotice({
		entries: [groupedEntry({ name: "worker-0" })],
	});
	assert.equal(notice.status, "completed");
	assert.match(notice.content, /Background tasks completed \(1\):/);
	assert.match(notice.content, /- worker-0 \(worker\): completed/);
});

test("formatGroupedNotice: per-entry previews are capped so the batch stays bounded", () => {
	const long = "x".repeat(5000);
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "a", output: long }),
			groupedEntry({ name: "b", output: long }),
			groupedEntry({ name: "c", output: long }),
			groupedEntry({ name: "d", output: long }),
			groupedEntry({ name: "e", output: long }),
			groupedEntry({ name: "f", output: long }),
			groupedEntry({ name: "g", output: long }),
			groupedEntry({ name: "h", output: long }),
		],
	});
	// 8 entries → cap is max(500, 4000/8) = 500 chars per preview.
	assert.match(notice.content, /…/);
	assert.ok(notice.content.length < 8 * 600 + 500, "batch preview must be bounded");
});
