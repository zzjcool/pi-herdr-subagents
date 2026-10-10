import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createDbEventSource,
	createLegionEventBus,
	type DbEventSource,
	type EventSourceClock,
	type EventSourceIntervalHandle,
} from "../../src/extension/event-bus.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";

function makeClock(): { clock: EventSourceClock; tick(): void; clearCount(): number } {
	let callback: (() => void) | undefined;
	let clears = 0;
	const clock: EventSourceClock = {
		setInterval(next) {
			callback = next;
			const handle = setInterval(() => {}, 60_000);
			handle.unref();
			return handle;
		},
		clearInterval(handle: EventSourceIntervalHandle) {
			clears++;
			clearInterval(handle);
		},
	};
	return {
		clock,
		tick() {
			assert.ok(callback, "polling interval is registered");
			callback();
		},
		clearCount: () => clears,
	};
}

test("LegionEventBus delivers direct process events synchronously to multiple subscribers", () => {
	const bus = createLegionEventBus();
	const calls: string[] = [];
	const first = bus.on("tool_call", (event) => calls.push(`first:${event.nodeId}`));
	bus.on("tool_call", (event) => calls.push(`second:${event.type}`));
	bus.emit({ nodeId: "root.worker", type: "tool_call", data: { name: "read" }, ts: 10 });
	assert.deepEqual(calls, ["first:root.worker", "second:tool_call"]);
	first();
	first();
	calls.length = 0;
	bus.emit({ nodeId: "root.worker", type: "tool_call", data: null, ts: 11 });
	assert.deepEqual(calls, ["second:tool_call"]);
});

test("LegionEventBus isolates a throwing handler and still delivers to later handlers", () => {
	const failures: unknown[] = [];
	const bus = createLegionEventBus({ onHandlerError: (error) => failures.push(error) });
	const calls: string[] = [];
	bus.on("node_launched", () => {
		throw new Error("subscriber failed");
	});
	bus.on("node_launched", () => calls.push("delivered"));
	assert.doesNotThrow(() => {
		bus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 20 });
	});
	assert.deepEqual(calls, ["delivered"]);
	assert.equal(failures.length, 1);
	assert.match(String(failures[0]), /subscriber failed/);
});

test("DB event source uses data_version, advances its cursor and goes quiet after unsubscribe", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-event-bus-"));
	const file = path.join(directory, "legion.db");
	const writer = openLegionDb(file);
	const timers = makeClock();
	insertNode(writer, { parentId: null, name: "root", role: "root" }, () => 1);
	const reader = openLegionDb(file);
	let eventSelects = 0;
	const instrumentedReader: DatabaseSync = {
		exec: (sql) => reader.exec(sql),
		prepare(sql) {
			if (sql.startsWith("SELECT id, node_id, type, data, ts FROM events WHERE id > ?")) {
				eventSelects++;
			}
			return reader.prepare(sql);
		},
		close: () => reader.close(),
	};
	let source: DbEventSource | undefined;
	try {
		source = createDbEventSource(instrumentedReader, { pollMs: 250, clock: timers.clock });
		const bus = createLegionEventBus();
		const received: number[] = [];
		const unsubscribe = bus.on("node_launched", (event) => received.push(event.id ?? -1));
		source.start(bus);
		assert.deepEqual(received, [], "initial read starts at the configured cursor");
		assert.equal(eventSelects, 1, "start performs one initial cursor read");
		timers.tick();
		assert.equal(eventSelects, 1, "unchanged data_version skips event SELECTs");

		const launched = appendEvent(writer, "root.worker", "node_launched", { fact: true }, { now: () => 2 });
		timers.tick(); // the next 250ms poll notices the external commit
		assert.deepEqual(received, [launched.id]);
		assert.equal(eventSelects, 2, "changed data_version triggers one incremental SELECT");
		assert.equal(source.getCursor(), launched.id);

		const settled = appendEvent(writer, "root.worker", "node_settled", null, { now: () => 3 });
		timers.tick();
		assert.equal(source.getCursor(), settled.id);
		assert.deepEqual(received, [launched.id], "unrelated event types do not reach this subscriber");

		unsubscribe();
		const nextLaunch = appendEvent(writer, "root", "node_launched", null, { now: () => 4 });
		timers.tick();
		assert.equal(source.getCursor(), nextLaunch.id);
		assert.deepEqual(received, [launched.id], "unsubscribe is silent while source cursor keeps advancing");

		source.stop();
		assert.equal(source.isRunning(), false);
		assert.equal(timers.clearCount(), 1);
		timers.tick();
		assert.deepEqual(received, [launched.id]);
	} finally {
		source?.stop();
		writer.close();
		reader.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("DB event source rejects polling outside the frozen 200–500ms interval", () => {
	const db = openLegionDb(":memory:");
	try {
		assert.throws(() => createDbEventSource(db, { pollMs: 100 }), /200 and 500/);
		assert.throws(() => createDbEventSource(db, { pollMs: 501 }), /200 and 500/);
	} finally {
		db.close();
	}
});
