/**
 * Public programmatic surface for `@zzjcool/pi-herdr-subagents`.
 *
 * The extension registers a `subagent` tool, but a host that wants to drive the
 * same machinery directly (another extension, a script, a test harness) can
 * import from here instead of reaching into `src/`. Everything re-exported below
 * is covered by the package's test suite and is safe to depend on.
 *
 * ```ts
 * import { createHerdrClient, Orchestrator, loadAgentsFromDir } from "@zzjcool/pi-herdr-subagents/api";
 *
 * const client = createHerdrClient();
 * const [scout] = loadAgentsFromDir("/path/to/agents", "user");
 * const orch = new Orchestrator({ client, runDir: "/tmp/run", cwd: process.cwd() });
 * const handle = await orch.launch({ agent: scout, task: "survey the repo" });
 * const result = await orch.collect(handle.name);
 * ```
 */

// ── herdr transport ─────────────────────────────────────────────────────────
export {
	createHerdrClient,
	parseHerdrResponse,
	mapHerdrErrorCode,
	readPaneDiagnostic,
	SubagentError,
} from "./herdr/client.ts";
export { createCommandRunner, resolveHerdrBin } from "./herdr/runner.ts";
export type { RunnerOptions } from "./herdr/runner.ts";

// ── agent definitions ───────────────────────────────────────────────────────
export {
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS_DIR,
	EXTRA_AGENT_DIRS_ENV,
	discoverAgents,
	findNearestProjectAgentsDir,
	formatAgentList,
	loadAgentsFromDir,
	parseAgentDocument,
} from "./agents/agents.ts";
export type { DiscoverOptions } from "./agents/agents.ts";
export {
	applyAgentOverrides,
	applyDefaultModel,
	applyOverride,
} from "./agents/overrides.ts";
export {
	parseFrontmatter,
	parseFrontmatterList,
} from "./agents/frontmatter.ts";
export type { ParsedFrontmatter } from "./agents/frontmatter.ts";
export {
	providerOf,
	resolveModel,
} from "./agents/model-resolution.ts";
export type {
	ResolvedModel,
	ResolveModelInput,
} from "./agents/model-resolution.ts";
export {
	checkModelScope,
	matchesScopePattern,
	parseModelScopeConfig,
	stripThinkingSuffix,
} from "./agents/model-scope.ts";
export {
	loadSubagentSettings,
	parseSubagentSettings,
	resolveSubagentSettings,
} from "./agents/settings.ts";
export type { LoadSettingsOptions } from "./agents/settings.ts";
export { getAgentDir } from "./agents/paths.ts";

// ── model profiles (cheap / medium / strong) ────────────────────────────────
export {
	TIER_AGENTS,
	agentsForRoleTier,
	buildClassificationContext,
	buildProfileFile,
	classifyModel,
	filterDominatedModels,
	inferProfileBand,
	pickTierModels,
} from "./profiles/classify.ts";
export type {
	ProfileKind,
	RecommendedRoleTier,
	SubagentProfileFile,
} from "./profiles/classify.ts";
export {
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	PROFILES_DIR_NAME,
	applySubagentProfile,
	checkSubagentProfile,
	generateProfilesForProvider,
	listSubagentProfiles,
	readSubagentProfile,
	refreshProviderModelCatalog,
	resolveProfilePaths,
} from "./profiles/profiles.ts";
export { registerProfileCommands } from "./extension/slash.ts";

// ── runs ────────────────────────────────────────────────────────────────────
export { Orchestrator, preCreateSessionFile } from "./runs/orchestrator.ts";
export type { OrchestratorDeps } from "./runs/orchestrator.ts";
export { createSessionLayout, typeTabLabel, tileSplit, TILE_COLUMNS } from "./runs/layout.ts";
export type { SessionLayout } from "./runs/layout.ts";
export { RunStore, sanitizeNameForFs } from "./runs/store.ts";
export type { StoreOptions } from "./runs/store.ts";
export {
	applyThinkingSuffix,
	buildPiArgs,
	TASK_ARG_LIMIT,
	THINKING_LEVELS,
} from "./runs/args.ts";
export type { BuildArgsInput, BuildArgsResult } from "./runs/args.ts";

// ── parent session: completion notify + input-box status ────────────────────
export { createSessionRuntime, shouldRecycleAfterCollect } from "./extension/runtime.ts";
export type {
	CollectSnapshot,
	SessionRuntime,
	SessionRuntimeDeps,
	TrackedJob,
	TrackedJobInput,
} from "./extension/runtime.ts";
export {
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	SUBAGENT_NOTIFY_TYPE,
} from "./extension/notify.ts";
export type { CompletionInput, CompletionNotice } from "./extension/notify.ts";
export {
	applyStatus,
	formatBusyLabel,
	formatFooterStatus,
	formatWidgetLines,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
} from "./tui/status.ts";
export {
	blockMessage,
	forbiddenDispatchReason,
	PARENT_PLAYBOOK,
	TOOL_DESCRIPTION,
} from "./extension/playbook.ts";

// ── session parsing / outcome derivation ────────────────────────────────────
export {
	countAssistantMessages,
	deriveOutcome,
	emptyParsedSession,
	extractVerdict,
	isLastTurnComplete,
	parseSessionFile,
	parseSessionText,
} from "./shared/session.ts";

// ── shared vocabulary ───────────────────────────────────────────────────────
export type {
	AcceptanceConfig,
	AcceptanceCriterion,
	AcceptanceLevel,
	AcceptanceResult,
	AgentConfig,
	AgentDiscoveryResult,
	AgentInfo,
	AgentKind,
	AgentScope,
	AgentSource,
	ChildRecord,
	Execution,
	ExecutionStatus,
	HerdrError,
	HerdrResult,
	ModelScopeConfig,
	ModelScopeViolation,
	ModelSourceInfo,
	NestedPathEntry,
	OnBlockedPolicy,
	PaneInfo,
	Placement,
	RunRecord,
	StopReason,
	SubagentsSettings,
	SystemPromptMode,
	TaskState,
	ToolBudgetConfig,
	TurnBudgetConfig,
	Usage,
} from "./shared/types.ts";
