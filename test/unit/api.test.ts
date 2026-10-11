import { test } from "node:test";
import assert from "node:assert/strict";

test("public API exposes RPC orchestration and deprecated legacy compatibility", async () => {
	const api = await import("../../src/api.ts");
	assert.equal(typeof api.Orchestrator, "function");
	assert.equal(typeof api.RpcSupervisor, "function");
	assert.equal(typeof api.InMemoryUIProxy, "function");
	assert.equal(typeof api.createHerdrClient, "function", "legacy API remains importable during migration");
	assert.equal("Placement" in api, false, "pane Placement is no longer part of the public API");
});
