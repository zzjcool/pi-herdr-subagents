import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";

function snapshot(over: Partial<CollectSnapshot> = {}): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "attested", level: "attested" },
		...over,
	};
}

async function waitFor(pred: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > 1_000) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("runtime: async watch notifies the parent once and drops the widget entry", async () => {
	const messages: unknown[] = [];
	const busy: unknown[] = [];
	let resolveCollect!: (value: CollectSnapshot) => void;
	const runtime = createSessionRuntime({
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
		now: () => 1_000,
	});

	runtime.track({
		name: "worker-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
	});
	assert.equal(runtime.activeJobs().length, 1);
	assert.equal((busy.at(-1) as { active: boolean }).active, true);

	runtime.watch("worker-0");
	assert.equal(runtime.get("worker-0")?.watching, true);
	resolveCollect(snapshot());
	await waitFor(() => messages.length === 1, "completion notify");
	await waitFor(() => runtime.activeJobs().length === 0, "job released");
	const sent = messages[0] as {
		message: { customType: string; content: string; display: boolean };
		options: { triggerTurn: boolean };
	};
	assert.equal(sent.message.customType, SUBAGENT_NOTIFY_TYPE);
	assert.equal(sent.message.display, false);
	assert.equal(sent.options.triggerTurn, true);
	assert.match(sent.message.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.equal(runtime.activeJobs().length, 0);
	assert.equal((busy.at(-1) as { active: boolean }).active, false);
});

test("runtime: watch recycles the pane after a terminal collect", async () => {
	const messages: unknown[] = [];
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
		retire: async () => {
			retired += 1;
		},
	});
	runtime.watch("w1");
	await waitFor(() => messages.length === 1, "completion notify");
	await waitFor(() => retired === 1, "auto-retire");
	assert.equal(retired, 1);
});

test("runtime: a blocked child is not recycled", async () => {
	let retired = 0;
	const runtime = createSessionRuntime({
		sendMessage() {},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot({ execution: { status: "blocked" } }),
		retire: async () => {
			retired += 1;
		},
	});
	runtime.watch("w1");
	await waitFor(() => runtime.activeJobs().length === 0, "job released");
	assert.equal(retired, 0);
});

test("runtime: an explicit collect suppresses the completion message", async () => {
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	let collects = 0;
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collects += 1;
			return snapshot();
		},
	});
	runtime.watch("w1");
	const pending = runtime.consumeCollect("w1");
	assert.ok(pending);
	const collected = await pending;
	assert.equal(collected.execution.status, "success");
	await waitFor(() => runtime.activeJobs().length === 0, "watcher release");
	assert.equal(collects, 1, "tool collect and watcher must share one wait");
	assert.equal(messages.length, 0, "parent must not also get a notify");
});

test("runtime: collect failure still wakes the parent", async () => {
	const messages: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message);
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			throw new Error("pane gone");
		},
	});
	runtime.watch("w1");
	await waitFor(() => messages.length === 1, "failure notify");
	const sent = messages[0] as { content: string; display: boolean };
	assert.equal(sent.display, true);
	assert.match(sent.content, /pane gone/);
});

test("runtime: dispose clears jobs and busy overlay", () => {
	const busy: unknown[] = [];
	const runtime = createSessionRuntime({
		sendMessage() {},
		emitBusy(active, label) {
			busy.push({ active, label });
		},
	});
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot(),
	});
	runtime.dispose();
	assert.equal(runtime.activeJobs().length, 0);
	assert.equal((busy.at(-1) as { active: boolean }).active, false);
	runtime.watch("w1");
	assert.equal(runtime.activeJobs().length, 0);
});
