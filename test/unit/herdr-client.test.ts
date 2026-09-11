/**
 * W4 tests for src/herdr/client.ts — written from IMPLEMENTATION.md's spec
 * (findings F1/F7/F11/F16/F17/F19/F21/F22), using the in-memory fake herdr.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHerdrClient, parseHerdrResponse } from "../../src/herdr/client.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import { createCommandRunner, resolveHerdrBin } from "../../src/herdr/runner.ts";
import {
	FakeHerdr,
	createFakeRunner,
	createMissingBinaryRunner,
} from "../helpers/fake-herdr.ts";

// ── Required test cases (client): parseHerdrResponse ─────────────────────────

test("success JSON on stdout → parsed value", () => {
	const r = parseHerdrResponse('{"result":{"pane_id":"w1:p1"}}', "", 0);
	assert.ok(r.ok);
	if (r.ok) assert.deepEqual(r.value, { pane_id: "w1:p1" });
});

test("error JSON on stderr with empty stdout and code 1 → ok:false with the stderr code (F21)", () => {
	const r = parseHerdrResponse("", '{"error":{"code":"agent_not_found","message":"no agent x"}}', 1);
	assert.ok(!r.ok);
	if (!r.ok) {
		assert.equal(r.error.code, "NOT_FOUND");
		assert.equal(r.error.message, "no agent x");
	}
});

test("non-JSON garbage → ok:false with PARSE_ERROR (code 0) or HERDR_ERROR (non-zero)", () => {
	const cleanExit = parseHerdrResponse("total garbage", "", 0);
	assert.ok(!cleanExit.ok);
	if (!cleanExit.ok) assert.equal(cleanExit.error.code, "PARSE_ERROR");

	const badExit = parseHerdrResponse("segfault at 0x0", "stack smashed", 139);
	assert.ok(!badExit.ok);
	if (!badExit.ok) assert.equal(badExit.error.code, "HERDR_ERROR");
});

test("agent_pane_busy error → mapped to PANE_BUSY (F19)", () => {
	const r = parseHerdrResponse("", '{"error":{"code":"agent_pane_busy","message":"not an available shell"}}', 1);
	assert.ok(!r.ok);
	if (!r.ok) assert.equal(r.error.code, ErrorCodes.PANE_BUSY);
});

test("agent_name_taken error → mapped to NAME_TAKEN (F16)", () => {
	const r = parseHerdrResponse("", '{"error":{"code":"agent_name_taken","message":"name w-1 already used"}}', 1);
	assert.ok(!r.ok);
	if (!r.ok) assert.equal(r.error.code, ErrorCodes.NAME_TAKEN);
});

test("missing herdr binary (ENOENT) → HERDR_UNAVAILABLE (F22)", () => {
	const r = parseHerdrResponse("", "Error: spawn herdr ENOENT", -1);
	assert.ok(!r.ok);
	if (!r.ok) assert.equal(r.error.code, ErrorCodes.HERDR_UNAVAILABLE);
});

// ── Required test cases (client): name + nested-path utilities ────────────────

test("makeName lowercases, replaces spaces, appends the index (F17)", async () => {
	const { makeName, isValidAgentName } = await import("../../src/shared/name.ts");
	assert.equal(makeName("Review Agent", 1), "review-agent-1");
	assert.ok(isValidAgentName(makeName("Review Agent", 1)));
});

test("makeName('9bad', 0) → starts with a letter, ≤32 chars", async () => {
	const { makeName, isValidAgentName } = await import("../../src/shared/name.ts");
	const name = makeName("9bad", 0);
	assert.ok(name.length <= 32);
	assert.match(name, /^[a-z]/);
	assert.ok(isValidAgentName(name));
});

test("makeName with a 50-char input → ≤32 chars and still valid", async () => {
	const { makeName, isValidAgentName } = await import("../../src/shared/name.ts");
	const name = makeName("x".repeat(50), 3);
	assert.ok(name.length <= 32);
	assert.ok(isValidAgentName(name));
});

test("isSafeNestedPathId rejects traversal and absolute paths", async () => {
	const { isSafeNestedPathId } = await import("../../src/shared/nested-path.ts");
	assert.equal(isSafeNestedPathId("../../etc"), false);
	assert.equal(isSafeNestedPathId("/abs"), false);
	assert.equal(isSafeNestedPathId("a\\b"), false);
	assert.equal(isSafeNestedPathId(""), false);
	assert.equal(isSafeNestedPathId("r-123"), true);
});

test("sanitizeNestedPath truncates to 4 entries", async () => {
	const { sanitizeNestedPath } = await import("../../src/shared/nested-path.ts");
	const entries = Array.from({ length: 9 }, (_, i) => ({ runId: `r-${i}` }));
	const out = sanitizeNestedPath(entries);
	assert.equal(out.length, 4);
	assert.equal(out[0]?.runId, "r-0");
	assert.equal(out[3]?.runId, "r-3");
});

test("sanitizeNestedPath drops junk entries, keeps good ones", async () => {
	const { sanitizeNestedPath } = await import("../../src/shared/nested-path.ts");
	const out = sanitizeNestedPath([
		"junk-string",
		{ runId: "../../evil" },
		{ runId: "r-ok", agent: "reviewer", stepIndex: 2 },
		42,
		null,
		{ noRunId: true },
	]);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0], { runId: "r-ok", stepIndex: 2, agent: "reviewer" });
	assert.deepEqual(sanitizeNestedPath("not-an-array"), []);
});

// ── Client against the fake herdr ─────────────────────────────────────────────

function clientWith(opts: { paneBusyMs?: number } = {}) {
	const fake = new FakeHerdr(opts);
	return { fake, client: createHerdrClient(createFakeRunner(fake)) };
}

test("agentStart returns the session path for pi kind (F1)", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	const res = await client.agentStart({ name: "w-1", kind: "pi", paneId });
	assert.ok(res.ok);
	if (res.ok) {
		assert.equal(res.value.name, "w-1");
		assert.equal(res.value.paneId, paneId);
		assert.equal(res.value.sessionPath, "/tmp/sessions/w-1.jsonl");
	}
});

test("agentStart reports NO session path for non-pi kinds (F7)", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	const res = await client.agentStart({ name: "cursor-1", kind: "cursor", paneId });
	assert.ok(res.ok);
	if (res.ok) {
		assert.equal(res.value.sessionPath, undefined);
		const info = await client.agentGet("cursor-1");
		assert.ok(info.ok);
		if (info.ok) assert.equal(info.value.agent_session, null);
	}
});

test("agent_pane_busy race after split, retry succeeds (F19/F20)", async () => {
	const { fake, client } = clientWith({ paneBusyMs: 500 });
	const split = await client.paneSplit({ current: true, direction: "down", cwd: "/tmp/project" });
	assert.ok(split.ok);
	const paneId = split.ok ? split.value.pane_id : "";

	// Immediately after the split the pane still rejects agent start.
	const first = await client.agentStart({ name: "w-1", kind: "pi", paneId });
	assert.ok(!first.ok);
	if (!first.ok) assert.equal(first.error.code, ErrorCodes.PANE_BUSY);

	// Advance the fake clock past the busy window, then retry.
	fake.advance(600);
	const second = await client.agentStart({ name: "w-1", kind: "pi", paneId });
	assert.ok(second.ok, second.ok ? "" : `retry failed: ${second.error.code}`);
});

test("reusing a live name → agent_name_taken; freed after exit (F16)", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	const started = await client.agentStart({ name: "w-1", kind: "pi", paneId });
	assert.ok(started.ok);

	// Same pane, new agent, same name → taken.
	const clash = await client.agentStart({ name: "w-1", kind: "pi", paneId: fake.addRootPane() });
	assert.ok(!clash.ok);
	if (!clash.ok) assert.equal(clash.error.code, ErrorCodes.NAME_TAKEN);

	// Send ctrl+d — the clean exit (F11). The name is now free.
	const keys = await client.agentSendKeys("w-1", "ctrl+d");
	assert.ok(keys.ok);
	const freed = await client.agentStart({ name: "w-1", kind: "pi", paneId: fake.addRootPane() });
	assert.ok(freed.ok, freed.ok ? "" : `name not freed: ${freed.error.code}`);
});

test("ctrl+d exits the agent but ctrl+c does NOT (F11)", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	await client.agentStart({ name: "a", kind: "pi", paneId });
	await client.agentStart({ name: "b", kind: "pi", paneId: fake.addRootPane() });

	await client.agentSendKeys("a", "ctrl+c");
	assert.ok(fake.agents.has("a"), "ctrl+c must leave the agent alive");

	await client.agentSendKeys("b", "ctrl+d");
	assert.ok(!fake.agents.has("b"), "ctrl+d must exit the agent");
});

test("missing herdr binary surfaces as a start timeout, not a clear error (F22)", async () => {
	const client = createHerdrClient(createMissingBinaryRunner());
	const res = await client.agentStart({ name: "w-1", kind: "claude", paneId: "w1:p1" });
	assert.ok(!res.ok);
	if (!res.ok) {
		// The runner reports code -1 + stderr; client maps it to HERDR_UNAVAILABLE —
		// NOT a structured "binary missing" message (that's the F22 finding: no clear error).
		assert.equal(res.error.code, ErrorCodes.HERDR_UNAVAILABLE);
		assert.match(res.error.message, /ENOENT/);
	}
});

test("start timeout maps to START_TIMEOUT (F22 family)", () => {
	const r = parseHerdrResponse("", '{"error":{"code":"agent_start_timeout","message":"timed out after 15000ms"}}', 1);
	assert.ok(!r.ok);
	if (!r.ok) assert.equal(r.error.code, ErrorCodes.START_TIMEOUT);
});

test("agentGet → session info; agentList → arrays", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	await client.agentStart({ name: "w-1", kind: "pi", paneId });

	const got = await client.agentGet("w-1");
	assert.ok(got.ok);
	if (got.ok) {
		assert.equal(got.value.agent_status, "idle");
		assert.equal(got.value.agent_session?.value, "/tmp/sessions/w-1.jsonl");
	}

	const list = await client.agentList();
	assert.ok(list.ok);
	if (list.ok) assert.equal(list.value.length, 1);
});

test("agentGet on an unknown agent → NOT_FOUND (F21 shape: stderr, empty stdout)", async () => {
	const { fake, client } = clientWith();
	const call = fake.exec(["agent", "get", "ghost"]);
	assert.equal(call.stdout, "");
	assert.equal(call.code, 1);
	assert.match(call.stderr, /agent_not_found/);

	const res = await client.agentGet("ghost");
	assert.ok(!res.ok);
	if (!res.ok) assert.equal(res.error.code, ErrorCodes.NOT_FOUND);
});

test("paneRead returns plain text, not JSON (F6)", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	fake.panes.get(paneId)!.screen.push("STEP 1 done", "STEP 2 done");
	const res = await client.paneRead(paneId, { source: "recent-unwrapped" });
	assert.ok(res.ok);
	if (res.ok) assert.equal(res.value, "STEP 1 done\nSTEP 2 done\n");
});

test("tabCreate / tabList / tabClose round trip; tab close kills agents atomically (F15)", async () => {
	const { fake, client } = clientWith();
	const created = await client.tabCreate({ label: "task:x", cwd: "/tmp" });
	assert.ok(created.ok);
	if (created.ok) {
		const tabId = created.value.tab.tab_id;
		await client.agentStart({ name: "w-1", kind: "pi", paneId: created.value.rootPaneId });

		const listed = await client.tabList();
		assert.ok(listed.ok);
		if (listed.ok) assert.ok(listed.value.some((t) => t.tab_id === tabId));

		const closed = await client.tabClose(tabId);
		assert.ok(closed.ok);
		assert.ok(!fake.agents.has("w-1"), "tab close must kill the agent");
		assert.ok(!fake.panes.has(created.value.rootPaneId));
	}
});

test("agentStart forwards extra args and timeout", async () => {
	const { fake, client } = clientWith();
	const paneId = fake.addRootPane();
	await client.agentStart({
		name: "w-1",
		kind: "pi",
		paneId,
		args: ["--session", "/tmp/s.jsonl", "--mode", "json"],
		timeoutMs: 1234,
	});
	const start = fake.commands.find((c) => c.args[0] === "agent" && c.args[1] === "start");
	assert.ok(start);
	assert.ok(start.args.includes("--timeout"));
	assert.equal(start.args[start.args.length - 1], "json");
});

test("client.available() is true against the fake, false for a missing binary", async () => {
	const { client } = clientWith();
	assert.equal(await client.available(), true);

	const missing = createHerdrClient(createMissingBinaryRunner());
	assert.equal(await missing.available(), false);
});

test("createCommandRunner: resolveHerdrBin honours HERDR_BIN env", () => {
	assert.equal(resolveHerdrBin({ HERDR_BIN: "/fake/herdr" }), "/fake/herdr");
	assert.equal(resolveHerdrBin({}), "herdr");
	// A runner can be constructed without spawning anything.
	const runner = createCommandRunner({ bin: "/fake/herdr" });
	assert.equal(typeof runner, "function");
});
