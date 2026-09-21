/**
 * Session-scoped supervisor for live herdr children.
 *
 * Tool calls are short; children are not. This object lives for the parent
 * session so we can:
 *   1. show running children next to the input box,
 *   2. collect in the background,
 *   3. wake the parent with `sendMessage` when a turn finishes —
 *      without the child ever prompting the parent.
 */

import {
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	type SendMessageApi,
} from "./notify.ts";
import {
	createStatusBoard,
	formatBusyLabel,
	type StatusEntry,
	type StatusUi,
} from "../tui/status.ts";
import {
	mergeProgress,
	progressFromSessionFile,
	type LiveProgress,
} from "../shared/progress.ts";
import type { AgentKind } from "../shared/types.ts";

export interface CollectSnapshot {
	execution: { status: string; reason?: string };
	output: string;
	acceptance: {
		status: string;
		level?: string;
		pendingCriteria?: Array<{
			id: string;
			must: string;
			severity?: string;
		}>;
	};
	/** True when the child is alive but waiting on a tool approval. */
	blocked?: boolean;
}

export interface TrackedJobInput {
	name: string;
	runId: string;
	agent: string;
	sessionFile: string;
	spawnedAt?: number;
	timeoutMs: number;
	kind?: AgentKind;
	model?: string;
	thinking?: string | false;
	worktreeBranch?: string;
	/**
	 * Extra live fields when session jsonl is missing or incomplete (non-pi
	 * kinds). Called on a slower cadence than the widget tick.
	 */
	probe?: () => Promise<LiveProgress>;
	collect: () => Promise<CollectSnapshot>;
	persist?: (snapshot: CollectSnapshot) => Promise<void>;
	/** Recycle the pane after a terminal collect. Blocked children stay open. */
	retire?: () => Promise<void>;
	/**
	 * Called when collect reports a blocked child. `resume` rewatches after
	 * the parent approved or denied; `hold` keeps the widget up.
	 */
	handleBlocked?: (
		snapshot: CollectSnapshot,
	) => Promise<"resume" | "hold">;
}

export interface TrackedJob extends TrackedJobInput {
	spawnedAt: number;
	state: string;
	consumedByTool: boolean;
	notified: boolean;
	watching: boolean;
	generation: number;
	collectPromise?: Promise<CollectSnapshot>;
	probed?: LiveProgress;
	probePromise?: Promise<void>;
	lastProbeAt?: number;
}

export interface SessionRuntimeDeps {
	sendMessage: SendMessageApi["sendMessage"];
	emitBusy?: (active: boolean, label?: string) => void;
	now?: () => number;
	refreshMs?: number;
	/** How often to call `probe` (non-pi live fields). */
	probeMs?: number;
}

const DEFAULT_REFRESH_MS = 500;
const DEFAULT_PROBE_MS = 2_000;

/** Recycle after collect unless the child is still waiting on the user. */
export function shouldRecycleAfterCollect(status: string): boolean {
	// `unknown` is terminal for non-pi kinds (F7: no jsonl). `running` means
	// collect gave up while the agent is still alive — keep the pane.
	return status !== "blocked" && status !== "running";
}

export interface SessionRuntime {
	bind(ctx: StatusUi): void;
	track(input: TrackedJobInput): TrackedJob;
	watch(name: string, opts?: { triggerTurn?: boolean }): void;
	/**
	 * Mark this result as belonging to an explicit `collect` tool call so the
	 * watcher will not also inject a completion message. Returns the shared
	 * collect promise when we are already tracking the child.
	 */
	consumeCollect(name: string): Promise<CollectSnapshot> | undefined;
	rewatch(name: string, opts?: { triggerTurn?: boolean }): void;
	release(name: string): void;
	get(name: string): TrackedJob | undefined;
	activeJobs(): TrackedJob[];
	refreshUi(): void;
	dispose(): void;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
	const now = deps.now ?? Date.now;
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	const probeMs = deps.probeMs ?? DEFAULT_PROBE_MS;
	const jobs = new Map<string, TrackedJob>();
	const finished = new Map<string, CollectSnapshot>();
	const board = createStatusBoard();
	let ctx: StatusUi | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	let busyRaised = false;

	const entries = (): StatusEntry[] =>
		[...jobs.values()]
			.filter((job) => job.state !== "retired")
			.sort((a, b) => a.spawnedAt - b.spawnedAt)
			.map(statusEntryFromJob);

	const kickProbes = (): void => {
		if (disposed) return;
		const t = now();
		for (const job of jobs.values()) {
			if (!job.probe || job.probePromise) continue;
			if (job.lastProbeAt !== undefined && t - job.lastProbeAt < probeMs) {
				continue;
			}
			job.lastProbeAt = t;
			job.probePromise = job
				.probe()
				.then((live) => {
					if (disposed || jobs.get(job.name) !== job) return;
					job.probed = live;
					board.paint(entries(), now());
					syncBusy();
				})
				.catch(() => {
					/* live fields are best-effort */
				})
				.finally(() => {
					if (jobs.get(job.name) === job) job.probePromise = undefined;
				});
		}
	};

	const syncBusy = (): void => {
		const list = entries();
		const label = formatBusyLabel(list);
		if (list.length > 0) {
			if (busyRaised && label === undefined) return;
			deps.emitBusy?.(true, label);
			busyRaised = true;
			return;
		}
		if (busyRaised) {
			busyRaised = false;
			deps.emitBusy?.(false);
		}
	};

	const refreshUi = (): void => {
		if (disposed) return;
		board.paint(entries(), now());
		syncBusy();
		kickProbes();
	};

	const ensureTimer = (): void => {
		if (timer || jobs.size === 0 || disposed) return;
		timer = setInterval(() => refreshUi(), refreshMs);
		timer.unref?.();
	};

	const stopTimerIfIdle = (): void => {
		if (jobs.size > 0) return;
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const ensureCollect = (job: TrackedJob): Promise<CollectSnapshot> => {
		if (!job.collectPromise) {
			job.collectPromise = (async () => {
				const snapshot = await job.collect();
				try {
					await job.persist?.(snapshot);
				} catch {
					// Notification still happens; the tool-side persist is the backup.
				}
				if (!snapshot.blocked) finished.set(job.name, snapshot);
				return snapshot;
			})();
		}
		return job.collectPromise;
	};

	const runtime: SessionRuntime = {
		bind(next) {
			ctx = next;
			board.bind(next);
			refreshUi();
		},

		track(input) {
			const existing = jobs.get(input.name);
			if (existing) {
				existing.collect = input.collect;
				existing.persist = input.persist;
				existing.retire = input.retire;
				existing.timeoutMs = input.timeoutMs;
				existing.sessionFile = input.sessionFile;
				existing.agent = input.agent;
				existing.runId = input.runId;
				existing.kind = input.kind;
				existing.model = input.model;
				existing.thinking = input.thinking;
				existing.worktreeBranch = input.worktreeBranch;
				existing.probe = input.probe;
				existing.state = "working";
				ensureTimer();
				refreshUi();
				return existing;
			}
			const job: TrackedJob = {
				...input,
				spawnedAt: input.spawnedAt ?? now(),
				state: "working",
				consumedByTool: false,
				notified: false,
				watching: false,
				generation: 0,
			};
			jobs.set(job.name, job);
			ensureTimer();
			refreshUi();
			return job;
		},

		watch(name, opts = {}) {
			const job = jobs.get(name);
			if (!job || disposed) return;
			const triggerTurn = opts.triggerTurn !== false;
			const gen = (job.generation += 1);
			job.watching = true;
			job.state = "working";
			refreshUi();
			void (async () => {
				let snapshot: CollectSnapshot | undefined;
				let hold = false;
				try {
					snapshot = await ensureCollect(job);
					if (disposed || job.generation !== gen) return;
					if (snapshot.blocked) {
						job.state = "blocked";
						refreshUi();
						const next =
							(await job.handleBlocked?.(snapshot)) ?? "hold";
						if (disposed || job.generation !== gen) return;
						if (next === "resume") {
							job.collectPromise = undefined;
							job.notified = false;
							job.consumedByTool = false;
							job.state = "working";
							runtime.watch(name, opts);
							return;
						}
						hold = true;
						job.watching = false;
						return;
					}
					job.state = "awaiting";
					if (!job.consumedByTool && !job.notified) {
						job.notified = true;
						deliverCompletion(
							{ sendMessage: deps.sendMessage },
							formatCompletionNotice({
								name: job.name,
								agent: job.agent,
								execution: snapshot.execution,
								output: snapshot.output,
								sessionFile: job.sessionFile,
								acceptance: snapshot.acceptance,
								recycled: shouldRecycleAfterCollect(
									snapshot.execution.status,
								),
							}),
							triggerTurn,
						);
					}
				} catch (error) {
					if (disposed || job.generation !== gen) return;
					job.state = "awaiting";
					if (!job.consumedByTool && !job.notified) {
						job.notified = true;
						deliverCompletion(
							{ sendMessage: deps.sendMessage },
							formatCollectFailure(job.name, error),
							triggerTurn,
						);
					}
				} finally {
					if (job.generation === gen && !hold) {
						if (
							snapshot &&
							!snapshot.blocked &&
							shouldRecycleAfterCollect(snapshot.execution.status)
						) {
							try {
								await job.retire?.();
							} catch {
								// Recycle is best-effort; the completion notice already fired.
							}
						}
						job.watching = false;
						runtime.release(name);
					}
				}
			})();
		},

		consumeCollect(name) {
			const job = jobs.get(name);
			if (job) {
				job.consumedByTool = true;
				return ensureCollect(job);
			}
			const cached = finished.get(name);
			if (cached) return Promise.resolve(cached);
			return undefined;
		},

		rewatch(name, opts) {
			const job = jobs.get(name);
			if (!job || disposed) return;
			job.notified = false;
			job.consumedByTool = false;
			job.collectPromise = undefined;
			job.state = "working";
			finished.delete(name);
			runtime.watch(name, opts);
		},

		release(name) {
			if (!jobs.delete(name)) return;
			stopTimerIfIdle();
			refreshUi();
		},

		get(name) {
			return jobs.get(name);
		},

		activeJobs() {
			return [...jobs.values()];
		},

		refreshUi,

		dispose() {
			if (disposed) return;
			disposed = true;
			jobs.clear();
			finished.clear();
			if (timer) clearInterval(timer);
			timer = undefined;
			board.clear();
			if (busyRaised) {
				busyRaised = false;
				deps.emitBusy?.(false);
			}
			ctx = undefined;
		},
	};

	return runtime;
}

function statusEntryFromJob(job: TrackedJob): StatusEntry {
	const live = mergeProgress(
		progressFromSessionFile(job.sessionFile),
		job.probed,
	);
	const model = live.model ?? job.model;
	const thinking = live.thinking ?? job.thinking;
	return {
		name: job.name,
		agent: job.agent,
		state: job.state,
		startedAt: job.spawnedAt,
		...(job.kind ? { kind: job.kind } : {}),
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(job.worktreeBranch ? { worktreeBranch: job.worktreeBranch } : {}),
		...(live.herdrStatus ? { herdrStatus: live.herdrStatus } : {}),
		...(live.turns ? { turns: live.turns } : {}),
		...(live.lastTools?.length ? { lastTools: live.lastTools } : {}),
	};
}
