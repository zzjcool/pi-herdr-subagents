/**
 * Pure step-model resolution: preset expansion + model precedence.
 *
 * Extracted from `index.ts` so the launch wiring is testable without herdr.
 * Everything here is a pure function of its inputs — no panes, no process
 * state, no I/O — because the two invariants this module owns are the ones the
 * feature is judged on:
 *
 *   1. A referenced preset's kind/model/thinking reach the child, and its
 *      model beats `agentOverrides` (which `loadCatalog` folds into
 *      `agent.model` before anything here runs).
 *   2. `kind` and the FINAL model are coherent, or the launch is refused
 *      loudly instead of dropping the model at start (`nativeModelFor`).
 *
 * Invariant 2 is checked on the resolved model, NOT on the preset's own
 * `model`: the launched model can come from a level above or below the preset
 * (a per-run tool `model`, `defaultModel`, the dispatch model, an override),
 * so validating the preset's own pair would let an incoherent pair ship.
 */

import type { AgentConfig, PresetConfig } from "../shared/types.ts";
import { providerOf, resolveModel, type ResolvedModel } from "./model-resolution.ts";
import { assertKindModelCoherent, expandPreset } from "./presets.ts";

export interface StepModelInput {
	/** The catalog agent, with `agentOverrides` already folded in. */
	agent: AgentConfig;
	/** Per-step overrides (a `tasks[]`/`chain[]` entry). */
	step: { model?: string; preset?: string };
	/** Top-level tool params that act as per-run overrides for every step. */
	params: { model?: string; preset?: string };
	/** The parent session's model as `provider/id`, if known. */
	dispatchModel?: string;
	settings: {
		agentOverrides?: Record<string, Partial<AgentConfig>>;
		agentOverridesByProvider?: Record<string, Record<string, Partial<AgentConfig>>>;
		presets?: Record<string, PresetConfig>;
		defaultModel?: string;
	};
}

export interface StepModelResult {
	resolved: ResolvedModel;
	/** The agent to hand to `orchestrator.launch` (preset-patched when one applied). */
	agent: AgentConfig;
	/** True when a preset was referenced and expanded. */
	usedPreset: boolean;
}

/**
 * Resolve the model (and the effective agent) a step will launch with.
 *
 * Throws when a referenced preset is undefined, or when the resolved
 * kind/model pair would be silently dropped at start. Callers are expected to
 * turn those into a refusal line rather than letting them escape.
 */
export function resolveStepModel(input: StepModelInput): StepModelResult {
	const override = input.step.model ?? input.params.model;

	const expanded = expandPreset({
		agent: input.agent,
		toolPreset: input.step.preset ?? input.params.preset,
		...(input.settings.presets ? { presets: input.settings.presets } : {}),
	});

	const effective = expanded?.agent ?? input.agent;

	const resolved = resolveModel({
		agent: effective,
		...(override ? { override } : {}),
		...(expanded?.presetModel ? { presetModel: expanded.presetModel } : {}),
		...(input.dispatchModel ? { dispatchModel: input.dispatchModel } : {}),
		...(input.settings.defaultModel
			? { defaultModel: input.settings.defaultModel }
			: {}),
		...(input.dispatchModel
			? { parentProvider: providerOf(input.dispatchModel) }
			: {}),
		settings: input.settings as Parameters<typeof resolveModel>[0]["settings"],
	});

	// Only a preset can make the kind disagree with the launched model in a way
	// this module is responsible for. An agent that merely sets `kind` keeps its
	// pre-existing behaviour (that is an older, separate concern).
	if (expanded) {
		assertKindModelCoherent(
			effective.kind,
			resolved.model,
			expanded.presetName,
			describeModelOrigin(resolved, override, input.dispatchModel),
		);
	}

	return { resolved, agent: effective, usedPreset: expanded !== undefined };
}

/**
 * Human-readable origin for a coherence error, so the blame lands correctly.
 *
 * `resolved.source.type` alone is not enough: `"dispatch"` is emitted both for
 * the per-run `model` override (model-resolution.ts) AND for the fall-through to
 * the dispatching session's model. Those are different claims — one was chosen
 * by the caller, the other is just the parent's model — so they are told apart
 * by comparing the winning model against the two inputs.
 */
function describeModelOrigin(
	resolved: ResolvedModel,
	override: string | undefined,
	dispatchModel: string | undefined,
): string | undefined {
	const source = resolved.source;
	if (!source) return undefined;
	if (source.type === "dispatch") {
		if (override !== undefined && resolved.model === override) {
			return "the per-run model override";
		}
		if (dispatchModel !== undefined && resolved.model === dispatchModel) {
			return "the parent session model";
		}
		return "the per-run model override";
	}
	switch (source.type) {
		case "preset":
			return "the preset";
		case "agentOverrides":
			return "agentOverrides";
		case "frontmatter":
			return "the agent's frontmatter";
		case "subagents.defaultModel":
			return "subagents.defaultModel";
		case "inherit":
			return "the parent session model";
		default:
			return undefined;
	}
}
