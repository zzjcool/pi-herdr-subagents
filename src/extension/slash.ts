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
	type ModelRegistryLike,
} from "../profiles/profiles.ts";
import { classifyModelOrigin, resolveStepModel } from "../agents/step-model.ts";
import { checkModelScope } from "../agents/model-scope.ts";
import { nativeModelFor } from "../runs/kind.ts";

export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text";

export interface ProfileCommandDeps {
	getModelRegistry?: () => ModelRegistryLike | undefined;
}

function sendSlashText(pi: ExtensionAPI, text: string): void {
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
	scope: AgentScope;
	projectAgentsDir: string | null;
	builtinAgentsDir: string;
	userAgentsDir?: string;
	settings: SubagentsSettings;
	dispatchModel?: string;
}): string {
	const { agents, scope } = input;
	const lines: string[] = ["Subagent roles", `Scope: ${scope}`];

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
		projectAgentsDir: string | null;
		builtinAgentsDir: string;
		userAgentsDir?: string;
	};
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
					sendSlashText(
						pi,
						renderAgentsListing({
							agents: catalog.agents,
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
