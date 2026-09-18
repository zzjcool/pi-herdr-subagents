/**
 * Orchestrator integration tests.
 *
 * These exercise launch / collect / retire against the fake herdr (driven
 * through the REAL client, so argv construction and response parsing are
 * covered too), asserting the MEASURED behaviours that make this design work:
 *
 *   F4  — the session file is pre-created before the agent starts
 *   F11 — retirement uses ctrl+d, and falls back to pane close
 *   F12 — closing a pane is safe: the session file survives
 *   F15 — retireAll can reap a whole tab
 *   F19 — the agent_pane_busy race is retried, not fatal
 *   F26 — success/failure comes from the session, not agent_status
 *   F27 — retire snapshots the outcome BEFORE the agent disappears
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeHerdr, createFakeRunner } from "../helpers/fake-herdr.ts";
import { createHerdrClient } from "../../src/herdr/client.ts";
import {
	Orchestrator,
	preCreateSessionFile,
} from "../../src/runs/orchestrator.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

/** Build a pi-shaped session transcript from the shared fixtures. */
function transcript(messages: Array<Record<string, unknown>>): string {
	const lines = [sessionHeader()];
	for (const m of messages) {
		if (m.role === "user") {
			lines.push(userMsg(String(m.text ?? "")));
			continue;
		}
		const opts: Record<string, unknown> = {};
		if (m.stopReason !== undefined) opts.stopReason = m.stopReason;
		if (m.text !== undefined) opts.text = m.text;
		if (m.tools !== undefined) opts.tools = m.tools;
		if (m.errorMessage !== undefined) opts.errorMessage = m.errorMessage;
		lines.push(assistantMsg(opts));
	}
	return `${lines.join("\n")}\n`;
}

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "test agent",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test agent.",
		source: "user",
		filePath: "/fake/reviewer.md",
		...over,
	};
}

interface Harness {
	orchestrator: Orchestrator;
	fake: FakeHerdr;
	client: ReturnType<typeof createHerdrClient>;
	runDir: string;
	/** How many `agent start` invocations were attempted (retry assertions). */
	startAttempts: () => number;
	openPanes: () => number;
	cleanup: () => void;
}

/**
 * Wire the orchestrator to a fake herdr through the REAL client.
 * `sleep` advances the fake clock rather than really waiting, so the F19 busy
 * window expires deterministically and the tests stay fast.
 */
function harness(options: { paneBusyMs?: number } = {}): Harness {
	const runDir = mkdtempSync(path.join(tmpdir(), "orch-test-"));
	const fake = new FakeHerdr({ paneBusyMs: options.paneBusyMs ?? 0 });
	fake.addRootPane("w1");
	const client = createHerdrClient(createFakeRunner(fake));

	const orchestrator = new Orchestrator({
		client,
		runDir,
		cwd: "/tmp/project",
		sleep: async (ms) => {
			fake.advance(ms);
		},
	});

	return {
		orchestrator,
		fake,
		client,
		runDir,
		startAttempts: () =>
			fake.commands.filter((c) => c.args[0] === "agent" && c.args[1] === "start")
				.length,
		openPanes: () => fake.panes.size,
		cleanup: () => rmSync(runDir, { recursive: true, force: true }),
	};
}

// ─────────────────────────── session pre-creation (F4) ───────────────────────────

test("preCreateSessionFile creates an empty 0600 file and is idempotent", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "precreate-"));
	try {
		const file = path.join(dir, "nested", "s.jsonl");
		preCreateSessionFile(file);
		assert.ok(existsSync(file));
		assert.equal(statSync(file).size, 0);

		// Idempotent: an existing file must not be truncated.
		writeFileSync(file, "existing\n");
		preCreateSessionFile(file);
		assert.equal(statSync(file).size, "existing\n".length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("launch pre-creates the session file before starting the agent (F4)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({
			agent: agent(),
			task: "do it",
		});
		assert.ok(
			existsSync(handle.sessionFile),
			"session file must exist right after launch",
		);
		assert.notEqual(handle.paneId, null);
	} finally {
		h.cleanup();
	}
});

test("launch records the child with provenance", async () => {
	const h = harness();
	try {
		await h.orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t",
			model: "cb/glm-5.3",
		});
		const [child] = h.orchestrator.childrenSnapshot();
		assert.ok(child);
		assert.equal(child.agent, "worker");
		assert.equal(child.kind, "pi");
		assert.equal(child.model, "cb/glm-5.3");
		assert.equal(child.state, "working");
		assert.ok(child.ownerToken.length > 0, "an owner token must be recorded");
	} finally {
		h.cleanup();
	}
});

// ─────────────────────────── the readiness race (F19) ───────────────────────────

test("launch retries agent_pane_busy until the pane is ready (F19)", async () => {
	const h = harness({ paneBusyMs: 500 });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		assert.ok(handle.name);
		assert.ok(
			h.startAttempts() > 1,
			`expected more than one start attempt, got ${h.startAttempts()}`,
		);
	} finally {
		h.cleanup();
	}
});

test("a failed launch rolls back its pane instead of leaking it", async () => {
	// A pane that never becomes ready exhausts the retry budget, so the launch
	// fails — and the pane it created must be closed again.
	const runDir = mkdtempSync(path.join(tmpdir(), "orch-rollback-"));
	try {
		const fake = new FakeHerdr({ paneBusyMs: 10_000 });
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp/project",
			sleep: async () => {}, // never advance: the pane stays busy forever
			startRetries: 3,
			startRetryBackoffMs: 1,
		});

		const before = fake.panes.size;
		await assert.rejects(
			() => orchestrator.launch({ agent: agent(), task: "t" }),
			/agent start/,
		);
		assert.equal(
			fake.panes.size,
			before,
			"a failed launch must not leak its pane",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────── outcome derivation (F26/F27/F29) ───────────────────────────

test("collect derives success from the session, not agent_status (F26)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{ role: "assistant", stopReason: "stop", text: "done" },
			]),
		);
		const result = await h.orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "success");
		assert.equal(result.output, "done");
	} finally {
		h.cleanup();
	}
});

test("collect reports failure for an LLM error even though herdr says done (F26)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "400 status code",
				},
			]),
		);
		const result = await h.orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "failed");
		assert.equal(result.execution.errorMessage, "400 status code");
	} finally {
		h.cleanup();
	}
});

test("collect reports abort when the agent is GONE and the last prompt has no reply (F29)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(handle.sessionFile, transcript([{ role: "user", text: "go" }]));

		// F29's measured scenario is a HARD KILL: the pane dies mid-turn, so no
		// assistant message is ever written and the agent is gone. Only the
		// combination of "no reply" + "agent gone" is an abort; a live agent with
		// no reply is simply still working (covered by the next test).
		// ctrl+d is the fake's modelled clean exit (F11).
		await h.client.agentSendKeys(handle.name, "ctrl+d");

		const result = await h.orchestrator.collect(handle.name, {
			timeoutMs: 2_000,
		});
		assert.equal(result.execution.status, "aborted");
	} finally {
		h.cleanup();
	}
});

test("collect reports `running` (not aborted) when the agent is still alive", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		// A user prompt with no reply yet, but the agent is alive: this is a slow
		// turn, not an abort. Reporting `aborted` here would be a false alarm.
		writeFileSync(handle.sessionFile, transcript([{ role: "user", text: "go" }]));

		const result = await h.orchestrator.collect(handle.name, {
			timeoutMs: 2_000,
		});
		assert.equal(result.execution.status, "running");
		assert.match(result.execution.reason ?? "", /timed out|still alive/);
	} finally {
		h.cleanup();
	}
});

test("collect turns a self-reported verdict into acceptance (F33)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{
					role: "assistant",
					stopReason: "stop",
					text: '{"ok": false, "reason": "missing input"}',
				},
			]),
		);
		const result = await h.orchestrator.collect(handle.name);
		assert.equal(result.execution.status, "success");
		assert.equal(result.acceptance.status, "rejected");
		assert.equal(result.acceptance.reason, "missing input");
	} finally {
		h.cleanup();
	}
});

test("collect on an unknown child throws", async () => {
	const h = harness();
	try {
		await assert.rejects(() => h.orchestrator.collect("nobody"), /unknown child/);
	} finally {
		h.cleanup();
	}
});

// ─────────────────────────── retirement (F11/F12/F15/F27) ───────────────────────────

test("retire snapshots the outcome before the agent disappears (F27)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{ role: "assistant", stopReason: "stop", text: "ok" },
			]),
		);

		// Retire WITHOUT calling collect first: the snapshot must still be taken.
		const child = await h.orchestrator.retire(handle.name);
		assert.equal(child.state, "retired");
		assert.equal(
			child.execution?.status,
			"success",
			"outcome must be captured during retire",
		);
		assert.equal(child.paneId, null, "paneId is cleared after recycling");
	} finally {
		h.cleanup();
	}
});

test("retire leaves the session file on disk so resume stays possible (F12)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{ role: "assistant", stopReason: "stop", text: "ok" },
			]),
		);
		await h.orchestrator.retire(handle.name);
		assert.ok(
			existsSync(handle.sessionFile),
			"session file must survive retirement",
		);
	} finally {
		h.cleanup();
	}
});

test("retire exits the agent and closes its pane", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		assert.ok(h.fake.agents.has(handle.name), "agent should exist after launch");

		await h.orchestrator.retire(handle.name);

		assert.equal(h.fake.agents.has(handle.name), false, "agent must be gone");
		// Only the root pane remains.
		assert.equal(h.openPanes(), 1, "the child pane must be closed");
	} finally {
		h.cleanup();
	}
});

test("retire is idempotent", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		await h.orchestrator.retire(handle.name);
		const again = await h.orchestrator.retire(handle.name);
		assert.equal(again.state, "retired");
	} finally {
		h.cleanup();
	}
});

test("retireAll reaps every child (F15)", async () => {
	const h = harness();
	try {
		const a = await h.orchestrator.launch({
			agent: agent({ name: "a" }),
			task: "t",
		});
		const b = await h.orchestrator.launch({
			agent: agent({ name: "b" }),
			task: "t",
		});

		const retired = await h.orchestrator.retireAll({});

		assert.equal(retired.length, 2);
		assert.equal(h.fake.agents.has(a.name), false);
		assert.equal(h.fake.agents.has(b.name), false);
	} finally {
		h.cleanup();
	}
});

// ─────────────────────────── names, steering, audit, restore ───────────────────────────

test("allocateName produces valid, non-colliding names", () => {
	const h = harness();
	try {
		const seen = new Set<string>();
		for (let i = 0; i < 5; i += 1) {
			const n = h.orchestrator.allocateName("Review Agent");
			assert.match(n, /^[a-z][a-z0-9_-]{0,31}$/, `invalid name: ${n}`);
			assert.equal(seen.has(n), false, `duplicate name: ${n}`);
			seen.add(n);
		}
	} finally {
		h.cleanup();
	}
});

test("steer forwards a prompt to a live child (F10)", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		await h.orchestrator.steer(handle.name, "change of plan");
		// The fake records prompts it received.
		const prompts = h.fake.commands.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "prompt",
		);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0]?.args.join(" ") ?? "", /change of plan/);
	} finally {
		h.cleanup();
	}
});

test("steer on a missing child throws", async () => {
	const h = harness();
	try {
		await assert.rejects(() => h.orchestrator.steer("ghost", "hi"));
	} finally {
		h.cleanup();
	}
});

test("auditOrphans reports panes in the tab that the tree does not know about", async () => {
	const h = harness();
	try {
		// The run owns one task tab; its children live inside it.
		await h.orchestrator.launch({ agent: agent(), task: "t" });
		const tabId = h.orchestrator.tabId;
		assert.ok(tabId, "the launch must have created the run tab");

		// An out-of-band pane in the SAME tab, created by someone else: a new tab
		// would be invisible to the audit, which is scoped to one tab.
		const orphanPane = h.fake.addPaneInTab(tabId, "w1");
		void orphanPane;

		const orphans = await h.orchestrator.auditOrphans(tabId);
		assert.ok(
			orphans.length >= 1,
			`expected at least one orphan, got ${orphans.length}`,
		);
	} finally {
		h.cleanup();
	}
});

test("restore rehydrates children from a persisted record", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		const snapshot = h.orchestrator.childrenSnapshot();

		const fresh = new Orchestrator({
			client: h.client,
			runDir: h.runDir,
			cwd: "/tmp/project",
			sleep: async () => {},
		});
		fresh.restore({
			schemaVersion: 1,
			runId: "r-test",
			task: "t",
			cwd: "/tmp/project",
			herdr: {},
			path: [],
			depth: 0,
			maxDepth: 1,
			children: snapshot,
			budget: { spawned: 1, limit: 8, granted: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		assert.equal(fresh.childrenSnapshot().length, 1);
		assert.equal(fresh.childrenSnapshot()[0]?.name, handle.name);
	} finally {
		h.cleanup();
	}
});

test("collect runs verification-output criteria and promotes attested to verified", async () => {
	const h = harness();
	try {
		const commands: string[] = [];
		const orchestrator = new Orchestrator({
			client: h.client,
			runDir: h.runDir,
			cwd: "/work",
			sleep: async (ms) => {
				h.fake.advance(ms);
			},
			verifyRunner: async (command, cwd) => {
				commands.push(`${cwd}::${command}`);
				return { code: 0, stdout: "ok\n", stderr: "" };
			},
		});
		const handle = await orchestrator.launch({
			agent: agent({
				acceptance: {
					level: "attested",
					criteria: [
						{
							id: "typecheck-test-pass",
							must: "npm run typecheck 与 npm test 全绿",
							evidence: ["verification-output"],
							severity: "required",
						},
					],
				},
			}),
			task: "t",
		});
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "t" },
				{
					role: "assistant",
					stopReason: "stop",
					text: '{"ok": true, "reason": "done"}',
				},
			]),
		);
		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.acceptance.status, "accepted");
		assert.equal(collected.acceptance.level, "verified");
		assert.equal(commands.length, 1);
		assert.match(commands[0] ?? "", /\/work::npm run typecheck/);
	} finally {
		h.cleanup();
	}
});

test("collect reports blocked without waiting out the timeout", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({ onBlocked: "forward" }),
			task: "t",
		});
		assert.equal(handle.child.onBlocked, "forward");
		h.fake.block(handle.name);
		const started = Date.now();
		const collected = await h.orchestrator.collect(handle.name, {
			timeoutMs: 60_000,
		});
		assert.ok(Date.now() - started < 5_000, "must not wait the full timeout");
		assert.equal(collected.blocked, true);
		assert.equal(collected.execution.status, "running");
		assert.equal(
			h.orchestrator.childrenSnapshot().find((c) => c.name === handle.name)
				?.state,
			"blocked",
		);
	} finally {
		h.cleanup();
	}
});

test("cachedCollect returns the snapshot after retire so a later collect is a no-wait", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "go" },
				{ role: "assistant", stopReason: "stop", text: "ok" },
			]),
		);
		await h.orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		await h.orchestrator.retire(handle.name);
		const cached = h.orchestrator.cachedCollect(handle.name);
		assert.ok(cached);
		assert.equal(cached.execution.status, "success");
		assert.equal(h.orchestrator.cachedCollect("nobody"), undefined);
	} finally {
		h.cleanup();
	}
});

test("approveBlocked sends y and lets collect run again", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t" });
		h.fake.block(handle.name);
		await h.orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		await h.orchestrator.approveBlocked(handle.name);
		const child = h.orchestrator
			.childrenSnapshot()
			.find((c) => c.name === handle.name);
		assert.equal(child?.state, "working");
		assert.equal(child?.execution, undefined);
		assert.ok(
			h.fake.sentKeys.some((entry) => entry.keys.includes("y")),
			"approval must reach herdr as send-keys y",
		);
	} finally {
		h.cleanup();
	}
});

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initGitRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "orch-git-"));
	execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
	writeFileSync(path.join(dir, "README"), "hi\n");
	execFileSync("git", ["-C", dir, "add", "README"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-m", "init"], {
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	return dir;
}

test("launch worktree:true is refused outside a git repo", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() =>
				h.orchestrator.launch({
					agent: agent({ worktree: true }),
					task: "t",
				}),
			/git repository/,
		);
		assert.equal(h.startAttempts(), 0);
	} finally {
		h.cleanup();
	}
});

test("launch worktree:true sets pane cwd and retire leaves the tree", {
	skip: !hasGit(),
}, async () => {
	const repo = initGitRepo();
	const runDir = mkdtempSync(path.join(tmpdir(), "orch-wt-"));
	const fake = new FakeHerdr({ paneBusyMs: 0 });
	fake.addRootPane("w1");
	const client = createHerdrClient(createFakeRunner(fake));
	const verifyCwds: string[] = [];
	const orchestrator = new Orchestrator({
		client,
		runDir,
		cwd: repo,
		sleep: async (ms) => {
			fake.advance(ms);
		},
		verifyRunner: async (_command, cwd) => {
			verifyCwds.push(cwd);
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	});
	try {
		const handle = await orchestrator.launch({
			agent: agent({
				worktree: true,
				acceptance: {
					level: "attested",
					criteria: [
						{
							id: "typecheck-test-pass",
							must: "tests",
							evidence: ["verification-output"],
							severity: "required",
						},
					],
				},
			}),
			task: "t",
		});
		assert.ok(handle.child.worktreePath);
		assert.ok(handle.child.worktreeBranch);
		assert.ok(existsSync(path.join(handle.child.worktreePath, "README")));
		assert.match(
			handle.child.worktreeBranch,
			/^pi-subagent\/[a-z0-9._-]+-[0-9a-f]{8}$/,
		);
		const pane = fake.panes.get(handle.paneId ?? "");
		assert.equal(pane?.cwd, handle.child.worktreePath);

		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "t" },
				{
					role: "assistant",
					stopReason: "stop",
					text: '{"ok": true, "reason": "done"}',
				},
			]),
		);
		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.acceptance.level, "verified");
		assert.deepEqual(verifyCwds, [handle.child.worktreePath]);

		await orchestrator.retire(handle.name);
		assert.ok(
			existsSync(handle.child.worktreePath),
			"retire must leave the worktree on disk",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("launch worktree: false opts out of the role default", {
	skip: !hasGit(),
}, async () => {
	const repo = initGitRepo();
	const runDir = mkdtempSync(path.join(tmpdir(), "orch-wt-off-"));
	const fake = new FakeHerdr({ paneBusyMs: 0 });
	fake.addRootPane("w1");
	const orchestrator = new Orchestrator({
		client: createHerdrClient(createFakeRunner(fake)),
		runDir,
		cwd: repo,
		sleep: async (ms) => fake.advance(ms),
	});
	try {
		const handle = await orchestrator.launch({
			agent: agent({ worktree: true }),
			task: "t",
			worktree: false,
		});
		assert.equal(handle.child.worktreePath, undefined);
		assert.equal(fake.panes.get(handle.paneId ?? "")?.cwd, repo);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("launch worktree: true isolates even when the role did not default it", {
	skip: !hasGit(),
}, async () => {
	const repo = initGitRepo();
	const runDir = mkdtempSync(path.join(tmpdir(), "orch-wt-on-"));
	const fake = new FakeHerdr({ paneBusyMs: 0 });
	fake.addRootPane("w1");
	const orchestrator = new Orchestrator({
		client: createHerdrClient(createFakeRunner(fake)),
		runDir,
		cwd: repo,
		sleep: async (ms) => fake.advance(ms),
	});
	try {
		const handle = await orchestrator.launch({
			agent: agent({ worktree: false }),
			task: "t",
			worktree: true,
		});
		assert.ok(handle.child.worktreePath);
		assert.equal(fake.panes.get(handle.paneId ?? "")?.cwd, handle.child.worktreePath);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	}
});

test("launch retries fallbackModels after a start failure", async () => {
	const h = harness();
	try {
		h.fake.failStartOnModel.add("bad/model");
		const handle = await h.orchestrator.launch({
			agent: agent({ fallbackModels: ["good/model"] }),
			task: "t",
			model: "bad/model",
		});
		assert.equal(handle.child.model, "good/model");
		assert.deepEqual(h.fake.startedModels, ["good/model"]);
		assert.ok(h.startAttempts() >= 2);
	} finally {
		h.cleanup();
	}
});

test("completionGuard rejects a successful turn with no verdict JSON", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({ completionGuard: true }),
			task: "t",
		});
		assert.equal(handle.child.completionGuard, true);
		writeFileSync(
			handle.sessionFile,
			transcript([
				{ role: "user", text: "t" },
				{ role: "assistant", stopReason: "stop", text: "all done, trust me" },
			]),
		);
		const collected = await h.orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.execution.status, "success");
		assert.equal(collected.acceptance.status, "rejected");
		assert.match(collected.acceptance.reason ?? "", /completionGuard/);
	} finally {
		h.cleanup();
	}
});

test("launch injects budget and nested-allow env into the pane", async () => {
	const h = harness();
	try {
		await h.orchestrator.launch({
			agent: agent({
				toolBudget: { maxToolCalls: 4 },
				turnBudget: { maxTurns: 2 },
				toolTimeoutMs: 9_000,
				allowNestedSubagents: true,
			}),
			task: "t",
		});
		const tab = h.fake.commands.find(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.ok(tab);
		const argv = tab.args.join(" ");
		assert.match(argv, /PI_SUBAGENT_MAX_TOOL_CALLS=4/);
		assert.match(argv, /PI_SUBAGENT_MAX_TURNS=2/);
		assert.match(argv, /PI_SUBAGENT_TOOL_TIMEOUT_MS=9000/);
		assert.match(argv, /PI_SUBAGENT_ALLOW_NESTED=1/);
	} finally {
		h.cleanup();
	}
});

test("probeProgress maps non-pi herdr labels onto the same live fields as jsonl", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({
				name: "reviewer",
				kind: "cursor",
				model: "grok-4.6",
			}),
			task: "t",
		});
		assert.equal(handle.child.kind, "cursor");
		assert.equal(handle.child.model, "cursor-grok-4.6-high");
		h.fake.setLiveProgress(handle.name, {
			status: "working",
			labels: { model: "cursor/gpt-4.1", tool: "edit", turns: "2" },
			title: "Cursor · cursor/gpt-4.1",
		});
		const live = await h.orchestrator.probeProgress(handle.name);
		assert.equal(live.model, "cursor/gpt-4.1");
		assert.equal(live.herdrStatus, "working");
		assert.equal(live.turns, 2);
		assert.deepEqual(live.lastTools, ["edit"]);
	} finally {
		h.cleanup();
	}
});

test("every kind starts via herdr then gets the task as agent prompt", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({
				kind: "cursor",
				model: "grok-4.6",
				thinking: "medium",
				systemPrompt: "You are a cursor child.",
			}),
			task: "review src/foo.ts",
		});
		const start = h.fake.commands.find(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		);
		assert.ok(start);
		const startArgv = start.args.join(" ");
		assert.match(startArgv, /--kind cursor/);
		assert.match(startArgv, /--model cursor-grok-4\.6-medium/);
		assert.equal(
			start.args.includes("--session"),
			false,
			"pi --session must not be forwarded to cursor",
		);
		assert.equal(
			start.args.some((a) => a.startsWith("@")),
			false,
			"task is not a start argument",
		);

		const prompt = h.fake.commands.find(
			(c) => c.args[0] === "agent" && c.args[1] === "prompt",
		);
		assert.ok(prompt);
		assert.equal(prompt.args[2], handle.name);
		assert.match(prompt.args.at(-1) ?? "", /You are a cursor child/);
		assert.match(prompt.args.at(-1) ?? "", /review src\/foo\.ts/);

		const paneId = handle.paneId;
		assert.ok(paneId);
		const pane = h.fake.panes.get(paneId);
		assert.ok(pane);
		pane.screen.push('CURSOR_OK\n{"ok": true, "reason": "reviewed"}');

		const collected = await h.orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.execution.status, "unknown");
		assert.match(collected.output, /CURSOR_OK/);
		assert.equal(collected.acceptance.status, "accepted");
	} finally {
		h.cleanup();
	}
});

