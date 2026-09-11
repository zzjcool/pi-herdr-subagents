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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Call = <T>(
	args: string[],
	opts?: { timeoutMs?: number },
) => Promise<HerdrResult<T>>;

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
		async paneSplit(opts) {
			const args = ["pane", "split"];
			if (opts.current) args.push("--current");
			else if (opts.target) args.push(opts.target);
			args.push("--direction", opts.direction);
			if (opts.cwd) args.push("--cwd", opts.cwd);
			for (const [key, value] of Object.entries(opts.env ?? {}))
				args.push("--env", `${key}=${value}`);
			args.push(opts.focus ? "--focus" : "--no-focus");

			const res = await call<Record<string, unknown>>(args);
			if (!res.ok) return res;
			return ok(toPaneInfo(asRecord(res.value).pane ?? res.value));
		},

		paneClose(paneId) {
			return call<void>(["pane", "close", paneId]);
		},

		async paneRead(paneId, opts = {}) {
			const args = ["pane", "read", paneId];
			if (opts.source) args.push("--source", opts.source);
			if (opts.lines) args.push("--lines", String(opts.lines));
			// F6: `pane read` emits PLAIN TEXT, not JSON.
			const { stdout, stderr, code } = await runner(args);
			if (code !== 0 && !stdout)
				return err({ code: "HERDR_ERROR", message: stderr.slice(0, 500) });
			return ok(stdout);
		},

		async paneList() {
			const res = await call<Record<string, unknown>>(["pane", "list"]);
			if (!res.ok) return res;
			const panes = asRecord(res.value).panes;
			return ok(Array.isArray(panes) ? panes.map(toPaneInfo) : []);
		},

		async paneGet(paneId) {
			const res = await call<Record<string, unknown>>(["pane", "get", paneId]);
			if (!res.ok) return res;
			return ok(toPaneInfo(asRecord(res.value).pane ?? res.value));
		},

		async paneProcessInfo(paneId) {
			const res = await call<Record<string, unknown>>([
				"pane",
				"process-info",
				"--pane",
				paneId,
			]);
			if (!res.ok) return res;
			const info = asRecord(asRecord(res.value).process_info ?? res.value);
			const procs = Array.isArray(info.foreground_processes)
				? info.foreground_processes
				: [];
			return ok({
				foregroundProcesses: procs.map((p) => {
					const pr = asRecord(p);
					return {
						argv: Array.isArray(pr.argv) ? pr.argv.map(String) : [],
						cmdline: str(pr.cmdline) ?? "",
						pid: typeof pr.pid === "number" ? pr.pid : 0,
						name: str(pr.name) ?? "",
						cwd: str(pr.cwd),
					};
				}),
				shellPid:
					typeof info.shell_pid === "number" ? info.shell_pid : undefined,
			} satisfies ProcessInfo);
		},

		paneReportMetadata(opts) {
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
			return call<void>(args);
		},
	};
}

function createTabApi(
	call: Call,
): Pick<HerdrClient, "tabCreate" | "tabClose" | "tabRename" | "tabList"> {
	return {
		async tabCreate(opts) {
			const args = ["tab", "create"];
			if (opts.cwd) args.push("--cwd", opts.cwd);
			if (opts.label) args.push("--label", opts.label);
			for (const [key, value] of Object.entries(opts.env ?? {}))
				args.push("--env", `${key}=${value}`);
			args.push(opts.focus ? "--focus" : "--no-focus");

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
		async agentStart(opts) {
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

			const res = await call<Record<string, unknown>>(args, {
				timeoutMs: (opts.timeoutMs ?? 45_000) + 15_000,
			});
			if (!res.ok) return res;

			const value = asRecord(res.value);
			const agent = toAgentInfo(value.agent);
			const sessionPath = agent.agent_session?.value;
			return ok({
				name: agent.name ?? opts.name,
				paneId: agent.pane_id || opts.paneId,
				argv: Array.isArray(value.argv) ? value.argv.map(String) : [],
				...(sessionPath ? { sessionPath } : {}),
				agentStatus: agent.agent_status,
			} satisfies AgentStartResult);
		},

		async agentPrompt(target, text, opts = {}) {
			const args = ["agent", "prompt", target, text];
			if (opts.wait) args.push("--wait");
			if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));

			const res = await call<Record<string, unknown>>(args, {
				timeoutMs: (opts.timeoutMs ?? 0) + 20_000,
			});
			if (!res.ok) return res;
			const value = asRecord(res.value);
			return ok(toAgentInfo(value.agent ?? value));
		},

		async agentGet(target) {
			const res = await call<Record<string, unknown>>(["agent", "get", target]);
			if (!res.ok) return res;
			const value = asRecord(res.value);
			return ok(toAgentInfo(value.agent ?? value));
		},

		async agentList() {
			const res = await call<Record<string, unknown>>(["agent", "list"]);
			if (!res.ok) return res;
			const agents = asRecord(res.value).agents;
			return ok(Array.isArray(agents) ? agents.map(toAgentInfo) : []);
		},

		agentSendKeys(target, ...keys) {
			return call<void>(["agent", "send-keys", target, ...keys]);
		},

		agentWait(target, opts = {}) {
			const args = ["agent", "wait", target];
			for (const state of opts.until ?? []) args.push("--until", state);
			if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
			return call<void>(args, { timeoutMs: (opts.timeoutMs ?? 0) + 10_000 });
		},
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
