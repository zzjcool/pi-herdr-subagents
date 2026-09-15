/**
 * Regression tests for bugs found during adversarial review.
 *
 * Each test names the bug it pins down, so a reintroduction fails loudly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseSessionText,
	deriveOutcome,
	isLastTurnComplete,
} from "../../src/shared/session.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { createSessionLayout } from "../../src/runs/layout.ts";
import { FakeHerdr, createFakeRunner } from "../helpers/fake-herdr.ts";
import { createHerdrClient } from "../../src/herdr/client.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

const user = (t: string) => userMsg(t);

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "t",
		description: "d",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "p",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG 1 (review: rev-correctness): a literal `stopReason: "aborted"` fell through
// to the `failed` catch-all, misreporting a known value as unknown.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: stopReason 'aborted' maps to aborted, not failed", () => {
	const parsed = parseSessionText(
		[user("go"), assistantMsg({ stopReason: "aborted" })].join("\n"),
	);
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "aborted");
	assert.equal(outcome.stopReason, "aborted");
	assert.doesNotMatch(outcome.reason ?? "", /unknown stopReason/);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 2 (review: rev-correctness): an assistant message with NO stopReason was
// reported as `failed` with a misleading "unknown stopReason: null".
// It must be distinguishable from a genuinely unrecognized value.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: absent stopReason is treated as a truncated stream (aborted)", () => {
	// No stopReason key at all.
	const noField = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "cut off" }],
		},
	});
	const outcome = deriveOutcome(
		parseSessionText([user("go"), noField].join("\n")),
	);
	assert.equal(outcome.status, "aborted");
	assert.match(outcome.reason ?? "", /no stopReason/);
});

test("regression: an UNRECOGNIZED stopReason is still reported as failed", () => {
	const weird = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "?" }],
			stopReason: "something-new",
		},
	});
	const outcome = deriveOutcome(
		parseSessionText([user("go"), weird].join("\n")),
	);
	assert.equal(outcome.status, "failed");
	assert.match(outcome.reason ?? "", /unknown stopReason: something-new/);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 3 (review: rev-tests): collect() blocked for the FULL timeout when the turn
// had already finished, because no NEW message ever appeared. With the default
// 900s timeout this made every post-completion collect hang for 15 minutes.
// The harness's fake sleep masked it (it advanced the clock without waiting).
// ─────────────────────────────────────────────────────────────────────────────

test("regression: collect() returns immediately when the turn already finished", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-settled-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		// REAL sleep + REAL clock: the bug only manifests without a fake clock.
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
		});

		const handle = await orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("go"),
				assistantMsg({ stopReason: "stop", text: "done" }),
			].join("\n") + "\n",
		);

		const started = Date.now();
		const result = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		const elapsed = Date.now() - started;

		assert.equal(result.execution.status, "success");
		// The fast path must not wait on the timeout.
		assert.ok(
			elapsed < 1_000,
			`collect took ${elapsed}ms; expected the already-settled fast path`,
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("isLastTurnComplete distinguishes settled, mid-tool, and unanswered turns", () => {
	const settled = parseSessionText(
		[user("go"), assistantMsg({ stopReason: "stop", text: "x" })].join("\n"),
	);
	assert.equal(isLastTurnComplete(settled), true);

	const midTool = parseSessionText(
		[user("go"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] })].join(
			"\n",
		),
	);
	assert.equal(
		isLastTurnComplete(midTool),
		false,
		"a trailing toolUse means still working",
	);

	const unanswered = parseSessionText(user("go"));
	assert.equal(isLastTurnComplete(unanswered), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 4 (review: rev-simplicity): index.ts wrote a hardcoded placeholder string as
// the child's owner token. Because the placeholder was truthy, RunStore kept it
// verbatim, so every persisted child shared the same zero-entropy token —
// defeating the ownership audit. The fix routes the orchestrator's authoritative
// record through Handle.child.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: the persisted child carries a real, unique ownerToken", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-token-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const store = new RunStore({ rootDir: runDir });
		const run = store.createRun({ task: "t", cwd: "/tmp" });

		const a = await orchestrator.launch({
			agent: agent({ name: "a" }),
			task: "t",
		});
		await store.addChild(run.runId, a.child);
		const b = await orchestrator.launch({
			agent: agent({ name: "b" }),
			task: "t",
		});
		await store.addChild(run.runId, b.child);

		const persisted = store.readRun(run.runId);
		assert.ok(persisted);
		const tokens = persisted.children.map((c) => c.ownerToken);

		assert.equal(tokens.length, 2);
		assert.ok(
			tokens.every((t) => t !== "pending"),
			`ownerToken must not be the placeholder value, got ${JSON.stringify(tokens)}`,
		);
		assert.ok(
			tokens.every((t) => t.length > 0),
			"ownerToken must be present",
		);
		assert.notEqual(tokens[0], tokens[1], "ownerTokens must be unique per child");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 5 (review: rev-tests): the F19 race was only ever tested with a SINGLE
// concurrent start. The design measured 2/6 failures without retry (exp7-H1) and
// 6/6 success with retry (exp8-A), so the multi-child scramble must be pinned.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: concurrent launches all succeed against a busy-pane window (F19/F20)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-concurrent-"));
	try {
		const fake = new FakeHerdr({ paneBusyMs: 200 });
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			// Advance the fake clock so the busy window expires deterministically.
			sleep: async (ms) => fake.advance(ms),
		});

		const handles = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				orchestrator.launch({ agent: agent({ name: `w${i}` }), task: "t" }),
			),
		);

		assert.equal(handles.length, 5);
		const names = new Set(handles.map((h) => h.name));
		assert.equal(
			names.size,
			5,
			`expected 5 distinct names, got ${[...names].join(", ")}`,
		);
		assert.equal(fake.agents.size, 5, "all five agents must be live");

		// Every launch must have retried past the busy window at least once.
		const attempts = fake.commands.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		).length;
		assert.ok(
			attempts > 5,
			`expected retries beyond one attempt each, got ${attempts} attempts`,
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 6 (review: rev-simplicity): launch() ignored the agent's own configured
// model, so a caller that omitted `model` silently lost the frontmatter setting.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: launch() falls back to the agent's configured model", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-model-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		// No explicit model: the frontmatter value must reach the child argv.
		const handle = await orchestrator.launch({
			agent: agent({ model: "cb/glm-5.3-flash", thinking: "medium" }),
			task: "t",
		});
		assert.equal(
			handle.child.model,
			undefined,
			"child.model records only an explicit override",
		);

		const start = fake.commands.find(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		);
		assert.ok(start, "agent start must have been invoked");
		const argv = start.args.join(" ");
		assert.match(
			argv,
			/cb\/glm-5\.3-flash/,
			`expected the frontmatter model in argv, got: ${argv}`,
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 7 (review: rev-simplicity M2 / self-review O1): the lineage tree was
// defined and sanitized but never wired — no env propagation, no depth check,
// so nesting was unbounded and the "prevent cycles / bound depth" property was
// decorative. These tests pin the wiring.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: launch propagates lineage and depth to the child pane", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-lineage-"));
	const saved = process.env.HERDR_PANE_ID;
	// Inside a herdr pane, so the split path is taken (the original case).
	process.env.HERDR_PANE_ID = "w1:p1";
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		await orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t",
		});
		// Same type joins the type tab: the first child takes the root pane,
		// the second splits, and lineage env is set on that split.
		await orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t2",
		});

		const split = fake.commands.find(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		assert.ok(split, "a pane split must have happened");
		const argv = split.args.join(" ");

		assert.match(
			argv,
			/PI_SUBAGENT_PARENT_PATH=/,
			"lineage env must be passed to the child pane",
		);
		assert.match(argv, /PI_SUBAGENT_CHILD=1/, "the child marker must be set");
		assert.match(
			argv,
			/PI_SUBAGENT_MAX_DEPTH=/,
			"the depth ceiling must be passed down",
		);
	} finally {
		if (saved === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: lineage also survives the new-tab fallback", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-lineage-tab-"));
	const saved = process.env.HERDR_PANE_ID;
	// No current pane, so the launch falls back to a new tab.
	delete process.env.HERDR_PANE_ID;
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		await orchestrator.launch({ agent: agent(), task: "t" });

		const tab = fake.commands.find(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.ok(tab, "a tab must have been created");
		const argv = tab.args.join(" ");

		assert.match(
			argv,
			/PI_SUBAGENT_PARENT_PATH=/,
			"lineage env must reach the tab's root pane too",
		);
		assert.match(argv, /PI_SUBAGENT_CHILD=1/, "the child marker must be set");
		assert.match(
			argv,
			/PI_SUBAGENT_MAX_DEPTH=/,
			"the depth ceiling must be passed down",
		);
	} finally {
		if (saved !== undefined) process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: nesting beyond maxDepth is refused", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-depth-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		// Simulate a process that is already at the ceiling.
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
			parentPath: [{ runId: "r-root", agent: "orchestrator" }],
			maxDepth: 1,
		});

		assert.equal(orchestrator.depth, 1);
		await assert.rejects(
			() => orchestrator.launch({ agent: agent(), task: "t" }),
			/nesting limit reached/,
		);
		// The refusal must not leak a pane.
		assert.equal(
			fake.panes.size,
			1,
			"only the pre-existing root pane should remain",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: childPath appends this run to the inherited lineage", () => {
	const orchestrator = new Orchestrator({
		client: createHerdrClient(createFakeRunner(new FakeHerdr())),
		runDir: "/tmp/runs/r-child",
		cwd: "/tmp",
		parentPath: [{ runId: "r-root", agent: "orchestrator" }],
	});
	const p = orchestrator.childPath("reviewer");
	assert.equal(p.length, 2);
	assert.equal(p[0]?.runId, "r-root");
	assert.equal(p[1]?.runId, "r-child");
	assert.equal(p[1]?.agent, "reviewer");
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 8 (review: rev-simplicity M2): maxSubagentSpawnsPerSession was parsed from
// settings but never enforced — ErrorCodes.BUDGET_EXCEEDED existed and was never
// thrown, so a runaway fan-out was unbounded.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: the spawn budget is enforced and reports remaining", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-budget-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
			maxSpawns: 2,
		});

		assert.deepEqual(orchestrator.budget(), {
			used: 0,
			limit: 2,
			remaining: 2,
		});

		await orchestrator.launch({ agent: agent({ name: "a" }), task: "t" });
		await orchestrator.launch({ agent: agent({ name: "b" }), task: "t" });
		assert.deepEqual(orchestrator.budget(), {
			used: 2,
			limit: 2,
			remaining: 0,
		});

		// The third launch must be refused BEFORE creating any resource.
		const panesBefore = fake.panes.size;
		await assert.rejects(
			() => orchestrator.launch({ agent: agent({ name: "c" }), task: "t" }),
			/spawn budget exhausted/,
		);
		assert.equal(
			fake.panes.size,
			panesBefore,
			"a refused launch must not create a pane",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: an unlimited budget reports null remaining", () => {
	const orchestrator = new Orchestrator({
		client: createHerdrClient(createFakeRunner(new FakeHerdr())),
		runDir: "/tmp/runs/r-x",
		cwd: "/tmp",
	});
	assert.deepEqual(orchestrator.budget(), {
		used: 0,
		limit: null,
		remaining: null,
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 9 (found in production): herdr's agent-name namespace is GLOBAL, shared by
// every session. A concurrent session holding `orchestrator`/`reviewer-0` made
// our launch fail outright, because allocateName only consulted our own children
// and startWithRetry treated NAME_TAKEN as fatal.
//
// Observed live: another session ran `herdr agent rename w9:p1 orchestrator`
// and got "agent name orchestrator is already used; pane_id=w7:p1" (our pane).
// ─────────────────────────────────────────────────────────────────────────────

test("regression: a name held by an unrelated live agent is avoided up front", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-globalname-"));
	try {
		const fake = new FakeHerdr();
		const root = fake.addRootPane("w1");
		// A foreign agent (another session) already holds the name we want.
		fake.addAgent("reviewer-0", root, "pi");

		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const handle = await orchestrator.launch({
			agent: agent({ name: "reviewer" }),
			task: "t",
		});

		assert.notEqual(
			handle.name,
			"reviewer-0",
			"must not collide with the foreign agent",
		);
		assert.match(handle.name, /^[a-z][a-z0-9_-]{0,31}$/);
		// No failed attempt should have been needed: we saw the name up front.
		const attempts = fake.commands.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		).length;
		assert.equal(attempts, 1, `expected a single start attempt, got ${attempts}`);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: a name claimed between check and start is retried, not fatal", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-race-name-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");

		// Claim the name AFTER the orchestrator's up-front check would have run,
		// simulating a true race with another session.
		const originalExec = fake.exec.bind(fake);
		let grabbed = false;
		fake.exec = (args: string[]) => {
			if (!grabbed && args[0] === "agent" && args[1] === "start") {
				grabbed = true;
				const paneId = args[args.indexOf("--pane") + 1];
				const wanted = args[2];
				if (paneId && wanted) fake.addAgent(wanted, paneId, "pi");
			}
			return originalExec(args);
		};

		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const handle = await orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t",
		});

		// The launch must succeed under a different name rather than throwing.
		assert.ok(handle.name);
		assert.equal(
			fake.agents.has(handle.name),
			true,
			"the agent must be live under the final name",
		);
		const attempts = fake.commands.filter(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		).length;
		assert.ok(
			attempts >= 2,
			`expected a retry after the collision, got ${attempts} attempt(s)`,
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: the session file follows a mid-launch rename", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-rename-session-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");

		const originalExec = fake.exec.bind(fake);
		let grabbed = false;
		fake.exec = (args: string[]) => {
			if (!grabbed && args[0] === "agent" && args[1] === "start") {
				grabbed = true;
				const paneId = args[args.indexOf("--pane") + 1];
				const wanted = args[2];
				if (paneId && wanted) fake.addAgent(wanted, paneId, "pi");
			}
			return originalExec(args);
		};

		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const handle = await orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t",
		});

		// The resume credential must point at a file that actually exists.
		assert.ok(
			existsSync(handle.sessionFile),
			`session file must exist after a rename: ${handle.sessionFile}`,
		);
		assert.match(
			path.basename(handle.sessionFile),
			new RegExp(`^${handle.name}\\.jsonl$`),
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 10 (found by running the plugin in a container): `pane split --current`
// needs HERDR_PANE_ID. Outside a herdr pane (headless pi, a script, CI) the
// variable is unset and the DEFAULT placement failed outright with
// "--current requires HERDR_PANE_ID", making the tool unusable there.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: split placement falls back to a new tab without HERDR_PANE_ID", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-placement-"));
	const saved = process.env.HERDR_PANE_ID;
	delete process.env.HERDR_PANE_ID;
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		// The agent asks for a split, but there is no current pane.
		const handle = await orchestrator.launch({
			agent: agent({ name: "worker", placement: "split-down" }),
			task: "t",
		});

		const split = fake.commands.filter(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		const tabs = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.equal(
			split.length,
			0,
			"must not attempt a split without a current pane",
		);
		assert.equal(tabs.length, 1, "must create a tab instead");
		assert.ok(handle.paneId, "a pane must still be assigned");
	} finally {
		if (saved !== undefined) process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: split placement is honoured when HERDR_PANE_ID is present", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-placement-on-"));
	const saved = process.env.HERDR_PANE_ID;
	process.env.HERDR_PANE_ID = "w1:p1";
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		// Two children of the SAME type: the first takes the type tab's root
		// pane; the second tiles to the right (3-column grid).
		await orchestrator.launch({ agent: agent({ name: "worker" }), task: "t" });
		await orchestrator.launch({
			agent: agent({ name: "worker" }),
			task: "t",
		});

		const split = fake.commands.filter(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		assert.equal(split.length, 1, "the second child must be split in");
		assert.ok(
			split[0]?.args.includes("right"),
			"the second pane tiles to the right of the first",
		);
		// The split targets the run tab's ROOT pane by explicit id rather than
		// `--current`: that is what keeps the pane inside the task tab and works
		// with no HERDR_PANE_ID at all.
		const target =
			split[0]?.args.includes("--pane") === true
				? split[0]?.args[split[0].args.indexOf("--pane") + 1]
				: split[0]?.args.find((a) => /^w\d+:p\d+$/.test(a));
		assert.ok(target, "the split must name its target pane");
		assert.ok(
			!split[0]?.args.includes("--current"),
			"--current must not be used: it needs HERDR_PANE_ID",
		);
	} finally {
		if (saved === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: same-type panes tile as a 3-column grid, not a vertical stack", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-tile-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		for (let i = 0; i < 4; i += 1) {
			await orchestrator.launch({
				agent: agent({ name: "scout" }),
				task: "t",
			});
		}

		const splits = fake.commands.filter(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		assert.equal(splits.length, 3, "first child occupies the root; next three split");
		const directions = splits.map((c) => {
			const idx = c.args.indexOf("--direction");
			return idx >= 0 ? c.args[idx + 1] : undefined;
		});
		assert.deepEqual(
			directions,
			["right", "right", "down"],
			"3-column grid: [A|B|C] then wrap down",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: retiring the last child of a type closes the type tab", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-autotabclose-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const first = await orchestrator.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const second = await orchestrator.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const tabId = first.child.tabId;
		assert.ok(tabId);

		await orchestrator.retire(first.name);
		const closesAfterFirst = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "close",
		);
		assert.equal(
			closesAfterFirst.length,
			0,
			"a still-running sibling must keep the type tab",
		);

		await orchestrator.retire(second.name);
		const closes = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "close",
		);
		assert.equal(closes.length, 1, "the empty type tab must be closed");
		assert.equal(closes[0]?.args[2], tabId);
		assert.equal(fake.tabs.has(tabId), false);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: an explicit new-tab placement never splits", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-placement-tab-"));
	const saved = process.env.HERDR_PANE_ID;
	process.env.HERDR_PANE_ID = "w1:p1";
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		await orchestrator.launch({
			agent: agent({ name: "worker", placement: "new-tab" }),
			task: "t",
		});

		const split = fake.commands.filter(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		assert.equal(split.length, 0, "new-tab must not split");
	} finally {
		if (saved === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 11 (found by installing the plugin read-only in a container): a run root
// that cannot be written produced an opaque deep ENOENT
//   "ENOENT: no such file or directory, mkdir '/plugin/.pi-subagents/runs/r-...'"
// with no hint about what to do. Now it fails fast with an actionable message.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: an unwritable run root fails with an actionable error", async () => {
	// A path UNDER a regular file can never be a directory, so mkdir fails
	// deterministically regardless of the user we run as (root bypasses modes).
	const blocker = mkdtempSync(path.join(tmpdir(), "regress-unwritable-"));
	const fileAsDir = path.join(blocker, "not-a-dir");
	writeFileSync(fileAsDir, "x");
	const runDir = path.join(fileAsDir, "nested");
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		await assert.rejects(
			() => orchestrator.launch({ agent: agent(), task: "t" }),
			(err: unknown) => {
				const msg = String(err instanceof Error ? err.message : err);
				assert.match(msg, /cannot write run artifacts/i);
				assert.match(msg, /writable/i, "must say what to do about it");
				assert.match(
					msg,
					new RegExp(fileAsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				);
				return true;
			},
		);
	} finally {
		rmSync(blocker, { recursive: true, force: true });
	}
});

test("regression: a writable run root is unaffected", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-writable-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });
		assert.ok(handle.name);
		assert.ok(existsSync(handle.sessionFile));
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 15: `acceptance.criteria` was parsed and then silently dropped. An agent
// declaring `must: "tests pass"` got no checklist back, so a caller could not
// tell that nothing had verified it. An agent asserting success is exactly the
// signal that cannot be trusted (F32), so the criteria must reach the caller.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: declared acceptance criteria reach the caller as a checklist", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-criteria-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const withCriteria = agent({
			name: "audited",
			acceptance: {
				level: "attested",
				criteria: [
					{ id: "tests-pass", must: "the suite is green", severity: "required" },
					{ id: "no-secrets", must: "no keys in the diff", severity: "optional" },
				],
			},
		});

		const handle = await orchestrator.launch({ agent: withCriteria, task: "t" });
		assert.equal(
			handle.child.pendingCriteria?.length,
			2,
			"criteria must be snapshotted onto the child at launch",
		);

		// The child answers with a passing verdict.
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("t"),
				assistantMsg({
					stopReason: "stop",
					text: '{"ok": true, "reason": "looks good"}',
				}),
			].join("\n"),
		);

		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.acceptance.status, "accepted");
		// The self-report is only ATTESTED — never silently promoted to verified.
		assert.equal(
			collected.acceptance.level,
			"attested",
			"an agent's own verdict cannot upgrade the level to verified",
		);
		assert.deepEqual(
			collected.acceptance.pendingCriteria?.map((c) => c.id),
			["tests-pass", "no-secrets"],
			"the caller must receive the criteria it still has to confirm",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: an agent without criteria reports none", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-nocriteria-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("t"),
				assistantMsg({ stopReason: "stop", text: "done" }),
			].join("\n"),
		);
		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.acceptance.pendingCriteria, undefined);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// F38 (found by exercising the installed plugin end-to-end): herdr refuses an
// argv element containing a control character — `agent start` fails with
// `invalid_agent_argument` ("cannot be encoded safely for the target shell").
// Nearly every real task card is multi-line, so passing the task as one argv
// element made the common case unlaunchable. The task is now ALWAYS written to
// a file and referenced with `@path`.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: a multi-line task never lands in argv (F38)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-multiline-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const task = "line one\nline two\ttabbed\nline three";
		await orchestrator.launch({ agent: agent(), task });

		const start = fake.commands.find(
			(c) => c.args[0] === "agent" && c.args[1] === "start",
		);
		assert.ok(start, "agent start must have been invoked");

		// No argv element may contain a control character, or herdr rejects the
		// launch outright.
		for (const arg of start.args) {
			assert.doesNotMatch(
				arg,
				/[\n\r\t]/,
				`control character leaked into argv: ${JSON.stringify(arg)}`,
			);
		}

		// The task must still reach the child — by file reference. (The temp file
		// itself is removed when `launch` returns, so its CONTENT is asserted by
		// the `buildPiArgs` unit test; here the transport is what matters.)
		const taskArg = start.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg, "the task must be passed as an @file reference");
		assert.match(
			taskArg,
			/task\.md$/,
			"the reference must point at the task file",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Same agent type = one tab, each child a pane. Two scouts (even two tool
// calls / two Orchestrators) must share a tab; scout + reviewer may differ.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: same-type children share one tab as panes", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-runtab-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const first = await orchestrator.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const second = await orchestrator.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});

		const tabCreates = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.equal(tabCreates.length, 1, "one type must create exactly one tab");

		const tabId = orchestrator.tabId;
		assert.ok(tabId, "the type tab must exist");
		assert.equal(first.child.tabId, tabId, "child 1 belongs to the type tab");
		assert.equal(second.child.tabId, tabId, "child 2 belongs to the type tab");

		const panes = [...fake.panes.values()].filter((p) => p.tab_id === tabId);
		assert.equal(panes.length, 2, "both children are panes of the type tab");

		const split = fake.commands.find(
			(c) => c.args[0] === "pane" && c.args[1] === "split",
		);
		assert.ok(split, "the second child must be split into the tab");
		assert.ok(
			!split.args.includes("--current"),
			"--current must not be used: it requires HERDR_PANE_ID",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: different agent types get different tabs", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-typetabs-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		const scout = await orchestrator.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const reviewer = await orchestrator.launch({
			agent: agent({ name: "reviewer" }),
			task: "t",
		});

		const tabCreates = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.equal(tabCreates.length, 2, "each type gets its own tab");
		assert.notEqual(scout.child.tabId, reviewer.child.tabId);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: a run tab is created even outside a herdr pane (headless)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-runtab-headless-"));
	const saved = process.env.HERDR_PANE_ID;
	delete process.env.HERDR_PANE_ID;
	try {
		const fake = new FakeHerdr();
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});

		// No ambient pane exists at all: the old `--current` split failed here.
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });
		assert.ok(handle.paneId, "the child must still get a pane");
		assert.ok(orchestrator.tabId, "the run tab must exist without a pane");
	} finally {
		if (saved !== undefined) process.env.HERDR_PANE_ID = saved;
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-type grouping must hold ACROSS tool calls (each call is a fresh
// Orchestrator). Re-adopt by herdr tab label after the in-memory registry is
// gone; racing launches share a SessionLayout so they cannot both tabCreate.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: a later launch of the same type joins the existing type tab", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-tabreuse-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");

		const first = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const a = await first.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const tabId = first.tabId;
		assert.ok(tabId, "the first launch must create the type tab");

		const later = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const b = await later.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});

		assert.equal(b.child.tabId, tabId, "the later scout must join the scout tab");
		const tabCreates = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.equal(tabCreates.length, 1, "only ONE tab may exist for the type");
		assert.notEqual(a.paneId, b.paneId, "each child still gets its own pane");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: a recycled type tab is replaced, not reused", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-tabstale-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const client = createHerdrClient(createFakeRunner(fake));

		const first = new Orchestrator({
			client,
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await first.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});
		const stale = handle.child.tabId;
		assert.ok(stale);
		await client.tabClose(stale);

		const later = new Orchestrator({
			client,
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const next = await later.launch({
			agent: agent({ name: "scout" }),
			task: "t",
		});

		assert.ok(next.paneId, "the launch must still succeed");
		assert.notEqual(next.child.tabId, stale, "a closed type tab must not be reused");
		assert.ok(later.tabId, "a fresh type tab must have been created");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: parallel same-type launches share one tab (two tool calls)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-parallel-type-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const layout = createSessionLayout();
		const client = createHerdrClient(createFakeRunner(fake));

		const left = new Orchestrator({
			client,
			runDir,
			cwd: "/tmp",
			layout,
			sleep: async (ms) => fake.advance(ms),
		});
		const right = new Orchestrator({
			client,
			runDir,
			cwd: "/tmp",
			layout,
			sleep: async (ms) => fake.advance(ms),
		});

		const [a, b] = await Promise.all([
			left.launch({ agent: agent({ name: "scout" }), task: "t" }),
			right.launch({ agent: agent({ name: "scout" }), task: "t" }),
		]);

		const tabCreates = fake.commands.filter(
			(c) => c.args[0] === "tab" && c.args[1] === "create",
		);
		assert.equal(tabCreates.length, 1, "racing scouts must not each create a tab");
		assert.equal(a.child.tabId, b.child.tabId, "both scouts share the type tab");
		assert.notEqual(a.paneId, b.paneId, "each scout still gets its own pane");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// F39 (reported by an adversarial reviewer, then reproduced): the acceptance
// verdict was derived from `parsed.output`, which is the last non-empty text
// ANYWHERE in the session. A turn that ended without text (a tool call, or a
// mid-turn kill) left an EARLIER turn's "ok" in place, so a run could report
// `execution: aborted` together with `acceptance: accepted/attested`.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: an aborted turn must not inherit the previous turn's verdict (F39)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-f39-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });

		// Turn 1 succeeds with a verdict; turn 2 is killed mid-tool with no text.
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("do the thing"),
				assistantMsg({
					stopReason: "stop",
					text: '{"ok": true, "reason": "turn 1 all good"}',
				}),
				user("now do more"),
				assistantMsg({ stopReason: "toolUse", text: "" }),
			].join("\n"),
		);
		// A kill is what makes this an abort rather than "still running": with the
		// agent alive, `resolveExecution` correctly reports `running` (F29).
		fake.agents.delete(handle.name);

		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});

		assert.equal(collected.execution.status, "aborted");
		assert.notEqual(
			collected.acceptance.status,
			"accepted",
			"an aborted turn must never report the previous turn's acceptance",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: a hard-killed turn must not inherit the previous verdict either (F39)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-f39b-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });

		// Turn 1 has a verdict; turn 2 got NO assistant message at all.
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("do the thing"),
				assistantMsg({
					stopReason: "stop",
					text: '{"ok": true, "reason": "turn 1 all good"}',
				}),
				user("now do more"),
			].join("\n"),
		);
		fake.agents.delete(handle.name);

		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});

		assert.equal(collected.execution.status, "aborted");
		assert.notEqual(
			collected.acceptance.status,
			"accepted",
			"a killed turn must never report the previous turn's acceptance",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("regression: a LATER turn's rejection must override an earlier acceptance (F39)", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "regress-f39c-"));
	try {
		const fake = new FakeHerdr();
		fake.addRootPane("w1");
		const orchestrator = new Orchestrator({
			client: createHerdrClient(createFakeRunner(fake)),
			runDir,
			cwd: "/tmp",
			sleep: async (ms) => fake.advance(ms),
		});
		const handle = await orchestrator.launch({ agent: agent(), task: "t" });

		// The converse leak: turn 1 accepted, turn 2 REJECTS. Reading a stale
		// earlier verdict would hide the rejection.
		writeFileSync(
			handle.sessionFile,
			[
				sessionHeader(),
				user("do the thing"),
				assistantMsg({
					stopReason: "stop",
					text: '{"ok": true, "reason": "turn 1 fine"}',
				}),
				user("retry"),
				assistantMsg({
					stopReason: "stop",
					text: '{"ok": false, "reason": "turn 2 rejected"}',
				}),
			].join("\n"),
		);

		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 5_000,
		});
		assert.equal(collected.execution.status, "success");
		assert.equal(
			collected.acceptance.status,
			"rejected",
			"the LAST turn's verdict must win",
		);
		assert.match(String(collected.acceptance.reason), /turn 2 rejected/);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});
