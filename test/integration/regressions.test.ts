import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseSessionText, deriveOutcome, isLastTurnComplete } from "../../src/shared/session.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker", description: "worker", systemPrompt: "role prompt", systemPromptMode: "append",
		inheritProjectContext: true, inheritSkills: false, kind: "pi", source: "user", filePath: "/worker.md", ...overrides,
	};
}

function tempDir(): string { return mkdtempSync(path.join(tmpdir(), "rpc-regression-")); }

test("regression: aborted and missing stopReason map to aborted, while unknown stopReason remains failed", () => {
	const aborted = deriveOutcome(parseSessionText([userMsg("go"), assistantMsg({ stopReason: "aborted" })].join("\n")));
	assert.equal(aborted.status, "aborted");
	const truncated = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "cut off" }] } });
	const missing = deriveOutcome(parseSessionText([userMsg("go"), truncated].join("\n")));
	assert.equal(missing.status, "aborted");
	const unknown = JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "something-new" } });
	assert.equal(deriveOutcome(parseSessionText([userMsg("go"), unknown].join("\n"))).status, "failed");
});

test("regression: a settled session returns without waiting for the RPC timeout", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		let clock = 0;
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project", now: () => clock, sleep: async (ms) => { clock += ms; } });
		const handle = await orchestrator.launch({ agent: agent(), task: "go", worktree: false });
		supervisor.settle(handle.name, { text: "done" });
		const start = clock;
		const result = await orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		assert.equal(result.execution.status, "success");
		assert.ok(clock - start < 5_000, "settled JSONL should stay inside the collect deadline");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: a later rejection overrides an earlier accepted verdict", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({ agent: agent(), task: "first", worktree: false });
		supervisor.settle(handle.name, { text: '{"ok":true,"reason":"first turn"}' });
		await orchestrator.collect(handle.name);
		await orchestrator.steer(handle.name, "second turn");
		supervisor.settle(handle.name, { text: '{"ok":false,"reason":"second turn failed"}' });
		const result = await orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "success");
		assert.equal(result.acceptance.status, "rejected");
		assert.equal(result.acceptance.reason, "second turn failed");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: a process exit with an unanswered final turn is an abort", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({ agent: agent(), task: "first", worktree: false });
		supervisor.settle(handle.name, { text: '{"ok":true,"reason":"old turn"}' });
		await orchestrator.collect(handle.name);
		await orchestrator.steer(handle.name, "second turn is killed");
		supervisor.exit(handle.name);
		const result = await orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "aborted");
		assert.notEqual(result.acceptance.status, "accepted");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: the final turn owns the verdict; stale earlier verdicts cannot survive abort", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({ agent: agent(), task: "first", worktree: false });
		writeFileSync(handle.sessionFile, [
			sessionHeader(), userMsg("first"), assistantMsg({ stopReason: "stop", text: '{"ok":true,"reason":"old"}' }),
			userMsg("second"),
		].join("\n") + "\n");
		supervisor.settle(handle.name, { text: "", stopReason: "aborted" });
		const result = await orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "aborted");
		assert.notEqual(result.acceptance.status, "accepted");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: terminal output artifact is cleared when a later turn has no output", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		let clock = 0;
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project", now: () => clock, sleep: async (ms) => { clock += ms; } });
		const first = await orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		supervisor.settle(first.name, { text: "first output" });
		const result1 = await orchestrator.collect(first.name);
		assert.ok(result1.outputFile);
		await orchestrator.retire(first.name);
		const resumed = await orchestrator.launch({ agent: agent(), task: "second", name: "worker-0", worktree: false });
		supervisor.settle(resumed.name, { text: "" });
		const result2 = await orchestrator.collect(resumed.name);
		assert.equal(result2.outputFile, undefined);
		assert.equal(orchestrator.cachedCollect(resumed.name)?.outputFile, undefined);
		assert.equal(orchestrator.cachedCollect(resumed.name)?.output, "", "cached result must not resurrect a previous turn's text");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: RPC start fallback tries configured models in order", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor({ rejectSpawn: (input) => input.model === "primary/model" ? new SubagentError("model unavailable", ErrorCodes.START_FAILED) : undefined });
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({ agent: agent({ model: "primary/model", fallbackModels: ["fallback/model"] }), task: "go", worktree: false });
		assert.deepEqual(supervisor.spawns.map((spawn) => spawn.input.model), ["fallback/model"]);
		assert.equal(handle.child.model, "fallback/model", "persisted metadata must reflect the model that actually started");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: role depth never widens parent depth and spawn budget is enforced", async () => {
	const runDir = tempDir();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp", parentPath: [{ runId: "r-parent" }], maxDepth: 2, maxSpawns: 1 });
		await orchestrator.launch({ agent: agent({ maxSubagentDepth: 4 }), task: "allowed", worktree: false });
		assert.equal(Number(supervisor.spawns[0]?.input.env?.PI_SUBAGENT_MAX_DEPTH), 2);
		await assert.rejects(() => orchestrator.launch({ agent: agent(), task: "budget" }), (error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED);
	} finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("regression: worktree can be disabled for a writer and remains after RPC retirement", async () => {
	const root = tempDir();
	const repo = path.join(root, "repo");
	const runDir = path.join(root, "run");
	const { execFileSync } = await import("node:child_process");
	try {
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const optedOut = await orchestrator.launch({ agent: agent({ worktree: true }), task: "share", worktree: false });
		assert.equal(optedOut.child.worktreePath, undefined);
		const isolated = await orchestrator.launch({ agent: agent(), task: "isolate", worktree: true });
		assert.ok(isolated.child.worktreePath);
		assert.ok(existsSync(isolated.child.worktreePath!));
		await orchestrator.retire(isolated.name);
		assert.ok(existsSync(isolated.child.worktreePath!), "RPC retirement preserves the resume worktree");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("regression: worktree is created for a writer role and the branch is passed to RPC spawn", async () => {
	const root = tempDir();
	const repo = path.join(root, "repo");
	const runDir = path.join(root, "run");
	const { execFileSync } = await import("node:child_process");
	try {
		import.meta.resolve("node:fs");
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const handle = await orchestrator.launch({ agent: agent({ worktree: true }), task: "work in isolation" });
		assert.ok(handle.child.worktreeBranch);
		assert.equal(supervisor.spawns[0]?.input.worktreeBranch, handle.child.worktreeBranch);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("regression: session completion distinguishes settled, toolUse, and unanswered turns", () => {
	assert.equal(isLastTurnComplete(parseSessionText([userMsg("go"), assistantMsg({ stopReason: "stop" })].join("\n"))), true);
	assert.equal(isLastTurnComplete(parseSessionText([userMsg("go"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] })].join("\n"))), false);
	assert.equal(isLastTurnComplete(parseSessionText(userMsg("go"))), false);
});
