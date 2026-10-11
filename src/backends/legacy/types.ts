import type { AgentKind } from "../../shared/types.ts";

/** @legacy Error envelope returned by the archived herdr CLI backend. */
export interface HerdrError {
	code: string;
	message: string;
	details?: unknown;
}

/** @legacy Result envelope returned by the archived herdr CLI backend. */
export type HerdrResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: HerdrError };

/** @legacy Herdr pane payload; RPC v2 does not create panes. */
export interface PaneInfo {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	agent_status?: string;
	cwd?: string | null;
	terminal_title_stripped?: string;
}

/** @legacy Herdr agent payload retained for archived clients. */
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

/** @legacy Herdr tab payload retained for archived clients. */
export interface TabInfo {
	tab_id: string;
	workspace_id: string;
	label?: string | null;
	pane_count: number;
}

/** @legacy Herdr launch payload retained for archived clients. */
export interface AgentStartResult {
	name: string;
	paneId: string;
	argv: string[];
	sessionPath?: string;
	agentStatus: string;
}

/** @legacy Herdr process-info payload retained for archived clients. */
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

/** @legacy Injectable runner for the archived herdr CLI client. */
export type CommandRunner = (
	args: string[],
	opts?: { timeoutMs?: number; env?: Record<string, string | undefined> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** @deprecated Archived v0.16.x backend contract; RPC v2 uses LegionSupervisor. */
export interface HerdrClient {
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
	paneReportMetadata(opts: {
		paneId: string;
		source: string;
		displayAgent?: string;
		title?: string;
		tokens?: Record<string, string>;
		stateLabel?: { status: string; text: string };
		ttlMs?: number;
		clearStateLabels?: boolean;
	}): Promise<HerdrResult<void>>;
	tabCreate(opts: {
		cwd?: string;
		label?: string;
		focus?: boolean;
		env?: Record<string, string>;
		workspaceId?: string;
	}): Promise<HerdrResult<{ tab: TabInfo; rootPaneId: string }>>;
	tabClose(tabId: string): Promise<HerdrResult<void>>;
	tabList(workspaceId?: string): Promise<HerdrResult<TabInfo[]>>;
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
	available(): Promise<boolean>;
	integrationStatus(target: string): Promise<HerdrResult<string | null>>;
	integrationInstall(target: string): Promise<HerdrResult<string>>;
}

export type ReadSource =
	| "visible"
	| "recent"
	| "recent-unwrapped"
	| "detection";
