/**
 * Apply user/project overrides to discovered agents (design §6.1).
 *
 * Overrides come from `subagents.agentOverrides` in settings.json and are
 * matched by agent name. A field present in the override replaces the
 * frontmatter value; absent fields are left untouched.
 */

import type {
	AgentConfig,
	ModelSourceInfo,
	SubagentsSettings,
} from "../shared/types.ts";

type Override = NonNullable<SubagentsSettings["agentOverrides"]>[string];

/** Every field an override may set. Kept explicit so typos are caught at review time. */
const OVERRIDE_FIELDS = [
	// scalars
	"description",
	"model",
	"preset",
	"thinking",
	"output",
	"kind",
	"placement",
	"onBlocked",
	"systemPromptMode",
	"systemPrompt",
	// booleans
	"inheritProjectContext",
	"inheritSkills",
	"defaultProgress",
	"async",
	"completionGuard",
	"allowNestedSubagents",
	"disabled",
	"worktree",
	"steer",
	// numbers
	"timeoutMs",
	"toolTimeoutMs",
	"maxSubagentDepth",
	// arrays (a `false` value is meaningful for skills/extensions)
	"tools",
	"skills",
	"extensions",
	"subagentOnlyExtensions",
	"skillPath",
	"defaultReads",
	"fallbackModels",
	"alias",
] as const;

/**
 * Build the patch object for one override.
 *
 * Arrays are copied so later mutation of the settings object cannot leak into
 * the resolved agent list.
 */
function overridePatch(override: Override): Record<string, unknown> {
	const source = override as Record<string, unknown>;
	const patch: Record<string, unknown> = {};

	for (const field of OVERRIDE_FIELDS) {
		const value = source[field];
		if (value === undefined) continue;
		patch[field] = Array.isArray(value) ? [...value] : value;
	}

	return patch;
}

/**
 * Merge one override onto an agent.
 * `Object.assign` keeps the result typed as `AgentConfig` without a cast.
 */
export function applyOverride(
	agent: AgentConfig,
	override: Override,
): AgentConfig {
	return Object.assign({}, agent, overridePatch(override));
}

/**
 * Apply `agentOverrides` to a list of agents.
 * An override with `disabled: true` removes the agent entirely.
 */
export function applyAgentOverrides(
	agents: AgentConfig[],
	overrides: SubagentsSettings["agentOverrides"],
): AgentConfig[] {
	if (!overrides) return agents;
	const out: AgentConfig[] = [];

	for (const agent of agents) {
		const override = overrides[agent.name];
		if (!override) {
			out.push(agent);
			continue;
		}
		if (override.disabled === true) continue; // explicitly disabled
		out.push(applyOverride(agent, override));
	}

	return out;
}

/**
 * Fill `model` for agents that do not define one (design §6.2, level 5).
 *
 * Agents that already resolved a model keep it; provenance is recorded so tool
 * output can explain where the model came from.
 */
export function applyDefaultModel(
	agents: AgentConfig[],
	defaultModel: string | undefined,
): AgentConfig[] {
	if (!defaultModel) return agents;
	return agents.map((agent) => {
		if (agent.model !== undefined) return agent;
		const source: ModelSourceInfo = {
			type: "subagents.defaultModel",
			model: defaultModel,
		};
		return { ...agent, model: defaultModel, modelSource: source };
	});
}
