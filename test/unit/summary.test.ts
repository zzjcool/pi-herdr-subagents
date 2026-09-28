import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	aggregateSubagentRuns,
	formatCost,
	formatDuration,
	formatSubagentDetail,
	formatSubagentSummary,
	formatTokens,
	registerSummaryCommand,
} from "../../src/extension/summary.ts";
import { parseSessionFile } from "../../src/shared/session.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord, RunRecord, Usage } from "../../src/shared/types.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";

function sessionText(usage: Usage, turns = 1, toolErrors = 0): string {
	const lines = [sessionHeader(), modelChange("cb/test-model")];
	for (let i = 0; i < turns; i += 1) {
		lines.push(userMsg(`turn ${i + 1}`));
		if (i === 0) {
			for (let error = 0; error < toolErrors; error += 1) {
				lines.push(assistantMsg({ stopReason: "toolUse", tools: ["bash"] }));
				lines.push(toolResult({ isError: true }));
			}
		}
		lines.push(
			assistantMsg({
				stopReason: "stop",
				text: "done",
				model: "cb/test-model",
				usage: {
					input: turns === 1 ? usage.input : usage.input / turns,
					output: turns === 1 ? usage.output : usage.output / turns,
					cacheRead: turns === 1 ? usage.cacheRead : usage.cacheRead / turns,
					cacheWrite: turns === 1 ? usage.cacheWrite : usage.cacheWrite / turns,
					cost: { total: turns === 1 ? usage.cost : usage.cost / turns },
				},
			}),
		);
	}
	return lines.join("\n");
}

function child(
	rootDir: string,
	name: string,
	spawnedAt: string,
	overrides: Partial<ChildRecord> = {},
): ChildRecord {
	return {
		name,
		paneId: "w1:p1",
		sessionFile: path.join(rootDir, `${name}.jsonl`),
		ownerToken: `token-${name}`,
		state: "retired",
		spawnedAt,
		...overrides,
	};
}

function tempRoot(): string {
	return mkdtempSync(path.join(os.tmpdir(), "summary-"));
}

test("formatters follow the compact summary conventions", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1K");
	assert.equal(formatTokens(50_000), "50K");
	assert.equal(formatTokens(651_000), "651K");
	assert.equal(formatTokens(1_200_000), "1.2M");
	assert.equal(formatTokens(null), "—");
	assert.equal(formatCost(0.003), "$0.003");
	assert.equal(formatCost(0.53), "$0.53");
	assert.equal(formatCost(null), "—");
	assert.equal(formatDuration(42_000), "42s");
	assert.equal(formatDuration(4 * 60_000 + 48_000), "4m48s");
	assert.equal(formatDuration(65 * 60_000), "1h05m");
});

test("aggregateSubagentRuns groups by agent, prefers execution snapshots, and falls back to jsonl", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const now = Date.parse("2026-01-01T04:20:00.000Z");
		const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents"), now: () => now });
		const run = store.createRun({
			task: "summary fixture",
			cwd,
			herdr: { parentPaneId: "w1:p0" },
		});
		const reviewer0 = child(
			root,
			"reviewer-0",
			"2026-01-01T04:00:00.000Z",
			{
				sessionFile: path.join(root, "reviewer-0.jsonl"),
				execution: {
					status: "success",
					turns: 6,
					usage: {
						input: 50_000,
						output: 12_000,
						cacheRead: 651_000,
						cacheWrite: 0,
						cost: 0.53,
					},
				},
				retiredAt: "2026-01-01T04:09:36.000Z",
			},
		);
		const reviewer1 = child(
			root,
			"reviewer-1",
			"2026-01-01T04:01:00.000Z",
			{
				sessionFile: path.join(root, "reviewer-1.jsonl"),
				// The terminal status exists, but usage and turns are absent; the
				// session file supplies those fields.
				execution: { status: "success" },
				retiredAt: "2026-01-01T04:04:00.000Z",
			},
		);
		const worker0 = child(
			root,
			"worker-0",
			"2026-01-01T04:08:00.000Z",
			{
				agent: "worker",
				state: "working",
				paneId: "w1:p2",
				sessionFile: path.join(root, "worker-0.jsonl"),
			},
		);
		for (const entry of [reviewer0, reviewer1, worker0]) {
			writeFileSync(entry.sessionFile, sessionText({ input: 9_400, output: 2_100, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 3));
			await store.addChild(run.runId, entry);
		}
		writeFileSync(
			reviewer0.sessionFile,
			sessionText({ input: 1, output: 1, cacheRead: 1, cacheWrite: 0, cost: 0.001 }),
		);
		writeFileSync(
			reviewer1.sessionFile,
			sessionText({ input: 1_000, output: 2_000, cacheRead: 3_000, cacheWrite: 0, cost: 0.02 }, 2),
		);
		writeFileSync(
			worker0.sessionFile,
			sessionText({ input: 9_400, output: 2_100, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 3),
		);
		const runs = store.listRuns();
		const sessions = new Map(
			runs.flatMap((record) =>
				record.children.map((entry) => [entry.sessionFile, parseSessionFile(entry.sessionFile)] as const),
			),
		);
		const summary = aggregateSubagentRuns(runs, { now, sessions });
		assert.equal(summary.runCount, 1);
		assert.equal(summary.childCount, 3);
		assert.deepEqual(summary.groups.map((group) => [group.role, group.count]), [
			["reviewer", 2],
			["worker", 1],
		]);
		const reviewer = summary.groups[0];
		assert.ok(reviewer);
		assert.equal(reviewer.turns, 8, "execution turns take precedence for reviewer-0");
		assert.equal(reviewer.usage?.input, 51_000);
		assert.equal(reviewer.usage?.output, 14_000);
		assert.equal(reviewer.usage?.cacheRead, 654_000);
		assert.equal(reviewer.outcomes.success, 2);
		const worker = summary.groups[1];
		assert.ok(worker);
		assert.equal(worker.turns, 3);
		assert.equal(worker.children[0]?.running, true);
		assert.equal(worker.live, true);
		assert.equal(worker.runningDurationMs, 12 * 60_000);
		assert.equal(summary.totals.outcomes.running, 1);
		assert.equal(summary.totals.totalDurationMs, 9 * 60_000 + 36_000 + 12 * 60_000 + 3 * 60_000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-pi zero session usage is unavailable, and awaiting execution counts as both outcome and running", async () => {
	const root = tempRoot();
	try {
		const cwd = path.join(root, "project");
		const now = Date.parse("2026-01-01T05:00:00.000Z");
		const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents"), now: () => now });
		const run = store.createRun({ task: "non-pi fixture", cwd });
		const cursor = child(root, "reviewer-0", "2026-01-01T04:59:00.000Z", {
			kind: "cursor",
			agent: "reviewer",
			sessionFile: path.join(root, "cursor.jsonl"),
		});
		const awaiting = child(root, "worker-0", "2026-01-01T04:58:00.000Z", {
			kind: "pi",
			agent: "worker",
			state: "awaiting",
			paneId: "w1:p3",
			sessionFile: path.join(root, "awaiting.jsonl"),
			execution: {
				status: "success",
				turns: 4,
				usage: { input: 4_000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
			},
		});
		writeFileSync(cursor.sessionFile, sessionText({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }));
		writeFileSync(awaiting.sessionFile, "");
		await store.addChild(run.runId, cursor);
		await store.addChild(run.runId, awaiting);
		const runs = store.listRuns();
		const sessions = new Map(
			runs.flatMap((record) =>
				record.children.map((entry) => [entry.sessionFile, parseSessionFile(entry.sessionFile)] as const),
			),
		);
		const summary = aggregateSubagentRuns(runs, { now, sessions });
		const cursorGroup = summary.groups.find((group) => group.role === "reviewer");
		assert.ok(cursorGroup);
		assert.equal(cursorGroup.usage, null);
		assert.equal(summary.totals.usage?.input, 4_000);
		const workerGroup = summary.groups.find((group) => group.role === "worker");
		assert.ok(workerGroup);
		assert.equal(workerGroup.outcomes.success, 1);
		assert.equal(workerGroup.outcomes.running, 1);
		assert.match(formatSubagentSummary(summary), /success, running 2m/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("formatSubagentSummary renders the fixed seven-column table and empty state", () => {
	const empty = formatSubagentSummary([], { cwd: "/tmp/project", parentPaneId: "w8:p1" });
	assert.equal(
		empty,
		"No subagent runs under this session (parent pane w8:p1).\nLaunch children with the subagent tool to see them here.",
	);
	const noPane = formatSubagentSummary([], { cwd: "/tmp/project" });
	assert.match(noPane, /^No subagent runs under \/tmp\/project\./);
});

test("formatSubagentDetail includes available fields and omits missing pane/tab/worktree data", () => {
	const run: RunRecord = {
		schemaVersion: 1,
		runId: "r-detail",
		task: "detail",
		cwd: "/tmp/project",
		herdr: {},
		path: [],
		depth: 0,
		maxDepth: 1,
		children: [],
		budget: { spawned: 1, limit: null, granted: 0 },
		createdAt: "2026-01-01T04:00:00.000Z",
		updatedAt: "2026-01-01T04:30:00.000Z",
	};
	const childRecord = child("/tmp/project", "reviewer-0", "2026-01-01T04:21:53.000Z", {
		agent: "reviewer",
		kind: "pi",
		paneId: null,
		retiredAt: "2026-01-01T04:27:37.000Z",
		model: "cb/kimi-k3",
		thinking: "max",
		execution: {
			status: "success",
			turns: 1,
			toolErrors: 6,
			usage: { input: 34_000, output: 7_600, cacheRead: 525_000, cacheWrite: 0, cost: 0.37 },
		},
		acceptance: { status: "rejected", level: "attested" },
		sessionFile: "/tmp/project/.pi-subagents/runs/r-detail/reviewer-0.jsonl",
	});
	const output = formatSubagentDetail({ run, child: childRecord, cwd: "/tmp/project" });
	assert.match(output, /^reviewer-0 — reviewer \(pi\)/);
	assert.match(output, /state: retired · execution: success · model: cb\/kimi-k3 · thinking: max/);
	assert.match(output, /run: r-detail · pane: \(recycled\)/);
	assert.match(output, /time: \d\d:21:53 → \d\d:27:37 \(5m44s\)/);
	assert.match(output, /usage: 34\.0K in · 7\.6K out · 525K cache · \$0\.37/);
	assert.match(output, /turns: 1 · tool errors: 6 · acceptance: rejected \(attested\)/);
	assert.match(output, /session: \.pi-subagents\/runs\/r-detail\/reviewer-0\.jsonl/);
	assert.doesNotMatch(output, /tab:/);
	assert.doesNotMatch(output, /worktree:/);
});

test("registerSummaryCommand registers completion and emits slash text", async () => {
	const root = tempRoot();
	const oldCwd = process.cwd();
	const oldPane = process.env.HERDR_PANE_ID;
	try {
		const cwd = path.join(root, "project");
		const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
		const run = store.createRun({ task: "command", cwd, herdr: { parentPaneId: "w9:p1" } });
		const entry = child(root, "reviewer-0", new Date(Date.now() - 1000).toISOString(), {
			agent: "reviewer",
			kind: "pi",
			sessionFile: path.join(root, "command.jsonl"),
		});
		writeFileSync(entry.sessionFile, "");
		await store.addChild(run.runId, entry);
		const otherRun = store.createRun({ task: "other parent", cwd, herdr: { parentPaneId: "w9:other" } });
		const otherEntry = child(root, "planner-0", new Date(Date.now() - 1000).toISOString(), {
			agent: "planner",
			kind: "pi",
			sessionFile: path.join(root, "other.jsonl"),
		});
		writeFileSync(otherEntry.sessionFile, "");
		await store.addChild(otherRun.runId, otherEntry);
		const commands = new Map<string, any>();
		const messages: string[] = [];
		const fakePi = {
			registerCommand(name: string, options: unknown) {
				commands.set(name, options);
			},
			sendMessage(message: { content: string }) {
				messages.push(message.content);
			},
		} as any;
		registerSummaryCommand(fakePi);
		const command = commands.get("subagents-summary");
		assert.ok(command);
		process.env.HERDR_PANE_ID = "w9:p1";
		await command.handler("", { cwd, ui: { notify() {} } });
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /Subagents session summary/);
		assert.match(messages[0] ?? "", /1 children/);
		assert.doesNotMatch(messages[0] ?? "", /planner/);
		await command.handler("--all", { cwd, ui: { notify() {} } });
		assert.match(messages[1] ?? "", /2 children/);
		assert.match(messages[1] ?? "", /planner/);
		// The handler establishes the current cwd used by completion lookup.
		const completions = await command.getArgumentCompletions("rev");
		assert.deepEqual(completions, [{ value: "reviewer-0", label: "reviewer-0" }]);
		const allCompletions = await command.getArgumentCompletions("--all p");
		assert.deepEqual(allCompletions, [{ value: "--all planner-0", label: "planner-0" }]);
	} finally {
		process.chdir(oldCwd);
		if (oldPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = oldPane;
		rmSync(root, { recursive: true, force: true });
	}
});
