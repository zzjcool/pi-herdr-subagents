import { test } from "node:test";
import assert from "node:assert/strict";
import {
	matchesScopePattern,
	checkModelScope,
	stripThinkingSuffix,
	splitThinkingSuffix,
	parseModelScopeConfig,
} from "../../src/agents/model-scope.ts";
import { resolveModel, providerOf } from "../../src/agents/model-resolution.ts";
import {
	applyAgentOverrides,
	applyDefaultModel,
	applyOverride,
} from "../../src/agents/overrides.ts";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
	loadSubagentSettings,
} from "../../src/agents/settings.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
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

// ─────────────────────────── model scope ───────────────────────────

test("scope: thinking suffix is stripped only for known levels", () => {
	assert.equal(stripThinkingSuffix("cb/glm-5.3:high"), "cb/glm-5.3");
	assert.equal(stripThinkingSuffix("cb/model:variant"), "cb/model:variant");
	assert.deepEqual(splitThinkingSuffix("a/b:low"), {
		baseModel: "a/b",
		thinking: "low",
	});
});

test("scope: glob matching is case-insensitive and anchored", () => {
	assert.equal(matchesScopePattern("cb/glm-5.3", "cb/*"), true);
	assert.equal(matchesScopePattern("cb/glm-5.3:high", "cb/*"), true);
	assert.equal(matchesScopePattern("anthropic/claude", "cb/*"), false);
	assert.equal(matchesScopePattern("xcb/glm", "cb/*"), false);
});

test("scope: explicit violation is an error, inherited is a warning", () => {
	const scope = { enforce: true, allow: ["cb/*"] };
	const explicit = checkModelScope("anthropic/claude", scope, "explicit");
	assert.equal(explicit?.severity, "error");
	const inherited = checkModelScope("anthropic/claude", scope, "inherited");
	assert.equal(inherited?.severity, "warn");
});

test("scope: in-scope model yields no violation", () => {
	assert.equal(
		checkModelScope(
			"cb/glm-5.3",
			{ enforce: true, allow: ["cb/*"] },
			"explicit",
		),
		undefined,
	);
});

test("scope: enforcement without allow list is a no-op", () => {
	assert.equal(
		checkModelScope("anything", { enforce: true, allow: [] }, "explicit"),
		undefined,
	);
});

test("scope: disabled enforcement never violates", () => {
	assert.equal(
		checkModelScope(
			"anything",
			{ enforce: false, allow: ["cb/*"] },
			"explicit",
		),
		undefined,
	);
});

test("scope: parse rejects malformed config", () => {
	assert.throws(() => parseModelScopeConfig("nope", { filePath: "/s.json" }));
	assert.throws(() =>
		parseModelScopeConfig({ enforce: "yes" }, { filePath: "/s.json" }),
	);
	assert.throws(() =>
		parseModelScopeConfig({ allow: "cb/*" }, { filePath: "/s.json" }),
	);
	assert.throws(() =>
		parseModelScopeConfig(
			{ enforce: true, allow: [] },
			{ filePath: "/s.json" },
		),
	);
});

test("scope: parse accepts a valid config", () => {
	assert.deepEqual(
		parseModelScopeConfig(
			{ enforce: true, allow: ["cb/*"] },
			{ filePath: "/s.json" },
		),
		{
			enforce: true,
			allow: ["cb/*"],
		},
	);
});

// ─────────────────────────── model resolution ───────────────────────────

test("resolve: per-run override wins over everything", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter-model" }),
		override: "override-model",
		dispatchModel: "parent/model",
		defaultModel: "default-model",
	});
	assert.equal(r.model, "override-model");
});

test("resolve: provider-scoped override beats plain override", () => {
	const r = resolveModel({
		agent: agent(),
		settings: {
			agentOverrides: { reviewer: { model: "plain" } },
			agentOverridesByProvider: { cb: { reviewer: { model: "scoped" } } },
		},
		parentProvider: "cb",
	});
	assert.equal(r.model, "scoped");
});

test("resolve: plain override beats frontmatter", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter" }),
		settings: { agentOverrides: { reviewer: { model: "override" } } },
	});
	assert.equal(r.model, "override");
});

test("resolve: frontmatter beats defaultModel", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter" }),
		defaultModel: "default",
	});
	assert.equal(r.model, "frontmatter");
	assert.equal(r.source?.type, "frontmatter");
});

test("resolve: defaultModel used when frontmatter is absent", () => {
	const r = resolveModel({ agent: agent(), defaultModel: "default" });
	assert.equal(r.model, "default");
	assert.equal(r.source?.type, "subagents.defaultModel");
});

test("resolve: falls back to the dispatch model", () => {
	const r = resolveModel({ agent: agent(), dispatchModel: "parent/model" });
	assert.equal(r.model, "parent/model");
});

test("resolve: 'inherit' selects the dispatch model explicitly", () => {
	const r = resolveModel({
		agent: agent({ model: "inherit" }),
		dispatchModel: "parent/model",
	});
	assert.equal(r.model, "parent/model");
	assert.equal(r.source?.type, "inherit");
});

test("resolve: no candidates yields no model", () => {
	const r = resolveModel({ agent: agent() });
	assert.equal(r.model, undefined);
});

test("resolve: providerOf extracts the provider half", () => {
	assert.equal(providerOf("cb/glm-5.3:high"), "cb");
	assert.equal(providerOf("bare-model"), undefined);
	assert.equal(providerOf(undefined), undefined);
});

// ─────────────────────────── overrides ───────────────────────────

test("overrides: scalar fields replace frontmatter values", () => {
	const out = applyOverride(agent({ model: "old" }), {
		model: "new",
		thinking: "high",
	});
	assert.equal(out.model, "new");
	assert.equal(out.thinking, "high");
});

test("overrides: arrays are copied, not aliased", () => {
	const tools = ["read"];
	const out = applyOverride(agent(), { tools });
	tools.push("bash");
	assert.deepEqual(out.tools, ["read"]);
});

test("overrides: disabled removes the agent", () => {
	const out = applyAgentOverrides(
		[agent({ name: "a" }), agent({ name: "b" })],
		{ a: { disabled: true } },
	);
	assert.deepEqual(
		out.map((x) => x.name),
		["b"],
	);
});

test("overrides: unknown agent names are ignored", () => {
	const out = applyAgentOverrides([agent()], { nobody: { model: "x" } });
	assert.equal(out.length, 1);
	assert.equal(out[0]?.model, undefined);
});

test("overrides: absent overrides returns the same list", () => {
	const list = [agent()];
	assert.equal(applyAgentOverrides(list, undefined), list);
});

test("overrides: applyDefaultModel only fills agents without a model", () => {
	const out = applyDefaultModel(
		[agent({ name: "a" }), agent({ name: "b", model: "keep" })],
		"default",
	);
	assert.equal(out[0]?.model, "default");
	assert.equal(out[0]?.modelSource?.type, "subagents.defaultModel");
	assert.equal(out[1]?.model, "keep");
});

test("overrides: applyDefaultModel is a no-op without a default", () => {
	const list = [agent()];
	assert.equal(applyDefaultModel(list, undefined), list);
});

// ─────────────────────────── settings ───────────────────────────

test("settings: absent subagents key yields empty settings", () => {
	assert.deepEqual(parseSubagentSettings({}, "/s.json"), {});
	assert.deepEqual(parseSubagentSettings(undefined, "/s.json"), {});
});

test("settings: rejects a non-object subagents value", () => {
	assert.throws(() => parseSubagentSettings({ subagents: "x" }, "/s.json"));
	assert.throws(() => parseSubagentSettings({ subagents: [] }, "/s.json"));
});

test("settings: rejects an empty defaultModel", () => {
	assert.throws(() =>
		parseSubagentSettings({ subagents: { defaultModel: "  " } }, "/s.json"),
	);
});

test("settings: validates herdr numeric fields", () => {
	assert.throws(() =>
		parseSubagentSettings(
			{ subagents: { herdr: { maxConcurrentAgents: 0 } } },
			"/s.json",
		),
	);
	assert.throws(() =>
		parseSubagentSettings(
			{ subagents: { herdr: { startRetries: -1 } } },
			"/s.json",
		),
	);
	assert.deepEqual(
		parseSubagentSettings(
			{ subagents: { herdr: { maxConcurrentAgents: 3 } } },
			"/s.json",
		),
		{
			herdr: { maxConcurrentAgents: 3 },
		},
	);
});

test("settings: rejects an invalid placement", () => {
	assert.throws(() =>
		parseSubagentSettings(
			{ subagents: { herdr: { defaultPlacement: "sideways" } } },
			"/s.json",
		),
	);
});

test("settings: project settings win over user settings", () => {
	const merged = resolveSubagentSettings(
		{
			defaultModel: "user",
			herdr: { maxConcurrentAgents: 2, startRetries: 5 },
		},
		{ defaultModel: "project", herdr: { maxConcurrentAgents: 9 } },
	);
	assert.equal(merged.defaultModel, "project");
	assert.equal(merged.herdr?.maxConcurrentAgents, 9);
	assert.equal(merged.herdr?.startRetries, 5); // preserved from user
});

test("settings: agentOverrides shallow-merge across scopes", () => {
	const merged = resolveSubagentSettings(
		{ agentOverrides: { a: { model: "ua" } } },
		{ agentOverrides: { b: { model: "pb" } } },
	);
	assert.deepEqual(Object.keys(merged.agentOverrides ?? {}).sort(), ["a", "b"]);
});

test("settings: loadSubagentSettings tolerates a missing file", () => {
	assert.deepEqual(
		loadSubagentSettings({ userSettingsPath: "/nonexistent/xyz.json" }),
		{},
	);
});

test("settings: loadSubagentSettings reports malformed JSON with the path", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "settings-test-"));
	try {
		const file = path.join(dir, "settings.json");
		writeFileSync(file, "{ not json");
		assert.throws(
			() => loadSubagentSettings({ userSettingsPath: file }),
			/Invalid JSON/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
