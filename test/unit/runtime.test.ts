import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSessionRuntime,
	shouldRecycleAfterCollect,
} from "../../src/extension/runtime.ts";
import { SUBAGENT_NOTIFY_TYPE } from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import { withTempDir } from "../helpers/tmp.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

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
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(sent.message.customType, SUBAGENT_NOTIFY_TYPE);
	assert.equal(sent.message.display, false);
	assert.equal(sent.options.triggerTurn, true);
	assert.equal(sent.options.deliverAs, "followUp");
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

test("runtime: collect after watch finished returns the cached snapshot", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot({ output: "cached-output" }),
	});
	runtime.watch("w1");
	await waitFor(() => runtime.activeJobs().length === 0, "watch finished");
	const pending = runtime.consumeCollect("w1");
	assert.ok(pending, "finished collect must stay cached after the widget drops");
	const collected = await pending;
	assert.equal(collected.output, "cached-output");
});

test("runtime: a blocked child asks the parent and does not recycle", async () => {
	let retired = 0;
	let handled = 0;
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
		collect: async () =>
			snapshot({
				execution: { status: "running", reason: "blocked: waiting for approval" },
				blocked: true,
			}),
		retire: async () => {
			retired += 1;
		},
		handleBlocked: async () => {
			handled += 1;
			return "hold";
		},
	});
	runtime.watch("w1");
	await waitFor(() => handled === 1, "blocked handler");
	assert.equal(retired, 0);
	assert.equal(messages.length, 0, "blocked is not a completion");
	assert.equal(runtime.get("w1")?.state, "blocked");
	assert.equal(runtime.activeJobs().length, 1, "pane stays on the widget");
});

test("runtime: approving a blocked child rewatches instead of releasing", async () => {
	let collects = 0;
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "w1",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/w.jsonl",
		timeoutMs: 1_000,
		collect: async () => {
			collects += 1;
			if (collects === 1) {
				return snapshot({
					execution: { status: "running" },
					blocked: true,
				});
			}
			return snapshot();
		},
		handleBlocked: async () => "resume",
	});
	runtime.watch("w1");
	await waitFor(() => collects >= 2, "rewatch after approve");
	await waitFor(() => runtime.activeJobs().length === 0, "terminal release");
	assert.equal(collects, 2);
});

test("runtime: session jsonl fills model, turns, and in-flight tools", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = join(dir, "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			[
				sessionHeader(),
				modelChange("cb/glm-5.3"),
				userMsg("go"),
				assistantMsg({
					stopReason: "toolUse",
					tools: ["bash"],
					model: "cb/glm-5.3",
				}),
			].join("\n"),
		);
		const rendered: string[] = [];
		const runtime = createSessionRuntime({
			sendMessage() {},
			now: () => 5_000,
		});
		runtime.bind({
			hasUI: true,
			ui: {
				theme: { fg: (_c, text) => text },
				setStatus() {},
				setWidget(_key, content) {
					if (typeof content === "function") {
						const component = content({ requestRender() {} }, {
							fg: (_c, text) => text,
						});
						rendered.splice(0, rendered.length, ...component.render());
					}
				},
			},
		});
		runtime.track({
			name: "worker-0",
			runId: "r-1",
			agent: "worker",
			sessionFile,
			timeoutMs: 1_000,
			kind: "pi",
			thinking: "medium",
			worktreeBranch: "pi-subagent/worker-0-abcd",
			collect: () => new Promise(() => {}),
		});
		assert.match(rendered.join("\n"), /cb\/glm-5\.3:medium/);
		assert.match(rendered.join("\n"), /turn 1/);
		assert.match(rendered.join("\n"), /bash/);
		assert.match(rendered.join("\n"), /wt worker-0-abcd/);
		runtime.dispose();
	});
});

test("runtime: non-pi probe fills the same live fields", async () => {
	const runtime = createSessionRuntime({
		sendMessage() {},
		now: () => 1_000,
		probeMs: 0,
	});
	runtime.track({
		name: "cursor-0",
		runId: "r-1",
		agent: "reviewer",
		sessionFile: "",
		timeoutMs: 1_000,
		kind: "cursor",
		model: "inherit-parent",
		probe: async () => ({
			model: "cursor/gpt-4.1",
			herdrStatus: "working",
			turns: 2,
			lastTools: ["edit"],
		}),
		collect: () => new Promise(() => {}),
	});
	await waitFor(
		() => runtime.get("cursor-0")?.probed?.model === "cursor/gpt-4.1",
		"probe result",
	);
	assert.deepEqual(runtime.get("cursor-0")?.probed, {
		model: "cursor/gpt-4.1",
		herdrStatus: "working",
		turns: 2,
		lastTools: ["edit"],
	});
	runtime.dispose();
});

test("shouldRecycleAfterCollect keeps running/blocked panes, recycles unknown", () => {
	assert.equal(shouldRecycleAfterCollect("running"), false);
	assert.equal(shouldRecycleAfterCollect("blocked"), false);
	assert.equal(shouldRecycleAfterCollect("unknown"), true);
	assert.equal(shouldRecycleAfterCollect("success"), true);
	assert.equal(shouldRecycleAfterCollect("aborted"), true);
});
