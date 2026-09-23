import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ParentPaneLabeler,
	PARENT_LABEL_SOURCE,
	PARENT_LABEL_TTL_MS,
} from "../../src/extension/parent-label.ts";
import type { HerdrClient, HerdrResult } from "../../src/shared/types.ts";

const okResult: HerdrResult<void> = { ok: true, value: undefined };
const failResult: HerdrResult<void> = {
	ok: false,
	error: { code: "HERDR_ERROR", message: "boom" },
};

type Report = {
	paneId: string;
	source: string;
	stateLabel?: { status: string; text: string };
	clearStateLabels?: boolean;
	ttlMs?: number;
};

function fakeClient(
	results: Array<HerdrResult<void>> = [],
): { client: HerdrClient; calls: Report[] } {
	const calls: Report[] = [];
	let i = 0;
	const client = {
		paneReportMetadata: async (opts: Report): Promise<HerdrResult<void>> => {
			calls.push(opts);
			return results[i++] ?? okResult;
		},
	} as unknown as HerdrClient;
	return { client, calls };
}

function labelerWith(
	client: HerdrClient,
	now: () => number,
): ParentPaneLabeler {
	return new ParentPaneLabeler({ client, paneId: "w1:p1", now });
}

test("parent-label: no pane id means no-op", async () => {
	const { client, calls } = fakeClient();
	const labeler = new ParentPaneLabeler({ client });
	labeler.report("⏳ 1 subagent (w-0)");
	labeler.report(undefined);
	await labeler.clear();
	assert.equal(calls.length, 0);
});

test("parent-label: reports idle state-label with TTL and source", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 2 subagents (w-0, r-1)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		paneId: "w1:p1",
		source: PARENT_LABEL_SOURCE,
		stateLabel: { status: "idle", text: "⏳ 2 subagents (w-0, r-1)" },
		ttlMs: PARENT_LABEL_TTL_MS,
	});
});

test("parent-label: skips an unchanged label inside the dedupe window", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	t += 100;
	labeler.report("⏳ 1 subagent (w-0)"); // unchanged, within TTL/2
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 1);
	// Past half the TTL: refresh so the label never expires while children run.
	t += PARENT_LABEL_TTL_MS;
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.stateLabel?.text, "⏳ 1 subagent (w-0)");
});

test("parent-label: a changed label reports immediately", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	t += 50;
	labeler.report("⏳ 2 subagents (w-0, r-1)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 2);
});

test("parent-label: clear sends clear-state-labels and resets dedupe", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	await labeler.clear();
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.clearStateLabels, true);
	assert.equal(calls[1]?.stateLabel, undefined);
	// After a clear, the same text reports again (no stale dedupe pin).
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 3);
});

test("parent-label: report(undefined) clears via the busy hook path", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	labeler.report(undefined);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.clearStateLabels, true);
});

test("parent-label: a failed report is retried on the next tick", async () => {
	const { client, calls } = fakeClient([failResult]);
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 1);
	t += 100;
	// Same text but the last report FAILED — the dedupe must not pin it.
	labeler.report("⏳ 1 subagent (w-0)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 2);
});

test("parent-label: concurrent reports coalesce (in-flight guard)", async () => {
	const { client, calls } = fakeClient();
	let t = 1_000;
	const labeler = labelerWith(client, () => t);
	labeler.report("⏳ 1 subagent (w-0)");
	// Second call before the first send resolves: dropped by the in-flight flag.
	labeler.report("⏳ 1 subagent (w-0)");
	labeler.report("⏳ 2 subagents (w-0, r-1)");
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(calls.length, 1);
	// After the send settles the latest text goes out on the next tick.
	labeler.report("⏳ 2 subagents (w-0, r-1)");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.length, 2);
});
