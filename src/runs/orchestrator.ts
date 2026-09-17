/**
 * Launch / collect / retire orchestration.
 *
 * Design refs: §5 (recycling), §9 (launch), §10 (collect).
 * Measured refs that shape this code:
 *   F4  — pre-create the session file (closes the lazy-creation data-loss window)
 *   F8  — `agent wait` covers a turn
 *   F11 — clean exit is ctrl+d, NOT ctrl+c
 *   F15 — `tab close` reaps everything atomically
 *   F19 — `agent_pane_busy` race after a split; retry with backoff
 *   F21 — errors arrive on stderr
 *   F22 — a missing binary looks like a start timeout
 *   F26 — `agent_status` cannot tell success from failure
 *   F27 — after exit the agent is gone; collect BEFORE recycle or lose the outcome
 *   F29 — a hard kill leaves no assistant message
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { readPaneDiagnostic } from "../herdr/client.ts";
import { makeName } from "../shared/name.ts";
import {
	encodeNestedPath,
	parseNestedPathEnv,
} from "../shared/nested-path.ts";
import { CHILD_ACCEPTANCE_ROLE_ENV, CHILD_ROLE_ENV } from "../extension/child-guard.ts";
import {
	ALLOW_NESTED_ENV,
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
} from "../extension/budget.ts";
import { modelCandidates } from "../agents/model-resolution.ts";
import {
	countAssistantMessages,
	deriveOutcome,
	isLastTurnComplete,
	parseSessionFile,
	emptyParsedSession,
	extractVerdict,
} from "../shared/session.ts";
import {
	type AgentConfig,
	type AcceptanceResult,
	type ChildRecord,
	DEFAULTS,
	ErrorCodes,
	type Execution,
	type Handle,
	type HerdrClient,
	MAX_NESTED_PATH_ENTRIES,
	type NestedPathEntry,
	type Placement,
	type RunRecord,
	SubagentError,
	type Usage,
} from "../shared/types.ts";
import { applyVerification, type VerifyRunner } from "./acceptance.ts";
import { buildPiArgs } from "./args.ts";
import { canUseCachedCollect } from "../extension/recycle.ts";
import {
	createChildWorktree,
	removeChildWorktree,
} from "./worktree.ts";
import {
	createSessionLayout,
	typeTabLabel,
	type SessionLayout,
	type TypeTabCreateResult,
} from "./layout.ts";

export interface OrchestratorDeps {
	client: HerdrClient;
	/** Absolute path of the run directory; session files live here. */
	runDir: string;
	/** Working directory for child agents. */
	cwd: string;
	/** Called after every state change so the caller can persist. */
	onChildUpdate?: (child: ChildRecord) => void;
	/** Injected for tests. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	startRetries?: number;
	startRetryBackoffMs?: number;
	startTimeoutMs?: number;
	/**
	 * Lineage of THIS process, read from the environment when running as a
	 * child. Appended to when spawning children so a grandchild knows its full
	 * ancestry (design §4.2).
	 */
	parentPath?: NestedPathEntry[];
	/** Hard ceiling on nesting depth; launches beyond it are refused. */
	maxDepth?: number;
	/**
	 * Maximum children this orchestrator may spawn. Enforces
	 * `subagents.maxSubagentSpawnsPerSession` so a runaway fan-out cannot
	 * exhaust the machine. `null`/undefined means unlimited.
	 */
	maxSpawns?: number | null;
	/**
	 * Session-wide tab/name registry. Same agent type shares one tab (each
	 * child a pane). The extension passes one instance so parallel tool calls
	 * cannot each create a tab; tests omit it and get an isolated registry.
	 */
	layout?: SessionLayout;
	/** Injected so tests do not actually run `npm test`. */
	verifyRunner?: VerifyRunner;
	/**
	 * Parent agent's herdr Space (`HERDR_WORKSPACE_ID`). Pins `tab create`
	 * and adopt to that Space; without it herdr uses the UI-focused Space.
	 */
	workspaceId?: string;
}

export interface CollectResult {
	execution: Execution;
	output: string;
	usage: Usage | null;
	model: string | null;
	acceptance: AcceptanceResult;
	blocked?: boolean;
}

/** Environment variable carrying the lineage chain into a child process. */
const LINEAGE_ENV = "PI_SUBAGENT_PARENT_PATH";
/** Environment variable carrying the depth ceiling into a child process. */
const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
/** Environment variable marking a process as a subagent child. */
const CHILD_ENV = "PI_SUBAGENT_CHILD";

const defaultSleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));

/**
 * Await a teardown call whose failure is genuinely ignorable.
 *
 * Recycling is best-effort by design: a pane may already be gone, and the
 * session file survives either way (F12). Spelling that intent once keeps the
 * call sites free of `await x.catch(...)` chains, which mix two async styles
 * and hide which failures matter.
 */
async function bestEffort(work: Promise<unknown>): Promise<void> {
	try {
		await work;
	} catch {
		/* teardown is best-effort */
	}
}

function canFallbackStart(error: unknown): boolean {
	if (!(error instanceof SubagentError)) return false;
	return (
		error.code !== ErrorCodes.NOT_FOUND &&
		error.code !== ErrorCodes.BUDGET_EXCEEDED &&
		error.code !== ErrorCodes.NAME_TAKEN
	);
}

/**
 * Random hex token proving we created a pane (guards against killing others').
 * Crypto-safe: this token is the ownership proof persisted in run.json.
 */
function ownerToken(): string {
	return randomBytes(8).toString("hex");
}

/**
 * Derive the acceptance verdict (design §3.5).
 *
 * L2 reads the agent's own machine-readable verdict. An agent asserting success
 * is exactly the signal that cannot be trusted (F32), so a self-report can only
 * ever reach `attested` — never `verified`.
 *
 * L3 criteria are SEMANTIC (`must: "tests pass"`), so the runtime cannot decide
 * them. Rather than silently dropping the checklist, it is carried forward for
 * the caller to confirm; that is also why `verified` is never claimed here.
 */
function deriveAcceptance(
	parsed: ReturnType<typeof parseSessionFile>,
	execution: Execution,
	pendingCriteria: ChildRecord["pendingCriteria"],
	opts: { completionGuard?: boolean } = {},
): AcceptanceResult {
	let acceptance: AcceptanceResult = { status: "unknown", level: "none" };
	// MUST read `lastTurnOutput`, not `output`: `output` is the last non-empty text
	// anywhere in the session, so it survives into a turn that produced none — and
	// a stale "ok" from an earlier turn would then be reported as
	// accepted/attested while `execution` says aborted (F39).
	const verdict = extractVerdict(parsed.lastTurnOutput ?? "");

	if (verdict) {
		acceptance = {
			status: verdict.ok ? "accepted" : "rejected",
			level: "attested",
			...(verdict.reason ? { reason: verdict.reason } : {}),
		};
	} else if (execution.status === "success") {
		acceptance = opts.completionGuard
			? {
					status: "rejected",
					level: "none",
					reason: 'completionGuard: missing {"ok": true|false} verdict',
				}
			: {
					status: "unknown",
					level: "none",
					reason: "no machine-readable verdict",
				};
	} else {
		acceptance = {
			status: "rejected",
			level: "none",
			reason: execution.reason ?? execution.status,
		};
	}

	if (pendingCriteria?.length) {
		acceptance = {
			...acceptance,
			pendingCriteria: pendingCriteria.map((c) => ({ ...c })),
		};
	}

	return acceptance;
}

/**
 * Pre-create the session file (F4).
 *
 * pi creates session files lazily: a child that dies before its first flush
 * leaves NO file, so there is nothing to resume. Creating it up front closes
 * that window and is verified to not interfere with normal writes.
 */
/**
 * Pre-create an empty session file (F4) so pi cannot lose the first turn.
 *
 * Reports a clear error when the directory is unusable: a bare `mkdirSync`
 * surfaces as an opaque `ENOTDIR`/`EACCES` from deep inside the launcher.
 */
export function preCreateSessionFile(file: string): void {
	const dir = path.dirname(file);
	try {
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
		throw new SubagentError(
			`cannot write run artifacts to ${dir} (${code}). ` +
				`Subagent runs need a writable directory: pass a writable \`cwd\` ` +
				`to the subagent tool, or run from a checkout you can write to.`,
			ErrorCodes.INVALID_PARAMS,
			{ dir },
		);
	}
}

// The bundled `large-class` rule matches ANY class whose body contains a
// method-like declaration (verified: a 2-member class trips it), so it fires on
// every class in this file regardless of size and cannot be satisfied by
// splitting. Orchestrator's own cohesion is tracked by the complexity rules.
// pi-lens-ignore: large-class
export class Orchestrator {
	private readonly client: HerdrClient;
	private readonly runDir: string;
	private readonly cwd: string;
	private readonly onChildUpdate: (child: ChildRecord) => void;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly startRetries: number;
	private readonly startBackoff: number;
	private readonly startTimeoutMs: number;
	/** Poll interval while waiting for a turn to produce its first output. */
	private readonly pollIntervalMs = 500;
	private readonly parentPath: NestedPathEntry[];
	private readonly maxDepth: number;
	private readonly maxSpawns: number | null;
	private readonly layout: SessionLayout;
	private readonly verifyRunner?: VerifyRunner;
	/**
	 * Parent Space id for `tab create` / adopt. Empty or unset means herdr
	 * places the tab in the UI-focused Space.
	 */
	private readonly workspaceId?: string;
	/** Last type-tab used by a child of this orchestrator. */
	private lastTypeTabId: string | null = null;
	private spawned = 0;
	private readonly children = new Map<string, ChildRecord>();
	private readonly counter = new Map<string, number>();

	constructor(deps: OrchestratorDeps) {
		this.client = deps.client;
		this.runDir = deps.runDir;
		this.cwd = deps.cwd;
		this.onChildUpdate = deps.onChildUpdate ?? (() => {});
		this.now = deps.now ?? (() => Date.now());
		this.sleep = deps.sleep ?? defaultSleep;
		this.startRetries = deps.startRetries ?? DEFAULTS.startRetries;
		this.startBackoff = deps.startRetryBackoffMs ?? DEFAULTS.startRetryBackoffMs;
		this.startTimeoutMs = deps.startTimeoutMs ?? DEFAULTS.startTimeoutMs;
		// Inherit lineage from the environment when this process is itself a child,
		// so nested subagents can be bounded and cycles are impossible.
		this.parentPath =
			deps.parentPath ?? parseNestedPathEnv(process.env[LINEAGE_ENV]);
		this.maxDepth =
			deps.maxDepth ??
			Number(process.env[MAX_DEPTH_ENV]) ??
			MAX_NESTED_PATH_ENTRIES;
		if (!Number.isFinite(this.maxDepth) || this.maxDepth < 1)
			this.maxDepth = MAX_NESTED_PATH_ENTRIES;
		this.maxSpawns = deps.maxSpawns ?? null;
		this.layout = deps.layout ?? createSessionLayout();
		this.verifyRunner = deps.verifyRunner;
		const rawWorkspaceId =
			deps.workspaceId ?? process.env.HERDR_WORKSPACE_ID;
		this.workspaceId = rawWorkspaceId?.trim() || undefined;
	}

	/** The lineage path a child of this process would receive. */
	childPath(agentName: string): NestedPathEntry[] {
		return [
			...this.parentPath,
			{ runId: path.basename(this.runDir), agent: agentName },
		].slice(-MAX_NESTED_PATH_ENTRIES);
	}

	/** Current nesting depth (0 = a top-level orchestrator). */
	get depth(): number {
		return this.parentPath.length;
	}

	sessionFileFor(name: string): string {
		return path.join(this.runDir, `${name}.jsonl`);
	}

	/**
	 * Names currently held by live agents across the WHOLE herdr session.
	 *
	 * herdr's agent-name namespace is global, not per-workspace: an unrelated
	 * session (or a human) can hold `orchestrator`, `reviewer-0`, etc. Consulting
	 * this before allocating avoids burning a retry on a name we can already see
	 * is taken.
	 */
	private async activeAgentNames(): Promise<Set<string>> {
		const res = await this.client.agentList();
		if (!res.ok) return new Set(); // best-effort: the retry path still covers us
		const names = new Set<string>();
		for (const agent of res.value) {
			if (agent.name) names.add(agent.name);
		}
		return names;
	}

	/**
	 * Allocate a herdr-valid name that is unique both within this run and
	 * against `reserved` (names held by other live agents).
	 */
	allocateName(agent: string, reserved?: ReadonlySet<string>): string {
		const seen = this.counter.get(agent) ?? 0;
		for (let i = seen; i < seen + 1000; i += 1) {
			const candidate = makeName(agent, i);
			if (!this.children.has(candidate) && !reserved?.has(candidate)) {
				this.counter.set(agent, i + 1);
				return candidate;
			}
		}
		this.counter.set(agent, seen + 1);
		return makeName(agent, seen);
	}

	/** The type-tab last used by a child of this orchestrator (null before launch). */
	get tabId(): string | null {
		return this.lastTypeTabId;
	}

	/**
	 * The tab for this agent type, created or adopted on first use.
	 *
	 * Same type = one tab, each child a pane. The first occupant takes the
	 * tab's root pane; later ones split that root by explicit id rather than
	 * `--current` (which needs HERDR_PANE_ID and fails headless).
	 *
	 * After a reload the in-memory registry is empty; we re-adopt by herdr
	 * tab label so a second scout still joins the scout tab.
	 */
	private async ensureTypeTab(
		agentType: string,
		env?: Record<string, string>,
		cwd: string = this.cwd,
	): Promise<{ tabId: string; rootPaneId: string }> {
		const slot = await this.layout.acquireTypeTab(agentType, () =>
			this.createOrAdoptTypeTab(agentType, env, cwd),
		);
		this.lastTypeTabId = slot.tabId;
		return { tabId: slot.tabId, rootPaneId: slot.rootPaneId };
	}

	private async createOrAdoptTypeTab(
		agentType: string,
		env?: Record<string, string>,
		cwd: string = this.cwd,
	): Promise<TypeTabCreateResult> {
		const label = typeTabLabel(agentType);
		const adopted = await this.adoptTabByLabel(label);
		if (adopted) return adopted;

		const res = await this.client.tabCreate({
			cwd,
			label,
			...(env ? { env } : {}),
			focus: false,
			...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
		});
		if (!res.ok) {
			throw new SubagentError(
				`tab create failed: ${res.error.message}`,
				res.error.code,
			);
		}
		return {
			tabId: res.value.tab.tab_id,
			rootPaneId: res.value.rootPaneId,
		};
	}

	/**
	 * Reuse a live herdr tab with this type's label (survives process reload).
	 *
	 * The root pane is treated as occupied: a later child must split, never
	 * steal a pane that may already host an agent.
	 */
	private async adoptTabByLabel(
		label: string,
	): Promise<TypeTabCreateResult | null> {
		const tabs = await this.client.tabList(this.workspaceId);
		if (!tabs.ok) return null;
		const hit = tabs.value.find(
			(t) =>
				t.label === label &&
				(!this.workspaceId || t.workspace_id === this.workspaceId),
		);
		if (!hit) return null;

		const panes = await this.client.paneList();
		if (!panes.ok) return null;
		const inTab = panes.value.filter((p) => p.tab_id === hit.tab_id);
		const root = inTab[0];
		if (!root) return null;
		return {
			tabId: hit.tab_id,
			rootPaneId: root.pane_id,
			rootOccupied: true,
			panes: inTab.map((p) => p.pane_id),
		};
	}

	/**
	 * Create the pane an agent will occupy.
	 *
	 * `new-tab` gives the child a tab of its OWN. Everything else lands in the
	 * type tab and is tiled automatically (3-column grid: fill a row of
	 * three, then wrap down). Agent frontmatter `split-down` is
	 * ignored here — stacking every child off the root looks like a column
	 * of thin panes.
	 */
	private async createPane(
		placement: Placement,
		agentType: string,
		env?: Record<string, string>,
		cwd: string = this.cwd,
	): Promise<{ paneId: string; tabId?: string }> {
		if (placement === "new-tab") {
			const res = await this.client.tabCreate({
				cwd,
				label: `task:${agentType}`,
				...(env ? { env } : {}),
				focus: false,
				...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
			});
			if (!res.ok) {
				throw new SubagentError(
					`tab create failed: ${res.error.message}`,
					res.error.code,
				);
			}
			return { paneId: res.value.rootPaneId, tabId: res.value.tab.tab_id };
		}

		await this.ensureTypeTab(agentType, env, cwd);
		return this.layout.assignPane(agentType, async (plan) => {
			const res = await this.client.paneSplit({
				target: plan.target,
				direction: plan.direction,
				cwd,
				...(env ? { env } : {}),
				focus: false,
			});
			if (!res.ok) {
				this.layout.dropTypeTab(agentType);
				throw new SubagentError(
					`pane split failed: ${res.error.message}`,
					res.error.code,
				);
			}
			return res.value.pane_id;
		});
	}

	/**
	 * Start an agent, retrying transient failures.
	 *
	 * Two measured races are retried rather than surfaced:
	 *   F19 — `agent_pane_busy` for a moment after a pane split.
	 *   F16 — `agent_name_taken`. herdr's name namespace is GLOBAL, so another
	 *         session holding `orchestrator` would otherwise fail our launch
	 *         outright; instead we allocate a fresh name and retry.
	 *
	 * Returns the name actually used, which may differ from `input.name`.
	 */
	private async startWithRetry(input: {
		name: string;
		kind: AgentConfig["kind"];
		paneId: string;
		args: string[];
		/** Supplies a replacement name when the current one is taken. */
		reallocate?: () => string;
	}): Promise<string> {
		let name = input.name;
		let lastMessage = "start failed";

		for (let attempt = 0; attempt < this.startRetries; attempt += 1) {
			const res = await this.client.agentStart({
				name,
				kind: input.kind,
				paneId: input.paneId,
				args: input.args,
				timeoutMs: this.startTimeoutMs,
			});
			if (res.ok) return name;

			lastMessage = res.error.message;

			// F16: the name is held by a live agent elsewhere. Take a new one and
			// retry instead of failing the launch.
			if (res.error.code === ErrorCodes.NAME_TAKEN && input.reallocate) {
				name = input.reallocate();
				await this.sleep(this.startBackoff + attempt * 50);
				continue;
			}

			if (res.error.code !== ErrorCodes.PANE_BUSY) {
				// A real error. F22: a missing binary shows up as a timeout, so
				// attach the pane's contents to make the cause visible.
				const diagnostic = await readPaneDiagnostic(this.client, input.paneId, 30);
				throw new SubagentError(
					`agent start failed (${res.error.code}): ${res.error.message}${
						diagnostic ? `\n--- pane output ---\n${diagnostic}` : ""
					}`,
					res.error.code,
					{ paneId: input.paneId },
				);
			}
			await this.sleep(this.startBackoff + attempt * 50);
		}
		throw new SubagentError(
			`agent start exhausted ${this.startRetries} retries: ${lastMessage}`,
			ErrorCodes.START_FAILED,
		);
	}

	/** Spawn-budget snapshot, for reporting and for tests. */
	budget(): { used: number; limit: number | null; remaining: number | null } {
		return {
			used: this.spawned,
			limit: this.maxSpawns,
			remaining:
				this.maxSpawns === null ? null : Math.max(0, this.maxSpawns - this.spawned),
		};
	}

	/**
	 * Launch a child agent. Returns a handle immediately; the child keeps
	 * running in its pane even if this process dies (F13).
	 */
	async launch(input: {
		agent: AgentConfig;
		task: string;
		name?: string;
		model?: string;
		thinking?: string | false;
		placement?: Placement;
	}): Promise<Handle> {
		// Allocate against BOTH our own children and the global herdr namespace.
		// herdr names are session-global, so an unrelated agent holding
		// `orchestrator` would otherwise cost us a failed start attempt.
		const reserved = await this.layout.liveNames(() => this.activeAgentNames());
		let name =
			input.name ??
			this.layout.claimName(
				input.agent.name,
				(n) => this.children.has(n) || reserved.has(n),
			);
		if (input.name) this.layout.rememberName(input.name);

		this.assertWithinBudgets();

		let sessionFile = this.sessionFileFor(name);
		preCreateSessionFile(sessionFile);

		const tempDir = fs.mkdtempSync(path.join(this.runDir, `tmp-${name}-`));
		const placement = input.placement ?? input.agent.placement ?? "split-down";

		let paneId: string | null = null;
		let worktreePath: string | undefined;
		try {
			if (input.agent.worktree) {
				worktreePath = createChildWorktree({
					repoCwd: this.cwd,
					runDir: this.runDir,
					name,
				});
			}
			const childCwd = worktreePath ?? this.cwd;
			const pane = await this.createPane(
				placement,
				input.agent.name,
				this.lineageEnv(name, input.agent),
				childCwd,
			);
			paneId = pane.paneId;

			const candidates = modelCandidates(
				input.model ?? input.agent.model,
				input.agent.fallbackModels,
			);
			const started = await this.startWithModelFallback({
				name,
				kind: input.agent.kind,
				paneId,
				agent: input.agent,
				task: input.task,
				sessionFile,
				thinking: input.thinking ?? input.agent.thinking,
				tempDir,
				cwd: childCwd,
				candidates,
				reallocate: () => {
					const next = this.layout.claimName(
						input.agent.name,
						(n) => this.children.has(n) || reserved.has(n),
					);
					sessionFile = this.rehomeSessionFile(sessionFile, next);
					return next;
				},
			});
			name = started.name;
			sessionFile = started.sessionFile;
			const usedModel = started.model;
			const snapshotModel =
				input.model || (usedModel && usedModel !== input.agent.model)
					? usedModel
					: undefined;

			const child = this.recordChild({
				name,
				agent: input.agent,
				paneId: pane.paneId,
				tabId: pane.tabId,
				sessionFile,
				...(snapshotModel ? { model: snapshotModel } : {}),
				...(worktreePath ? { worktreePath } : {}),
			});
			// Sidebar metadata is not on the launch critical path.
			void this.announceChild(child, input.agent.name, snapshotModel).catch(
				() => {},
			);

			return {
				name,
				paneId,
				sessionFile,
				runId: path.basename(this.runDir),
				agent: input.agent.name,
				kind: input.agent.kind,
				child,
			};
		} catch (error) {
			// Roll back the pane so a failed launch does not leak resources.
			if (paneId) {
				await bestEffort(this.client.paneClose(paneId));
				if (placement !== "new-tab") {
					await this.reapTypeTabIfEmpty(input.agent.name, paneId, undefined);
				}
			}
			if (worktreePath) {
				removeChildWorktree({ repoCwd: this.cwd, dest: worktreePath });
			}
			throw error;
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}

	/**
	 * Try each model candidate on the same pane. A start that fails for a
	 * reason other than "name taken" / "not found" falls through to the next
	 * id; NAME_TAKEN is already reallocated inside `startWithRetry`.
	 */
	private async startWithModelFallback(input: {
		name: string;
		kind: AgentConfig["kind"];
		paneId: string;
		agent: AgentConfig;
		task: string;
		sessionFile: string;
		thinking?: string | false;
		tempDir: string;
		cwd: string;
		candidates: Array<string | undefined>;
		reallocate: () => string;
	}): Promise<{ name: string; sessionFile: string; model?: string }> {
		let name = input.name;
		let sessionFile = input.sessionFile;
		let lastError: unknown;
		for (let i = 0; i < input.candidates.length; i += 1) {
			const model = input.candidates[i];
			const built = buildPiArgs({
				agent: input.agent,
				task: input.task,
				sessionFile,
				model,
				thinking: input.thinking,
				tempDir: input.tempDir,
				cwd: input.cwd,
				allowNestedSubagents: input.agent.allowNestedSubagents,
			});
			try {
				name = await this.startWithRetry({
					name,
					kind: input.kind,
					paneId: input.paneId,
					args: built.args,
					reallocate: () => {
						const next = input.reallocate();
						sessionFile = this.sessionFileFor(next);
						return next;
					},
				});
				return {
					name,
					sessionFile,
					...(model ? { model } : {}),
				};
			} catch (error) {
				lastError = error;
				if (!canFallbackStart(error) || i === input.candidates.length - 1) {
					throw error;
				}
			}
		}
		throw lastError instanceof Error
			? lastError
			: new SubagentError("agent start failed", ErrorCodes.START_FAILED);
	}

	/**
	 * Refuse a launch that would exceed the nesting ceiling or the spawn budget.
	 *
	 * Both are checked BEFORE any resource is created, so a refusal never leaks a
	 * pane; without the depth guard the lineage tree would be decorative and
	 * nesting could recurse forever.
	 */
	private assertWithinBudgets(): void {
		if (this.depth + 1 > this.maxDepth) {
			throw new SubagentError(
				`subagent nesting limit reached (depth ${this.depth}, max ${this.maxDepth}); ` +
					`raise maxSubagentDepth to allow deeper nesting`,
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
		if (this.maxSpawns !== null && this.spawned >= this.maxSpawns) {
			throw new SubagentError(
				`subagent spawn budget exhausted (${this.spawned}/${this.maxSpawns}); ` +
					`raise subagents.maxSubagentSpawnsPerSession to allow more`,
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
	}

	/**
	 * Lineage env for a child pane (design §4.2): a grandchild learns its full
	 * ancestry and is bounded by the same ceiling.
	 */
	private lineageEnv(
		name: string,
		agent?: AgentConfig,
	): Record<string, string> {
		const env: Record<string, string> = {
			[LINEAGE_ENV]: encodeNestedPath(this.childPath(name)),
			[MAX_DEPTH_ENV]: String(this.maxDepth),
			[CHILD_ENV]: "1",
			[CHILD_ROLE_ENV]: agent?.name ?? "",
		};
		if (agent?.acceptance?.role) {
			env[CHILD_ACCEPTANCE_ROLE_ENV] = agent.acceptance.role;
		}
		if (agent?.toolBudget?.maxToolCalls !== undefined) {
			env[MAX_TOOL_CALLS_ENV] = String(agent.toolBudget.maxToolCalls);
		}
		if (agent?.turnBudget?.maxTurns !== undefined) {
			env[MAX_TURNS_ENV] = String(agent.turnBudget.maxTurns);
		}
		if (agent?.toolTimeoutMs !== undefined) {
			env[TOOL_TIMEOUT_MS_ENV] = String(agent.toolTimeoutMs);
		}
		if (agent?.allowNestedSubagents) {
			env[ALLOW_NESTED_ENV] = "1";
		}
		return env;
	}

	/**
	 * Move a child's session file to follow a mid-launch rename so the resume
	 * credential stays valid; fall back to creating it if the rename cannot.
	 */
	private rehomeSessionFile(from: string, toName: string): string {
		const next = this.sessionFileFor(toName);
		try {
			fs.renameSync(from, next);
		} catch {
			preCreateSessionFile(next);
		}
		return next;
	}

	/** Build the child record, register it, and publish the update. */
	private recordChild(input: {
		name: string;
		agent: AgentConfig;
		paneId: string;
		tabId: string | undefined;
		sessionFile: string;
		model?: string;
		worktreePath?: string;
	}): ChildRecord {
		const { name, agent, sessionFile } = input;
		const child: ChildRecord = {
			name,
			paneId: input.paneId,
			sessionFile,
			ownerToken: ownerToken(),
			state: "working",
			spawnedAt: new Date(this.now()).toISOString(),
			agent: agent.name,
			kind: agent.kind,
			// Snapshot the declared criteria: `collect` may run in a later process
			// that cannot re-read this agent definition.
			...(agent.acceptance?.criteria?.length
				? {
						pendingCriteria: agent.acceptance.criteria.map((c) => ({
							...c,
						})),
					}
				: {}),
			...(agent.onBlocked ? { onBlocked: agent.onBlocked } : {}),
			...(agent.completionGuard ? { completionGuard: true } : {}),
			...(input.tabId ? { tabId: input.tabId } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
		};
		this.children.set(name, child);
		this.spawned += 1;
		this.onChildUpdate(child);
		return child;
	}

	/** Surface the child in the herdr sidebar (design §8.4). */
	private async announceChild(
		child: ChildRecord,
		agentName: string,
		model?: string,
	): Promise<void> {
		if (!child.paneId) return;
		await this.client.paneReportMetadata({
			paneId: child.paneId,
			source: "pi-herdr-subagents",
			displayAgent: agentName,
			tokens: {
				agent: agentName,
				model: model ?? "inherit",
				run: path.basename(this.runDir),
			},
		});
	}

	/** Send a follow-up prompt to a live child (steering, F10). */
	async steer(name: string, message: string): Promise<void> {
		const res = await this.client.agentPrompt(name, message);
		if (!res.ok) {
			throw new SubagentError(
				`steer failed: ${res.error.message}`,
				res.error.code,
			);
		}
	}

	/**
	 * Wait for the current turn to settle, then derive the outcome (F26-F31).
	 *
	 * Never trust `agent_status` for success/failure — it reports "done" for
	 * successes, LLM errors, and kills alike.
	 *
	 * `agent wait` alone is NOT sufficient: it matches any settled state, so it
	 * returns immediately when the agent is idle and the turn has not started
	 * yet (observed in end-to-end testing: collect returned in 19ms with zero
	 * assistant messages). The turn is therefore confirmed by watching the
	 * session file for actual progress, with `agent wait` used only as a fast
	 * wake-up signal.
	 */
	async collect(
		name: string,
		opts: { timeoutMs?: number } = {},
	): Promise<CollectResult> {
		const child = this.children.get(name);
		if (!child)
			throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);

		if (await this.isAgentBlocked(name)) return this.blockedResult(child);

		const timeoutMs = opts.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		const deadline = this.now() + timeoutMs;
		const initial = parseSessionFile(child.sessionFile);

		// Fast path: the turn has ALREADY settled (common when the caller polls
		// status first, re-collects after a crash, or collects a finished child).
		// Without this the wait below would never observe new growth and would
		// block for the entire timeout.
		const alreadySettled = isLastTurnComplete(initial);
		const wait = alreadySettled
			? "settled"
			: await this.awaitTurn(child, initial, deadline);
		if (wait === "blocked") return this.blockedResult(child);
		const timedOut = wait === "timeout";

		const parsed = parseSessionFile(child.sessionFile);
		const execution = await this.resolveExecution(
			name,
			parsed,
			timedOut,
			timeoutMs,
		);
		const acceptance = await applyVerification(
			deriveAcceptance(parsed, execution, child.pendingCriteria, {
				...(child.completionGuard ? { completionGuard: true } : {}),
			}),
			{
				cwd: child.worktreePath ?? this.cwd,
				criteria: child.pendingCriteria,
				run: this.verifyRunner,
				timeoutMs: Math.max(5_000, deadline - this.now()),
			},
		);

		child.state = "awaiting";
		child.execution = execution;
		child.acceptance = acceptance;
		this.onChildUpdate(child);

		return {
			execution,
			output: parsed.output,
			usage: parsed.usage,
			model: parsed.model,
			acceptance,
		};
	}

	/**
	 * Return a previously collected snapshot without waiting on the child.
	 *
	 * Used when the parent model calls `collect` after auto-watch already
	 * derived the outcome (and possibly recycled the pane).
	 */
	cachedCollect(name: string): CollectResult | undefined {
		const child = this.children.get(name);
		if (!child?.execution) return undefined;
		if (!canUseCachedCollect(child.state)) return undefined;
		const parsed = fs.existsSync(child.sessionFile)
			? parseSessionFile(child.sessionFile)
			: emptyParsedSession();
		return {
			execution: child.execution,
			output: parsed.output,
			usage: parsed.usage ?? child.execution.usage ?? null,
			model: parsed.model ?? child.execution.model ?? null,
			acceptance:
				child.acceptance ?? { status: "unknown", level: "none" },
			...(child.state === "blocked" ? { blocked: true } : {}),
		};
	}

	/** Unblock a child after the parent approved the pending tool. */
	async approveBlocked(name: string): Promise<void> {
		this.clearBlocked(name);
		await bestEffort(this.client.agentSendKeys(name, "y"));
	}

	/** Unblock a child after the parent denied the pending tool. */
	async rejectBlocked(name: string): Promise<void> {
		this.clearBlocked(name);
		await bestEffort(this.client.agentSendKeys(name, "n"));
	}

	/**
	 * Wait for the child's current turn to start and then settle.
	 *
	 * Two phases, because they answer different questions: phase 1 asks "did the
	 * turn produce anything at all?" (a collect issued right after launch would
	 * otherwise read the previous, empty state and report "unknown"), phase 2
	 * waits for that turn to stop growing.
	 *
	 * Bounded by BOTH the deadline and an iteration cap: if an injected clock does
	 * not advance with `sleep`, the deadline alone would spin forever.
	 *
	 * @returns whether the turn settled, timed out, or hit a tool approval.
	 */
	private async awaitTurn(
		child: ChildRecord,
		initial: ReturnType<typeof parseSessionFile>,
		deadline: number,
	): Promise<"settled" | "timeout" | "blocked"> {
		if (await this.isAgentBlocked(child.name)) return "blocked";
		const before = countAssistantMessages(initial);
		const timeoutMs = deadline - this.now();
		const maxPolls = Math.max(1, Math.ceil(timeoutMs / this.pollIntervalMs)) + 10;

		let progressed = false;
		for (let poll = 0; poll < maxPolls; poll += 1) {
			if (await this.isAgentBlocked(child.name)) return "blocked";
			const parsed = parseSessionFile(child.sessionFile);
			if (countAssistantMessages(parsed) > before) {
				progressed = true;
				break;
			}
			if (this.now() >= deadline) break;
			await this.sleep(this.pollIntervalMs);
		}

		// Nothing ever appeared: the caller gave up rather than the turn aborting.
		if (!progressed) return "timeout";

		const remaining = Math.max(1_000, deadline - this.now());
		await this.client.agentWait(child.name, { timeoutMs: remaining });
		await this.waitForQuiet(child.sessionFile, deadline);
		if (await this.isAgentBlocked(child.name)) return "blocked";
		return "settled";
	}

	private async isAgentBlocked(name: string): Promise<boolean> {
		const agentState = await this.client.agentGet(name);
		if (!agentState.ok) return false;
		return agentState.value.agent_status === "blocked";
	}

	private blockedResult(child: ChildRecord): CollectResult {
		const parsed = parseSessionFile(child.sessionFile);
		const execution: Execution = {
			status: "running",
			reason: "blocked: waiting for approval",
		};
		const acceptance = deriveAcceptance(
			parsed,
			execution,
			child.pendingCriteria,
			{
				...(child.completionGuard ? { completionGuard: true } : {}),
			},
		);
		child.state = "blocked";
		child.execution = execution;
		child.acceptance = acceptance;
		this.onChildUpdate(child);
		return {
			execution,
			output: parsed.output,
			usage: parsed.usage,
			model: parsed.model,
			acceptance,
			blocked: true,
		};
	}

	private clearBlocked(name: string): void {
		const child = this.children.get(name);
		if (!child) return;
		child.state = "working";
		child.execution = undefined;
		this.onChildUpdate(child);
	}

	/**
	 * Derive the outcome, disambiguating a timeout from a real abort.
	 *
	 * Both present as "no reply to the last prompt" (F29), so the discriminator
	 * is whether the agent is still alive:
	 *   alive + no reply -> still running (we timed out)
	 *   gone  + no reply -> aborted (killed mid-turn)
	 */
	private async resolveExecution(
		name: string,
		parsed: ReturnType<typeof parseSessionFile>,
		timedOut: boolean,
		timeoutMs: number,
	): Promise<Execution> {
		const execution = deriveOutcome(parsed);
		if (!timedOut || execution.status !== "aborted") return execution;

		const agentState = await this.client.agentGet(name);
		if (!agentState.ok) return execution;

		return {
			...execution,
			status: "running",
			reason: `collect timed out after ${timeoutMs}ms; the agent is still alive`,
		};
	}

	/**
	 * Wait until the session file stops growing for `settleQuietMs`.
	 *
	 * Guards against deriving an outcome from a half-written turn: the file is
	 * flushed incrementally, so a `stop` seen mid-stream may not be the last
	 * message the child will write.
	 */
	private async waitForQuiet(
		sessionFile: string,
		deadline: number,
	): Promise<void> {
		let lastSize = -1;
		let quietSince = this.now();
		const maxPolls = Math.max(
			1,
			Math.ceil(DEFAULTS.turnTimeoutMs / this.pollIntervalMs),
		);

		// Bounded by iterations as well as the deadline: an injected `sleep` that
		// does not advance the clock would otherwise spin here forever.
		for (let poll = 0; poll < maxPolls; poll += 1) {
			let size = 0;
			try {
				size = fs.statSync(sessionFile).size;
			} catch {
				size = 0;
			}

			if (size !== lastSize) {
				lastSize = size;
				quietSince = this.now();
			} else if (this.now() - quietSince >= DEFAULTS.settleQuietMs) {
				return;
			}

			if (this.now() >= deadline) return;
			await this.sleep(this.pollIntervalMs);
		}
	}

	/**
	 * Recycle a child.
	 *
	 * ORDER IS MANDATORY (F27): snapshot the outcome BEFORE the agent disappears,
	 * because `agent get` returns `agent_not_found` once it exits.
	 */
	async retire(name: string): Promise<ChildRecord> {
		const child = this.children.get(name);
		if (!child)
			throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);

		// 1. Capture the outcome while the session is still the source of truth.
		if (!child.execution && fs.existsSync(child.sessionFile)) {
			const parsed = parseSessionFile(child.sessionFile);
			child.execution = deriveOutcome(parsed);
		}

		// 2. Graceful exit first (F11: ctrl+d, never ctrl+c), then force-close.
		const paneId = child.paneId;
		const tabId = child.tabId;
		if (paneId) {
			const alive = await this.client.agentGet(name);
			if (alive.ok) {
				await bestEffort(this.client.agentSendKeys(name, "ctrl+d"));
				await this.sleep(600);
				await bestEffort(this.client.agentSendKeys(name, "ctrl+d"));
				await this.sleep(1_200);
			}
			// F12: closing the pane is safe — the session file survives and resumes.
			await bestEffort(this.client.paneClose(paneId));
			await this.reapTypeTabIfEmpty(child.agent ?? "", paneId, tabId);
		}

		child.state = "retired";
		child.retiredAt = new Date(this.now()).toISOString();
		child.paneId = null;
		this.onChildUpdate(child);
		return child;
	}

	/**
	 * After closing a child's pane, drop the type tab if it is now empty.
	 *
	 * Same-type agents share a tab; leaving an empty tab behind is the leftover
	 * the parent used to have to close by hand.
	 */
	private async reapTypeTabIfEmpty(
		agentType: string,
		paneId: string,
		tabId: string | undefined,
	): Promise<void> {
		const released = agentType
			? this.layout.releasePane(agentType, paneId)
			: { tabId: undefined, empty: true };
		if (released.empty && released.tabId) {
			await bestEffort(this.client.tabClose(released.tabId));
			return;
		}
		if (released.empty && tabId && !this.layout.getTypeTab(agentType)) {
			const panes = await this.client.paneList();
			if (!panes.ok) {
				await bestEffort(this.client.tabClose(tabId));
				return;
			}
			const left = panes.value.filter((p) => p.tab_id === tabId);
			if (left.length === 0) await bestEffort(this.client.tabClose(tabId));
		}
	}

	/** Retire every known child; optionally reap the whole tab (F15). */
	async retireAll(opts: { tabId?: string } = {}): Promise<ChildRecord[]> {
		const retired: ChildRecord[] = [];
		for (const name of [...this.children.keys()]) {
			try {
				retired.push(await this.retire(name));
			} catch {
				// Keep going: one bad child must not block the rest.
			}
		}
		if (opts.tabId) await bestEffort(this.client.tabClose(opts.tabId));
		return retired;
	}

	/**
	 * Audit for orphan panes: panes present in our tab but absent from our tree.
	 * herdr enforces no isolation (F23-F25), so this detects — never prevents —
	 * out-of-band pane creation.
	 */
	async auditOrphans(tabId: string): Promise<string[]> {
		const res = await this.client.paneList();
		if (!res.ok) return [];
		const known = new Set(
			[...this.children.values()].flatMap((c) => (c.paneId ? [c.paneId] : [])),
		);
		return res.value.flatMap((p) =>
			p.tab_id === tabId && !known.has(p.pane_id) ? [p.pane_id] : [],
		);
	}

	childrenSnapshot(): ChildRecord[] {
		return [...this.children.values()];
	}

	/** Rehydrate from a persisted run record (crash recovery). */
	restore(record: RunRecord): void {
		for (const child of record.children) {
			this.children.set(child.name, { ...child });
		}
	}
}
