/**
 * Live tests: exercise the REAL herdr binary and a REAL pi child process.
 *
 * These are the only tests that can catch facts the fakes cannot model — herdr's
 * actual JSON shapes, the real `agent start` handshake, and whether a child
 * genuinely writes a parseable session file.
 *
 * They are OPT-IN, because they spawn processes and talk to a herdr server:
 *
 *     npm run test:live                      # uses the ambient herdr session
 *     HERDR_LIVE=1 npm run test:live         # same, explicit
 *
 * When herdr is not reachable every test in this file is skipped rather than
 * failed, so `npm run test:all` stays green on a machine without herdr.
 *
 * WARNING: the default run uses whatever herdr server is ambient. It creates a
 * tab, so run it in a scratch session if you care about the current layout. To
 * isolate completely, start a dedicated server first:
 *
 *     HERDR_SOCKET_PATH=/tmp/live/herdr.sock herdr server &
 *     HERDR_SOCKET_PATH=/tmp/live/herdr.sock npm run test:live
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "../../src/herdr/client.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { loadAgentsFromDir } from "../../src/agents/agents.ts";

/** Cheap, widely-available model; override with PI_LIVE_MODEL. */
const LIVE_MODEL = process.env.PI_LIVE_MODEL ?? "cb/glm-5.3-flash";
// `fileURLToPath` (not `new URL().pathname`) so spaces and other encoded
// characters in the checkout path survive.
const AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

/** Skip the whole file unless a herdr server is actually reachable. */
async function herdrAvailable(): Promise<boolean> {
	try {
		const client = createHerdrClient();
		return await client.available();
	} catch {
		return false;
	}
}

const available = await herdrAvailable();
const skip = available
	? false
	: "herdr is not reachable; start a herdr server (or set HERDR_SOCKET_PATH) to run live tests";

function liveAgent(name: string) {
	const agents = loadAgentsFromDir(AGENTS_DIR, "user");
	const agent = agents.find((a) => a.name === name);
	assert.ok(agent, `bundled agent "${name}" must exist in ${AGENTS_DIR}`);
	return { ...agent, model: LIVE_MODEL };
}

test("live: herdr client reports availability and lists agents", {
	skip,
}, async () => {
	const client = createHerdrClient();
	const res = await client.agentList();
	assert.equal(res.ok, true, "agentList must succeed against a live server");
});

test("live: launch → collect → retire a real pi child", { skip }, async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "herdr-live-"));
	try {
		const client = createHerdrClient();
		const orchestrator = new Orchestrator({
			client,
			runDir,
			cwd: process.cwd(),
		});

		const handle = await orchestrator.launch({
			agent: liveAgent("scout"),
			task: "Reply with exactly: LIVE_SUBAGENT_OK. Do not use any tools.",
		});

		// The child is a real process in a real pane.
		assert.match(handle.name, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.ok(handle.paneId, "a pane must be assigned");
		assert.ok(
			existsSync(handle.sessionFile),
			`session file must be pre-created: ${handle.sessionFile}`,
		);

		const collected = await orchestrator.collect(handle.name, {
			timeoutMs: 240_000,
		});

		// Outcome comes from the session JSONL, never from herdr's agent status.
		assert.equal(
			collected.execution.status,
			"success",
			`expected success, got ${collected.execution.status}: ${JSON.stringify(collected.output)}`,
		);
		assert.ok(
			(collected.execution.turns ?? 0) >= 1,
			"at least one assistant turn must be recorded",
		);
		assert.match(
			String(collected.output),
			/LIVE_SUBAGENT_OK/,
			`child output should contain the sentinel, got: ${JSON.stringify(collected.output)}`,
		);

		// Retire closes the pane but MUST leave the session file for resume.
		await orchestrator.retire(handle.name);
		assert.ok(
			existsSync(handle.sessionFile),
			"session file must survive retire so the child can be resumed",
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("live: a foreign agent holding the role name is avoided", {
	skip,
}, async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "herdr-live-name-"));
	try {
		const client = createHerdrClient();
		const orchestrator = new Orchestrator({
			client,
			runDir,
			cwd: process.cwd(),
		});

		// herdr's agent-name namespace is GLOBAL. Seed the collision by asking
		// for an explicit name, then confirm a second launch under the same
		// requested name still succeeds by picking a different one.
		const first = await orchestrator.launch({
			agent: liveAgent("scout"),
			task: "Reply with exactly: ONE. Do not use tools.",
			name: "livenameprobe",
		});

		const second = await orchestrator.launch({
			agent: liveAgent("scout"),
			task: "Reply with exactly: TWO. Do not use tools.",
			// Same requested name; must NOT throw agent_name_taken.
			name: "livenameprobe",
		});

		assert.notEqual(
			second.name,
			first.name,
			"the second launch must pick a distinct name",
		);

		await orchestrator.retire(first.name);
		await orchestrator.retire(second.name);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});
