import type { DatabaseSync } from "../legion/db.ts";
import {
	LEGION_EVENT_TYPES as STORED_LEGION_EVENT_TYPES,
	getDataVersion,
	readEventsAfter,
} from "../legion/events.ts";
import type { LegionEventType as StoredLegionEventType } from "../legion/events.ts";

/** Process-only activity. These events are never written to the closed DB enum. */
export const LEGION_PROCESS_EVENT_TYPES = [
	"text_delta",
	"tool_call",
	"agent_settled",
	"turn_start",
] as const;
export type LegionProcessEventType = (typeof LEGION_PROCESS_EVENT_TYPES)[number];

/** Stored tree events plus transient RPC activity for consumers such as the live overlay. */
export const LEGION_EVENT_TYPES = [
	...STORED_LEGION_EVENT_TYPES,
	...LEGION_PROCESS_EVENT_TYPES,
] as const;
export type LegionEventType = StoredLegionEventType | LegionProcessEventType;

/**
 * A normalized event-bus event. Persisted events retain the DB row id; process-only
 * events have no id. `data` is machine metadata, not a source for interpreting LLM claims.
 */
export interface LegionEvent<T = unknown> {
	id?: number;
	nodeId: string;
	type: LegionEventType;
	data: T | null;
	ts: number;
}

export type LegionEventHandler = (event: LegionEvent) => void;

export interface LegionEventBus {
	on(type: LegionEventType, handler: LegionEventHandler): () => void;
	emit(event: LegionEvent): void;
}

export interface LegionEventBusOptions {
	/** Optional observer for isolated subscriber failures. Failures here are isolated too. */
	onHandlerError?: (
		error: unknown,
		event: LegionEvent,
		handler: LegionEventHandler,
	) => void;
}

interface EventSubscription {
	handler: LegionEventHandler;
	active: boolean;
}

const EVENT_TYPE_SET = new Set<string>(LEGION_EVENT_TYPES);

/** Create a synchronous, multi-subscriber event bus with idempotent unsubscribe. */
export function createLegionEventBus(
	options: LegionEventBusOptions = {},
): LegionEventBus {
	const subscribers = new Map<LegionEventType, Set<EventSubscription>>();

	return {
		on(type, handler) {
			assertEventType(type);
			if (typeof handler !== "function") {
				throw new TypeError("event handler must be a function");
			}
			let handlers = subscribers.get(type);
			if (!handlers) {
				handlers = new Set();
				subscribers.set(type, handlers);
			}
			const subscription: EventSubscription = { handler, active: true };
			handlers.add(subscription);

			return () => {
				if (!subscription.active) return;
				subscription.active = false;
				handlers!.delete(subscription);
				if (handlers!.size === 0) subscribers.delete(type);
			};
		},
		emit(event) {
			assertEvent(event);
			const handlers = subscribers.get(event.type);
			if (!handlers?.size) return;

			// Snapshot the set so subscriptions added while dispatching start on the next emit.
			for (const subscription of [...handlers]) {
				if (!subscription.active || !handlers.has(subscription)) continue;
				try {
					subscription.handler(event);
				} catch (error) {
					try {
						options.onHandlerError?.(error, event, subscription.handler);
					} catch {
						// Error reporting must not break synchronous delivery to other consumers.
					}
				}
			}
		},
	};
}

export type EventSourceIntervalHandle = ReturnType<typeof globalThis.setInterval>;

export interface EventSourceClock {
	setInterval(callback: () => void, milliseconds: number): EventSourceIntervalHandle;
	clearInterval(handle: EventSourceIntervalHandle): void;
}

export interface DbEventSourceOptions {
	/** Contract §10.2 recommends 200–500ms; default is 250ms. */
	pollMs?: number;
	/** Resume after this persisted event id. Defaults to the beginning of the log. */
	cursor?: number;
	/** Injectable interval scheduler for deterministic tests and embedding. */
	clock?: EventSourceClock;
	onError?: (error: unknown) => void;
}

export interface DbEventSource {
	/** Start polling and immediately perform one initial incremental read. */
	start(bus: Pick<LegionEventBus, "emit">): void;
	/**
	 * Notify the source that this same connection committed an event. SQLite's
	 * data_version only reports writes from other connections, so this schedules
	 * an immediate cursor read for local commits without weakening the poll dirty-check.
	 */
	notifyLocalCommit(): void;
	stop(): void;
	/** Perform one dirty-check/read cycle when the source is running. */
	poll(): void;
	getCursor(): number;
	isRunning(): boolean;
}

const DEFAULT_POLL_MS = 250;
const EVENT_BATCH_SIZE = 1_000;
const systemClock: EventSourceClock = {
	setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
	clearInterval: (handle) => globalThis.clearInterval(handle),
};

/**
 * Poll the ledger using PRAGMA data_version as a cheap dirty check. It performs
 * one initial cursor read on start, then skips event SELECTs until another
 * connection has committed a change. It deliberately does not watch DB/WAL files.
 */
export function createDbEventSource(
	db: DatabaseSync,
	options: DbEventSourceOptions = {},
): DbEventSource {
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	if (!Number.isFinite(pollMs) || pollMs < 200 || pollMs > 500) {
		throw new TypeError("pollMs must be between 200 and 500 milliseconds");
	}
	let cursor = options.cursor ?? 0;
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new TypeError("cursor must be a non-negative safe integer");
	}

	const clock = options.clock ?? systemClock;
	let bus: Pick<LegionEventBus, "emit"> | undefined;
	let timer: EventSourceIntervalHandle | undefined;
	let running = false;
	let polling = false;
	let localCommitPending = false;
	let lastDataVersion: number | undefined;

	const reportError = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// Diagnostics are optional and cannot be allowed to stop the poller.
		}
	};

	const poll = (): void => {
		if (!running || !bus || polling) return;
		polling = true;
		const currentBus = bus;
		const hadLocalCommit = localCommitPending;
		localCommitPending = false;
		try {
			const dataVersion = getDataVersion(db);
			if (hadLocalCommit || lastDataVersion !== dataVersion) {
				// Drain all batches for this dirty version so the cursor cannot strand
				// events when a busy producer commits more than one batch at once.
				for (;;) {
					const batch = readEventsAfter(db, cursor, { limit: EVENT_BATCH_SIZE });
					for (const event of batch) {
						currentBus.emit(event);
						cursor = event.id;
						if (!running || bus !== currentBus) return;
					}
					if (batch.length < EVENT_BATCH_SIZE) break;
				}
				lastDataVersion = dataVersion;
			}
		} catch (error) {
			if (hadLocalCommit) localCommitPending = true;
			reportError(error);
		} finally {
			polling = false;
		}
	};

	return {
		start(nextBus) {
			if (running) return;
			bus = nextBus;
			running = true;
			poll();
			try {
				timer = clock.setInterval(poll, pollMs);
			} catch (error) {
				running = false;
				bus = undefined;
				throw error;
			}
		},
		notifyLocalCommit() {
			localCommitPending = true;
			poll();
		},
		stop() {
			if (timer !== undefined) {
				clock.clearInterval(timer);
				timer = undefined;
			}
			running = false;
			bus = undefined;
		},
		poll,
		getCursor: () => cursor,
		isRunning: () => running,
	};
}

function assertEventType(type: unknown): asserts type is LegionEventType {
	if (typeof type !== "string" || !EVENT_TYPE_SET.has(type)) {
		throw new TypeError(`invalid legion bus event type: ${String(type)}`);
	}
}

function assertEvent(event: LegionEvent): void {
	if (!event || typeof event !== "object") {
		throw new TypeError("event must be an object");
	}
	assertEventType(event.type);
	if (typeof event.nodeId !== "string" || event.nodeId.length === 0) {
		throw new TypeError("event nodeId must be a non-empty string");
	}
	if (!Number.isFinite(event.ts)) {
		throw new TypeError("event ts must be a finite timestamp");
	}
	if (
		event.id !== undefined &&
		(!Number.isSafeInteger(event.id) || event.id < 1)
	) {
		throw new TypeError("event id must be a positive safe integer when present");
	}
}
