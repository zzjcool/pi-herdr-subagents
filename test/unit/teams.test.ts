import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig, ChildRecord, SubagentsSettings } from "../../src/shared/types.ts";
import {
	applyTeam,
	DEFAULT_TEAM,
	listTeamNames,
	resolveActiveTeamName,
	TEAM_ENV,
} from "../../src/agents/teams.ts";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import {
	parseTeamCommandArgs,
	registerTeamCommand,
	renderAgentsListing,
	updateSubagentSettingsFile,
} from "../../src/extension/slash.ts";
import { readSubagentProfile } from "../../src/profiles/profiles.ts";
import { formatAgentRoster } from "../../src/agents/agents.ts";
import {
	loadCatalog,
	renderAgentList,
	renderParentRoster,
	unknownAgentLine,
	unknownAgentLineForCatalog,
	waitAction,
} from "../../index.ts";
import { createSessionRuntime, type WaitResult } from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import herdrSubagents from "../../index.ts";

const savedTeamEnv = process.env[TEAM_ENV];
delete process.env[TEAM_ENV];
after(() => {
	if (savedTeamEnv === undefined) delete process.env[TEAM_ENV];
	else process.env[TEAM_ENV] = savedTeamEnv;
});

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: name,
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "",
		source: "user",
		filePath: `/${name}.md`,
		...over,
	};
}

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

function withTeamSettings(
	overrides: Partial<SubagentsSettings> = {},
): SubagentsSettings {
	return {
		teams: {
			frontend: { description: "front end", members: ["designer", "worker"] },
		},
		...overrides,
	};
}

test("teams: environment wins over settings, then default", () => {
	assert.deepEqual(resolveActiveTeamName({}, {}), {
		name: DEFAULT_TEAM,
		source: "default",
	});
	assert.deepEqual(resolveActiveTeamName({ team: "frontend" }, {}), {
		name: "frontend",
		source: "settings",
	});
	assert.deepEqual(
		resolveActiveTeamName(
			{ team: "frontend" },
			{ [TEAM_ENV]: "  backend  " },
		),
		{ name: "backend", source: "env" },
	);
	assert.deepEqual(
		resolveActiveTeamName({ team: "frontend" }, { [TEAM_ENV]: "   " }),
		{ name: "frontend", source: "settings" },
	);
});

test("teams: default returns the exact input array", () => {
	const agents = [agent("worker")];
	const result = applyTeam(agents, {}, {});
	assert.equal(result.agents, agents);
	assert.deepEqual(result.team, { name: "default", source: "default" });
	assert.deepEqual(result.warnings, []);
});

test("teams: members preserve first-seen order and warnings are exact", () => {
	const agents = [agent("designer"), agent("worker")];
	const result = applyTeam(
		agents,
		{
			team: "frontend",
			teams: {
				frontend: {
					members: ["worker", "missing", "designer", "missing"],
				},
			},
		},
		{},
	);
	assert.deepEqual(result.agents.map((entry) => entry.name), ["worker", "designer"]);
	assert.deepEqual(result.warnings, [
		'Subagent team "frontend" references missing agent "missing"; skipped.',
		'Subagent team "frontend" references missing agent "missing"; skipped.',
	]);
});

test("teams: star expands each role once and later object overrides win", () => {
	const agents = [
		agent("designer", { model: "old-designer" }),
		agent("worker", { model: "old-worker" }),
		agent("reviewer", { model: "old-reviewer" }),
	];
	const result = applyTeam(
		agents,
		{
			team: "full",
			teams: {
				full: {
					members: ["worker", "*", { agent: "worker", model: "new-worker" }],
				},
			},
		},
		{},
	);
	assert.deepEqual(result.agents.map((entry) => entry.name), [
		"worker",
		"designer",
		"reviewer",
	]);
	assert.equal(result.agents[0]?.model, "new-worker");
	assert.equal(result.agents[1]?.model, "old-designer");
	assert.deepEqual(result.warnings, []);
});

test("teams: a later member or star restores a role removed by disabled", () => {
	const agents = [agent("worker"), agent("reviewer")];
	const afterExplicitMention = applyTeam(
		agents,
		{
			team: "restore",
			teams: {
				restore: {
					members: [
						"worker",
					{ agent: "worker", disabled: true },
					"reviewer",
					"worker",
				],
				},
			},
		},
		{},
	);
	assert.deepEqual(afterExplicitMention.agents.map((entry) => entry.name), [
		"reviewer",
		"worker",
	]);

	const afterWildcard = applyTeam(
		agents,
		{
			team: "restore",
			teams: {
				restore: {
					members: ["*", { agent: "worker", disabled: true }, "*"],
				},
			},
		},
		{},
	);
	assert.deepEqual(afterWildcard.agents.map((entry) => entry.name), [
		"reviewer",
		"worker",
	]);
});

test('teams: object member agent:"*" is not a wildcard and warns as a missing role', () => {
	const agents = [agent("worker")];
	const settings = parseSubagentSettings(
		{ subagents: { team: "literal", teams: { literal: { members: [{ agent: "*" }] } } } },
		"/settings.json",
	);
	const result = applyTeam(agents, settings, {});
	assert.deepEqual(result.agents, []);
	assert.deepEqual(result.warnings, [
		'Subagent team "literal" references missing agent "*"; skipped.',
	]);
});

test("teams: undefined constructor selection warns and returns the full catalog", () => {
	const agents = [agent("worker")];
	const result = applyTeam(agents, {}, { [TEAM_ENV]: "constructor" });
	assert.equal(result.agents, agents);
	assert.deepEqual(result.team, { name: "constructor", source: "env" });
	assert.deepEqual(result.warnings, [
		'Subagent team "constructor" is not defined; using all agents. Available teams: default.',
	]);
});

test("teams: configured constructor key is an own, usable team name", () => {
	const doc = JSON.parse(
		'{"subagents":{"team":"constructor","teams":{"constructor":{"members":["worker"]}}}}',
	) as Record<string, unknown>;
	const settings = parseSubagentSettings(doc, "/constructor.json");
	assert.equal(Object.getPrototypeOf(settings.teams), null);
	assert.equal(Object.hasOwn(settings.teams ?? {}, "constructor"), true);
	const result = applyTeam([agent("worker")], settings, {});
	assert.deepEqual(result.agents.map((entry) => entry.name), ["worker"]);
	assert.deepEqual(result.warnings, []);
});

test("teams: missing active name falls back to all roles with exact warning", () => {
	const agents = [agent("worker")];
	const result = applyTeam(
		agents,
		{ team: "missing", teams: { frontend: { members: ["worker"] } } },
		{},
	);
	assert.equal(result.agents, agents);
	assert.deepEqual(result.warnings, [
		'Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
	]);
});

test("teams: list puts default first and keeps configured insertion order", () => {
	assert.deepEqual(
		listTeamNames({
			teams: { z: { members: ["worker"] }, a: { members: ["worker"] } },
		}),
		["default", "z", "a"],
	);
});

test("settings: project team entries replace same names; absent project teams keep user teams", () => {
	const user = parseSubagentSettings(
		{
			subagents: {
				team: "user-team",
				teams: {
					shared: { description: "user", members: ["worker"] },
					userOnly: { members: ["worker"] },
				},
			},
		},
		"/user/settings.json",
	);
	const project = parseSubagentSettings(
		{
			subagents: {
				team: "project-team",
				teams: {
					shared: { description: "project", members: ["designer"] },
					projectOnly: { members: ["designer"] },
				},
			},
		},
		"/project/settings.json",
	);
	const merged = resolveSubagentSettings(user, project);
	assert.equal(merged.team, "project-team");
	assert.deepEqual(merged.teams?.shared, {
		description: "project",
		members: ["designer"],
	});
	assert.deepEqual(Object.keys(merged.teams ?? {}).sort(), [
		"projectOnly",
		"shared",
		"userOnly",
	]);

	const noProjectTeams = resolveSubagentSettings(user, { defaultModel: "project/model" });
	assert.equal(noProjectTeams.team, "user-team");
	assert.deepEqual(noProjectTeams.teams?.userOnly, { members: ["worker"] });
});

test("settings: team structure, description, reserved names, and member override types validate", () => {
	for (const [teams, pattern] of [
		[[], /invalid 'teams';/],
		["not an object", /invalid 'teams';/],
		[null, /invalid 'teams';/],
		[{ frontend: [] }, /invalid 'teams\.frontend';/],
		[{ frontend: {} }, /invalid 'teams\.frontend\.members';/],
		[{ frontend: { members: [] } }, /invalid 'teams\.frontend\.members';/],
		[{ frontend: { description: 5, members: ["worker"] } }, /invalid 'teams\.frontend\.description';/],
	] as const) {
		assert.throws(
			() => parseSubagentSettings({ subagents: { teams } }, "/settings.json"),
			pattern,
		);
	}
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { teams: { default: { members: ["worker"] } } } },
				"/settings.json",
			),
		/teams\.default/,
	);
	const protoDoc = JSON.parse(
		'{"subagents":{"teams":{"__proto__":{"members":["worker"]}}}}',
	) as Record<string, unknown>;
	assert.throws(
		() => parseSubagentSettings(protoDoc, "/unsafe/settings.json"),
		/Subagent settings in '\/unsafe\/settings\.json' have invalid 'teams\.__proto__'/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { team: "  " } }, "/settings.json"),
		/team/,
	);
	for (const [member, field] of [
		[{ agent: "worker", model: 5, disabled: "yes" }, "model"],
		[{ agent: "worker", disabled: "yes" }, "disabled"],
		[{ agent: "worker", tools: 5 }, "tools"],
	] as const) {
		assert.throws(
			() =>
				parseSubagentSettings(
					{ subagents: { teams: { frontend: { members: [member] } } } },
					"/settings.json",
				),
			new RegExp(`teams\\.frontend\\.members\\[0\\]\\.${field}`),
		);
	}
});

test("slash: team argument boundaries reject malformed and extra tokens", () => {
	for (const args of [
		"use a b",
		"use x --global --global",
		"--global --global",
		"create x",
		"unknown x",
		"list extra",
		"use --global",
	]) {
		assert.equal(parseTeamCommandArgs(args).ok, false, args);
	}
	assert.deepEqual(parseTeamCommandArgs(""), {
		ok: true,
		value: { action: "show" },
	});
	assert.deepEqual(parseTeamCommandArgs("list"), {
		ok: true,
		value: { action: "list" },
	});
	assert.deepEqual(parseTeamCommandArgs("use frontend --global"), {
		ok: true,
		value: { action: "use", name: "frontend", global: true },
	});
	assert.deepEqual(parseTeamCommandArgs("create frontend designer, worker"), {
		ok: true,
		value: {
			action: "create",
			name: "frontend",
			members: ["designer", "worker"],
			global: false,
		},
	});
	assert.equal(parseTeamCommandArgs("create frontend worker,").ok, false);
});

test("slash: settings writer preserves unrelated keys", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-settings-"));
	try {
		const file = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ unrelated: 1, subagents: { defaultModel: "cb/x" } }),
		);
		updateSubagentSettingsFile(file, (subagents) => {
			subagents.team = "frontend";
			const teams = (subagents.teams ?? {}) as Record<string, unknown>;
			teams.frontend = { members: ["worker"] };
			subagents.teams = teams;
		});
		const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		assert.equal(saved.unrelated, 1);
		assert.equal(saved.subagents.defaultModel, "cb/x");
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.frontend.members, ["worker"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface TeamCommandHarness {
	messages: Array<{ content: string }>;
	notifications: Array<{ message: string; level: string }>;
	invoke(args: string, cwd: string): Promise<void>;
}

function teamCommandHarness(
	catalog: {
		agents: AgentConfig[];
		allAgents: AgentConfig[];
		settings: SubagentsSettings;
		team: { name: string; source: "env" | "settings" | "default" };
		teamWarnings: string[];
	},
): TeamCommandHarness {
	const messages: Array<{ content: string }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand(_name: string, options: { handler: typeof handler }) {
			handler = options.handler;
		},
		sendMessage(message: { content: string }) {
			messages.push(message);
		},
	} as never;
	registerTeamCommand(pi, { loadCatalog: () => catalog });
	return {
		messages,
		notifications,
		async invoke(args, cwd) {
			assert.ok(handler);
			await handler(args, {
				cwd,
				hasUI: false,
				ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				},
			});
		},
	};
}

const commandCatalog = (settings: SubagentsSettings = {
	teams: { frontend: { members: ["worker"] } },
}) => ({
	agents: [agent("worker")],
	allAgents: [agent("worker")],
	settings,
	team: { name: "frontend", source: "settings" as const },
	teamWarnings: [],
});

test("slash: use/create success messages are exact and environment override is disclosed", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-success-"));
	const previousTeam = process.env[TEAM_ENV];
	try {
		const settingsPath = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(
			settingsPath,
			JSON.stringify({ keep: { value: true }, subagents: { defaultModel: "cb/x" } }),
		);
		const harness = teamCommandHarness(commandCatalog());
		process.env[TEAM_ENV] = "frontend";
		await harness.invoke("use frontend", dir);
		await harness.invoke("create backend worker", dir);
		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.messages.map((message) => message.content), [
			`Subagent team set to "frontend" in ${settingsPath}. Environment ${TEAM_ENV} is set and overrides this setting. Next prompt will use it.`,
			"Created subagent team backend. Select it with /subagents-team use backend",
		]);
		const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
		assert.deepEqual(saved.keep, { value: true });
		assert.equal(saved.subagents.defaultModel, "cb/x");
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.backend.members, ["worker"]);
	} finally {
		restoreEnv(TEAM_ENV, previousTeam);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: unknown, reserved, and existing teams error without changing file bytes", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-errors-"));
	try {
		const settingsPath = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		const initial = '{"keep":1,"subagents":{"teams":{"fileOnly":{"members":["worker"]}}}}';
		writeFileSync(settingsPath, initial);
		const harness = teamCommandHarness(commandCatalog());
		for (const [args, expected] of [
			["use missing", 'Unknown team "missing"'],
			["create default worker", 'Team name "default" is reserved'],
			["create frontend worker", 'Team "frontend" already exists'],
			["create fileOnly worker", 'Team "fileOnly" already exists'],
		] as const) {
			await harness.invoke(args, dir);
			assert.ok(harness.notifications.at(-1)?.message.includes(expected), args);
			assert.equal(harness.notifications.at(-1)?.level, "error", args);
			assert.equal(readFileSync(settingsPath, "utf8"), initial, args);
		}
		assert.deepEqual(harness.messages, []);
		assert.deepEqual(
			harness.notifications.map(({ message, level }) => {
				assert.equal(level, "error");
				return message;
			}),
			[
				'Unknown team "missing". Available: default, frontend.',
				'Team name "default" is reserved.',
				'Team "frontend" already exists; edit it manually instead.',
				'Team "fileOnly" already exists; edit it manually instead.',
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: --global use/create update temporary user settings only", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-global-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = path.join(dir, "user-agent-dir");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const project = path.join(dir, "project");
		mkdirSync(project, { recursive: true });
		const harness = teamCommandHarness(commandCatalog());
		await harness.invoke("use frontend --global", project);
		await harness.invoke("create backend worker --global", project);
		const userSettingsPath = path.join(agentDir, "settings.json");
		assert.equal(existsSync(userSettingsPath), true);
		assert.equal(existsSync(path.join(project, ".pi", "settings.json")), false);
		const saved = JSON.parse(readFileSync(userSettingsPath, "utf8")) as Record<string, any>;
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.backend.members, ["worker"]);
		assert.match(harness.messages[0]?.content ?? "", /in .*\/user-agent-dir\/settings\.json/);
		assert.equal(
			harness.messages[1]?.content,
			"Created subagent team backend. Select it with /subagents-team use backend",
		);
		assert.deepEqual(harness.notifications, []);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: list and status report current team and warnings", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-status-"));
	try {
		const harness = teamCommandHarness({
			agents: [agent("worker")],
			allAgents: [agent("worker"), agent("designer")],
			settings: {
				teams: { frontend: { description: "UI", members: ["worker"] } },
			},
			team: { name: "missing", source: "env" },
			teamWarnings: ['Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.'],
		});
		await harness.invoke("", dir);
		assert.equal(
			harness.messages[0]?.content,
			'Active subagent team: missing\nSource: env\nMembers (1): worker\nWarning: Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
		);
		await harness.invoke("list", dir);
		assert.equal(
			harness.messages[1]?.content,
			'Subagent teams\n  default — all discovered agents (2 members)\n  frontend — UI (1 members)\n* missing — (not defined; using all agents)\nWarning: Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("catalog: filters agents, keeps allAgents, and team overrides precede defaults", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-catalog-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		team: process.env[TEAM_ENV],
	};
	try {
		const agentDir = path.join(dir, "agentdir");
		const extraDir = path.join(dir, "extra");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				subagents: {
					disableBuiltins: true,
					team: "frontend",
					defaultModel: "fallback/model",
					defaultOnBlocked: "notify",
					teams: {
						frontend: {
							members: [{
							agent: "worker",
							model: "team/model",
							onBlocked: "forward",
							timeoutMs: 17,
							kind: "claude",
							tools: ["read"],
							placement: "new-tab",
						}],
						},
					},
				},
			}),
		);
		writeFileSync(
			path.join(extraDir, "worker.md"),
			"---\nname: worker\ndescription: worker\ntimeoutMs: 900\n---\nworker prompt\n",
		);
		writeFileSync(
			path.join(extraDir, "designer.md"),
			"---\nname: designer\ndescription: designer\n---\ndesigner prompt\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
		delete process.env[TEAM_ENV];
		const catalog = loadCatalog(dir, dir, "user");
		assert.deepEqual(catalog.agents.map((entry) => entry.name), ["worker"]);
		assert.deepEqual(catalog.allAgents.map((entry) => entry.name), [
			"designer",
			"worker",
		]);
		assert.equal(catalog.agents[0]?.model, "team/model");
		assert.equal(catalog.agents[0]?.onBlocked, "forward");
		assert.equal(catalog.agents[0]?.timeoutMs, 17);
		assert.equal(catalog.agents[0]?.kind, "claude");
		assert.deepEqual(catalog.agents[0]?.tools, ["read"]);
		assert.equal(catalog.agents[0]?.placement, "new-tab");
		assert.equal(catalog.allAgents[1]?.model, "fallback/model");
		assert.equal(catalog.allAgents[1]?.onBlocked, "notify");
		assert.equal(catalog.allAgents[1]?.timeoutMs, 900);
		assert.equal(catalog.allAgents[1]?.kind, "pi");
		assert.deepEqual(catalog.team, { name: "frontend", source: "settings" });
		assert.deepEqual(catalog.teamWarnings, []);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
		restoreEnv("PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", previous.extra);
		restoreEnv(TEAM_ENV, previous.team);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("catalog: missing and constructor-selected teams warn and keep the full catalog", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-catalog-fallback-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		team: process.env[TEAM_ENV],
	};
	try {
		const agentDir = path.join(dir, "agentdir");
		const extraDir = path.join(dir, "extra");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { disableBuiltins: true, teams: { frontend: { members: ["worker"] } } } }),
		);
		writeFileSync(path.join(extraDir, "worker.md"), "---\nname: worker\ndescription: worker\n---\nprompt\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
		for (const name of ["missing", "constructor"]) {
			process.env[TEAM_ENV] = name;
			const catalog = loadCatalog(dir, dir, "user");
			assert.deepEqual(catalog.agents.map((entry) => entry.name), ["worker"]);
			assert.deepEqual(catalog.allAgents.map((entry) => entry.name), ["worker"]);
			assert.deepEqual(catalog.team, { name, source: "env" });
			assert.deepEqual(catalog.teamWarnings, [
				`Subagent team "${name}" is not defined; using all agents. Available teams: default, frontend.`,
			]);
		}
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
		restoreEnv("PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", previous.extra);
		restoreEnv(TEAM_ENV, previous.team);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listing and roster: default/no-warning text is byte-for-byte legacy; team lines are conditional", () => {
	const worker = agent("worker");
	const defaultTeam = { name: DEFAULT_TEAM, source: "default" as const };
	assert.equal(renderAgentList([worker], defaultTeam, []), "worker [user] — worker");
	assert.equal(
		renderAgentList([], defaultTeam, []),
		"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
	);
	assert.equal(renderParentRoster([worker], defaultTeam, []), formatAgentRoster([worker]));
	assert.equal(renderParentRoster([], defaultTeam, []), formatAgentRoster([]));

	const warning = "team config is incomplete";
	assert.equal(
		renderAgentList([worker], { name: "frontend", source: "settings" }, []),
		"Active team: frontend (source: settings)\n\nworker [user] — worker",
	);
	assert.equal(
		renderAgentList([worker], defaultTeam, [warning]),
		`Active team: default (source: default)\nWarning: ${warning}\n\nworker [user] — worker`,
	);
	assert.equal(
		renderParentRoster([worker], { name: "frontend", source: "settings" }, [warning]),
		`Active subagent team: frontend\nTeam warning: ${warning}\n${formatAgentRoster([worker])}`,
	);

	const legacyEmptySlashText = [
		"Subagent roles",
		"Scope: user",
		"",
		"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		"",
		"Directories",
		"  builtin: /builtin",
		"  user: ~/.pi/agent/agents",
		"  project: (none found)",
	].join("\n");
	const common = {
		agents: [],
		scope: "user" as const,
		projectAgentsDir: null,
		builtinAgentsDir: "/builtin",
		settings: {},
	};
	assert.equal(
		renderAgentsListing({ ...common, team: defaultTeam, teamWarnings: [] }),
		legacyEmptySlashText,
	);
	assert.match(
		renderAgentsListing({
			...common,
			team: { name: "frontend", source: "settings" },
			teamWarnings: [warning],
		}),
		/^Subagent roles\nScope: user\nActive team: frontend \(source: settings\)\nWarning: team config is incomplete/m,
	);
});

test("launch refusal: only a real team-filtered role gets team wording", () => {
	const filtered = [agent("designer")];
	const allAgents = [agent("worker"), agent("designer")];
	const settings = withTeamSettings();
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"worker",
			{ name: "frontend", source: "settings" },
			settings,
		),
		'✗ unknown agent "worker" in team "frontend". Available: designer. Switch with /subagents-team use frontend (or "default").',
	);
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"ghost",
			{ name: "frontend", source: "settings" },
			settings,
		),
		'✗ unknown agent "ghost". Available: designer',
	);
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"worker",
			{ name: "missing", source: "env" },
			{},
		),
		'✗ unknown agent "worker". Available: designer',
	);
	assert.equal(
		unknownAgentLine(filtered, "ghost"),
		'✗ unknown agent "ghost". Available: designer',
	);
});

test("control resolution prefers team override, then recovers a filtered role from allAgents", () => {
	const baseWorker = agent("worker", { timeoutMs: 2_000, kind: "pi" });
	const teamWorker = agent("worker", { timeoutMs: 17, kind: "claude" });
	const designer = agent("designer");
	const currentTeam = [teamWorker, designer];
	const resolve = (agents: AgentConfig[], allAgents: AgentConfig[], role: string | undefined) =>
		agents.find((entry) => entry.name === role) ??
		allAgents.find((entry) => entry.name === role);
	assert.equal(resolve(currentTeam, [baseWorker], "worker"), teamWorker);
	assert.equal(resolve([designer], [baseWorker], "worker"), baseWorker);
	assert.equal(resolve([designer], [baseWorker], undefined), undefined);
});

test("control wait: filtered child falls back to allAgents timeout", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "worker-existing",
		runId: "r-team",
		agent: "worker",
		sessionFile: "/tmp/worker-existing.jsonl",
		timeoutMs: 10,
		collect: () => new Promise(() => {}),
	});
	const requests: Array<{ names: string[]; timeoutMs?: number }> = [];
	runtime.wait = (names: string[], options?: { timeoutMs?: number }) => {
		requests.push({ names, timeoutMs: options?.timeoutMs });
		return Promise.resolve(names.map((name) => ({ name, stillRunning: true }) as WaitResult));
	};
	const dir = mkdtempSync(path.join(tmpdir(), "teams-wait-control-"));
	try {
		const store = new RunStore({ rootDir: path.join(dir, ".pi-subagents") });
		const run = store.createRun({ task: "existing", cwd: dir });
		await store.addChild(run.runId, {
			name: "worker-existing",
			paneId: null,
			sessionFile: "/tmp/worker-existing.jsonl",
			ownerToken: "owner",
			state: "working",
			spawnedAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		const result = await waitAction({
			params: { action: "wait", name: "worker-existing" },
			runtime,
			agents: [agent("designer")],
			allAgents: [agent("worker", { timeoutMs: 2_000 })],
			store,
			cwd: dir,
		});
		assert.deepEqual(requests, [{ names: ["worker-existing"], timeoutMs: 2_000 }]);
		assert.match((result.content as Array<{ text: string }>)[0]?.text ?? "", /still running/);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("control wait: team-overridden role definition wins over allAgents", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "worker-existing",
		runId: "r-team-override",
		agent: "worker",
		sessionFile: "/tmp/worker-existing.jsonl",
		timeoutMs: 10,
		collect: () => new Promise(() => {}),
	});
	const requests: Array<{ names: string[]; timeoutMs?: number }> = [];
	runtime.wait = (names: string[], options?: { timeoutMs?: number }) => {
		requests.push({ names, timeoutMs: options?.timeoutMs });
		return Promise.resolve(names.map((name) => ({ name, stillRunning: true }) as WaitResult));
	};
	const dir = mkdtempSync(path.join(tmpdir(), "teams-wait-override-"));
	try {
		const store = new RunStore({ rootDir: path.join(dir, ".pi-subagents") });
		const run = store.createRun({ task: "existing", cwd: dir });
		await store.addChild(run.runId, {
			name: "worker-existing",
			paneId: null,
			sessionFile: "/tmp/worker-existing.jsonl",
			ownerToken: "owner",
			state: "working",
			spawnedAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		await waitAction({
			params: { action: "wait", name: "worker-existing" },
			runtime,
			agents: [agent("worker", { kind: "claude", timeoutMs: 17 })],
			allAgents: [agent("worker", { timeoutMs: 2_000 })],
			store,
			cwd: dir,
		});
		assert.deepEqual(requests, [{ names: ["worker-existing"], timeoutMs: 17 }]);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("profiles: malformed JSON error includes the file path", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-profile-json-"));
	try {
		const profiles = path.join(dir, "profiles", "pi-herdr-swarm");
		mkdirSync(profiles, { recursive: true });
		const file = path.join(profiles, "broken.json");
		writeFileSync(file, "{ invalid");
		assert.throws(
			() => readSubagentProfile("broken", { agentDir: dir }),
			new RegExp(`Invalid JSON in '${file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}'`),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const FAKE_HERDR_SOURCE = String.raw`
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\n");
const out = (value) => { process.stdout.write(JSON.stringify({ result: value }) + "\n"); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } }) + "\n"); process.exitCode = 1; };
const [command, subcommand] = args;
if (command === "--version") { process.stdout.write("herdr test\n"); process.exit(0); }
if (command === "pane" && subcommand === "list") { out({ panes: [] }); }
else if (command === "pane" && subcommand === "split") { out({ pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", cwd: null } }); }
else if (command === "pane" && subcommand === "read") { process.stdout.write("fake pane reply\n"); }
else if (command === "pane" && subcommand === "get") { out({ pane: { pane_id: args[2], tab_id: "w1:t1", workspace_id: "w1", cwd: null } }); }
else if (command === "tab" && subcommand === "list") { out({ tabs: [] }); }
else if (command === "tab" && subcommand === "create") {
  const labelIndex = args.indexOf("--label");
  const workspaceIndex = args.indexOf("--workspace");
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : "w1";
  const tabId = workspace + ":t1";
  const paneId = workspace + ":p1";
  out({ tab: { tab_id: tabId, workspace_id: workspace, label: labelIndex >= 0 ? args[labelIndex + 1] : null, pane_count: 1 }, root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspace, cwd: null } });
}
else if (command === "agent" && subcommand === "list") { out({ agents: [] }); }
else if (command === "agent" && subcommand === "start") {
  const name = args[2] || "child";
  const paneIndex = args.indexOf("--pane");
  const sessionIndex = args.indexOf("--session");
  const paneId = paneIndex >= 0 ? args[paneIndex + 1] : "w1:p1";
  const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : "/tmp/fake-session.jsonl";
  try {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "sess-" + name, cwd: "/tmp" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "test/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }),
    ].join("\n") + "\n");
  } catch {}
  out({ agent: { name, pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1", agent_status: "working", agent_session: { kind: "path", source: "pi", value: sessionFile } } });
}
else if (command === "agent" && subcommand === "get") {
  const missing = (process.env.FAKE_HERDR_MISSING_AGENT_NAMES || "").split(",");
  if (missing.includes(args[2])) fail("not_found", "no agent " + args[2]);
  else out({ agent: { name: args[2], pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
}
else if (command === "agent" && (subcommand === "prompt" || subcommand === "wait" || subcommand === "send-keys")) { out({ ok: true, agent: { name: args[2], agent_status: "idle" } }); }
else if (command === "pane" && (subcommand === "close" || subcommand === "report-metadata")) { out({}); }
else if (command === "tab" && (subcommand === "close" || subcommand === "rename")) { out({}); }
else { out({}); }
`;

interface IndexHarness {
	cwd: string;
	calls(): string[][];
	invoke(params: Record<string, unknown>): Promise<{ text: string; result: unknown }>;
	shutdown(): void;
	cleanup(): void;
}

async function indexHarness(
	settings: Record<string, unknown>,
	agents: Record<string, string>,
): Promise<IndexHarness> {
	const cwd = mkdtempSync(path.join(tmpdir(), "teams-index-mainline-"));
	const names = [
		"PI_SUBAGENT_CHILD",
		"PI_CODING_AGENT_DIR",
		"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
		"HERDR_BIN",
		"FAKE_HERDR_LOG",
		"FAKE_HERDR_MISSING_AGENT_NAMES",
		"HERDR_WORKSPACE_ID",
		"HERDR_PANE_ID",
	];
	const previous = new Map(names.map((name) => [name, process.env[name]]));
	const agentDir = path.join(cwd, "agentdir");
	const extraDir = path.join(cwd, "extra-agents");
	const binDir = path.join(cwd, "fake-bin");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: settings }),
	);
	for (const [file, content] of Object.entries(agents)) {
		writeFileSync(path.join(extraDir, file), content);
	}
	const source = path.join(binDir, "herdr.mjs");
	const wrapper = path.join(binDir, "herdr");
	const log = path.join(cwd, "herdr.log");
	writeFileSync(source, FAKE_HERDR_SOURCE);
	writeFileSync(
		wrapper,
		`#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`,
	);
	chmodSync(wrapper, 0o755);
	writeFileSync(log, "");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
	process.env.HERDR_BIN = wrapper;
	process.env.FAKE_HERDR_LOG = log;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_PANE_ID;

	const tools: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, handler);
		},
		sendMessage() {},
		eventsBus: { emit() {} },
	};
	herdrSubagents(pi as never);
	const tool = tools.find((entry) => entry.name === "subagent") as
		| {
				execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; [key: string]: unknown }>;
		  }
		| undefined;
	assert.ok(tool, "subagent tool registered through the index entry point");

	return {
		cwd,
		calls: () => {
			const text = readFileSync(log, "utf8");
			return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
		},
		async invoke(params) {
			const result = await tool.execute(
				"team-test",
				params,
				undefined,
				undefined,
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			);
			return {
				text: (result.content ?? []).map((part) => part.text ?? "").join("\n"),
				result,
			};
		},
		shutdown() {
			handlers.get("session_shutdown")?.();
		},
		cleanup() {
			handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) restoreEnv(name, value);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";
const DESIGNER_FILE = "---\nname: designer\ndescription: designer role\n---\ndesigner prompt\n";

function assertEnvArgs(calls: string[][], expected: string | undefined): void {
	const launches = calls.filter(
		(args) => (args[0] === "pane" && args[1] === "split") || (args[0] === "tab" && args[1] === "create"),
	);
	assert.ok(launches.length > 0, "pane or tab creation was issued");
	for (const args of launches) {
		if (expected) assert.ok(args.includes(`PI_SUBAGENTS_TEAM=${expected}`), args.join(" "));
		else assert.equal(args.some((arg) => arg.startsWith("PI_SUBAGENTS_TEAM=")), false, args.join(" "));
	}
}

test("index mainline: launchFamily passes a named team through tab, split, and start", async () => {
	const harness = await indexHarness(
		{
			disableBuiltins: true,
			team: "frontend",
			teams: { frontend: { members: ["worker"] } },
		},
		{ "worker.md": WORKER_FILE },
	);
	try {
		await harness.invoke({
			tasks: [
				{ agent: "worker", task: "first" },
				{ agent: "worker", task: "second" },
			],
			async: false,
			worktree: false,
		});
		const calls = harness.calls();
		harness.shutdown();
		assertEnvArgs(calls, "frontend");
		assert.ok(calls.some((args) => args[0] === "agent" && args[1] === "start"));
		assert.ok(calls.some((args) => args[0] === "pane" && args[1] === "split"));
	} finally {
		harness.cleanup();
	}
});

test("index mainline: default team omits env on split and new-tab paths", async () => {
	for (const placement of ["split-down", "new-tab"] as const) {
		const harness = await indexHarness(
			{ disableBuiltins: true },
			{ "worker.md": WORKER_FILE },
		);
		try {
			const tasks =
				placement === "split-down"
					? [
							{ agent: "worker", task: "first" },
							{ agent: "worker", task: "second" },
						]
					: undefined;
			await harness.invoke({
				...(tasks ? { tasks } : { agent: "worker", task: "one" }),
				...(placement === "new-tab" ? { placement } : {}),
				async: false,
				worktree: false,
			});
			const calls = harness.calls();
			harness.shutdown();
			assertEnvArgs(calls, undefined);
			if (placement === "split-down") {
				assert.ok(calls.some((args) => args[0] === "pane" && args[1] === "split"));
			} else {
				assert.ok(calls.some((args) => args[0] === "tab" && args[1] === "create"));
			}
		} finally {
			harness.cleanup();
		}
	}
});

test("index mainline: env=default overrides settings and is passed to a new tab", async () => {
	const harness = await indexHarness(
		{
			disableBuiltins: true,
			team: "frontend",
			teams: { frontend: { members: ["designer"] } },
		},
		{ "worker.md": WORKER_FILE, "designer.md": DESIGNER_FILE },
	);
	const previous = process.env[TEAM_ENV];
	try {
		process.env[TEAM_ENV] = "default";
		const result = await harness.invoke({
			agent: "worker",
			task: "default-selected role",
			placement: "new-tab",
			async: false,
			worktree: false,
		});
		const calls = harness.calls();
		harness.shutdown();
		assert.doesNotMatch(result.text, /unknown agent/);
		assertEnvArgs(calls, "default");
	} finally {
		restoreEnv(TEAM_ENV, previous);
		harness.cleanup();
	}
});

test("index mainline: revive finds a child filtered from the selected team and inherits team env", async () => {
	const harness = await indexHarness(
		{
			disableBuiltins: true,
			team: "frontend",
			teams: { frontend: { members: ["designer"] } },
		},
		{ "worker.md": WORKER_FILE, "designer.md": DESIGNER_FILE },
	);
	try {
		const store = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") });
		const run = store.createRun({ task: "previous", cwd: harness.cwd });
		const sessionFile = store.sessionFileFor(run.runId, "worker-existing");
		const child: ChildRecord = {
			name: "worker-existing",
			paneId: null,
			sessionFile,
			ownerToken: "test-owner",
			state: "retired",
			spawnedAt: new Date().toISOString(),
			retiredAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		};
		await store.addChild(run.runId, child);
		process.env.FAKE_HERDR_MISSING_AGENT_NAMES = "worker-existing";
		// Prevent the deliberately backgrounded follow watcher from keeping a
		// unit-test child-process tree alive after the control request returns.
		harness.shutdown();
		const result = await harness.invoke({
			action: "resume",
			name: "worker-existing",
			message: "continue",
		});
		assert.match(result.text, /Resumed worker-existing from its session/);
		assert.doesNotMatch(result.text, /no longer defined/);
		assertEnvArgs(harness.calls(), "frontend");
		assert.ok(harness.calls().some((args) => args[0] === "agent" && args[1] === "start"));
	} finally {
		harness.cleanup();
	}
});

test("index mainline: revive uses the selected team's override for an existing child", async () => {
	const harness = await indexHarness(
		{
			disableBuiltins: true,
			team: "frontend",
			teams: {
				frontend: {
					members: [{ agent: "worker", kind: "claude", timeoutMs: 321 }],
				},
			},
		},
		{ "worker.md": WORKER_FILE },
	);
	try {
		const store = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") });
		const run = store.createRun({ task: "previous", cwd: harness.cwd });
		await store.addChild(run.runId, {
			name: "worker-existing",
			paneId: null,
			sessionFile: store.sessionFileFor(run.runId, "worker-existing"),
			ownerToken: "test-owner",
			state: "retired",
			spawnedAt: new Date().toISOString(),
			retiredAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		process.env.FAKE_HERDR_MISSING_AGENT_NAMES = "worker-existing";
		harness.shutdown();
		const result = await harness.invoke({
			action: "resume",
			name: "worker-existing",
			message: "continue",
		});
		assert.match(result.text, /Resumed worker-existing from its session/);
		const start = harness.calls().find((args) => args[0] === "agent" && args[1] === "start");
		assert.ok(start);
		assert.ok(start.includes("claude"), start.join(" "));
		assert.doesNotMatch(start.join(" "), /--kind pi/);
		assertEnvArgs(harness.calls(), "frontend");
	} finally {
		harness.cleanup();
	}
});

test("index mainline: collect applies the selected team's timeout to an existing child", async () => {
	const harness = await indexHarness(
		{
			disableBuiltins: true,
			team: "frontend",
			defaultModel: "fallback/model",
			teams: {
				frontend: { members: [{ agent: "worker", timeoutMs: 9_000 }] },
			},
		},
		{ "worker.md": "---\nname: worker\ndescription: worker role\ntimeoutMs: 300\n---\nworker prompt\n" },
	);
	try {
		const store = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") });
		const run = store.createRun({ task: "existing", cwd: harness.cwd });
		await store.addChild(run.runId, {
			name: "worker-existing",
			paneId: null,
			sessionFile: store.sessionFileFor(run.runId, "worker-existing"),
			ownerToken: "test-owner",
			state: "working",
			spawnedAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		harness.shutdown();
		const result = await harness.invoke({ action: "collect", name: "worker-existing" });
		assert.doesNotMatch(result.text, /collect failed/);
		const wait = harness.calls().find((args) => args[0] === "agent" && args[1] === "wait");
		assert.ok(wait, "collect must use Herdr's wait path for the existing child");
		assert.ok(wait.includes("2000"), wait.join(" "));
		assert.ok(!wait.includes("300"), wait.join(" "));	
	} finally {
		harness.cleanup();
	}
});
