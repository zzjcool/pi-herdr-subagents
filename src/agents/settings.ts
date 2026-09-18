/**
 * Subagent settings: read + validate the `subagents` key from settings.json.
 *
 * Design ref: §6.3.
 * Project settings win over user settings for the overlapping keys.
 */

import * as fs from "node:fs";
import type {
	HerdrSettings,
	ModelScopeConfig,
	Placement,
	SubagentsSettings,
} from "../shared/types.ts";
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

	// Each reader validates one field and returns `undefined` when absent, so a
	// missing key and a rejected key stay distinguishable (only the latter throws).
	setIf(out, "defaultModel", requiredString(input.defaultModel, "defaultModel", filePath));
	setIf(out, "defaultProvider", requiredString(input.defaultProvider, "defaultProvider", filePath));
	setIf(out, "agentOverrides", parseAgentOverrides(input.agentOverrides, filePath));
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

/**
 * Validate `agentOverrides`.
 *
 * Each value must be an object. A scalar used to pass validation and was then
 * ignored by the field-by-field merge, so the override looked configured while
 * doing nothing (the F45 failure mode).
 */
function parseAgentOverrides(
	value: unknown,
	filePath: string,
): SubagentsSettings["agentOverrides"] {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid 'agentOverrides'; expected an object.`,
		);
	}
	for (const [name, override] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (!override || typeof override !== "object" || Array.isArray(override)) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid 'agentOverrides.${name}'; expected an object of agent fields.`,
			);
		}
	}
	return value as SubagentsSettings["agentOverrides"];
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
 * `herdr`, `agentOverrides` and `presets` shallow-merge;
 * `modelScope` is replaced wholesale.
 */
export function resolveSubagentSettings(
	user: SubagentsSettings,
	project: SubagentsSettings,
): SubagentsSettings {
	const out: SubagentsSettings = { ...user };

	if (project.defaultModel !== undefined)
		out.defaultModel = project.defaultModel;
	if (project.defaultProvider !== undefined)
		out.defaultProvider = project.defaultProvider;
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

	if (project.herdr) {
		out.herdr = { ...(user.herdr ?? {}), ...project.herdr };
	}

	if (project.presets) {
		out.presets = { ...(user.presets ?? {}), ...project.presets };
	}

	return out;
}
