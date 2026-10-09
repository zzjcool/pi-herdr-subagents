/**
 * Slash commands for model profiles (cheap / medium / strong).
 *
 * Same names as pi-subagents so the workflow is familiar:
 *   /subagents-profiles
 *   /subagents-load-profile <name>
 *   /subagents-refresh-provider-models <provider> [--force] [--no-probe]
 *   /subagents-generate-profiles <provider> [--no-probe]
 *   /subagents-check-profile <name> [--no-probe]
 *
 * Plus the human-facing roster listing:
 *   /subagents-agents [user|project|both]
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentConfig,
	AgentScope,
	SubagentsSettings,
} from "../shared/types.ts";
import {
	applySubagentProfile,
	checkSubagentProfile,
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	generateProfilesForProvider,
	getProfileWorkerModel,
	listSubagentProfiles,
	PROFILES_DIR_NAME,
	readSubagentProfile,
	refreshProviderModelCatalog,
	readSettingsFile,
	writeJsonFile,
	type ModelRegistryLike,
} from "../profiles/profiles.ts";
import { classifyModelOrigin, resolveStepModel } from "../agents/step-model.ts";
import { checkModelScope } from "../agents/model-scope.ts";
import { nativeModelFor } from "../runs/kind.ts";
import {
	DEFAULT_TEAM,
	TEAM_ENV,
	listTeamNames,
	type ActiveTeam,
} from "../agents/teams.ts";
import { getAgentDir } from "../agents/paths.ts";

export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text";

export type TeamCommandArgs =
	| { action: "show" }
	| { action: "list" }
	| { action: "use"; name: string; global: boolean }
	| { action: "create"; name: string; members: string[]; global: boolean };

/** Pure parser for /subagents-team arguments. */
export function parseTeamCommandArgs(
	args: string,
): { ok: true; value: TeamCommandArgs } | { ok: false; message: string } {
	const usage =
		"Usage: /subagents-team [list|use <name> [--global]|create <name> a,b,c [--global]]";
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, value: { action: "show" } };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const action = tokens.shift();
	if (action === "list" && tokens.length === 0)
		return { ok: true, value: { action: "list" } };
	if (action !== "use" && action !== "create")
		return { ok: false, message: usage };
	const global = tokens.includes("--global");
	const rest = tokens.filter((token) => token !== "--global");
	if (tokens.filter((token) => token === "--global").length > 1)
		return { ok: false, message: usage };
	if (action === "use") {
		if (rest.length !== 1 || !rest[0]?.trim())
			return { ok: false, message: usage };
		return { ok: true, value: { action, name: rest[0].trim(), global } };
	}
	if (rest.length < 2 || !rest[0]?.trim())
		return { ok: false, message: usage };
	const memberText = rest.slice(1).join(" ");
	const rawMembers = memberText.split(",");
	const members = rawMembers.map((member) => member.trim());
	if (members.some((member) => !member))
		return { ok: false, message: usage };
	return {
		ok: true,
		value: { action, name: rest[0].trim(), members, global },
	};
}

export interface ProfileCommandDeps {
	getModelRegistry?: () => ModelRegistryLike | undefined;
}

export function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SLASH_TEXT_RESULT_TYPE,
		content: text,
		display: true,
	});
}

async function withSlashStatus<T>(
	ctx: ExtensionContext,
	text: string,
	run: () => Promise<T>,
): Promise<T> {
	if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", text);
	try {
		return await run();
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", undefined);
	}
}

export function parseSingleRequiredArg(
	args: string,
	usage: string,
): { ok: true; value: string } | { ok: false; message: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 1) return { ok: false, message: usage };
	const value = parts[0];
	if (!value) return { ok: false, message: usage };
	return { ok: true, value };
}

function stripFlag(
	args: string,
	flag: string,
): { rest: string; present: boolean } {
	const pattern = new RegExp(`(?:^|\\s)${flag}(?=\\s|$)`);
	const present = pattern.test(args);
	return { rest: args.replace(pattern, " ").trim(), present };
}

export function parseProviderArgs(
	args: string,
	usage: string,
):
	| { ok: true; provider: string; force: boolean; probe: boolean }
	| { ok: false; message: string } {
	let rest = args.trim();
	const forceA = stripFlag(rest, "--force");
	rest = forceA.rest;
	const forceB = stripFlag(rest, "force");
	rest = forceB.rest;
	const noProbe = stripFlag(rest, "--no-probe");
	rest = noProbe.rest;
	const parsed = parseSingleRequiredArg(rest, usage);
	if (parsed.ok === false) return parsed;
	return {
		ok: true,
		provider: parsed.value,
		force: forceA.present || forceB.present,
		probe: !noProbe.present,
	};
}

function parseNamedArgs(
	args: string,
	usage: string,
):
	| { ok: true; name: string; probe: boolean }
	| { ok: false; message: string } {
	const noProbe = stripFlag(args.trim(), "--no-probe");
	const parsed = parseSingleRequiredArg(noProbe.rest, usage);
	if (parsed.ok === false) return parsed;
	return { ok: true, name: parsed.value, probe: !noProbe.present };
}

function profileCompletions(prefix: string) {
	if (prefix.includes(" ")) return null;
	return listSubagentProfiles()
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ value: name, label: name }));
}

function providerCompletions(
	prefix: string,
	getRegistry: ProfileCommandDeps["getModelRegistry"],
	fallback?: ModelRegistryLike,
) {
	if (prefix.includes(" ")) return null;
	const registry = fallback ?? getRegistry?.();
	if (!registry) return null;
	const available = registry.getAvailable();
	if (!Array.isArray(available)) return null;
	const providers = [
		...new Set(
			available
				.map((model) =>
					typeof model?.provider === "string" ? model.provider : "",
				)
				.filter(Boolean),
		),
	].sort((a, b) => a.localeCompare(b));
	return providers
		.filter((provider) => provider.startsWith(prefix))
		.map((provider) => ({ value: provider, label: provider }));
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
	ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function assertCreatableTeamName(
	name: string,
	...catalogs: Array<Record<string, unknown>>
): void {
	if (name === DEFAULT_TEAM || name === "__proto__") {
		throw new Error(`Team name "${name}" is reserved.`);
	}
	if (catalogs.some((teams) => Object.hasOwn(teams, name))) {
		throw new Error(`Team "${name}" already exists; edit it manually instead.`);
	}
}

async function maybeSwitchSessionModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	workerModel: string,
	lines: string[],
): Promise<void> {
	if (
		typeof pi.setModel !== "function" ||
		typeof ctx.modelRegistry?.find !== "function" ||
		typeof ctx.modelRegistry?.getAvailable !== "function"
	) {
		lines.push(`Profile worker model: ${workerModel}`);
		return;
	}

	const shouldSwitch = ctx.hasUI
		? await ctx.ui.confirm(
				"",
				`Profile loaded. Also switch this session to the profile worker model?\n\n${workerModel}`,
			)
		: false;
	if (!shouldSwitch) return;

	const available = ctx.modelRegistry.getAvailable();
	const match = available.find(
		(model) => `${model.provider}/${model.id}` === workerModel.split(":")[0],
	);
	if (!match) {
		lines.push(
			`Could not switch current session model: '${workerModel}' is not available in the current model registry.`,
		);
		return;
	}
	const model = ctx.modelRegistry.find(match.provider, match.id);
	if (!model) {
		lines.push(
			`Could not switch current session model: '${workerModel}' is not available in the current model registry.`,
		);
		return;
	}
	const success = await pi.setModel(model);
	if (success) {
		lines.push(`Current session model switched to: ${match.provider}/${match.id}`);
	} else {
		lines.push(
			`Could not switch current session model to '${workerModel}': no API key or provider access is available.`,
		);
	}
}

/** Register the five profile slash commands on a Pi extension. */
export function registerProfileCommands(
	pi: ExtensionAPI,
	deps: ProfileCommandDeps = {},
): void {
	pi.registerCommand("subagents-profiles", {
		description: "List saved subagent model profiles",
		handler: async (_args, _ctx) => {
			const profiles = listSubagentProfiles();
			if (profiles.length === 0) {
				sendSlashText(
					pi,
					`Subagent profiles\n\nNo subagent profiles found in ~/.pi/agent/profiles/${PROFILES_DIR_NAME}/`,
				);
				return;
			}
			sendSlashText(pi, `Subagent profiles\n\n${profiles.join("\n")}`);
		},
	});

	pi.registerCommand("subagents-load-profile", {
		description: "Load a subagent profile into ~/.pi/agent/settings.json",
		getArgumentCompletions: (prefix) => profileCompletions(prefix),
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(
				args,
				"Usage: /subagents-load-profile <name>",
			);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(
					ctx,
					`Loading profile ${parsed.value}…`,
					async () => {
						const { profile } = readSubagentProfile(parsed.value);
						const workerModel = getProfileWorkerModel(profile);
						const result = applySubagentProfile(parsed.value);
						const lines = [
							`Loaded subagent profile: ${parsed.value}`,
							`Profile: ${result.filePath}`,
							`Updated: ${result.settingsPath}`,
						];
						if (workerModel) {
							await maybeSwitchSessionModel(pi, ctx, workerModel, lines);
						}
						sendSlashText(pi, lines.join("\n"));
					},
				);
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});

	pi.registerCommand("subagents-refresh-provider-models", {
		description: "Refresh the cached model catalog for one provider",
		getArgumentCompletions: (prefix) =>
			providerCompletions(prefix, deps.getModelRegistry),
		handler: async (args, ctx) => {
			const parsed = parseProviderArgs(
				args,
				"Usage: /subagents-refresh-provider-models <provider> [--force] [--no-probe]",
			);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(
					ctx,
					`Refreshing provider models for ${parsed.provider}…`,
					async () => {
						const result = await refreshProviderModelCatalog(
							pi,
							ctx.modelRegistry,
							parsed.provider,
							{
								force: parsed.force,
								probe: parsed.probe,
								maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
							},
						);
						const lines = [
							"Provider model catalog",
							`Provider: ${parsed.provider}`,
							`Status: ${result.reused ? "fresh cache reused" : "refreshed"}`,
							`File: ${result.filePath}`,
							`Models: ${result.catalog.models.length}`,
							`Refreshed at: ${result.catalog.refreshedAt}`,
						];
						if (result.heuristicFallbackCount > 0) {
							const n = result.heuristicFallbackCount;
							lines.push(
								`Warning: ${n} model${n === 1 ? " was" : "s were"} classified with name heuristics fallback.`,
							);
						}
						sendSlashText(pi, lines.join("\n"));
					},
				);
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});

	pi.registerCommand("subagents-generate-profiles", {
		description:
			"Generate <provider>.quota and <provider>.quality subagent profiles",
		getArgumentCompletions: (prefix) =>
			providerCompletions(prefix, deps.getModelRegistry),
		handler: async (args, ctx) => {
			const parsed = parseProviderArgs(
				args,
				"Usage: /subagents-generate-profiles <provider> [--force] [--no-probe]",
			);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(
					ctx,
					`Generating profiles for ${parsed.provider}…`,
					async () => {
						const result = await generateProfilesForProvider(
							pi,
							ctx.modelRegistry,
							parsed.provider,
							{
								maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
								forceRefresh: parsed.force,
								probe: parsed.probe,
							},
						);
						const lines = [
							"Generated subagent profiles",
							`Provider: ${parsed.provider}`,
							`Catalog: ${result.catalogPath}`,
							`Quota: ${result.quotaPath}`,
							`  cheap=${result.quotaModels.cheap}`,
							`  medium=${result.quotaModels.medium}`,
							`  strong=${result.quotaModels.strong}`,
							`Quality: ${result.qualityPath}`,
							`  cheap=${result.qualityModels.cheap}`,
							`  medium=${result.qualityModels.medium}`,
							`  strong=${result.qualityModels.strong}`,
						];
						if (result.selectedHeuristicFallbackCount > 0) {
							const n = result.selectedHeuristicFallbackCount;
							lines.push(
								`Warning: generated profiles depend on heuristic-only classification for ${n} selected model${n === 1 ? "" : "s"}.`,
							);
						} else if (result.heuristicFallbackCount > 0) {
							const n = result.heuristicFallbackCount;
							lines.push(
								`Warning: provider catalog still contains ${n} heuristic-classified model${n === 1 ? "" : "s"}.`,
							);
						}
						sendSlashText(pi, lines.join("\n"));
					},
				);
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});

	pi.registerCommand("subagents-check-profile", {
		description: "Check whether a saved profile still points to usable models",
		getArgumentCompletions: (prefix) => profileCompletions(prefix),
		handler: async (args, ctx) => {
			const parsed = parseNamedArgs(
				args,
				"Usage: /subagents-check-profile <name> [--no-probe]",
			);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(
					ctx,
					`Checking profile ${parsed.name}…`,
					async () => {
						const result = await checkSubagentProfile(
							pi,
							ctx.modelRegistry,
							parsed.name,
							{ probe: parsed.probe },
						);
						const lines = [
							"Subagent profile check",
							`Profile: ${result.profileName}`,
							`File: ${result.filePath}`,
							"",
							...result.results.map((entry) => {
								const probeMsg = entry.probe.message
									? ` (${entry.probe.message.split(/\r?\n/, 1)[0]})`
									: "";
								return `${entry.agent} → ${entry.model} — registry ${entry.inRegistry ? "ok" : "missing"}; probe ${entry.probe.status}${probeMsg}`;
							}),
						];
						sendSlashText(pi, lines.join("\n"));
					},
				);
				} catch (error) {
				notifyError(ctx, error);
			}
		},
	});
}

// ── /subagents-agents ───────────────────────────────────────────────────────

const AGENT_SCOPES = ["user", "project", "both"] as const;

/** Parse the optional scope argument; empty means the tool default (`user`). */
export function parseAgentsScopeArg(
	args: string,
	usage: string,
): { ok: true; scope: AgentScope | undefined } | { ok: false; message: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { ok: true, scope: undefined };
	if (parts.length > 1) return { ok: false, message: usage };
	const scope = parts[0] as AgentScope;
	if (!AGENT_SCOPES.includes(scope)) return { ok: false, message: usage };
	return { ok: true, scope };
}

/**
 * Render the /subagents-agents listing.
 *
 * Pure function of its inputs so tests can drive it directly. `dispatchModel`
 * is the parent session model as `provider/id` (when known) — supplied so the
 * `model:` line matches what a launch from THIS session would actually use;
 * omit it and roles without an explicit model say so instead of guessing.
 */
export function renderAgentsListing(input: {
	agents: AgentConfig[];
	team?: ActiveTeam;
	teamWarnings?: string[];
	scope: AgentScope;
	projectAgentsDir: string | null;
	builtinAgentsDir: string;
	userAgentsDir?: string;
	settings: SubagentsSettings;
	dispatchModel?: string;
}): string {
	const { agents, scope } = input;
	const lines: string[] = ["Subagent roles", `Scope: ${scope}`];
	const teamWarnings = input.teamWarnings ?? [];
	if (input.team && (input.team.name !== DEFAULT_TEAM || teamWarnings.length > 0)) {
		lines.push(`Active team: ${input.team.name} (source: ${input.team.source})`);
	}
	lines.push(...teamWarnings.map((warning) => `Warning: ${warning}`));

	const groupOrder: Array<AgentConfig["source"]> = ["builtin", "user", "project"];
	for (const group of groupOrder) {
		const members = agents.filter((a) => a.source === group);
		if (members.length === 0) continue;
		lines.push("", `${group} (${members.length})`);
		for (const agent of members) {
			lines.push(renderOneAgent(agent, input));
		}
	}

	if (agents.length === 0) {
		lines.push(
			"",
			"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		);
	}

	lines.push(
		"",
		"Directories",
		`  builtin: ${input.builtinAgentsDir}`,
		`  user: ${input.userAgentsDir ?? "~/.pi/agent/agents"}${
			scope === "project" ? " (skipped by scope)" : ""
		}`,
		`  project: ${input.projectAgentsDir ?? "(none found)"}`,
	);
	if (input.settings.disableBuiltins === true) {
		lines.push(
			"  (builtin layer disabled by subagents.disableBuiltins)",
		);
	}
	return lines.join("\n");
}

function renderOneAgent(
	agent: AgentConfig,
	input: {
		settings: SubagentsSettings;
		dispatchModel?: string;
	},
): string {
	const lines: string[] = [`  ${agent.name}`];
	lines.push(`    ${agent.description}`);

	const details: string[] = [];
	if (agent.kind !== "pi") details.push(`kind=${agent.kind}`);
	if (agent.alias?.length) details.push(`alias: ${agent.alias.join(", ")}`);

	// Model resolution mirrors the launch path (resolveStepModel) so the line
	// reports what a launch from this session would use — a preset's
	// kind/model/thinking fold in, and precedence is the real one.
	try {
		const resolved = resolveStepModel({
			agent,
			step: {},
			params: {},
			settings: input.settings,
			...(input.dispatchModel ? { dispatchModel: input.dispatchModel } : {}),
		});
		if (resolved.resolved.model) {
			details.push(modelLine(agent, resolved, input.settings));
		} else {
			details.push("model: (agent CLI default)");
		}
	} catch {
		// An undefined preset or an incoherent kind/model pair throws here —
		// the launch would refuse too. Report it instead of guessing.
		details.push(
			`model: ${agent.model ?? "(agent CLI default)"} (unresolvable — a launch with this configuration would be refused)`,
		);
	}
	lines.push(`    ${details.join(" · ")}`);

	lines.push(`    file: ${agent.filePath}`);
	if (agent.unenforcedFields?.length) {
		lines.push(
			`    ⚠ not enforced yet: ${agent.unenforcedFields.join(", ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * The `model:` detail line, including everything the LAUNCH path would do
 * with that model. Three behaviours are replicated so the listing tells the
 * truth about a launch instead of just naming the model:
 *
 *   - `classifyModelOrigin` (the launch path's own classifier) — so a parent
 *     model falling through is labelled `parent session model`, never
 *     `per-run override` (which cannot happen from this command: step and
 *     params are empty).
 *   - `checkModelScope` — an out-of-scope model is flagged exactly like
 *     `launchStep` would flag it (error-severity for explicit models).
 *   - `nativeModelFor` — a model the target kind cannot express is either a
 *     launch refusal (explicit origin, mirroring `planModelCandidates`) or a
 *     documented drop to the CLI's own default (inherited origin).
 */
function modelLine(
	agent: AgentConfig,
	resolved: ReturnType<typeof resolveStepModel>,
	settings: SubagentsSettings,
): string {
	const model = resolved.resolved.model as string;
	const { origin, label } = classifyModelOrigin(resolved.resolved, undefined);

	const parts = [`model: ${model} (${label ?? "resolved"})`];

	// Same settings, same severity semantics as `launchStep`.
	const violation = checkModelScope(
		model,
		settings.modelScope,
		origin === "explicit" ? "explicit" : "inherited",
	);
	if (violation) {
		parts.push(
			violation.severity === "error"
				? `✗ outside model scope — a launch would refuse this`
				: `⚠ outside model scope — a launch would warn`,
		);
	}

	// Kind/model coherence: a model the target CLI cannot express.
	if (agent.kind !== "pi") {
		const native = nativeModelFor(agent.kind, model, agent.thinking);
		if (native === undefined) {
			if (origin === "explicit") {
				parts.push(
					`✗ cannot be used with kind '${agent.kind}' — a launch would refuse this`,
				);
			} else {
				parts.push(
					`dropped at launch: kind '${agent.kind}' runs on its own default`,
				);
			}
		}
	}

	return parts.join(" · ");
}

export interface AgentsCommandDeps {
	/** Load the agent catalog the same way the subagent tool does. */
	loadCatalog: (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => {
		agents: AgentConfig[];
		settings: SubagentsSettings;
		team?: ActiveTeam;
		teamWarnings?: string[];
		projectAgentsDir: string | null;
		builtinAgentsDir: string;
		userAgentsDir?: string;
	};
}

export interface TeamCommandDeps {
	loadCatalog: (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => {
		agents: AgentConfig[];
		allAgents: AgentConfig[];
		settings: SubagentsSettings;
		team: ActiveTeam;
		teamWarnings: string[];
	};
}

/** Parsed `/subagents-toggle` arguments. `on`/`off` are explicit; `flip` inverts. */
export type ToggleCommandArgs =
	| { action: "show" }
	| { action: "flip" }
	| { action: "on" }
	| { action: "off" };

/** Pure parser for `/subagents-toggle` arguments. */
export function parseToggleCommandArgs(
	args: string,
): { ok: true; value: ToggleCommandArgs } | { ok: false; message: string } {
	const usage = "Usage: /subagents-toggle [on|off]";
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, value: { action: "show" } };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.length > 1) return { ok: false, message: usage };
	const action = tokens[0];
	if (action === "on" || action === "off")
		return { ok: true, value: { action } };
	if (action === "flip") return { ok: true, value: { action: "flip" } };
	return { ok: false, message: usage };
}

export interface ToggleCommandDeps {
	/** Whether subagents are currently enabled in THIS session (session-level override included). */
	sessionEnabled: () => boolean;
	/** Flip the session-level override (toggle only; never touches settings files). */
	setSessionEnabled: (enabled: boolean) => void;
	/** Effective `subagents.enabled` from merged settings, for display. */
	settingsEnabled: (cwd: string) => boolean;
	/** Count of currently running children, to warn before turning off mid-flight. */
	runningChildren: () => number;
}

/** Render the status line shown after `/subagents-toggle`. */
export function renderToggleStatus(input: {
	enabled: boolean;
	settingsEnabled: boolean;
	outcome: "shown" | "flipped" | "already-on" | "already-off";
	running: number;
}): string {
	const state = input.enabled ? "enabled" : "disabled";
	const origin = input.enabled === input.settingsEnabled
		? "matches settings"
		: "session override (settings unchanged; /reload restores them)";
	const lines = [`Subagents are ${state} — ${origin}.`];
	switch (input.outcome) {
		case "flipped":
			lines.push(
				input.enabled
					? "New launches are accepted again; the roster returns with the next turn."
					: "No new launches; the roster and the bash dispatch guard are off from the next turn. Existing children are untouched — status/collect/wait keep working.",
			);
			break;
		case "already-on":
			lines.push("Already enabled — nothing to do.");
			break;
		case "already-off":
			lines.push("Already disabled — nothing to do.");
			break;
		default:
			break;
	}
	if (input.running > 0)
		lines.push(
			`${input.running} child${input.running === 1 ? "" : "ren"} still running; they finish and notify normally.`,
		);
	return lines.join("\n");
}

/** Register `/subagents-toggle [on|off]`: session-level enable/disable without touching files. */
export function registerToggleCommand(
	pi: ExtensionAPI,
	deps: ToggleCommandDeps,
): void {
	pi.registerCommand("subagents-toggle", {
		description:
			"Temporarily disable/enable subagents for this session (no files are changed)",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return ["on", "off"]
				.flatMap((value) => (value.startsWith(prefix) ? [{ value, label: value }] : []));
		},
		handler: async (args, ctx) => {
			const parsed = parseToggleCommandArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			const enabled = deps.sessionEnabled();
			const running = deps.runningChildren();
			let outcome: "shown" | "flipped" | "already-on" | "already-off" = "shown";
			let next = enabled;
			const action = parsed.value.action;
			if (action === "flip") {
				next = !enabled;
				outcome = "flipped";
			} else if (action === "on") {
				next = true;
				outcome = enabled ? "already-on" : "flipped";
			} else if (action === "off") {
				next = false;
				outcome = enabled ? "flipped" : "already-off";
			}
			if (parsed.value.action !== "show") deps.setSessionEnabled(next);
			sendSlashText(
				pi,
				renderToggleStatus({
					enabled: next,
					settingsEnabled: deps.settingsEnabled(ctx.cwd),
					outcome,
					running,
				}),
			);
		},
	});
}

/** Register /subagents-agents [user|project|both] on a Pi extension. */
export function registerAgentsCommand(
	pi: ExtensionAPI,
	deps: AgentsCommandDeps,
): void {
	pi.registerCommand("subagents-agents", {
		description:
			"List available subagent roles (use /subagents-agents [user|project|both] to pick a scope)",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return AGENT_SCOPES.filter((scope) => scope.startsWith(prefix)).map(
				(scope) => ({ value: scope, label: scope }),
			);
		},
		handler: async (args, ctx) => {
			const usage = "Usage: /subagents-agents [user|project|both]";
			const parsed = parseAgentsScopeArg(args, usage);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, "Loading subagent roles…", async () => {
					const catalog = deps.loadCatalog({
						sessionCwd: ctx.cwd,
						runCwd: ctx.cwd,
						scope: parsed.scope,
					});
					const dispatchModel = ctx.model
						? `${ctx.model.provider}/${ctx.model.id}`
						: undefined;
					const teamWarnings = catalog.teamWarnings ?? [];
					sendSlashText(
						pi,
						renderAgentsListing({
							agents: catalog.agents,
							...(catalog.team &&
							(catalog.team.name !== DEFAULT_TEAM || teamWarnings.length > 0)
								? { team: catalog.team }
								: {}),
							teamWarnings,
							scope: parsed.scope ?? "user",
							projectAgentsDir: catalog.projectAgentsDir,
							builtinAgentsDir: catalog.builtinAgentsDir,
							...(catalog.userAgentsDir
								? { userAgentsDir: catalog.userAgentsDir }
								: {}),
							settings: catalog.settings,
							...(dispatchModel ? { dispatchModel } : {}),
						}),
					);
				});
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});
}

/** Render the current team status for the no-argument command. */
export function renderTeamStatus(input: {
	agents: AgentConfig[];
	team: ActiveTeam;
	warnings?: string[];
}): string {
	const members = input.agents.map((agent) => agent.name);
	const source = input.team.source;
	const lines = [
		`Active subagent team: ${input.team.name}`,
		`Source: ${source}`,
		`Members (${members.length}): ${members.join(", ") || "(none)"}`,
	];
	for (const warning of input.warnings ?? []) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

/** Preserve all unrelated settings while changing one subagents field. */
export function updateSubagentSettingsFile(
	filePath: string,
	update: (subagents: Record<string, unknown>) => void,
): void {
	const document = readSettingsFile(filePath);
	const raw = document.subagents;
	if (
		raw !== undefined &&
		(!raw || typeof raw !== "object" || Array.isArray(raw))
	) {
		throw new Error(`Settings file '${filePath}' has an invalid 'subagents' object.`);
	}
	const subagents = { ...(raw as Record<string, unknown> | undefined) };
	update(subagents);
	document.subagents = subagents;
	writeJsonFile(filePath, document);
}

/** Register /subagents-team [list|use|create]. */
export function registerTeamCommand(
	pi: ExtensionAPI,
	deps: TeamCommandDeps,
): void {
	pi.registerCommand("subagents-team", {
		description: "Show, list, switch, or create subagent teams",
		handler: async (args, ctx) => {
			const parsed = parseTeamCommandArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, "Loading subagent teams…", async () => {
					const catalog = deps.loadCatalog({
						sessionCwd: ctx.cwd,
						runCwd: ctx.cwd,
						scope: undefined,
					});
					const team = catalog.team;
					const warnings = catalog.teamWarnings;
					const settingsPath = (global: boolean): string =>
						path.join(
							global ? getAgentDir() : ctx.cwd,
							...(global ? [] : [".pi"]),
							"settings.json",
						);
					if (parsed.value.action === "show") {
						sendSlashText(
							pi,
							renderTeamStatus({
								agents: catalog.agents,
								team,
								warnings,
							}),
						);
						return;
					}
					if (parsed.value.action === "list") {
						const names = listTeamNames(catalog.settings);
						const lines = ["Subagent teams"];
						for (const name of names) {
							const teams = catalog.settings.teams ?? {};
							const config = Object.hasOwn(teams, name) ? teams[name] : undefined;
							const marker = name === team.name ? "* " : "  ";
							const description =
								name === DEFAULT_TEAM
									? "all discovered agents"
									: config?.description ?? "(no description)";
							const count =
								name === DEFAULT_TEAM
									? catalog.allAgents.length
									: config?.members.length ?? 0;
							lines.push(`${marker}${name} — ${description} (${count} members)`);
						}
						if (!names.includes(team.name)) {
							lines.push(`* ${team.name} — (not defined; using all agents)`);
						}
						if (warnings.length) lines.push(...warnings.map((w) => `Warning: ${w}`));
						sendSlashText(pi, lines.join("\n"));
						return;
					}

					const command = parsed.value;
					const available = listTeamNames(catalog.settings);
					const target = settingsPath(command.global);
					if (command.action === "use") {
						const teams = catalog.settings.teams ?? {};
						if (
							command.name !== DEFAULT_TEAM &&
							!Object.hasOwn(teams, command.name)
						) {
							throw new Error(
								`Unknown team "${command.name}". Available: ${available.join(", ")}.`,
							);
						}
						updateSubagentSettingsFile(target, (subagents) => {
							subagents.team = command.name;
						});
						const envNotice = process.env[TEAM_ENV]?.trim()
							? ` Environment ${TEAM_ENV} is set and overrides this setting.`
							: "";
						sendSlashText(
							pi,
							`Subagent team set to "${command.name}" in ${target}.${envNotice} Next prompt will use it.`,
						);
						return;
					}
					updateSubagentSettingsFile(target, (subagents) => {
						const fileTeams = subagents.teams;
						if (
							fileTeams !== undefined &&
							(!fileTeams || typeof fileTeams !== "object" || Array.isArray(fileTeams))
						) {
							throw new Error(`Settings file '${target}' has an invalid 'subagents.teams' object.`);
						}
						const teams = Object.assign(
							Object.create(null) as Record<string, unknown>,
							fileTeams as Record<string, unknown> | undefined,
						);
						assertCreatableTeamName(command.name, catalog.settings.teams ?? {}, teams);
						teams[command.name] = { members: command.members };
						subagents.teams = teams;
					});
					sendSlashText(
						pi,
						`Created subagent team ${command.name}. Select it with /subagents-team use ${command.name}`,
					);
				});
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});
}
