/**
 * Thin, testable wrapper over the `herdr` CLI.
 *
 * Measured behaviours this module encodes:
 *   F1  — `agent start` reports the child's session path
 *   F7  — non-pi kinds report no session ref (null)
 *   F11 — clean agent exit is `ctrl+d`, NOT `ctrl+c`
 *   F16 — `agent_name_taken` while alive; freed on exit
 *   F19 — `agent_pane_busy` race right after a pane split
 *   F21 — error JSON arrives on stderr with an empty stdout
 *   F22 — a missing binary surfaces as a start timeout, not a clear error
 */

import {
	type AgentInfo,
	type AgentKind,
	type AgentStartResult,
	type CommandRunner,
	ErrorCodes,
	type HerdrClient,
	type HerdrError,
	type HerdrResult,
	type PaneInfo,
	type ProcessInfo,
	type ReadSource,
	SubagentError,
	type TabInfo,
} from "../shared/types.ts";
import { createCommandRunner } from "./runner.ts";

interface HerdrEnvelope {
	id?: string;
	result?: unknown;
	error?: { code?: string; message?: string; details?: unknown };
}

/** Map herdr's error codes onto our stable error codes. */
export function mapHerdrErrorCode(
	raw: string | undefined,
	message: string,
): string {
	const code = (raw ?? "").toLowerCase();
	const text = message.toLowerCase();
	if (code.includes("pane_busy") || text.includes("not an available shell"))
		return ErrorCodes.PANE_BUSY;
	if (code.includes("name_taken") || text.includes("already used"))
		return ErrorCodes.NAME_TAKEN;
	if (code.includes("not_found") || text.includes("not found"))
		return ErrorCodes.NOT_FOUND;
	if (code.includes("timeout")) return ErrorCodes.START_TIMEOUT;
	return raw || "HERDR_ERROR";
}

function firstJson(text: string): HerdrEnvelope | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as HerdrEnvelope;
	} catch {
		/* fall through to line scanning */
	}
	// herdr may emit a non-JSON banner line before the payload.
	const lines = trimmed.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (!line || (!line.startsWith("{") && !line.startsWith("["))) continue;
		try {
			return JSON.parse(line) as HerdrEnvelope;
		} catch {
			/* keep scanning */
		}
	}
	return undefined;
}

/**
 * Turn a raw CLI invocation into a structured result.
 *
 * F21: success payloads live on stdout, error payloads on stderr.
 * We therefore inspect BOTH, preferring the one that parses.
 */
export function parseHerdrResponse(
	stdout: string,
	stderr: string,
	code: number,
): { ok: true; value: unknown } | { ok: false; error: HerdrError } {
	const fromStdout = firstJson(stdout);
	const fromStderr = firstJson(stderr);

	if (fromStdout?.error) {
		return { ok: false, error: toHerdrError(fromStdout.error) };
	}
	if (fromStderr?.error) {
		return { ok: false, error: toHerdrError(fromStderr.error) };
	}

	if (code === 0) {
		if (fromStdout && "result" in fromStdout)
			return { ok: true, value: fromStdout.result };
		if (fromStderr && "result" in fromStderr)
			return { ok: true, value: fromStderr.result };
		if (fromStdout) return { ok: true, value: fromStdout };
		if (fromStderr) return { ok: true, value: fromStderr };
		return {
			ok: false,
			error: {
				code: "PARSE_ERROR",
				message: `no JSON payload (stdout=${stdout.slice(0, 200)})`,
			},
		};
	}

	// Non-zero exit with no JSON error object: surface the raw text.
	const detail = (stderr || stdout).trim().slice(0, 500);
	return {
		ok: false,
		error: {
			code: code === -1 ? ErrorCodes.HERDR_UNAVAILABLE : "HERDR_ERROR",
			message: detail || `herdr exited with code ${code}`,
		},
	};
}

function toHerdrError(raw: {
	code?: string;
	message?: string;
	details?: unknown;
}): HerdrError {
	const message = raw.message ?? "unknown herdr error";
	return {
		code: mapHerdrErrorCode(raw.code, message),
		message,
		details: raw.details,
	};
}

function ok<T>(value: T): HerdrResult<T> {
	return { ok: true, value };
}
function err<T>(error: HerdrError): HerdrResult<T> {
	return { ok: false, error };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Payload normalizers
// ---------------------------------------------------------------------------

function toPaneInfo(raw: unknown): PaneInfo {
	const r = asRecord(raw);
	return {
		pane_id: str(r.pane_id) ?? "",
		tab_id: str(r.tab_id) ?? "",
		workspace_id: str(r.workspace_id) ?? "",
		agent_status: str(r.agent_status),
		cwd: (str(r.cwd) ?? null) as string | null,
		terminal_title_stripped: str(r.terminal_title_stripped),
	};
}

function toAgentInfo(raw: unknown): AgentInfo {
	const r = asRecord(raw);
	const session = r.agent_session;
	return {
		name: (str(r.name) ?? null) as string | null,
		pane_id: str(r.pane_id) ?? "",
		tab_id: str(r.tab_id) ?? "",
		workspace_id: str(r.workspace_id) ?? "",
		agent: (str(r.agent) ?? null) as string | null,
		agent_status: str(r.agent_status) ?? "unknown",
		cwd: (str(r.cwd) ?? null) as string | null,
		agent_session:
			session && typeof session === "object"
				? {
						kind: str(asRecord(session).kind) ?? "",
						source: str(asRecord(session).source) ?? "",
						value: str(asRecord(session).value) ?? "",
					}
				: null,
		state_labels: asRecord(r.state_labels) as Record<string, string>,
		tokens: r.tokens,
	};
}

function toTabInfo(raw: unknown): TabInfo {
	const r = asRecord(raw);
	return {
		tab_id: str(r.tab_id) ?? "",
		workspace_id: str(r.workspace_id) ?? "",
		label: (str(r.label) ?? null) as string | null,
		pane_count: typeof r.pane_count === "number" ? r.pane_count : 0,
	};
}

/**
 * herdr wraps an agent in `{agent: {...}}` for some calls and returns it
 * directly for others, so both shapes have to be accepted.
 */
function agentFromResult(value: unknown): AgentInfo {
	const record = asRecord(value);
	return toAgentInfo(record.agent ?? value);
}

/**
 * Map `agent start`'s payload to `AgentStartResult`.
 * The session path is the resume credential (F1), so it is only included when
 * herdr actually reported one — a non-pi kind reports `null` (F7).
 */
function toAgentStartResult(
	value: unknown,
	opts: { name: string; paneId: string },
): AgentStartResult {
	const record = asRecord(value);
	const agent = toAgentInfo(record.agent);
	const sessionPath = agent.agent_session?.value;
	return {
		name: agent.name ?? opts.name,
		paneId: agent.pane_id || opts.paneId,
		argv: Array.isArray(record.argv) ? record.argv.map(String) : [],
		...(sessionPath ? { sessionPath } : {}),
		agentStatus: agent.agent_status,
	};
}

/**
 * herdr wraps a pane in `{pane: {...}}` for some calls and returns it directly
 * for others, so both shapes have to be accepted.
 */
function paneFromResult(value: unknown): PaneInfo {
	const record = asRecord(value);
	return toPaneInfo(record.pane ?? value);
}

/** Map one entry of `pane process-info`'s `foreground_processes`. */
function toForegroundProcess(
	raw: unknown,
): ProcessInfo["foregroundProcesses"][number] {
	const p = asRecord(raw);
	return {
		argv: Array.isArray(p.argv) ? p.argv.map(String) : [],
		cmdline: str(p.cmdline) ?? "",
		pid: typeof p.pid === "number" ? p.pid : 0,
		name: str(p.name) ?? "",
		cwd: str(p.cwd),
	};
}

/** Map the `pane process-info` payload into `ProcessInfo`. */
function toProcessInfo(value: unknown): ProcessInfo {
	const info = asRecord(asRecord(value).process_info ?? value);
	const procs = Array.isArray(info.foreground_processes)
		? info.foreground_processes
		: [];
	return {
		foregroundProcesses: procs.map(toForegroundProcess),
		shellPid: typeof info.shell_pid === "number" ? info.shell_pid : undefined,
	};
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Call = <T>(
	args: string[],
	opts?: { timeoutMs?: number },
) => Promise<HerdrResult<T>>;

/** Append `--env K=V` for each entry. Shared by pane split and tab create. */
function pushEnvArgs(
	args: string[],
	env: Record<string, string> | undefined,
): void {
	for (const [key, value] of Object.entries(env ?? {})) {
		args.push("--env", `${key}=${value}`);
	}
}

/**
 * The `--cwd` / `--env` / focus trailer shared by `pane split` and `tab create`.
 * Both accept the same three options, and keeping them in one place means the
 * focus flag can never be forgotten on one path (it must always be explicit).
 */
function pushLaunchTrailer(
	args: string[],
	opts: {
		cwd?: string;
		env?: Record<string, string>;
		focus?: boolean;
	},
): void {
	if (opts.cwd) args.push("--cwd", opts.cwd);
	pushEnvArgs(args, opts.env);
	args.push(opts.focus ? "--focus" : "--no-focus");
}

function paneSplitCall(
	call: Call,
	opts: {
		target?: string;
		current?: boolean;
		direction: "right" | "down";
		cwd?: string;
		env?: Record<string, string>;
		focus?: boolean;
	},
): Promise<HerdrResult<PaneInfo>> {
	return call<Record<string, unknown>>(paneSplitArgs(opts)).then((res) =>
		res.ok ? ok(paneFromResult(res.value)) : res,
	);
}

/** Build the `pane split` argv (extracted so the API factory stays flat). */
function paneSplitArgs(opts: {
	target?: string;
	current?: boolean;
	direction: "right" | "down";
	cwd?: string;
	env?: Record<string, string>;
	focus?: boolean;
}): string[] {
	const args = ["pane", "split"];
	if (opts.current) args.push("--current");
	else if (opts.target) args.push(opts.target);
	args.push("--direction", opts.direction);
	pushLaunchTrailer(args, opts);
	return args;
}

async function paneReadCall(
	runner: CommandRunner,
	paneId: string,
	opts: { source?: ReadSource; lines?: number },
): Promise<HerdrResult<string>> {
	const args = ["pane", "read", paneId];
	if (opts.source) args.push("--source", opts.source);
	if (opts.lines) args.push("--lines", String(opts.lines));
	// F6: `pane read` emits PLAIN TEXT, not JSON.
	const { stdout, stderr, code } = await runner(args);
	if (code !== 0 && !stdout)
		return err({ code: "HERDR_ERROR", message: stderr.slice(0, 500) });
	return ok(stdout);
}

function paneReportMetadataArgs(opts: {
	paneId: string;
	source: string;
	displayAgent?: string;
	title?: string;
	tokens?: Record<string, string>;
}): string[] {
	const args = [
		"pane",
		"report-metadata",
		opts.paneId,
		"--source",
		opts.source,
	];
	if (opts.displayAgent) args.push("--display-agent", opts.displayAgent);
	if (opts.title) args.push("--title", opts.title);
	for (const [k, v] of Object.entries(opts.tokens ?? {}))
		args.push("--token", `${k}=${v}`);
	return args;
}

function createPaneApi(
	call: Call,
	runner: CommandRunner,
): Pick<
	HerdrClient,
	| "paneSplit"
	| "paneClose"
	| "paneRead"
	| "paneList"
	| "paneGet"
	| "paneProcessInfo"
	| "paneReportMetadata"
> {
	return {
		paneSplit: (opts) => paneSplitCall(call, opts),

		paneClose: (paneId) => call<void>(["pane", "close", paneId]),

		paneRead: (paneId, opts = {}) => paneReadCall(runner, paneId, opts),

		paneList: () =>
			call<Record<string, unknown>>(["pane", "list"]).then((res) => {
				if (!res.ok) return res;
				const panes = asRecord(res.value).panes;
				return ok(Array.isArray(panes) ? panes.map(toPaneInfo) : []);
			}),

		paneGet: (paneId) =>
			call<Record<string, unknown>>(["pane", "get", paneId]).then((res) =>
				res.ok ? ok(paneFromResult(res.value)) : res,
			),

		paneProcessInfo: (paneId) =>
			call<Record<string, unknown>>([
				"pane",
				"process-info",
				"--pane",
				paneId,
			]).then((res) => (res.ok ? ok(toProcessInfo(res.value)) : res)),

		paneReportMetadata: (opts) => call<void>(paneReportMetadataArgs(opts)),
	};
}

function createTabApi(
	call: Call,
): Pick<HerdrClient, "tabCreate" | "tabClose" | "tabRename" | "tabList"> {
	return {
		async tabCreate(opts) {
			const args = ["tab", "create"];
			if (opts.label) args.push("--label", opts.label);
			pushLaunchTrailer(args, opts);

			const res = await call<Record<string, unknown>>(args);
			if (!res.ok) return res;
			const value = asRecord(res.value);
			const rootPane = asRecord(value.root_pane);
			return ok({
				tab: toTabInfo(value.tab),
				rootPaneId: str(rootPane.pane_id) ?? "",
			});
		},

		tabClose(tabId) {
			return call<void>(["tab", "close", tabId]);
		},

		tabRename(tabId, label) {
			return call<void>(["tab", "rename", tabId, label]);
		},

		async tabList(workspaceId) {
			const args = ["tab", "list"];
			if (workspaceId) args.push("--workspace", workspaceId);
			const res = await call<Record<string, unknown>>(args);
			if (!res.ok) return res;
			const tabs = asRecord(res.value).tabs;
			return ok(Array.isArray(tabs) ? tabs.map(toTabInfo) : []);
		},
	};
}

function agentStartArgs(opts: {
	name: string;
	kind: AgentKind;
	paneId: string;
	args?: string[];
	timeoutMs?: number;
}): string[] {
	const args = [
		"agent",
		"start",
		opts.name,
		"--kind",
		opts.kind,
		"--pane",
		opts.paneId,
	];
	if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
	if (opts.args?.length) args.push("--", ...opts.args);
	return args;
}

function agentPromptArgs(
	target: string,
	text: string,
	opts: { wait?: boolean; timeoutMs?: number },
): string[] {
	const args = ["agent", "prompt", target, text];
	if (opts.wait) args.push("--wait");
	if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
	return args;
}

function agentWaitArgs(
	target: string,
	opts: { until?: string[]; timeoutMs?: number },
): string[] {
	const args = ["agent", "wait", target];
	for (const state of opts.until ?? []) args.push("--until", state);
	if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
	return args;
}

/** `agent list` -> a typed array, tolerating a non-array payload. */
function agentListFrom(res: HerdrResult<Record<string, unknown>>) {
	if (!res.ok) return res;
	const agents = asRecord(res.value).agents;
	return ok(Array.isArray(agents) ? agents.map(toAgentInfo) : []);
}

function createAgentApi(
	call: Call,
): Pick<
	HerdrClient,
	| "agentStart"
	| "agentPrompt"
	| "agentGet"
	| "agentList"
	| "agentSendKeys"
	| "agentWait"
> {
	return {
		agentStart: (opts) =>
			call<Record<string, unknown>>(agentStartArgs(opts), {
				timeoutMs: (opts.timeoutMs ?? 45_000) + 15_000,
			}).then((res) =>
				res.ok ? ok(toAgentStartResult(res.value, opts)) : res,
			),

		agentPrompt: (target, text, opts = {}) =>
			call<Record<string, unknown>>(agentPromptArgs(target, text, opts), {
				timeoutMs: (opts.timeoutMs ?? 0) + 20_000,
			}).then((res) => (res.ok ? ok(agentFromResult(res.value)) : res)),

		agentGet: (target) =>
			call<Record<string, unknown>>(["agent", "get", target]).then((res) =>
				res.ok ? ok(agentFromResult(res.value)) : res,
			),

		agentList: () =>
			call<Record<string, unknown>>(["agent", "list"]).then(agentListFrom),

		agentSendKeys: (target, ...keys) =>
			call<void>(["agent", "send-keys", target, ...keys]),

		agentWait: (target, opts = {}) =>
			call<void>(agentWaitArgs(target, opts), {
				timeoutMs: (opts.timeoutMs ?? 0) + 10_000,
			}),
	};
}

function createMetaApi(
	runner: CommandRunner,
): Pick<HerdrClient, "version" | "available"> {
	return {
		async version() {
			const { stdout, code } = await runner(["--version"]);
			if (code !== 0)
				return err({
					code: ErrorCodes.HERDR_UNAVAILABLE,
					message: stdout.slice(0, 200),
				});
			return ok(stdout.trim());
		},

		async available() {
			try {
				const res = await runner(["--version"], { timeoutMs: 5_000 });
				return res.code === 0;
			} catch {
				return false;
			}
		},
	};
}

export function createHerdrClient(
	runner: CommandRunner = createCommandRunner(),
): HerdrClient {
	const call: Call = async <T>(
		args: string[],
		opts: { timeoutMs?: number } = {},
	): Promise<HerdrResult<T>> => {
		const { stdout, stderr, code } = await runner(args, opts);
		const parsed = parseHerdrResponse(stdout, stderr, code);
		return parsed.ok ? ok(parsed.value as T) : err(parsed.error);
	};

	return {
		...createPaneApi(call, runner),
		...createTabApi(call),
		...createAgentApi(call),
		...createMetaApi(runner),
	};
}

/** Read a pane's recent output, preferring the unwrapped view (design §1.7). */
export async function readPaneDiagnostic(
	client: HerdrClient,
	paneId: string,
	lines = 60,
	source: ReadSource = "recent-unwrapped",
): Promise<string> {
	const res = await client.paneRead(paneId, { source, lines });
	return res.ok ? res.value : "";
}

export { SubagentError };
