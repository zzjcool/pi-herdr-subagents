/**
 * Subagent model profiles — cheap / medium / strong role assignments.
 *
 * Same workflow as pi-subagents:
 *   refresh a provider catalog → generate quota + quality profiles → load one
 *   into `~/.pi/agent/settings.json` as `subagents.agentOverrides`.
 *
 * Files live under `~/.pi/agent/profiles/pi-herdr-subagents/` so they do not
 * collide with a side-by-side pi-subagents install.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "../agents/paths.ts";
import { splitThinkingSuffix } from "../agents/model-scope.ts";
import { THINKING_LEVELS } from "../shared/types.ts";
import {
	buildClassificationContext,
	buildProfileFile,
	classifyModel,
	filterDominatedModels,
	pickTierModels,
	usesHeuristicClassification,
	type ClassificationSource,
	type ProfileKind,
	type SubagentProfileFile,
} from "./classify.ts";

export const DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS = 7;
export const PROFILES_DIR_NAME = "pi-herdr-subagents";

export type ProbeStatus =
	| "ok"
	| "unavailable"
	| "auth"
	| "timeout"
	| "error"
	| "skipped";

export interface RegistryModelLike {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	thinkingLevelMap?: Record<string, string | null | undefined>;
}

export interface ModelRegistryLike {
	getAvailable(): RegistryModelLike[];
	find?(provider: string, id: string): RegistryModelLike | undefined;
}

export interface ProbeExec {
	exec?: (
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	) => Promise<{
		code?: number | null;
		stdout?: string;
		stderr?: string;
		killed?: boolean;
	}>;
}

export interface ProfilePaths {
	agentDir: string;
	profilesDir: string;
	providersDir: string;
	settingsPath: string;
}

export interface ProviderModelCatalogModel {
	id: string;
	fullId: string;
	observed: {
		availableInRegistry: boolean;
		name?: string;
		reasoning?: boolean;
		thinkingLevels: string[];
		contextWindow?: number;
		maxTokens?: number;
		cost?: RegistryModelLike["cost"];
		probe: {
			status: ProbeStatus;
			checkedAt: string;
			message?: string;
		};
	};
	derived: {
		profileRank: number;
		costTier: string;
		qualityTier: string;
		latencyTier: string;
		recommendedRoleTier: string;
		recommendedAgents: string[];
		classificationSources: ClassificationSource[];
	};
	warnings: string[];
	notes: string[];
}

export interface ProviderModelCatalogFile {
	provider: string;
	refreshedAt: string;
	maxAgeDays: number;
	sources: string[];
	models: ProviderModelCatalogModel[];
}

export interface ProfileCheckResult {
	profileName: string;
	filePath: string;
	results: Array<{
		agent: string;
		model: string;
		inRegistry: boolean;
		probe: { status: ProbeStatus; message?: string };
	}>;
}

export interface ProfileIoOptions {
	agentDir?: string;
}

const SAFE_PATH_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readJsonObjectFile(filePath: string): Record<string, unknown> {
	const raw = fs.readFileSync(filePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`File '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function normalizePathToken(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} is required.`);
	if (
		!SAFE_PATH_TOKEN.test(trimmed) ||
		trimmed === "." ||
		trimmed === ".." ||
		trimmed.includes("/") ||
		trimmed.includes("\\")
	) {
		throw new Error(
			`${label} must be a safe file name using only letters, numbers, dots, underscores, and hyphens.`,
		);
	}
	return trimmed;
}

function normalizeProfileName(name: string): string {
	const trimmed = name.trim();
	const stem = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;
	return normalizePathToken(stem, "Profile name");
}

function normalizeProviderName(provider: string): string {
	return normalizePathToken(provider, "Provider");
}

export function resolveProfilePaths(opts?: ProfileIoOptions): ProfilePaths {
	const agentDir = opts?.agentDir ?? getAgentDir();
	const profilesDir = path.join(agentDir, "profiles", PROFILES_DIR_NAME);
	return {
		agentDir,
		profilesDir,
		providersDir: path.join(profilesDir, "providers"),
		settingsPath: path.join(agentDir, "settings.json"),
	};
}

export function ensureSubagentProfilesDir(opts?: ProfileIoOptions): string {
	const dir = resolveProfilePaths(opts).profilesDir;
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getProviderModelsPath(
	provider: string,
	opts?: ProfileIoOptions,
): string {
	const normalized = normalizeProviderName(provider);
	const dir = resolveProfilePaths(opts).providersDir;
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${normalized}.models.json`);
}

export function validateSubagentProfile(
	filePath: string,
	parsed: Record<string, unknown>,
): SubagentProfileFile {
	const subagents = parsed.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) {
		throw new Error(`Profile '${filePath}' must contain a 'subagents' object.`);
	}
	const agentOverrides = (subagents as Record<string, unknown>).agentOverrides;
	if (
		!agentOverrides ||
		typeof agentOverrides !== "object" ||
		Array.isArray(agentOverrides)
	) {
		throw new Error(
			`Profile '${filePath}' must contain 'subagents.agentOverrides' as an object.`,
		);
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(
				`Profile '${filePath}' has invalid override '${name}'; expected an object.`,
			);
		}
		const override = value as Record<string, unknown>;
		if (override.model !== undefined && typeof override.model !== "string") {
			throw new Error(
				`Profile '${filePath}' has invalid model for '${name}'; expected a string.`,
			);
		}
		if (
			override.thinking !== undefined &&
			override.thinking !== false &&
			typeof override.thinking !== "string"
		) {
			throw new Error(
				`Profile '${filePath}' has invalid thinking for '${name}'; expected a string or false.`,
			);
		}
		if (
			override.fallbackModels !== undefined &&
			override.fallbackModels !== false &&
			(!Array.isArray(override.fallbackModels) ||
				override.fallbackModels.some((item) => typeof item !== "string"))
		) {
			throw new Error(
				`Profile '${filePath}' has invalid fallbackModels for '${name}'; expected an array of strings or false.`,
			);
		}
	}
	const disableBuiltins = (subagents as Record<string, unknown>).disableBuiltins;
	if (disableBuiltins !== undefined && typeof disableBuiltins !== "boolean") {
		throw new Error(
			`Profile '${filePath}' has invalid subagents.disableBuiltins; expected a boolean.`,
		);
	}
	return parsed as unknown as SubagentProfileFile;
}

export function listSubagentProfiles(opts?: ProfileIoOptions): string[] {
	const dir = ensureSubagentProfilesDir(opts);
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name.slice(0, -5))
		.sort((a, b) => a.localeCompare(b));
}

export function readSubagentProfile(
	name: string,
	opts?: ProfileIoOptions,
): { filePath: string; profile: SubagentProfileFile } {
	const filePath = path.join(
		ensureSubagentProfilesDir(opts),
		`${normalizeProfileName(name)}.json`,
	);
	if (!fs.existsSync(filePath)) throw new Error(`Profile not found: ${name}`);
	const parsed = readJsonObjectFile(filePath);
	return { filePath, profile: validateSubagentProfile(filePath, parsed) };
}

function readSettingsFile(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	return readJsonObjectFile(filePath);
}

/**
 * Copy a profile's `agentOverrides` into user settings.
 *
 * Unrelated `subagents` keys (modelScope, herdr, disableBuiltins, …) survive
 * the switch; the profile owns the complete agent→model mapping.
 */
export function applySubagentProfile(
	name: string,
	opts?: ProfileIoOptions,
): { filePath: string; settingsPath: string } {
	const { filePath, profile } = readSubagentProfile(name, opts);
	const settingsPath = resolveProfilePaths(opts).settingsPath;
	const settings = readSettingsFile(settingsPath);
	const existing =
		settings.subagents &&
		typeof settings.subagents === "object" &&
		!Array.isArray(settings.subagents)
			? (settings.subagents as Record<string, unknown>)
			: {};
	settings.subagents = {
		...existing,
		...profile.subagents,
		agentOverrides: profile.subagents.agentOverrides,
	};
	writeJsonFile(settingsPath, settings);
	return { filePath, settingsPath };
}

export function readProviderModelCatalog(
	provider: string,
	opts?: ProfileIoOptions,
): ProviderModelCatalogFile | null {
	const filePath = getProviderModelsPath(provider, opts);
	if (!fs.existsSync(filePath)) return null;
	return readJsonObjectFile(filePath) as unknown as ProviderModelCatalogFile;
}

export function isProviderModelCatalogStale(
	catalog: ProviderModelCatalogFile,
	maxAgeDays = DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	now = Date.now(),
): boolean {
	const refreshedAt = Date.parse(catalog.refreshedAt);
	if (!Number.isFinite(refreshedAt)) return true;
	return now - refreshedAt > maxAgeDays * 24 * 60 * 60 * 1000;
}

function catalogModelIsUsable(model: ProviderModelCatalogModel): boolean {
	return (
		model.observed.availableInRegistry &&
		model.observed.probe.status !== "unavailable" &&
		model.observed.probe.status !== "auth" &&
		model.observed.probe.status !== "timeout" &&
		model.observed.probe.status !== "error"
	);
}

export function countHeuristicFallbackModels(
	catalog: ProviderModelCatalogFile,
): number {
	return catalog.models.filter((model) =>
		usesHeuristicClassification(model.derived.classificationSources),
	).length;
}

function thinkingLevelsOf(model: RegistryModelLike): string[] {
	const map = model.thinkingLevelMap;
	if (!map) return model.reasoning ? [...THINKING_LEVELS] : [];
	return THINKING_LEVELS.filter((level) => map[level] !== null);
}

function resolveProbeStatus(text: string, timedOut: boolean): ProbeStatus {
	if (timedOut) return "timeout";
	if (!text) return "error";
	if (/(unauthori[sz]ed|forbidden|api key|auth|billing|credit|quota)/i.test(text)) {
		return "auth";
	}
	if (
		/(not found|unknown model|model unavailable|model disabled|unsupported model|unavailable)/i.test(
			text,
		)
	) {
		return "unavailable";
	}
	return "error";
}

export async function probeModel(
	pi: ProbeExec,
	fullId: string,
): Promise<{ status: ProbeStatus; message?: string }> {
	if (typeof pi.exec !== "function") {
		return {
			status: "skipped",
			message: "pi.exec is unavailable in this runtime.",
		};
	}
	const result = await pi.exec(
		"pi",
		["-p", "--model", fullId, "--no-tools", 'Reply with exactly "OK".'],
		{ cwd: os.tmpdir(), timeout: 45_000 },
	);
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
	const combined = [stderr, stdout].filter(Boolean).join("\n").trim();
	if (result.code === 0) {
		return { status: "ok", message: stdout || "Probe succeeded." };
	}
	return {
		status: resolveProbeStatus(combined, result.killed === true),
		message: combined || `Probe exited with code ${result.code ?? "unknown"}.`,
	};
}

export function findRegistryModel(
	modelId: string,
	available: RegistryModelLike[],
): RegistryModelLike | undefined {
	const { baseModel } = splitThinkingSuffix(modelId);
	const slash = baseModel.indexOf("/");
	if (slash === -1) return available.find((model) => model.id === baseModel);
	const provider = baseModel.slice(0, slash);
	const id = baseModel.slice(slash + 1);
	return available.find(
		(model) => model.provider === provider && model.id === id,
	);
}

function rankedFromCatalog(
	model: ProviderModelCatalogModel,
): ProviderModelCatalogModel & {
	fullId: string;
	profileRank: number;
	cost?: RegistryModelLike["cost"];
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
} {
	return {
		...model,
		profileRank: model.derived.profileRank,
		cost: model.observed.cost,
		reasoning: model.observed.reasoning,
		contextWindow: model.observed.contextWindow,
		maxTokens: model.observed.maxTokens,
	};
}

export async function refreshProviderModelCatalog(
	pi: ProbeExec,
	registry: ModelRegistryLike,
	provider: string,
	options: {
		force?: boolean;
		maxAgeDays?: number;
		probe?: boolean;
		agentDir?: string;
		now?: () => number;
	} = {},
): Promise<{
	filePath: string;
	catalog: ProviderModelCatalogFile;
	reused: boolean;
	heuristicFallbackCount: number;
}> {
	const normalizedProvider = normalizeProviderName(provider);
	const maxAgeDays = options.maxAgeDays ?? DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS;
	const filePath = getProviderModelsPath(normalizedProvider, options);
	if (!options.force) {
		const existing = readProviderModelCatalog(normalizedProvider, options);
		if (
			existing &&
			!isProviderModelCatalogStale(
				existing,
				maxAgeDays,
				options.now?.() ?? Date.now(),
			)
		) {
			return {
				filePath,
				catalog: existing,
				reused: true,
				heuristicFallbackCount: countHeuristicFallbackModels(existing),
			};
		}
	}

	const availableModels = registry
		.getAvailable()
		.filter((model) => model.provider === normalizedProvider);
	if (availableModels.length === 0) {
		throw new Error(
			`No models found in the current registry for provider '${normalizedProvider}'.`,
		);
	}

	const observed: Array<{
		model: RegistryModelLike;
		fullId: string;
		probe: { status: ProbeStatus; message?: string };
	}> = [];
	for (const model of availableModels) {
		const fullId = `${model.provider}/${model.id}`;
		const probe =
			options.probe === false
				? { status: "skipped" as const, message: "Live probing disabled." }
				: await probeModel(pi, fullId);
		observed.push({ model, fullId, probe });
	}

	const classificationContext = buildClassificationContext(
		observed.map(({ model }) => ({
			id: model.id,
			...(typeof model.name === "string" ? { name: model.name } : {}),
			...(typeof model.reasoning === "boolean"
				? { reasoning: model.reasoning }
				: {}),
			...(typeof model.contextWindow === "number"
				? { contextWindow: model.contextWindow }
				: {}),
			...(typeof model.maxTokens === "number"
				? { maxTokens: model.maxTokens }
				: {}),
			...(model.cost && typeof model.cost === "object"
				? { cost: model.cost }
				: {}),
		})),
	);

	const models: ProviderModelCatalogModel[] = [];
	for (const { model, fullId, probe } of observed) {
		const classification = classifyModel(
			{
				id: model.id,
				...(typeof model.name === "string" ? { name: model.name } : {}),
				...(typeof model.reasoning === "boolean"
					? { reasoning: model.reasoning }
					: {}),
				...(typeof model.contextWindow === "number"
					? { contextWindow: model.contextWindow }
					: {}),
				...(typeof model.maxTokens === "number"
					? { maxTokens: model.maxTokens }
					: {}),
				...(model.cost && typeof model.cost === "object"
					? { cost: model.cost }
					: {}),
			},
			classificationContext,
		);
		const warnings = usesHeuristicClassification(
			classification.classificationSources,
		)
			? ["Classification fell back to name heuristics."]
			: [];
		models.push({
			id: model.id,
			fullId,
			observed: {
				availableInRegistry: true,
				...(typeof model.name === "string" ? { name: model.name } : {}),
				...(typeof model.reasoning === "boolean"
					? { reasoning: model.reasoning }
					: {}),
				thinkingLevels: thinkingLevelsOf(model),
				...(typeof model.contextWindow === "number"
					? { contextWindow: model.contextWindow }
					: {}),
				...(typeof model.maxTokens === "number"
					? { maxTokens: model.maxTokens }
					: {}),
				...(model.cost && typeof model.cost === "object"
					? { cost: model.cost }
					: {}),
				probe: {
					status: probe.status,
					checkedAt: new Date(
						options.now?.() ?? Date.now(),
					).toISOString(),
					...(probe.message ? { message: probe.message } : {}),
				},
			},
			derived: classification,
			warnings,
			notes: [],
		});
	}
	models.sort(
		(a, b) =>
			a.derived.profileRank - b.derived.profileRank ||
			a.fullId.localeCompare(b.fullId),
	);

	const catalog: ProviderModelCatalogFile = {
		provider: normalizedProvider,
		refreshedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
		maxAgeDays,
		sources: [
			"runtime-registry",
			...(options.probe === false ? [] : ["live-probe"]),
			"heuristic-classifier",
		],
		models,
	};
	writeJsonFile(filePath, catalog);
	return {
		filePath,
		catalog,
		reused: false,
		heuristicFallbackCount: countHeuristicFallbackModels(catalog),
	};
}

export async function generateProfilesForProvider(
	pi: ProbeExec,
	registry: ModelRegistryLike,
	provider: string,
	options: {
		maxAgeDays?: number;
		forceRefresh?: boolean;
		probe?: boolean;
		agentDir?: string;
	} = {},
): Promise<{
	quotaPath: string;
	qualityPath: string;
	catalogPath: string;
	quotaModels: { cheap: string; medium: string; strong: string };
	qualityModels: { cheap: string; medium: string; strong: string };
	heuristicFallbackCount: number;
	selectedHeuristicFallbackCount: number;
}> {
	const normalizedProvider = normalizeProviderName(provider);
	const { filePath: catalogPath, catalog, heuristicFallbackCount } =
		await refreshProviderModelCatalog(pi, registry, normalizedProvider, {
			maxAgeDays: options.maxAgeDays,
			force: options.forceRefresh,
			probe: options.probe,
			agentDir: options.agentDir,
		});
	const usableModels = catalog.models.filter(catalogModelIsUsable);
	const profileModels = filterDominatedModels(
		usableModels.map(rankedFromCatalog),
	);
	if (profileModels.length === 0) {
		throw new Error(
			`Provider '${normalizedProvider}' has no usable models after filtering.`,
		);
	}
	const quotaModels = pickTierModels(profileModels, "quota");
	const qualityModels = pickTierModels(profileModels, "quality");
	const dir = ensureSubagentProfilesDir(options);
	const quotaPath = path.join(dir, `${normalizedProvider}.quota.json`);
	const qualityPath = path.join(dir, `${normalizedProvider}.quality.json`);
	writeJsonFile(quotaPath, buildProfileFile(quotaModels));
	writeJsonFile(qualityPath, buildProfileFile(qualityModels));
	const selectedModels = new Set([
		...Object.values(quotaModels),
		...Object.values(qualityModels),
	]);
	const selectedHeuristicFallbackCount = profileModels.filter(
		(model) =>
			selectedModels.has(model.fullId) &&
			usesHeuristicClassification(model.derived.classificationSources),
	).length;
	return {
		quotaPath,
		qualityPath,
		catalogPath,
		quotaModels,
		qualityModels,
		heuristicFallbackCount,
		selectedHeuristicFallbackCount,
	};
}

export function getProfileWorkerModel(
	profile: SubagentProfileFile,
): string | undefined {
	const model = profile.subagents.agentOverrides.worker?.model;
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export async function checkSubagentProfile(
	pi: ProbeExec,
	registry: ModelRegistryLike,
	name: string,
	options: { agentDir?: string; probe?: boolean } = {},
): Promise<ProfileCheckResult> {
	const { filePath, profile } = readSubagentProfile(name, options);
	const available = registry.getAvailable();
	const entries = Object.entries(profile.subagents.agentOverrides)
		.filter(
			([, value]) => typeof value?.model === "string" && value.model.trim(),
		)
		.map(([agent, value]) => ({ agent, model: value.model!.trim() }));
	const probeCache = new Map<string, { status: ProbeStatus; message?: string }>();
	const results: ProfileCheckResult["results"] = [];
	for (const entry of entries) {
		const found = findRegistryModel(entry.model, available);
		const { thinking } = splitThinkingSuffix(entry.model);
		const probeModelId = found
			? `${found.provider}/${found.id}${thinking ? `:${thinking}` : ""}`
			: entry.model;
		let probe = probeCache.get(probeModelId);
		if (!probe) {
			probe =
				options.probe === false
					? { status: "skipped", message: "Live probing disabled." }
					: await probeModel(pi, probeModelId);
			probeCache.set(probeModelId, probe);
		}
		results.push({
			agent: entry.agent,
			model: entry.model,
			inRegistry: found !== undefined,
			probe,
		});
	}
	return { profileName: name, filePath, results };
}

/** @internal re-export so callers can name a kind without importing classify. */
export type { ProfileKind, SubagentProfileFile };
