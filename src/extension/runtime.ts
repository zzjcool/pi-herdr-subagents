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
	formatCompletionNotice,
	formatGroupedNotice,
	collectFailureInput,
	type SendMessageApi,
} from "./notify.ts";
import {
	DEFAULT_FLUSH_MS,
	DEFAULT_JOIN_MODE,
	JoinCoordinator,
	type JoinConfig,
} from "./join.ts";
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
import { DEFAULTS, type AgentKind } from "../shared/types.ts";

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
	/** Batching config; applied via setJoinConfig right after construction. */
	joinConfig?: JoinConfig;
}

const DEFAULT_REFRESH_MS = 500;
const DEFAULT_PROBE_MS = 2_000;
/** Fallback per-child timeout for wait(); index.ts passes the role value. */
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULTS.turnTimeoutMs;

/** A wait() promise that must settle by the deadline. */
class WaitTimeoutError extends Error {}

/** Recycle after collect unless the child is still waiting on the user. */
export function shouldRecycleAfterCollect(status: string): boolean {
	// `unknown` is terminal for non-pi kinds (F7: no jsonl). `running` means
	// collect gave up while the agent is still alive — keep the pane.
	return status !== "blocked" && status !== "running";
}

export interface WaitResult {
	name: string;
	/** Terminal snapshot (wait hit, or completed before the timeout). */
	snapshot?: CollectSnapshot;
	/** Still running when the timeout fired. */
	stillRunning?: boolean;
	/** Not tracked live and no finished cache (pre-validated upstream). */
	missing?: boolean;
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
	/** Forward join config to the internal coordinator (settings wiring). */
	setJoinConfig(config: JoinConfig): void;
	/**
	 * Explicit wait: suppress auto-notify on the targets via consumedByTool
	 * and aggregate their results. A timeout restores auto-notify.
	 */
	wait(
		names: string[],
		opts?: { timeoutMs?: number },
	): Promise<WaitResult[]>;
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

	// Smart join: batch completion notices per runId. The deliver sink merges
	// the buffered entries into ONE grouped message; an unbatched single-child
	// notice keeps the legacy "Background task …" format byte-for-byte (that
	// shape is asserted by pre-existing tests and muscle memory alike).
	let joinConfig: JoinConfig = deps.joinConfig ?? {
		mode: DEFAULT_JOIN_MODE,
		flushMs: DEFAULT_FLUSH_MS,
	};
	const join = new JoinCoordinator({
		deliver: (batch) => {
			if (disposed) return;
			const first = batch[0];
			if (!first) return;
			// A settled single-entry batch keeps the legacy "Background task …"
			// shape (asserted by pre-existing tests); a single entry flushed by
			// the WINDOW while stragglers are pending is a partial batch and
			// must use the grouped shape so the header can say "1 of N".
			// (mode "each" delivers immediately per member, so its single-entry
			// batches are never partial.)
			if (
				batch.length === 1 &&
				(joinConfig.mode === "each" || join.allSettled(first.runId))
			) {
				deliverCompletion(
					{ sendMessage: deps.sendMessage },
					formatCompletionNotice(first.input),
					first.triggerTurn,
				);
				return;
			}
			const triggerTurn = batch.some((e) => e.triggerTurn);
			// Partial flush: members of the same run still alive notify later.
			// consumedByTool members were just claimed by an explicit wait() —
			// the tool result carries them, so they are not "still running".
			const stillRunning = [...jobs.values()]
				.filter(
					(job) =>
						job.runId === first.runId &&
						job.state !== "retired" &&
						!job.consumedByTool &&
						!batch.some((e) => e.name === job.name),
				)
				.map((job) => job.name);
			deliverCompletion(
				{ sendMessage: deps.sendMessage },
				formatGroupedNotice({
					runId: first.runId,
					entries: batch.map((e) => ({ ...e.input, status: e.status })),
					...(stillRunning.length > 0 ? { stillRunning } : {}),
				}),
				triggerTurn,
			);
		},
	});
	join.setConfig(joinConfig);

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

	/**
	 * Wait for one child. Shares the in-flight watch's collect promise, so a
	 * hit suppresses the auto-notify (consumedByTool stays set); a TIMEOUT
	 * restores consumedByTool so the watch notifies normally when it lands.
	 */
	const waitOne = async (
		name: string,
		timeoutMs: number,
	): Promise<WaitResult> => {
		const job = jobs.get(name);
		if (!job) {
			const cached = finished.get(name);
			if (cached) return { name, snapshot: cached };
			return { name, missing: true };
		}
		job.consumedByTool = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const snapshot = await Promise.race([
				ensureCollect(job),
				new Promise<never>((_resolve, reject) => {
					// NOT unref'd: this timer may be the only thing driving the
					// caller's await; unref'd it could let the event loop drain
					// (and node:test abort the test) before the timeout fires.
					timer = setTimeout(
						() => reject(new WaitTimeoutError("wait timed out")),
						timeoutMs,
					);
				}),
			]);
			if (
				snapshot.blocked ||
				!shouldRecycleAfterCollect(snapshot.execution.status)
			) {
				// Not terminal: keep the pane and let the watch flow handle it.
				job.consumedByTool = false;
				if (snapshot.blocked && !job.watching) {
					// Nobody is collecting anymore: the previous watch consumed
					// this blocked snapshot and went hold. Without a rewatch the
					// eventual completion would never surface. Skip this branch
					// for a merely-running snapshot — a fresh watch would
					// re-collect the SAME running snapshot and treat it as a
					// terminal failure. Resume keeps the flag cleared on its own
					// branch, so no double-reset.
					job.collectPromise = undefined;
					job.notified = false;
					runtime.watch(name);
				}
				return { name, stillRunning: true };
			}
			if (jobs.get(name) === job) {
				try {
					await job.retire?.();
				} catch {
					// Recycle is best-effort; the snapshot is already in hand.
				}
				runtime.release(name);
			}
			return { name, snapshot };
		} catch (error) {
			if (error instanceof WaitTimeoutError) {
				// The watch is still in flight and shares this collect promise —
				// restore auto-notify or the result would never surface.
				job.consumedByTool = false;
				return { name, stillRunning: true };
			}
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
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
				join.addPending(input.runId, input.name);
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
			join.addPending(job.runId, job.name);
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
							join.addPending(job.runId, job.name);
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
						join.onTerminal({
							runId: job.runId,
							name: job.name,
							input: {
								name: job.name,
								agent: job.agent,
								execution: snapshot.execution,
								output: snapshot.output,
								sessionFile: job.sessionFile,
								acceptance: snapshot.acceptance,
								recycled: shouldRecycleAfterCollect(
									snapshot.execution.status,
								),
							},
							triggerTurn,
						});
					}
				} catch (error) {
					if (disposed || job.generation !== gen) return;
					job.state = "awaiting";
					if (!job.consumedByTool && !job.notified) {
						job.notified = true;
						// Collect failures join the batch too, as a failed entry.
						join.onTerminal({
							runId: job.runId,
							name: job.name,
							input: collectFailureInput(job.name, error),
							triggerTurn,
						});
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
			join.addPending(job.runId, job.name);
			runtime.watch(name, opts);
		},

		release(name) {
			if (!jobs.delete(name)) return;
			join.remove(name);
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

		setJoinConfig(config) {
			joinConfig = config;
			join.setConfig(config);
		},

		async wait(names, opts = {}) {
			return Promise.all(
				names.map((name) =>
					waitOne(name, opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
				),
			);
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			jobs.clear();
			finished.clear();
			join.dispose();
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
