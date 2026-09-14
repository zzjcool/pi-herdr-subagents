/**
 * In-memory herdr simulator: a `CommandRunner` that behaves like the real
 * `herdr` CLI (as measured in docs/design.md) plus a handle to script it.
 *
 * Measured behaviours reproduced here:
 *   F1  — `agent start` returns `agent_session.value` = the session path (pi kind)
 *   F7  — non-pi kinds report `agent_session: null`
 *   F11 — clean exit is `ctrl+d` (NOT ctrl+c); ctrl+c leaves the agent alive
 *   F16 — `agent_name_taken` while a name is alive; freed after exit
 *   F19 — `agent_pane_busy` for the first N ms after a pane split (configurable)
 *   F21 — ERROR JSON goes to STDERR with EMPTY stdout; success JSON to stdout
 *   F22 — a missing binary surfaces as a start TIMEOUT (code -2 + stderr note),
 *         not a clear error
 */

import type { CommandRunner } from "../../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FakeHerdrOptions {
	/** F19: panes reject `agent start` for this long after creation. Default 0 (no race). */
	paneBusyMs?: number;
	/** Simulated clock start; defaults to Date.now(). */
	now?: number;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface FakePane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd: string | null;
	agent_status: string | undefined;
	/** ms timestamp when pane_busy expires (F19). */
	busyUntil: number;
	/** Text visible to `pane read` (F6: plain text, not JSON). */
	screen: string[];
	/** Foreground processes reported by `pane process-info`. */
	processes: Array<{
		argv: string[];
		cmdline: string;
		pid: number;
		name: string;
	}>;
}

interface FakeTab {
	tab_id: string;
	workspace_id: string;
	label: string | null;
	paneIds: string[];
}

interface FakeAgent {
	name: string;
	kind: string;
	paneId: string;
	/** Session path reported by `agent start` (F1); null for non-pi kinds (F7). */
	sessionPath: string | null;
	status: "idle" | "working" | "done" | "blocked" | "exited";
	labels: Record<string, string>;
	/** Prompt text currently queued for the agent. */
	pendingPrompts: string[];
	/** Scripted transcript: each entry is a turn the agent will "complete". */
	script: FakeTurn[];
	scriptIndex: number;
}

interface FakeTurn {
	/** What the agent writes to the pane after the turn. */
	outputText: string;
	/** Simulated turn duration in ms (agent wait resolves after it). */
	durationMs?: number;
	/** If set, the turn ends with the agent exiting (freed name — F16). */
	exitsAfter?: boolean;
	/** If set, `agent prompt` during this turn is steered (F10) — recorded, not queued. */
	steerable?: boolean;
}

/** A prompt submitted while the agent was working (F10 steering evidence). */
export interface SteeredPrompt {
	text: string;
	at: number;
}

export class FakeHerdrError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "FakeHerdrError";
		this.code = code;
	}
}

export interface ExecutedCommand {
	args: string[];
	stdout: string;
	stderr: string;
	code: number;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export class FakeHerdr {
	readonly panes = new Map<string, FakePane>();
	readonly tabs = new Map<string, FakeTab>();
	readonly agents = new Map<string, FakeAgent>();

	/** Every CLI invocation, in order — assertions can inspect this. */
	readonly commands: ExecutedCommand[] = [];

	/** F19 configurable race window (ms). */
	paneBusyMs: number;
	/** Keys injected via `agent send-keys` (F11: ctrl+d exits, ctrl+c does not). */
	readonly sentKeys: Array<{ target: string; keys: string[]; at: number }> = [];
	/** Prompts accepted while an agent was working (F10). */
	readonly steeredPrompts: SteeredPrompt[] = [];

	private clock: number;
	private nextPane = 1;
	private nextTab = 1;

	constructor(opts: FakeHerdrOptions = {}) {
		this.paneBusyMs = opts.paneBusyMs ?? 0;
		this.clock = opts.now ?? Date.now();
	}

	// -- time ----------------------------------------------------------------

	/** Advance the fake clock (drives the F19 busy window and turn durations). */
	advance(ms: number): void {
		this.clock += ms;
	}

	get now(): number {
		return this.clock;
	}

	// -- fixtures --------------------------------------------------------------

	/** Create a workspace root pane shell (as herdr starts with). */
	addRootPane(workspaceId = "w1"): string {
		const paneId = `${workspaceId}:p${this.nextPane++}`;
		this.panes.set(paneId, {
			pane_id: paneId,
			tab_id: `${workspaceId}:t1`,
			workspace_id: workspaceId,
			cwd: "/tmp/project",
			agent_status: undefined,
			busyUntil: 0,
			screen: [],
			processes: [],
		});
		const tabId = `${workspaceId}:t1`;
		if (!this.tabs.has(tabId)) {
			this.tabs.set(tabId, {
				tab_id: tabId,
				workspace_id: workspaceId,
				label: null,
				paneIds: [],
			});
		}
		this.tabs.get(tabId)!.paneIds.push(paneId);
		return paneId;
	}

	/**
	 * Create an out-of-band pane inside an EXISTING tab.
	 * Models a pane created by someone else, which is what the orphan audit must
	 * detect. `addRootPane` cannot serve this purpose: it always lands in `w1:t1`.
	 */
	addPaneInTab(tabId: string, workspaceId = "w1"): string {
		const paneId = `${workspaceId}:p${this.nextPane++}`;
		this.panes.set(paneId, {
			pane_id: paneId,
			tab_id: tabId,
			workspace_id: workspaceId,
			cwd: "/tmp/project",
			agent_status: undefined,
			busyUntil: 0,
			screen: [],
			processes: [],
		});
		this.tabs.get(tabId)?.paneIds.push(paneId);
		return paneId;
	}

	/** Pre-register a live agent (bypasses agent start, e.g. for name-taken tests). */
	addAgent(
		name: string,
		paneId: string,
		kind = "pi",
		sessionPath: string | null = `/tmp/sessions/${name}.jsonl`,
	): FakeAgent {
		this.agents.set(name, {
			name,
			kind,
			paneId,
			sessionPath,
			status: "idle",
			labels: {},
			pendingPrompts: [],
			script: [],
			scriptIndex: 0,
		});
		const pane = this.panes.get(paneId);
		if (pane) pane.agent_status = "idle";
		return this.agents.get(name)!;
	}

	/** Script the next turn(s) an agent will run. */
	scriptTurns(name: string, turns: FakeTurn[]): void {
		const agent = this.agents.get(name);
		if (!agent) throw new FakeHerdrError("agent_not_found", `no agent ${name}`);
		agent.script.push(...turns);
	}

	// -- F19 -------------------------------------------------------------------

	/** Whether the pane currently rejects `agent start` (race window). */
	isPaneBusy(paneId: string): boolean {
		const pane = this.panes.get(paneId);
		if (!pane) return false;
		return pane.busyUntil > this.clock;
	}

	// -- F11 -------------------------------------------------------------------

	/** Whether the agent exited cleanly (ctrl+d was sent — never ctrl+c). */
	hasExited(name: string): boolean {
		return this.agents.get(name)?.status === "exited";
	}

	// -- internals -----------------------------------------------------------------

	private runTurn(name: string, prompt: string): void {
		const agent = this.agents.get(name);
		if (!agent) return;
		agent.pendingPrompts.push(prompt);
		const pane = this.panes.get(agent.paneId);
		const turn = agent.script[agent.scriptIndex];
		agent.status = "working";
		if (pane) pane.agent_status = "working";

		const duration = turn?.durationMs ?? 5;
		const finish = () => {
			this.clock += duration;
			if (turn) {
				agent.scriptIndex += 1;
				if (pane) {
					pane.screen.push(turn.outputText);
				}
				agent.status = turn.exitsAfter ? "exited" : "done";
				if (pane) pane.agent_status = turn.exitsAfter ? undefined : "idle";
				if (turn.exitsAfter) {
					// F16: the name is freed on exit.
					this.agents.delete(name);
				}
			} else {
				agent.status = "done";
				if (pane) pane.agent_status = "idle";
			}
		};
		// Turns resolve synchronously on the fake clock — deterministic tests.
		finish();
	}

	private paneBusyError(): { stderr: string; code: number } {
		// F21: error JSON on stderr, EMPTY stdout, exit code 1.
		return {
			stderr: `${JSON.stringify({
				error: {
					code: "agent_pane_busy",
					message: "pane is not an available shell yet",
				},
			})}\n`,
			code: 1,
		};
	}

	// -- CLI dispatch -----------------------------------------------------------

	/** Execute one `herdr ...` invocation against the in-memory state. */
	exec(args: string[]): { stdout: string; stderr: string; code: number } {
		const record = (
			stdout: string,
			stderr: string,
			code: number,
		): { stdout: string; stderr: string; code: number } => {
			this.commands.push({ args: [...args], stdout, stderr, code });
			return { stdout, stderr, code };
		};
		const okOut = (
			payload: unknown,
		): { stdout: string; stderr: string; code: number } =>
			record(`${JSON.stringify({ result: payload })}\n`, "", 0);
		const fail = (
			code: string,
			message: string,
		): { stdout: string; stderr: string; code: number } =>
			// F21: errors go to stderr with empty stdout.
			record("", `${JSON.stringify({ error: { code, message } })}\n`, 1);

		const [head, ...rest] = args;

		// -- meta --------------------------------------------------------------
		if (head === "--version") return okOut("herdr 0.4.2-fake");

		// -- panes -------------------------------------------------------------
		if (head === "pane") {
			const [sub, ...sargs] = rest;
			if (sub === "split") {
				const cwdIdx = sargs.indexOf("--cwd");
				const cwd = cwdIdx >= 0 ? (sargs[cwdIdx + 1] ?? null) : null;
				const workspaceId = "w1";
				// The tab is decided by the split TARGET: real herdr splits that pane,
				// so the new pane inherits its tab. `--current` resolves to the ambient
				// pane (w1:t1 in the fake). A bare positional is only a pane id when it
				// looks like one — flag values (e.g. `--direction down`) must not match.
				const targetIdx = sargs.indexOf("--pane");
				const positional = sargs.find((a) => /^w\d+:p\w+$/.test(a));
				const explicitTarget = targetIdx >= 0 ? sargs[targetIdx + 1] : positional;
				const targetPane = explicitTarget
					? this.panes.get(explicitTarget)
					: undefined;
				if (explicitTarget && !targetPane) {
					return fail("target_pane_not_found", `no pane ${explicitTarget}`);
				}
				const tabId = targetPane?.tab_id ?? "w1:t1";
				const paneId = `${workspaceId}:p${this.nextPane++}`;
				this.panes.set(paneId, {
					pane_id: paneId,
					tab_id: tabId,
					workspace_id: workspaceId,
					cwd,
					agent_status: undefined,
					// F19: the pane is busy for paneBusyMs after the split.
					busyUntil: this.clock + this.paneBusyMs,
					screen: [],
					processes: [],
				});
				this.tabs.get(tabId)?.paneIds.push(paneId);
				return okOut({ pane: this.paneJson(paneId) });
			}
			if (sub === "close") {
				const paneId = sargs[0] ?? "";
				const pane = this.panes.get(paneId);
				if (!pane) return fail("pane_not_found", `no pane ${paneId}`);
				// pane close kills any agent on it (F12) but frees names too.
				for (const [name, agent] of [...this.agents]) {
					if (agent.paneId === paneId) this.agents.delete(name);
				}
				this.panes.delete(paneId);
				return okOut({ closed: paneId });
			}
			if (sub === "read") {
				const paneId = sargs[0] ?? "";
				const pane = this.panes.get(paneId);
				if (!pane) return fail("pane_not_found", `no pane ${paneId}`);
				// F6: plain text, NOT JSON.
				return record(`${pane.screen.join("\n")}\n`, "", 0);
			}
			if (sub === "list") {
				return okOut({
					panes: [...this.panes.values()].map((p) => this.paneJson(p.pane_id)),
				});
			}
			if (sub === "get" && rest[0] !== undefined) {
				const paneId = sargs[0] ?? "";
				const pane = this.panes.get(paneId);
				if (!pane) return fail("pane_not_found", `no pane ${paneId}`);
				return okOut({ pane: this.paneJson(paneId) });
			}
			if (sub === "process-info") {
				const idx = sargs.indexOf("--pane");
				const paneId = (idx >= 0 ? sargs[idx + 1] : sargs[0]) ?? "";
				const pane = this.panes.get(paneId);
				if (!pane) return fail("pane_not_found", `no pane ${paneId}`);
				return okOut({
					process_info: {
						foreground_processes: pane.processes.map((p) => ({ ...p })),
						shell_pid: 1000 + this.nextPane,
					},
				});
			}
			if (sub === "report-metadata") return okOut({ reported: true });
			return fail("unknown_command", `unknown pane subcommand ${String(sub)}`);
		}

		// -- tabs --------------------------------------------------------------
		if (head === "tab") {
			const [sub, ...sargs] = rest;
			if (sub === "create") {
				const workspaceId = "w1";
				// `addRootPane` pre-registers `w1:t1` without consuming the counter, so
				// skip any id already taken — otherwise a created tab would overwrite it.
				let tabId = `${workspaceId}:t${this.nextTab++}`;
				while (this.tabs.has(tabId)) {
					tabId = `${workspaceId}:t${this.nextTab++}`;
				}
				const labelIdx = sargs.indexOf("--label");
				const label = labelIdx >= 0 ? (sargs[labelIdx + 1] ?? null) : null;
				const paneId = `${workspaceId}:p${this.nextPane++}`;
				this.tabs.set(tabId, {
					tab_id: tabId,
					workspace_id: workspaceId,
					label,
					paneIds: [paneId],
				});
				this.panes.set(paneId, {
					pane_id: paneId,
					tab_id: tabId,
					workspace_id: workspaceId,
					cwd: null,
					agent_status: undefined,
					busyUntil: this.clock + this.paneBusyMs,
					screen: [],
					processes: [],
				});
				return okOut({
					tab: this.tabJson(tabId),
					root_pane: this.paneJson(paneId),
				});
			}
			if (sub === "close") {
				const tabId = sargs[0] ?? "";
				const tab = this.tabs.get(tabId);
				if (!tab) return fail("tab_not_found", `no tab ${tabId}`);
				// F15: tab close atomically clears panes + agents.
				for (const paneId of tab.paneIds) {
					for (const [name, agent] of [...this.agents]) {
						if (agent.paneId === paneId) this.agents.delete(name);
					}
					this.panes.delete(paneId);
				}
				this.tabs.delete(tabId);
				return okOut({ closed: tabId });
			}
			if (sub === "rename") {
				const tab = this.tabs.get(sargs[0] ?? "");
				if (!tab) return fail("tab_not_found", `no tab ${sargs[0]}`);
				tab.label = sargs[1] ?? null;
				return okOut({ tab: this.tabJson(tab.tab_id) });
			}
			if (sub === "list") {
				return okOut({
					tabs: [...this.tabs.values()].map((t) => this.tabJson(t.tab_id)),
				});
			}
			return fail("unknown_command", `unknown tab subcommand ${String(sub)}`);
		}

		// -- agents ------------------------------------------------------------
		if (head === "agent") {
			const [sub, ...sargs] = rest;
			if (sub === "start") {
				const name = sargs[0] ?? "";
				const kindIdx = sargs.indexOf("--kind");
				const kind = (kindIdx >= 0 ? sargs[kindIdx + 1] : "pi") ?? "pi";
				const paneIdx = sargs.indexOf("--pane");
				const paneId = (paneIdx >= 0 ? sargs[paneIdx + 1] : sargs[1]) ?? "";
				const pane = this.panes.get(paneId);
				if (!pane) return fail("pane_not_found", `no pane ${paneId}`);
				// F19: the pane-busy race.
				if (this.isPaneBusy(paneId))
					return record("", this.paneBusyError().stderr, 1);
				// F16: names are unique among LIVE agents.
				if (this.agents.has(name)) {
					return fail("agent_name_taken", `agent name ${name} is already used`);
				}
				// F1/F7: only pi kinds report a session path.
				const sessionPath = kind === "pi" ? `/tmp/sessions/${name}.jsonl` : null;
				this.addAgent(name, paneId, kind, sessionPath);
				const agent = this.agents.get(name)!;
				pane.agent_status = "idle";
				pane.processes.push({
					argv: ["fake", kind],
					cmdline: `fake ${kind} ${name}`,
					pid: 4000 + this.agents.size,
					name: kind,
				});
				return okOut({
					agent: this.agentJson(name ?? ""),
					argv: agent.kind === "pi" ? ["pi", "--mode", "json"] : [kind],
				});
			}
			if (sub === "prompt") {
				const target = sargs[0] ?? "";
				const text = sargs[1] ?? "";
				const agent = this.agents.get(target ?? "");
				if (!agent) return fail("agent_not_found", `no agent ${target}`);
				const turn = agent.script[agent.scriptIndex];
				if (agent.status === "working" && turn?.steerable) {
					// F10: steering accepted, prompt does not queue.
					this.steeredPrompts.push({ text, at: this.clock });
				} else if (agent.status === "working") {
					agent.pendingPrompts.push(text);
				} else {
					this.runTurn(agent.name, text);
				}
				return okOut({ agent: this.agentJson(agent.name) });
			}
			if (sub === "get") {
				const agent = this.agents.get(sargs[0] ?? "");
				if (!agent) return fail("agent_not_found", `no agent ${sargs[0]}`);
				return okOut({ agent: this.agentJson(agent.name) });
			}
			if (sub === "list") {
				return okOut({
					agents: [...this.agents.values()].map((a) => this.agentJson(a.name)),
				});
			}
			if (sub === "send-keys") {
				const target = sargs[0];
				const keys = sargs.slice(1);
				const agent = this.agents.get(target ?? "");
				this.sentKeys.push({ target: target ?? "", keys, at: this.clock });
				if (!agent) return fail("agent_not_found", `no agent ${target}`);
				// F11: ctrl+d is the clean exit; ctrl+c does NOT stop the agent.
				if (keys.includes("ctrl+d")) {
					agent.status = "exited";
					const pane = this.panes.get(agent.paneId);
					if (pane) pane.agent_status = undefined;
					this.agents.delete(agent.name);
				}
				return okOut({ sent: keys });
			}
			if (sub === "wait") {
				const target = sargs[0];
				const agent = this.agents.get(target ?? "");
				if (!agent) return fail("agent_not_found", `no agent ${target}`);
				// Fake clock: turns resolve synchronously, so wait returns immediately.
				return okOut({ waited: agent.name, status: agent.status });
			}
			return fail("unknown_command", `unknown agent subcommand ${String(sub)}`);
		}

		return fail("unknown_command", `unknown command ${String(head)}`);
	}

	// -- JSON shapes ------------------------------------------------------------

	private paneJson(paneId: string): Record<string, unknown> {
		const pane = this.panes.get(paneId)!;
		return {
			pane_id: pane.pane_id,
			tab_id: pane.tab_id,
			workspace_id: pane.workspace_id,
			agent_status: pane.agent_status ?? null,
			cwd: pane.cwd,
			terminal_title_stripped: `pane ${pane.pane_id}`,
		};
	}

	private tabJson(tabId: string): Record<string, unknown> {
		const tab = this.tabs.get(tabId)!;
		return {
			tab_id: tab.tab_id,
			workspace_id: tab.workspace_id,
			label: tab.label,
			pane_count: tab.paneIds.length,
		};
	}

	private agentJson(name: string): Record<string, unknown> {
		const agent = this.agents.get(name);
		if (!agent) throw new FakeHerdrError("agent_not_found", `no agent ${name}`);
		return {
			name: agent.name,
			pane_id: agent.paneId,
			tab_id: this.panes.get(agent.paneId)?.tab_id ?? null,
			workspace_id: "w1",
			agent: agent.kind,
			agent_status: agent.status,
			cwd: this.panes.get(agent.paneId)?.cwd ?? null,
			// F1: pi → {kind, source, value: sessionPath}; F7: non-pi → null.
			agent_session: agent.sessionPath
				? { kind: "session", source: "pi", value: agent.sessionPath }
				: null,
			state_labels: agent.labels,
			tokens: { input: 0, output: 0 },
		};
	}
}

// ---------------------------------------------------------------------------
// CommandRunner adapters
// ---------------------------------------------------------------------------

/**
 * A CommandRunner backed by the in-memory fake. Never touches disk or processes.
 * The client's `available()` probe passes a timeoutMs — ignored here.
 */
export function createFakeRunner(fake: FakeHerdr): CommandRunner {
	return async (args) => fake.exec(args);
}

/**
 * A runner whose binary is missing (F22): every spawn fails with ENOENT,
 * which the real runner reports as code -1 + stderr text.
 */
export function createMissingBinaryRunner(): CommandRunner {
	return async () => ({
		stdout: "",
		stderr: "Error: spawn herdr ENOENT",
		code: -1,
	});
}
