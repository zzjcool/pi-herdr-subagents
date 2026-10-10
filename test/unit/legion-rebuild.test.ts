import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { rebuildLegionDb } from "../../src/legion/rebuild.ts";
import type { RunRecord } from "../../src/shared/types.ts";

function writeRun(directory: string, run: RunRecord): void {
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(run));
}

test("rebuild reconstructs root, centurion, worker, events and usage from run.json/jsonl", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const childDir = path.join(runs, "r-centurion");
	const centurionSession = path.join(rootDir, "centurion.jsonl");
	const workerSession = path.join(childDir, "worker.jsonl");
	const root: RunRecord = {
		schemaVersion: 1, runId: "r-root", task: "root", cwd: sandbox, herdr: {}, path: [],
		depth: 0, maxDepth: 4,
		children: [{
			name: "centurion", paneId: null, sessionFile: centurionSession, ownerToken: "root-token",
			state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "centurion", kind: "pi",
			worktreePath: "/tmp/team-a",
		}],
		budget: { spawned: 1, limit: null, granted: 0 },
		createdAt: new Date(500).toISOString(), updatedAt: new Date(3_000).toISOString(),
	};
	const nested: RunRecord = {
		...root, runId: "r-centurion", task: "team", path: [{ runId: "r-root", agent: "centurion" }],
		depth: 1,
		children: [{
			name: "worker", paneId: null, sessionFile: workerSession, ownerToken: "worker-token",
			state: "exited", execution: { status: "success", turns: 1, usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, cost: 0.42 } },
			spawnedAt: new Date(2_000).toISOString(), agent: "worker", kind: "pi",
		}],
		createdAt: new Date(1_500).toISOString(), updatedAt: new Date(4_000).toISOString(),
	};
	writeRun(rootDir, root);
	writeRun(childDir, nested);
	fs.writeFileSync(centurionSession, [
		JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "running" }], stopReason: "toolUse" } }),
	].join("\n"));
	fs.writeFileSync(workerSession, [
		JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, cost: { total: 0.42 } } } }),
		"{torn json",
	].join("\n"));
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 5_000 });
		assert.equal(result.runFiles.length, 2);
		assert.equal(result.nodesRebuilt, 3);
		assert.equal(getNode(db, "root")?.runId, "r-root");
		assert.equal(getNode(db, "root.centurion")?.runId, "r-centurion");
		assert.equal(getNode(db, "root.centurion")?.status, "running");
		assert.equal(getNode(db, "root.centurion.worker")?.status, "settled");
		assert.equal(getNode(db, "root.centurion")?.worktreePath, "/tmp/team-a");
		assert.deepEqual(readEventsAfter(db, 0).map((event) => event.type), ["node_launched", "node_launched", "node_settled"]);
		assert.deepEqual(getUsage(db, "root.centurion.worker"), {
			nodeId: "root.centurion.worker", tokensIn: 15, tokensOut: 8, costUsd: 0.42,
			updatedAt: new Date(4_000).getTime(),
		});
		assert.equal(result.warnings.length, 0);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild tolerates malformed run.json and preserves messages by default", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-bad-"));
	const rootDir = path.join(sandbox, "runs", "r-root");
	fs.mkdirSync(rootDir, { recursive: true });
	fs.writeFileSync(path.join(rootDir, "run.json"), "{bad json");
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(result.nodesRebuilt, 0);
		assert.ok(result.warnings.some((warning) => warning.message.includes("unreadable")));
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});
