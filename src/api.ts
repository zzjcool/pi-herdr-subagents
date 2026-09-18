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
	findAgent,
	findNearestProjectAgentsDir,
	formatAgentList,
	formatAgentRoster,
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
	modelCandidates,
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
export type { CollectResult, OrchestratorDeps } from "./runs/orchestrator.ts";
export {
	VERIFY_COMMAND,
	DEFAULT_VERIFY_TIMEOUT_MS,
	applyVerification,
	needsVerification,
	verifyCommandOf,
	defaultVerifyRunner,
} from "./runs/acceptance.ts";
export type { CommandResult, VerifyRunner } from "./runs/acceptance.ts";
export { createSessionLayout, typeTabLabel, sanitizeTabOwner, tileSplit, TILE_COLUMNS } from "./runs/layout.ts";
export type { SessionLayout } from "./runs/layout.ts";
export { RunStore, sanitizeNameForFs, pickChildByName } from "./runs/store.ts";
export type { StoreOptions } from "./runs/store.ts";
export {
	applyThinkingSuffix,
	buildPiArgs,
	TASK_ARG_LIMIT,
	THINKING_LEVELS,
} from "./runs/args.ts";
export type { BuildArgsInput, BuildArgsResult } from "./runs/args.ts";
export {
	cursorModel,
	isPiShapedModel,
	nativeModelFor,
	planKindStart,
} from "./runs/kind.ts";
export type { KindStartPlan } from "./runs/kind.ts";
export {
	createChildWorktree,
	isGitRepo,
	removeChildWorktree,
	resolveLaunchWorktree,
	worktreeBranchFor,
	worktreePathFor,
} from "./runs/worktree.ts";

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
	completionDeliveryOptions,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	SUBAGENT_NOTIFY_TYPE,
} from "./extension/notify.ts";
export type {
	CompletionInput,
	CompletionNotice,
	SendMessageOptions,
} from "./extension/notify.ts";
export {
	applyOnBlockedPolicy,
	followUpFor,
	formatBlockedPrompt,
} from "./extension/blocked.ts";
export type { BlockedDecision, BlockedFollowUp } from "./extension/blocked.ts";
export {
	canUseCachedCollect,
	formatAlreadyRecycled,
} from "./extension/recycle.ts";
export {
	applyStatus,
	createStatusBoard,
	formatBusyLabel,
	formatFooterStatus,
	formatWidgetLines,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
	STATUS_WIDGET_PLACEMENT,
} from "./tui/status.ts";
export {
	CHILD_ACCEPTANCE_ROLE_ENV,
	CHILD_ROLE_ENV,
	CHILD_TASK_APPENDIX,
	blockChildMessage,
	childTaskAppendix,
	forbiddenChildReason,
	formatChildTask,
	registerChildGuard,
} from "./extension/child-guard.ts";
export {
	ALLOW_NESTED_ENV,
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
	budgetExceededReason,
	parseBudgetInt,
	wrapBashWithTimeout,
} from "./extension/budget.ts";

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
export {
	mergeProgress,
	progressFromAgentInfo,
	progressFromPaneInfo,
	progressFromSession,
	progressFromSessionFile,
} from "./shared/progress.ts";
export type { LiveProgress } from "./shared/progress.ts";

// ── shared vocabulary ───────────────────────────────────────────────────────
export { AGENT_KINDS } from "./shared/types.ts";
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
