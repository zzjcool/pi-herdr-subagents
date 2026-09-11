/**
 * Frozen interfaces for pi-herdr-subagents.
 *
 * This file is the CONTRACT between modules. Parallel work depends on it, so:
 *   - Treat every exported type here as FROZEN once workers start.
 *   - Additive changes (new optional fields) are allowed.
 *   - Breaking changes require coordinating all modules.
 *
 * Design authority: herdr-subagents-design.md (33 measured findings F1-F33).
 */

// =============================================================================
// Agent definitions (aligned with pi-subagents conventions)
// =============================================================================

export type AgentScope = "user" | "project" | "both";

export type SystemPromptMode = "replace" | "append";

/** herdr agent kinds we can launch. Mirrors `herdr agent start --kind`. */
export type AgentKind =
	| "pi"
	| "claude"
	| "codex"
	| "cursor"
	| "gemini"
	| "opencode"
	| "copilot"
	| "droid"
	| "kimi"
	| "qwen";

/** Where a subagent's pane is placed (design §8.3). */
export type Placement = "split-down" | "split-right" | "new-tab";

/** What to do when an agent reports `blocked` (design §5.3). */
export type OnBlockedPolicy = "forward" | "auto-approve" | "notify";

export type AcceptanceLevel = "none" | "attested" | "verified";

export interface AcceptanceCriterion {
	id: string;
	must: string;
	evidence?: string[];
	severity?: "required" | "optional";
}

export interface AcceptanceConfig {
	level: AcceptanceLevel;
	/** Read-only agents degrade to `attested` (pi-subagents convention). */
	role?: "read-only" | "writer" | "unknown";
	criteria?: AcceptanceCriterion[];
}

export interface ToolBudgetConfig {
	maxToolCalls?: number;
}

export interface TurnBudgetConfig {
	maxTurns?: number;
}

/**
 * A discovered agent definition (from `agents/*.md` frontmatter + body).
 * Field set mirrors pi-subagents where applicable (design §6.1).
 */
export interface AgentConfig {
	name: string;
	description: string;

	// ── model ──
	model?: string;
	fallbackModels?: string[];
	thinking?: string | false;

	// ── capability bounds ──
	tools?: string[];
	skills?: string[] | false;
	skillPath?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;

	// ── behavior ──
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	async?: boolean;
	timeoutMs?: number;
	toolTimeoutMs?: number;
	acceptance?: AcceptanceConfig;
	completionGuard?: boolean;
	maxSubagentDepth?: number;
	allowNestedSubagents?: boolean;
	toolBudget?: ToolBudgetConfig;
	turnBudget?: TurnBudgetConfig;
	disabled?: boolean;
	alias?: string[];
	extraFields?: Record<string, string>;

	// ── herdr-specific ──
	kind: AgentKind;
	placement?: Placement;
	worktree?: boolean;
	steer?: boolean;
	onBlocked?: OnBlockedPolicy;

	// ── provenance ──
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	/** Which fields came from frontmatter (for override merging). */
	frontmatterFields?: Set<string>;
	modelSource?: ModelSourceInfo;
}

export type AgentSource = "builtin" | "user" | "project";

export interface ModelSourceInfo {
	type:
		| "subagents.defaultModel"
		| "agentOverrides"
		| "frontmatter"
		| "dispatch"
		| "inherit";
	scope?: "user" | "project";
	path?: string;
	model: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** Directory the package's own agent definitions were loaded from. */
	builtinAgentsDir?: string;
}

// =============================================================================
// Model scope (design §6.2)
// =============================================================================

export interface ModelScopeConfig {
	enforce: boolean;
	allow: string[];
}

export interface ModelScopeViolation {
	model: string;
	severity: "error" | "warn";
	allowedPatterns: string[];
	message: string;
}

// =============================================================================
// Lifecycle + outcome (design §3) — ORTHOGONAL dimensions
// =============================================================================

/** Lifecycle state. Independent of execution outcome. */
export type TaskState =
	| "launching"
	| "working"
	| "awaiting"
	| "blocked"
	| "retired"
	| "exited";

/** Execution outcome, derived ONLY from session jsonl (F26-F31). */
export type ExecutionStatus =
	| "success"
	| "failed"
	| "aborted"
	| "truncated"
	| "running"
	| "unknown";

/** pi's authoritative stop reason enum (session-format.md:88). */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Execution {
	status: ExecutionStatus;
	stopReason?: StopReason | null;
	errorMessage?: string | null;
	reason?: string;
	turns?: number;
	/** Cumulative tool errors — diagnostic only, never affects status (F30). */
	toolErrors?: number;
	/** Only the final turn decides the outcome (F31). */
	lastTurn?: { stopReason?: StopReason | null; toolErrors: number };
	model?: string | null;
	usage?: Usage | null;
	completedAt?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AcceptanceResult {
	status: "accepted" | "rejected" | "unknown";
	level: AcceptanceLevel;
	evidence?: string[];
	reason?: string;
}

// =============================================================================
// Tree / run record (design §4)
// =============================================================================

/** One entry in the lineage chain. Flat array, max 4 (pi-subagents convention). */
export interface NestedPathEntry {
	runId: string;
	stepIndex?: number;
	agent?: string;
}

export const MAX_NESTED_PATH_ENTRIES = 4;

export interface ChildRecord {
	/** herdr agent name, globally unique among live agents. */
	name: string;
	/** Pane id, or null once recycled (F12: pane is not the durable carrier). */
	paneId: string | null;
	/** Owning tab when the child got its own tab (placement: "new-tab"). */
	tabId?: string;
	/** ★ resume credential — must persist. */
	sessionFile: string;
	sessionId?: string;
	/** Proves we created this pane (guards against killing others'). */
	ownerToken: string;

	// lifecycle
	state: TaskState;
	spawnedAt: string;
	retiredAt?: string;

	// outcome (snapshot taken BEFORE recycle — F27)
	execution?: Execution;
	acceptance?: AcceptanceResult;

	// artifacts
	artifacts?: Array<{ kind: string; path: string }>;

	// config echo (for diagnostics)
	agent?: string;
	kind?: AgentKind;
	model?: string;
}

export interface RunRecord {
	schemaVersion: 1;
	runId: string;
	task: string;
	cwd: string;

	herdr: {
		workspaceId?: string;
		tabId?: string;
		tabLabel?: string;
	};

	/** Lineage: root → this node. */
	path: NestedPathEntry[];
	depth: number;
	maxDepth: number;

	children: ChildRecord[];

	budget: { spawned: number; limit: number | null; granted: number };

	createdAt: string;
	updatedAt: string;
}

// =============================================================================
// herdr client (design §9) — thin, testable wrapper over the CLI
// =============================================================================

export interface HerdrError {
	code: string;
	message: string;
	details?: unknown;
}

export type HerdrResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: HerdrError };

export interface PaneInfo {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent_status?: string;
	cwd?: string | null;
	terminal_title_stripped?: string;
}

export interface AgentInfo {
	name?: string | null;
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent: string | null;
	agent_status: string;
	cwd?: string | null;
	agent_session?: { kind: string; source: string; value: string } | null;
	state_labels?: Record<string, string>;
	tokens?: unknown;
}

export interface TabInfo {
	tab_id: string;
	workspace_id: string;
	label?: string | null;
	pane_count: number;
}

export interface AgentStartResult {
	name: string;
	paneId: string;
	argv: string[];
	/** Session path reported by herdr (F1) — absent for non-pi kinds (F7). */
	sessionPath?: string;
	agentStatus: string;
}

export interface ProcessInfo {
	foregroundProcesses: Array<{
		argv: string[];
		cmdline: string;
		pid: number;
		name: string;
		cwd?: string;
	}>;
	shellPid?: number;
}

/** Injectable runner so the client is unit-testable without a live herdr. */
export type CommandRunner = (
	args: string[],
	opts?: { timeoutMs?: number; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface HerdrClient {
	// ── panes ──
	paneSplit(opts: {
		target?: string;
		current?: boolean;
		direction: "right" | "down";
		cwd?: string;
		env?: Record<string, string>;
		focus?: boolean;
	}): Promise<HerdrResult<PaneInfo>>;
	paneClose(paneId: string): Promise<HerdrResult<void>>;
	paneRead(
		paneId: string,
		opts?: { source?: ReadSource; lines?: number },
	): Promise<HerdrResult<string>>;
	paneList(): Promise<HerdrResult<PaneInfo[]>>;
	paneGet(paneId: string): Promise<HerdrResult<PaneInfo>>;
	paneProcessInfo(paneId: string): Promise<HerdrResult<ProcessInfo>>;
	paneReportMetadata(opts: {
		paneId: string;
		source: string;
		displayAgent?: string;
		title?: string;
		tokens?: Record<string, string>;
	}): Promise<HerdrResult<void>>;

	// ── tabs ──
	tabCreate(opts: {
		cwd?: string;
		label?: string;
		focus?: boolean;
		/** Environment for the tab's root pane process (lineage propagation). */
		env?: Record<string, string>;
	}): Promise<HerdrResult<{ tab: TabInfo; rootPaneId: string }>>;
	tabClose(tabId: string): Promise<HerdrResult<void>>;
	tabRename(tabId: string, label: string): Promise<HerdrResult<void>>;
	tabList(workspaceId?: string): Promise<HerdrResult<TabInfo[]>>;

	// ── agents ──
	agentStart(opts: {
		name: string;
		kind: AgentKind;
		paneId: string;
		args?: string[];
		timeoutMs?: number;
	}): Promise<HerdrResult<AgentStartResult>>;
	agentPrompt(
		target: string,
		text: string,
		opts?: { wait?: boolean; timeoutMs?: number },
	): Promise<HerdrResult<AgentInfo>>;
	agentGet(target: string): Promise<HerdrResult<AgentInfo>>;
	agentList(): Promise<HerdrResult<AgentInfo[]>>;
	agentSendKeys(target: string, ...keys: string[]): Promise<HerdrResult<void>>;
	agentWait(
		target: string,
		opts?: { until?: string[]; timeoutMs?: number },
	): Promise<HerdrResult<void>>;

	// ── meta ──
	version(): Promise<HerdrResult<string>>;
	available(): Promise<boolean>;
}

export type ReadSource =
	| "visible"
	| "recent"
	| "recent-unwrapped"
	| "detection";

// =============================================================================
// Session parsing (design §10)
// =============================================================================

export interface ParsedSession {
	output: string;
	usage: Usage;
	model: string | null;
	stopReason: StopReason | null;
	turns: TurnRecord[];
	toolErrors: number;
	/** True when the last user prompt has no assistant reply (F29 abort signal). */
	lastTurnMissing: boolean;
	tornLines: number;
}

export interface TurnRecord {
	userText: string;
	assistants: Array<{
		stopReason: StopReason | null;
		/**
		 * The raw stopReason string as written. Lets an unrecognized value be
		 * distinguished from an absent field (an absent field means the stream
		 * was cut short; an unknown value should be surfaced, not hidden).
		 */
		rawStopReason?: string;
		errorMessage: string | null;
		text: string | null;
		tools: string[];
	}>;
	toolResults: number;
	toolErrors: number;
}

// =============================================================================
// Tool API (design §11)
// =============================================================================

export type SubagentAction =
	| "launch"
	| "continue"
	| "steer"
	| "resume"
	| "retire"
	| "status"
	| "collect"
	| "list";

export interface LaunchRequest {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	placement?: Placement;
	async?: boolean;
	name?: string;
}

export interface Handle {
	name: string;
	paneId: string | null;
	sessionFile: string;
	runId: string;
	agent: string;
	kind: AgentKind;
	/**
	 * The authoritative child record the orchestrator created (includes the
	 * real `ownerToken`). Callers should persist THIS rather than rebuild an
	 * equivalent record, which previously hardcoded a placeholder token and
	 * silently defeated the ownership audit.
	 */
	child: ChildRecord;
}

export interface CollectResult {
	handle: Handle;
	state: TaskState;
	execution: Execution;
	acceptance: AcceptanceResult;
	output: string;
	usage: Usage | null;
	model: string | null;
}

export interface SubagentToolParams {
	action?: SubagentAction;
	// launch
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; cwd?: string; model?: string }>;
	chain?: Array<{ agent: string; task: string; cwd?: string; model?: string }>;
	async?: boolean;
	model?: string;
	cwd?: string;
	placement?: Placement;
	agentScope?: AgentScope;
	// control
	name?: string;
	message?: string;
}

// =============================================================================
// Settings (design §6.3)
// =============================================================================

export interface HerdrSettings {
	defaultPlacement?: Placement;
	maxConcurrentAgents?: number;
	startRetries?: number;
	startRetryBackoffMs?: number;
	sessionRetentionDays?: number;
	sessionRetentionMaxBytesPerRun?: number;
}

export interface SubagentsSettings {
	defaultModel?: string;
	defaultProvider?: string;
	agentOverrides?: Record<
		string,
		Partial<AgentConfig> & { disabled?: boolean }
	>;
	/**
	 * Role fields layered by the active parent provider (design §6.2).
	 * Lets one role definition be configured differently per provider, e.g.
	 * `{ "cb": { "worker": { "model": "cb/glm-5.3" } } }`.
	 */
	agentOverridesByProvider?: Record<
		string,
		Record<string, Partial<AgentConfig> & { disabled?: boolean }>
	>;
	modelScope?: ModelScopeConfig;
	disableBuiltins?: boolean;
	disableThinking?: boolean;
	maxSubagentSpawnsPerSession?: number;
	herdr?: HerdrSettings;
}

/**
 * Thinking levels accepted by `pi --thinking`, and the set of suffixes that may
 * appear as `model:level`. Single source of truth: both the argv builder
 * (src/runs/args.ts) and the model-scope matcher import this, so they cannot
 * silently disagree about what counts as a known suffix.
 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** True when `value` is a recognized thinking level. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

// =============================================================================
// Errors
// =============================================================================

export class SubagentError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(message: string, code: string, details?: unknown) {
		super(message);
		this.name = "SubagentError";
		this.code = code;
		this.details = details;
	}
}

export const ErrorCodes = {
	HERDR_UNAVAILABLE: "HERDR_UNAVAILABLE",
	PANE_BUSY: "PANE_BUSY",
	START_FAILED: "START_FAILED",
	START_TIMEOUT: "START_TIMEOUT",
	NAME_TAKEN: "NAME_TAKEN",
	UNKNOWN_AGENT: "UNKNOWN_AGENT",
	AGENT_DISABLED: "AGENT_DISABLED",
	MODEL_SCOPE_VIOLATION: "MODEL_SCOPE_VIOLATION",
	BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
	NOT_FOUND: "NOT_FOUND",
	RETIRE_FAILED: "RETIRE_FAILED",
	INVALID_PARAMS: "INVALID_PARAMS",
} as const;

// =============================================================================
// Defaults (measured)
// =============================================================================

export const DEFAULTS = {
	/** F19/F20: agent_pane_busy race; retry with backoff. */
	startRetries: 40,
	startRetryBackoffMs: 150,
	/** F8: agent wait covers a turn; generous default. */
	turnTimeoutMs: 900_000,
	/** jsonl quiet window before declaring a turn settled. */
	settleQuietMs: 2_500,
	maxConcurrentAgents: 6,
	sessionRetentionDays: 7,
	/** F22: missing binary surfaces as a ~15s timeout. */
	startTimeoutMs: 45_000,
	binaryProbeTimeoutMs: 3_000,
} as const;
