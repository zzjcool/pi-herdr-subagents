/**
 * Named kind+model+thinking presets (`subagents.presets`).
 *
 * A preset is referenced by name from agent frontmatter (`preset: cheap`),
 * from `agentOverrides.<name>.preset`, or from the tool's `preset` param.
 * It slots into model precedence at level 2 — below the per-run tool
 * `model`, above `agentOverrides` (design §6.2).
 *
 * Two invariants live here:
 *
 *  1. ATOMICITY — `kind` and `model` come from the same preset object.
 *     `nativeModelFor("cursor", "cb/kimi-k3")` returns `undefined`, so a
 *     mismatched pair would silently drop the model and start the child on
 *     the CLI default. `assertKindModelCoherent` rejects that combination
 *     at expansion time instead of letting the launch proceed.
 *
 *  2. LOUD UNDEFINED — a referenced preset name with no matching entry is
 *     an error that names the defined presets, never a silent fallback to
 *     the dispatch model (mirrors `checkModelScope`'s out-of-scope error).
 */

import {
	AGENT_KINDS,
	type AgentConfig,
	type AgentKind,
	type ModelSourceInfo,
	type PresetConfig,
	type SubagentsSettings,
} from "../shared/types.ts";
import { nativeModelFor } from "../runs/kind.ts";

const VALID_KINDS: ReadonlySet<string> = new Set(AGENT_KINDS);

/**
 * Validate + normalize raw `subagents.presets`. Throws on malformed values.
 *
 * `undefined` input means the key is absent (not an error); every present
 * value must be a record of `{kind?, model?, thinking?}` objects, because a
 * config that passes validation and is then ignored is the exact
 * "accepted but inert" trap this feature is designed against.
 */
export function parsePresets(
	value: unknown,
	meta: { filePath: string },
): Record<string, PresetConfig> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' have invalid 'presets'; expected an object.`,
		);
	}
	const out: Record<string, PresetConfig> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		out[name] = parsePreset(name, raw, meta.filePath);
	}
	return out;
}

function parsePreset(
	name: string,
	raw: unknown,
	filePath: string,
): PresetConfig {
	const label = `presets.${name}`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${label}'; expected an object with kind/model/thinking.`,
		);
	}
	const input = raw as Record<string, unknown>;
	const out: PresetConfig = {};

	if (input.kind !== undefined) {
		if (typeof input.kind !== "string" || !VALID_KINDS.has(input.kind)) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${label}.kind'; ` +
					`expected one of: ${AGENT_KINDS.join(", ")}.`,
			);
		}
		out.kind = input.kind as AgentKind;
	}

	if (input.model !== undefined) {
		if (typeof input.model !== "string" || !input.model.trim()) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${label}.model'; expected a non-empty string.`,
			);
		}
		out.model = input.model.trim();
	}

	const thinking = input.thinking;
	if (thinking !== undefined) {
		if (thinking === false) {
			out.thinking = false;
		} else if (typeof thinking === "string" && thinking.trim()) {
			out.thinking = thinking.trim();
		} else {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${label}.thinking'; expected a non-empty string or false.`,
			);
		}
	}

	return out;
}

/**
 * Highest-precedence preset reference: tool param > agentOverrides > frontmatter.
 *
 * The caller folds `agentOverrides` into the agent BEFORE this runs, so
 * `agent.preset` already reflects the first two levels below the tool param.
 */
export function resolvePresetName(input: {
	toolPreset?: string;
	agent: AgentConfig;
	settings?: SubagentsSettings;
}): { name: string; source: ModelSourceInfo["type"] } | undefined {
	const tool = input.toolPreset?.trim();
	if (tool) return { name: tool, source: "dispatch" };
	const agentPreset = input.agent.preset?.trim();
	if (agentPreset) return { name: agentPreset, source: "preset" };
	return undefined;
}

/**
 * Look up `name`; throw a descriptive error when undefined.
 *
 * The message lists the presets that ARE defined so a shared agent package
 * shipping `preset:` gets an actionable error on a host with no presets,
 * not a mystery model from a silent fallback.
 */
export function requirePreset(
	name: string,
	presets: Record<string, PresetConfig> | undefined,
): PresetConfig {
	const preset = presets?.[name];
	if (preset) return preset;
	const defined = Object.keys(presets ?? {});
	const suffix = defined.length
		? `Defined: ${defined.join(", ")}.`
		: "None are defined.";
	throw new Error(
		`Preset '${name}' is not defined in subagents.presets. ${suffix}`,
	);
}

/**
 * Throw when `nativeModelFor(kind, model)` would silently drop the model.
 *
 * Reuses `nativeModelFor` rather than re-implementing the shape test, so the
 * guard can never disagree with the argv builder about what a kind accepts.
 */
export function assertKindModelCoherent(
	kind: AgentKind,
	model: string | undefined,
	presetName: string,
): void {
	if (!model) return;
	if (nativeModelFor(kind, model) === undefined) {
		throw new Error(
			`Preset '${presetName}' sets model '${model}', which kind '${kind}' cannot accept ` +
				`(it would be silently dropped at start). Fix the preset's kind or model.`,
		);
	}
}

/**
 * Return a COPY of `agent` with kind/model/thinking from `preset`.
 *
 * All three fields are written together from the same object — the atomicity
 * invariant. `undefined` preset fields leave the agent's value untouched;
 * `modelSource` records the provenance when the preset sets a model.
 */
export function applyPreset(
	agent: AgentConfig,
	presetName: string,
	preset: PresetConfig,
): AgentConfig {
	const out: AgentConfig = { ...agent };
	out.preset = presetName;
	if (preset.kind !== undefined) out.kind = preset.kind;
	if (preset.model !== undefined) {
		out.model = preset.model;
		out.modelSource = { type: "preset", model: preset.model };
	}
	if (preset.thinking !== undefined) out.thinking = preset.thinking;
	return out;
}
