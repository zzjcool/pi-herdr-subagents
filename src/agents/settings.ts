/**
 * Subagent settings: read + validate the `subagents` key from settings.json.
 *
 * Design ref: §6.3.
 * Project settings win over user settings for the overlapping keys.
 */

import * as fs from "node:fs";
import {
	AGENT_KINDS,
	type AgentOverride,
	type HerdrSettings,
	type ModelScopeConfig,
	type OnBlockedPolicy,
	type Placement,
	type SubagentsSettings,
	type TeamConfig,
	type TeamMember,
} from "../shared/types.ts";
import { OVERRIDE_FIELDS } from "./overrides.ts";
import { parseModelScopeConfig } from "./model-scope.ts";
import { parsePresets } from "./presets.ts";

const VALID_PLACEMENTS: ReadonlySet<string> = new Set([
	"split-down",
	"split-right",
	"new-tab",
]);

export interface LoadSettingsOptions {
	userSettingsPath: string;
	projectSettingsPath?: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path, "utf-8");
	} catch {
		return undefined; // missing file is normal
	}
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(
			`Invalid JSON in '${path}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function positiveInt(
	value: unknown,
	field: string,
	filePath: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${field}'; expected a positive integer.`,
		);
	}
	return value;
}

function nonNegativeInt(
	value: unknown,
	field: string,
	filePath: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${field}'; expected an integer >= 0.`,
		);
	}
	return value;
}

const VALID_JOIN_MODES: ReadonlySet<string> = new Set(["each", "smart"]);

const VALID_ON_BLOCKED_POLICIES: ReadonlySet<string> = new Set([
	"forward",
	"auto-approve",
	"notify",
]);

function readJoinFields(
	input: Record<string, unknown>,
	out: SubagentsSettings,
	filePath: string,
): void {
	const mode = input.joinMode;
	if (mode !== undefined) {
		if (typeof mode !== "string" || !VALID_JOIN_MODES.has(mode)) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid 'joinMode'; ` +
					`expected one of: ${[...VALID_JOIN_MODES].join(", ")}.`,
			);
		}
		out.joinMode = mode as "each" | "smart";
	}
	const flushMs = positiveInt(input.joinFlushMs, "joinFlushMs", filePath);
	if (flushMs !== undefined) out.joinFlushMs = flushMs;
}

function parseHerdrSettings(
	value: unknown,
	filePath: string,
): HerdrSettings | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid 'herdr'; expected an object.`,
		);
	}
	const input = value as Record<string, unknown>;
	const out: HerdrSettings = {};

	const placement = input.defaultPlacement;
	if (placement !== undefined) {
		if (typeof placement !== "string" || !VALID_PLACEMENTS.has(placement)) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid 'herdr.defaultPlacement'; ` +
					`expected one of: ${[...VALID_PLACEMENTS].join(", ")}.`,
			);
		}
		out.defaultPlacement = placement as Placement;
	}

	const maxAgents = positiveInt(
		input.maxConcurrentAgents,
		"herdr.maxConcurrentAgents",
		filePath,
	);
	if (maxAgents !== undefined) out.maxConcurrentAgents = maxAgents;

	const retries = nonNegativeInt(
		input.startRetries,
		"herdr.startRetries",
		filePath,
	);
	if (retries !== undefined) out.startRetries = retries;

	const backoff = nonNegativeInt(
		input.startRetryBackoffMs,
		"herdr.startRetryBackoffMs",
		filePath,
	);
	if (backoff !== undefined) out.startRetryBackoffMs = backoff;

	const days = positiveInt(
		input.sessionRetentionDays,
		"herdr.sessionRetentionDays",
		filePath,
	);
	if (days !== undefined) out.sessionRetentionDays = days;

	const bytes = positiveInt(
		input.sessionRetentionMaxBytesPerRun,
		"herdr.sessionRetentionMaxBytesPerRun",
		filePath,
	);
	if (bytes !== undefined) out.sessionRetentionMaxBytesPerRun = bytes;

	return out;
}

function parseOnBlocked(
	value: unknown,
	filePath: string,
): OnBlockedPolicy | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !VALID_ON_BLOCKED_POLICIES.has(value)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid 'defaultOnBlocked'; ` +
				`expected one of: ${[...VALID_ON_BLOCKED_POLICIES].join(", ")}.`,
		);
	}
	return value as OnBlockedPolicy;
}

/** Extract and validate the `subagents` object from a parsed settings document. */
export function parseSubagentSettings(
	doc: Record<string, unknown> | undefined,
	filePath: string,
): SubagentsSettings {
	if (!doc) return {};
	const raw = doc.subagents;
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid 'subagents'; expected an object.`,
		);
	}
	const input = raw as Record<string, unknown>;
	const out: SubagentsSettings = {};

	setIf(out, "enabled", requiredBoolean(input.enabled, "enabled", filePath));

	// Each reader validates one field and returns `undefined` when absent, so a
	// missing key and a rejected key stay distinguishable (only the latter throws).
	setIf(out, "defaultModel", requiredString(input.defaultModel, "defaultModel", filePath));
	setIf(out, "defaultProvider", requiredString(input.defaultProvider, "defaultProvider", filePath));
	setIf(
		out,
		"defaultOnBlocked",
		parseOnBlocked(input.defaultOnBlocked, filePath),
	);
	setIf(out, "agentOverrides", parseAgentOverrides(input.agentOverrides, filePath));
	setIf(out, "teams", parseTeams(input.teams, filePath));
	setIf(out, "team", requiredString(input.team, "team", filePath));
	setIf(out, "disableBuiltins", requiredBoolean(input.disableBuiltins, "disableBuiltins", filePath));
	setIf(out, "disableThinking", requiredBoolean(input.disableThinking, "disableThinking", filePath));

	const maxSpawns = positiveInt(
		input.maxSubagentSpawnsPerSession,
		"maxSubagentSpawnsPerSession",
		filePath,
	);
	if (maxSpawns !== undefined) out.maxSubagentSpawnsPerSession = maxSpawns;

	const modelScope = parseModelScopeConfig(input.modelScope, { filePath });
	if (modelScope) out.modelScope = modelScope;

	const herdr = parseHerdrSettings(input.herdr, filePath);
	if (herdr) out.herdr = herdr;

	readJoinFields(input, out, filePath);

	// THE WHITELIST: every key read above must be assigned, or it is silently
	// discarded. `presets` is the newest key and the easiest to drop here.
	setIf(out, "presets", parsePresets(input.presets, { filePath }));

	return out;
}

/** Assign `value` when present, leaving the key absent otherwise. */
function setIf<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined,
): void {
	if (value !== undefined) target[key] = value;
}

/** A non-empty trimmed string, or `undefined` when the key is absent. */
function requiredString(
	value: unknown,
	key: string,
	filePath: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${key}'; expected a non-empty string.`,
		);
	}
	return value.trim();
}

/** A boolean, or `undefined` when the key is absent. */
function requiredBoolean(
	value: unknown,
	key: string,
	filePath: string,
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${key}'; expected a boolean.`,
		);
	}
	return value;
}

/** True for a non-array JSON-style object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overrideFieldExpected(field: string): string | undefined {
	if (["description", "model", "preset", "output", "systemPrompt"].includes(field)) return "a string";
	if (field === "thinking") return "a string or false";
	if (field === "kind") return `one of: ${AGENT_KINDS.join(", ")}`;
	if (field === "placement") return "a valid placement";
	if (field === "onBlocked") return "a valid onBlocked policy";
	if (field === "systemPromptMode") return "replace or append";
	if (["inheritProjectContext", "inheritSkills", "defaultProgress", "async", "completionGuard", "allowNestedSubagents", "disabled", "worktree", "steer"].includes(field)) return "a boolean";
	if (["timeoutMs", "toolTimeoutMs", "maxSubagentDepth"].includes(field)) return "a number";
	if (field === "skills") return "an array of strings or false";
	if (["tools", "extensions", "subagentOnlyExtensions", "skillPath", "defaultReads", "fallbackModels", "alias"].includes(field)) return "an array of strings";
	return undefined;
}

function isValidOverrideField(field: string, value: unknown): boolean {
	if (["description", "model", "preset", "output", "systemPrompt"].includes(field)) return typeof value === "string";
	if (field === "thinking") return typeof value === "string" || value === false;
	if (field === "kind") return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
	if (field === "placement") return typeof value === "string" && VALID_PLACEMENTS.has(value);
	if (field === "onBlocked") return typeof value === "string" && VALID_ON_BLOCKED_POLICIES.has(value);
	if (field === "systemPromptMode") return value === "replace" || value === "append";
	if (["inheritProjectContext", "inheritSkills", "defaultProgress", "async", "completionGuard", "allowNestedSubagents", "disabled", "worktree", "steer"].includes(field)) return typeof value === "boolean";
	if (["timeoutMs", "toolTimeoutMs", "maxSubagentDepth"].includes(field)) return typeof value === "number";
	if (field === "skills") return value === false || isStringArray(value);
	if (["tools", "extensions", "subagentOnlyExtensions", "skillPath", "defaultReads", "fallbackModels", "alias"].includes(field)) return isStringArray(value);
	return true;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate the types of the supported fields in one override object. */
function parseAgentOverride(
	value: unknown,
	field: string,
	filePath: string,
): AgentOverride {
	if (!isRecord(value)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${field}'; expected an object of agent fields.`,
		);
	}
	for (const [key, member] of Object.entries(value)) {
		const expected = overrideFieldExpected(key);
		if (
			expected &&
			(OVERRIDE_FIELDS as readonly string[]).includes(key) &&
			!isValidOverrideField(key, member)
		) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${field}.${key}'; expected ${expected}.`,
			);
		}
	}
	return value as AgentOverride;
}

/**
 * Validate `agentOverrides`; scalar entries or invalid supported fields must not
 * pass validation and then disappear during the field-by-field merge.
 */
function parseAgentOverrides(
	value: unknown,
	filePath: string,
): SubagentsSettings["agentOverrides"] {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid 'agentOverrides'; expected an object.`,
		);
	}
	for (const [name, override] of Object.entries(value)) {
		if (!isRecord(override)) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid 'agentOverrides.${name}'; expected an object of agent fields.`,
			);
		}
	}
	return value as SubagentsSettings["agentOverrides"];
}

type InvalidTeamSetting = (field: string, expected: string) => never;

function parseTeamMember(
	value: unknown,
	field: string,
	filePath: string,
	bad: InvalidTeamSetting,
): TeamMember {
	if (typeof value === "string") {
		if (!value.trim()) bad(field, "expected a non-empty string or agent object");
		return value.trim();
	}
	if (!isRecord(value)) bad(field, "expected a non-empty string or agent object");
	const agent = requiredString(value.agent, `${field}.agent`, filePath);
	if (!agent) bad(`${field}.agent`, "expected a non-empty string");
	const { agent: _agent, ...override } = value;
	return { agent, ...parseAgentOverride(override, field, filePath) };
}

/** Validate the named team map and its ordered member references. */
function parseTeams(
	value: unknown,
	filePath: string,
): SubagentsSettings["teams"] {
	if (value === undefined) return undefined;
	const bad: InvalidTeamSetting = (field, expected) => {
		throw new Error(`Subagent settings in '${filePath}' have invalid '${field}'; ${expected}.`);
	};
	if (!isRecord(value)) bad("teams", "expected an object");
	const out = Object.create(null) as Record<string, TeamConfig>;
	for (const [name, raw] of Object.entries(value)) {
		const field = `teams.${name}`;
		if (name === "default") bad(field, "'default' is reserved");
		if (name === "__proto__") bad(field, "'__proto__' is not allowed");
		if (!isRecord(raw)) bad(field, "expected an object");
		if (!Array.isArray(raw.members) || raw.members.length === 0) {
			bad(`${field}.members`, "expected a non-empty array");
		}
		const members = raw.members.map((member, index) =>
			parseTeamMember(member, `${field}.members[${index}]`, filePath, bad),
		);
		if (raw.description !== undefined && typeof raw.description !== "string") {
			bad(`${field}.description`, "expected a string");
		}
		out[name] = {
			...(raw.description !== undefined ? { description: raw.description } : {}),
			members,
		};
	}
	return out;
}

/**
 * Load settings from disk. A missing file yields `{}`; malformed content throws
 * with the offending path so the user can fix it.
 */
export function loadSubagentSettings(
	opts: LoadSettingsOptions,
): SubagentsSettings {
	const merged: SubagentsSettings = {};

	const userDoc = readJson(opts.userSettingsPath);
	Object.assign(merged, parseSubagentSettings(userDoc, opts.userSettingsPath));

	if (opts.projectSettingsPath) {
		const projectDoc = readJson(opts.projectSettingsPath);
		const project = parseSubagentSettings(projectDoc, opts.projectSettingsPath);
		Object.assign(merged, resolveSubagentSettings(merged, project));
	}

	return merged;
}

/**
 * Merge project settings over user settings.
 * `herdr`, `agentOverrides`, `teams` and `presets` shallow-merge;
 * `modelScope` is replaced wholesale. A project team with the same name
 * replaces the user's complete team definition.
 */
export function resolveSubagentSettings(
	user: SubagentsSettings,
	project: SubagentsSettings,
): SubagentsSettings {
	const out: SubagentsSettings = { ...user };

	if (project.enabled !== undefined) out.enabled = project.enabled;

	if (project.defaultModel !== undefined)
		out.defaultModel = project.defaultModel;
	if (project.defaultProvider !== undefined)
		out.defaultProvider = project.defaultProvider;
	if (project.defaultOnBlocked !== undefined)
		out.defaultOnBlocked = project.defaultOnBlocked;
	if (project.disableBuiltins !== undefined)
		out.disableBuiltins = project.disableBuiltins;
	if (project.disableThinking !== undefined)
		out.disableThinking = project.disableThinking;
	if (project.maxSubagentSpawnsPerSession !== undefined) {
		out.maxSubagentSpawnsPerSession = project.maxSubagentSpawnsPerSession;
	}

	if (project.modelScope !== undefined)
		out.modelScope = project.modelScope as ModelScopeConfig;

	if (project.agentOverrides) {
		out.agentOverrides = {
			...(user.agentOverrides ?? {}),
			...project.agentOverrides,
		};
	}

	if (project.teams) {
		out.teams = {
			...(user.teams ?? {}),
			...project.teams,
		};
	}
	if (project.team !== undefined) out.team = project.team;

	if (project.herdr) {
		out.herdr = { ...(user.herdr ?? {}), ...project.herdr };
	}

	if (project.presets) {
		out.presets = { ...(user.presets ?? {}), ...project.presets };
	}

	if (project.joinMode !== undefined) out.joinMode = project.joinMode;
	if (project.joinFlushMs !== undefined)
		out.joinFlushMs = project.joinFlushMs;

	return out;
}
