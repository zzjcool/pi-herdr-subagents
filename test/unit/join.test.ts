import { test } from "node:test";
import assert from "node:assert/strict";
import {
	JoinCoordinator,
	MAX_BUSY_EXTENSIONS,
	type JoinEntry,
	type JoinSchedulerHandle,
} from "../../src/extension/join.ts";
import type { CompletionStatus } from "../../src/extension/notify.ts";

type Batch = Array<JoinEntry & { status: CompletionStatus }>;

function entry(name: string, runId = "r-1", status = "success"): JoinEntry {
	return {
		runId,
		name,
		input: { name, execution: { status }, output: `out-${name}` },
		triggerTurn: true,
	};
}

/** Manual scheduler: records the pending fn so the test fires it itself. */
function manualSchedule() {
	const pending: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
	const schedule = (ms: number, fn: () => void): JoinSchedulerHandle => {
		const slot = { ms, fn, cancelled: false };
		pending.push(slot);
		return {
			cancel: () => {
				slot.cancelled = true;
			},
		};
	};
	const fireLast = () => {
		const slot = pending.at(-1);
		assert.ok(slot && !slot.cancelled, "expected a live scheduled flush");
		slot.fn();
	};
	return { pending, schedule, fireLast };
}

function harness(over: {
	mode?: "each" | "smart";
	flushMs?: number;
	busy?: () => boolean;
} = {}) {
	const timers = manualSchedule();
	const delivered: Batch[] = [];
	const join = new JoinCoordinator({
		schedule: timers.schedule,
		deliver: (entries) => delivered.push(entries),
	});
	join.setConfig({
		mode: over.mode ?? "smart",
		flushMs: over.flushMs ?? 10_000,
		...(over.busy ? { parentBusy: over.busy } : {}),
	});
	return { join, delivered, timers };
}

test("join: default config is smart with a 10s window (constructor-only)", () => {
	const delivered: Batch[] = [];
	const timers = manualSchedule();
	const join = new JoinCoordinator({
		schedule: timers.schedule,
		deliver: (entries) => delivered.push(entries),
	});
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0, "smart default buffers the first finisher");
	assert.equal(timers.pending.length, 1, "window armed");
	assert.equal(timers.pending[0]?.ms, 10_000, "default window is 10s");
});

test("join: each mode delivers immediately, one notice per child", () => {
	const { join, delivered, timers } = harness({ mode: "each" });
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.onTerminal(entry("b"));
	assert.equal(delivered.length, 2);
	assert.equal(delivered[0]?.[0]?.name, "a");
	assert.equal(delivered[1]?.[0]?.name, "b");
	assert.equal(timers.pending.length, 0, "each mode must not arm timers");
});

test("join: all members terminal → one immediate grouped flush", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0, "first finisher waits for the group");
	join.onTerminal(entry("b"));
	assert.equal(delivered.length, 1, "all-settled flushes immediately");
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a", "b"],
	);
	// The window armed for `a` is cancelled by the immediate flush.
	assert.equal(timers.pending.at(-1)?.cancelled, true);
});

test("join: window expiry with stragglers flushes only the finished ones", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 0);
	timers.fireLast();
	assert.equal(delivered.length, 1);
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a"],
	);
	assert.equal(join.allSettled("r-1"), false, "slow is still pending");

	// The straggler finishing later is its own settled group → immediate flush.
	join.onTerminal(entry("slow"));
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		delivered[1]?.map((e) => e.name),
		["slow"],
	);
});

test("join: a busy parent extends the window at most MAX_BUSY_EXTENSIONS times", () => {
	let busy = true;
	const { join, delivered, timers } = harness({ busy: () => busy });
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	for (let i = 0; i < MAX_BUSY_EXTENSIONS; i += 1) {
		assert.equal(delivered.length, 0, `extension ${i}: still waiting`);
		timers.fireLast();
	}
	// Extension budget exhausted (total (1+MAX)×flushMs) → flush even while busy.
	timers.fireLast();
	assert.equal(delivered.length, 1, "forced flush after the extension budget");
	assert.deepEqual(
		delivered[0]?.map((e) => e.name),
		["a"],
	);
});

test("join: an idle parent flushes at the first window expiry", () => {
	const { join, delivered, timers } = harness({ busy: () => false });
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	timers.fireLast();
	assert.equal(delivered.length, 1);
});

test("join: remove() drops a member so the group can settle without it", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "gone");
	join.remove("gone");
	assert.equal(join.allSettled("r-1"), false, "a still pending");
	join.onTerminal(entry("a"));
	assert.equal(delivered.length, 1, "removed member does not block the flush");
});

test("join: failed entries keep their failed status in the batch", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.onTerminal(entry("a"));
	join.onTerminal(entry("b", "r-1", "failed"));
	assert.equal(delivered.length, 1);
	assert.deepEqual(
		delivered[0]?.map((e) => e.status),
		["completed", "failed"],
	);
});

test("join: onTerminal without tracking delivers directly instead of dropping", () => {
	const { join, delivered } = harness();
	join.onTerminal(entry("orphan"));
	assert.equal(delivered.length, 1);
});

test("join: dispose cancels timers and swallows nothing", () => {
	const { join, delivered, timers } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "slow");
	join.onTerminal(entry("a"));
	join.dispose();
	assert.equal(timers.pending.at(-1)?.cancelled, true);
	assert.equal(delivered.length, 0, "dispose discards the buffered batch");
	// Post-dispose calls are inert.
	join.onTerminal(entry("slow"));
	assert.equal(delivered.length, 0);
});

test("join: two runs batch independently", () => {
	const { join, delivered } = harness();
	join.addPending("r-1", "a");
	join.addPending("r-1", "b");
	join.addPending("r-2", "c");
	join.onTerminal(entry("a", "r-1"));
	join.onTerminal(entry("c", "r-2"));
	assert.equal(delivered.length, 1, "r-2 is a single-member group");
	join.onTerminal(entry("b", "r-1"));
	assert.equal(delivered.length, 2);
	assert.deepEqual(
		delivered[1]?.map((e) => e.name),
		["a", "b"],
	);
});
