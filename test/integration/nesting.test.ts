import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import {
	DEFAULT_LEGION_SETTINGS,
	ErrorCodes,
	SubagentError,
	type AgentConfig,
} from "../../src/shared/types.ts";
import {
	effectiveMaxDepth,
	Orchestrator,
} from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createHerdrClient } from "../../src/herdr/client.ts";
import { FakeHerdr, createFakeRunner } from "../helpers/fake-herdr.ts";

const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";

async function withEnvironment<T>(
	values: Record<string, string | undefined>,
	action: () => Promise<T>,
): Promise<T> {
	const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await action();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function role(name: string, maxSubagentDepth?: number): AgentConfig {
	return {
		name,
		description: name,
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "role prompt",
		source: "user",
		filePath: `/${name}.md`,
		allowNestedSubagents: true,
		...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
	};
}

function launchedChildMaxDepth(fake: FakeHerdr): string | undefined {
	const prefix = `${MAX_DEPTH_ENV}=`;
	for (const command of fake.commands) {
		const entry = command.args.find((arg) => arg.startsWith(prefix));
		if (entry) return entry.slice(prefix.length);
	}
	return undefined;
}

function pathAtDepth(depth: number): Array<{ runId: string; agent: string }> {
	return Array.from({ length: depth }, (_, index) => ({
		runId: `r-level-${index}`,
		agent: `agent-${index}`,
	}));
}

async function spawnChild(
	fake: FakeHerdr,
	input: {
		roleName: string;
		name: string;
		parentDepth: number;
		parentMaxDepth: number;
		roleMaxDepth?: number;
	},
): Promise<{ maxDepth: number; depth: number }> {
	return withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: String(input.parentMaxDepth) },
		async () => {
			const runDir = mkdtempSync(path.join(tmpdir(), "legion-nesting-node-"));
			try {
				const commandStart = fake.commands.length;
				const orchestrator = new Orchestrator({
					client: createHerdrClient(createFakeRunner(fake)),
					runDir,
					cwd: "/tmp",
					parentPath: pathAtDepth(input.parentDepth),
					maxDepth: input.parentMaxDepth,
				});
				await orchestrator.launch({
					agent: role(input.roleName, input.roleMaxDepth),
					task: `launch ${input.name}`,
					name: input.name,
				});
				const prefix = `${MAX_DEPTH_ENV}=`;
				const childCeiling = fake.commands
					.slice(commandStart)
					.flatMap((command) => command.args)
					.find((arg) => arg.startsWith(prefix))
					?.slice(prefix.length);
				assert.ok(childCeiling, "child pane receives a depth ceiling");
				return {
					maxDepth: Number(childCeiling),
					depth: input.parentDepth + 1,
				};
			} finally {
				rmSync(runDir, { recursive: true, force: true });
			}
		},
	);
}

async function assertLaunchRefused(
	fake: FakeHerdr,
	input: {
		roleName: string;
		name: string;
		parentDepth: number;
		parentMaxDepth: number;
	},
): Promise<void> {
	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: String(input.parentMaxDepth) },
		async () => {
			const runDir = mkdtempSync(path.join(tmpdir(), "legion-nesting-refused-"));
			const panesBefore = fake.panes.size;
			try {
				const orchestrator = new Orchestrator({
					client: createHerdrClient(createFakeRunner(fake)),
					runDir,
					cwd: "/tmp",
					parentPath: pathAtDepth(input.parentDepth),
					maxDepth: input.parentMaxDepth,
				});
				await assert.rejects(
					() =>
						orchestrator.launch({
							agent: role(input.roleName),
							task: `refused ${input.name}`,
							name: input.name,
						}),
					(error: unknown) =>
						error instanceof SubagentError &&
						error.code === ErrorCodes.BUDGET_EXCEEDED,
				);
				assert.equal(fake.panes.size, panesBefore, "refusal must not leak a pane");
			} finally {
				rmSync(runDir, { recursive: true, force: true });
			}
		},
	);
}

const isolatedParentEnv = {
	["PI_SUBAGENT_ALLOW_NESTED"]: undefined,
	["PI_SUBAGENT_CHILD"]: undefined,
	[MAX_DEPTH_ENV]: undefined,
	[PARENT_PATH_ENV]: undefined,
	["HERDR_PANE_ID"]: undefined,
	["HERDR_WORKSPACE_ID"]: undefined,
};

test("M0 settings: legion settings include contract defaults and merge by explicit field", () => {
	const user = parseSubagentSettings(
		{
			subagents: {
				legion: {
					maxDepth: 2,
					phaseTimeouts: { planning: 1_000, reviewing: 3_000 },
				},
			},
		},
		"/user/settings.json",
	);
	const project = parseSubagentSettings(
		{
			subagents: {
				legion: {
					maxDepth: 3,
					phaseTimeouts: { verifying: 4_000 },
				},
			},
		},
		"/project/.pi/settings.json",
	);

	assert.deepEqual(user.legion, {
		...DEFAULT_LEGION_SETTINGS,
		maxDepth: 2,
		phaseTimeouts: {
			...DEFAULT_LEGION_SETTINGS.phaseTimeouts,
			planning: 1_000,
			reviewing: 3_000,
		},
	});
	assert.deepEqual(resolveSubagentSettings(user, project).legion, {
		...DEFAULT_LEGION_SETTINGS,
		maxDepth: 3,
		phaseTimeouts: {
			...DEFAULT_LEGION_SETTINGS.phaseTimeouts,
			planning: 1_000,
			reviewing: 3_000,
			verifying: 4_000,
		},
	});
});

test("M0 nesting a: R=1 child cannot dispatch a grandchild", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const child = await spawnChild(fake, {
		roleName: "X",
		name: "X-1",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 1,
	});
	assert.equal(child.maxDepth, 1);
	await assertLaunchRefused(fake, {
		roleName: "Y",
		name: "Y-a",
		parentDepth: child.depth,
		parentMaxDepth: child.maxDepth,
	});
});

test("M0 nesting b: R=2 child may launch one generation, whose child is a leaf", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const x = await spawnChild(fake, {
		roleName: "X",
		name: "X-b",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 2,
	});
	assert.equal(x.maxDepth, 2);
	const y = await spawnChild(fake, {
		roleName: "Y",
		name: "Y-b",
		parentDepth: x.depth,
		parentMaxDepth: x.maxDepth,
	});
	assert.equal(y.depth, 2);
	assert.equal(y.maxDepth, 2);
	await assertLaunchRefused(fake, {
		roleName: "Z",
		name: "Z-b",
		parentDepth: y.depth,
		parentMaxDepth: y.maxDepth,
	});
});

test("M0 nesting b2: R=3 then R=2 allows Z but makes Z a leaf", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const x = await spawnChild(fake, {
		roleName: "X",
		name: "X-b2",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 3,
	});
	assert.equal(x.maxDepth, 3);
	const y = await spawnChild(fake, {
		roleName: "Y",
		name: "Y-b2",
		parentDepth: x.depth,
		parentMaxDepth: x.maxDepth,
		roleMaxDepth: 2,
	});
	assert.equal(y.maxDepth, 3);
	const z = await spawnChild(fake, {
		roleName: "Z",
		name: "Z-b2",
		parentDepth: y.depth,
		parentMaxDepth: y.maxDepth,
	});
	assert.equal(z.depth, 3);
	assert.equal(z.maxDepth, 3);
	await assertLaunchRefused(fake, {
		roleName: "leaf",
		name: "leaf-b2",
		parentDepth: z.depth,
		parentMaxDepth: z.maxDepth,
	});
});

test("M0 nesting b3: R=4 grandchild starts but inherits the tightened ceiling", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const x = await spawnChild(fake, {
		roleName: "X",
		name: "X-b3",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 2,
	});
	assert.equal(x.maxDepth, 2);
	const y = await spawnChild(fake, {
		roleName: "Y",
		name: "Y-b3",
		parentDepth: x.depth,
		parentMaxDepth: x.maxDepth,
		roleMaxDepth: 4,
	});
	assert.equal(y.depth, 2);
	assert.equal(y.maxDepth, 2);
	await assertLaunchRefused(fake, {
		roleName: "Z",
		name: "Z-b3",
		parentDepth: y.depth,
		parentMaxDepth: y.maxDepth,
	});
});

test("M0 nesting c1: centurion R=2 can launch advisor, worker R=1 is a leaf", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const centurion = await spawnChild(fake, {
		roleName: "centurion",
		name: "centurion-c1",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 2,
	});
	const worker = await spawnChild(fake, {
		roleName: "worker",
		name: "worker-c1",
		parentDepth: centurion.depth,
		parentMaxDepth: centurion.maxDepth,
		roleMaxDepth: 1,
	});
	assert.equal(worker.maxDepth, 2);
	assert.ok(
		fake.commands.some((command) =>
			command.args.includes("PI_SUBAGENT_ALLOW_NESTED=1"),
		),
		"nested registration is enabled so the refusal comes from the depth budget",
	);
	await assertLaunchRefused(fake, {
		roleName: "advisor",
		name: "advisor-from-worker-c1",
		parentDepth: worker.depth,
		parentMaxDepth: worker.maxDepth,
	});
	const advisor = await spawnChild(fake, {
		roleName: "advisor",
		name: "advisor-from-centurion-c1",
		parentDepth: centurion.depth,
		parentMaxDepth: centurion.maxDepth,
	});
	assert.equal(advisor.depth, 2);
	assert.equal(advisor.maxDepth, 2);
});

test("M0 nesting c3: centurion R=3 lets worker R=2 launch advisor, but advisor is a leaf", async () => {
	const fake = new FakeHerdr();
	fake.addRootPane("w1");
	const centurion = await spawnChild(fake, {
		roleName: "centurion",
		name: "centurion-c3",
		parentDepth: 0,
		parentMaxDepth: 4,
		roleMaxDepth: 3,
	});
	const worker = await spawnChild(fake, {
		roleName: "worker",
		name: "worker-c3",
		parentDepth: centurion.depth,
		parentMaxDepth: centurion.maxDepth,
		roleMaxDepth: 2,
	});
	assert.equal(worker.maxDepth, 3);
	const advisor = await spawnChild(fake, {
		roleName: "advisor",
		name: "advisor-c3",
		parentDepth: worker.depth,
		parentMaxDepth: worker.maxDepth,
	});
	assert.equal(advisor.depth, 3);
	assert.equal(advisor.maxDepth, 3);
	await assertLaunchRefused(fake, {
		roleName: "reviewer",
		name: "reviewer-from-advisor-c3",
		parentDepth: advisor.depth,
		parentMaxDepth: advisor.maxDepth,
	});
});

test("M0 nesting e: env=0 forbids dispatch and env=10 stops at the hard cap", async () => {
	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: "0" },
		async () => {
			assert.equal(effectiveMaxDepth(DEFAULT_LEGION_SETTINGS.maxDepth), 0);
			const fake = new FakeHerdr();
			fake.addRootPane("w1");
			await assertLaunchRefused(fake, {
				roleName: "X",
				name: "X-env-zero",
				parentDepth: 0,
				parentMaxDepth: effectiveMaxDepth(DEFAULT_LEGION_SETTINGS.maxDepth),
			});
		},
	);

	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: "not-an-integer" },
		async () => {
			assert.equal(effectiveMaxDepth(DEFAULT_LEGION_SETTINGS.maxDepth), 4);
		},
	);

	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: "10" },
		async () => {
			const maxDepth = effectiveMaxDepth(DEFAULT_LEGION_SETTINGS.maxDepth);
			assert.equal(maxDepth, 4);
			const fake = new FakeHerdr();
			fake.addRootPane("w1");
			const child = await spawnChild(fake, {
				roleName: "X",
				name: "X-env-ten",
				parentDepth: 0,
				parentMaxDepth: maxDepth,
				roleMaxDepth: 10,
			});
			assert.equal(child.maxDepth, 4);
			const depthFourNode = await spawnChild(fake, {
				roleName: "depth-four",
				name: "depth-four-env-ten",
				parentDepth: 3,
				parentMaxDepth: child.maxDepth,
			});
			assert.equal(depthFourNode.depth, 4);
			assert.equal(depthFourNode.maxDepth, 4);
			await assertLaunchRefused(fake, {
				roleName: "beyond-hard-cap",
				name: "beyond-hard-cap-env-ten",
				parentDepth: depthFourNode.depth,
				parentMaxDepth: depthFourNode.maxDepth,
			});
		},
	);
});

test("M0 persistence: run.json maxDepth matches the ceiling inherited by its child", async () => {
	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: "2" },
		async () => {
			const rootDir = mkdtempSync(path.join(tmpdir(), "legion-nesting-store-"));
			try {
				const maxDepth = effectiveMaxDepth(DEFAULT_LEGION_SETTINGS.maxDepth);
				const store = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
				const run = store.createRun({
					task: "persist actual depth budget",
					cwd: rootDir,
					maxDepth,
				});
				const defaultRun = store.createRun({
					task: "default depth budget",
					cwd: rootDir,
				});
				assert.equal(defaultRun.maxDepth, DEFAULT_LEGION_SETTINGS.maxDepth);
				const fake = new FakeHerdr();
				fake.addRootPane("w1");
				const orchestrator = new Orchestrator({
					client: createHerdrClient(createFakeRunner(fake)),
					runDir: store.runDir(run.runId),
					cwd: rootDir,
					maxDepth,
				});
				await orchestrator.launch({ agent: role("worker"), task: "persisted budget" });

				const persisted = JSON.parse(
					readFileSync(path.join(store.runDir(run.runId), "run.json"), "utf8"),
				) as { maxDepth: number };
				assert.equal(maxDepth, 2);
				assert.equal(persisted.maxDepth, Number(launchedChildMaxDepth(fake)));
				assert.equal(persisted.maxDepth, store.readRun(run.runId)?.maxDepth);
			} finally {
				rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);
});

test("M0 regression: inherited depth ceiling tightens the settings ceiling", async () => {
	await withEnvironment(
		{ ...isolatedParentEnv, [MAX_DEPTH_ENV]: "2" },
		async () => {
			const runDir = mkdtempSync(path.join(tmpdir(), "legion-nesting-env-"));
			try {
				const fake = new FakeHerdr();
				fake.addRootPane("w1");
				const orchestrator = new Orchestrator({
					client: createHerdrClient(createFakeRunner(fake)),
					runDir,
					cwd: "/tmp",
					parentPath: [{ runId: "r-parent", agent: "parent" }],
					maxDepth: 4,
				});

				await orchestrator.launch({
					agent: role("worker", 4),
					task: "check inherited budget",
				});

				assert.equal(
					launchedChildMaxDepth(fake),
					"2",
					"the child must inherit min(env ceiling, settings ceiling, hard cap, role budget)",
				);
			} finally {
				rmSync(runDir, { recursive: true, force: true });
			}
		},
	);
});
