import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionLayout, tileSplit, typeTabLabel } from "../../src/runs/layout.ts";

test("typeTabLabel is parent-scoped so two Pis in one Space do not share a tab", () => {
	assert.equal(typeTabLabel("scout"), "scout");
	assert.equal(typeTabLabel("scout", "wA:p1"), "scout@wA:p1");
	assert.equal(typeTabLabel("scout", "  wA:p1  "), "scout@wA:p1");
	assert.notEqual(
		typeTabLabel("scout", "wA:p1"),
		typeTabLabel("scout", "wA:p2"),
	);
});

test("tileSplit is a 3-column grid: fill a row, then wrap down", () => {
	assert.equal(tileSplit([]), undefined);
	assert.deepEqual(tileSplit(["a"]), { target: "a", direction: "right" });
	assert.deepEqual(tileSplit(["a", "b"]), { target: "b", direction: "right" });
	assert.deepEqual(tileSplit(["a", "b", "c"]), {
		target: "a",
		direction: "down",
	});
	assert.deepEqual(tileSplit(["a", "b", "c", "d"]), {
		target: "b",
		direction: "down",
	});
});

test("claimName reserves names so two callers cannot both take scout-0", () => {
	const layout = createSessionLayout();
	const a = layout.claimName("scout", () => false);
	const b = layout.claimName("scout", () => false);
	assert.equal(a, "scout-0");
	assert.equal(b, "scout-1");
});

test("liveNames unions claimed names with the fetched list", async () => {
	const layout = createSessionLayout();
	layout.rememberName("human-held");
	const names = await layout.liveNames(async () => new Set(["other"]));
	assert.equal(names.has("human-held"), true);
	assert.equal(names.has("other"), true);
});

test("liveNames coalesces concurrent fetches", async () => {
	const layout = createSessionLayout();
	let fetches = 0;
	const fetch = async () => {
		fetches += 1;
		await Promise.resolve();
		return new Set(["live"]);
	};
	const [a, b] = await Promise.all([
		layout.liveNames(fetch),
		layout.liveNames(fetch),
	]);
	assert.equal(fetches, 1, "parallel liveNames must share one agent list");
	assert.equal(a.has("live"), true);
	assert.equal(b.has("live"), true);
});

test("acquireTypeTab serializes creators of the same type", async () => {
	const layout = createSessionLayout();
	let creates = 0;
	const create = async () => {
		creates += 1;
		await Promise.resolve();
		return { tabId: "w1:tScout", rootPaneId: "w1:p1" };
	};
	const [left, right] = await Promise.all([
		layout.acquireTypeTab("scout", create),
		layout.acquireTypeTab("scout", create),
	]);
	assert.equal(creates, 1);
	assert.equal(left.tabId, right.tabId);
	const first = await layout.assignPane("scout", async () => {
		throw new Error("root occupy must not split");
	});
	assert.equal(first.paneId, "w1:p1");
	const second = await layout.assignPane("scout", async (plan) => {
		assert.equal(plan.direction, "right");
		assert.equal(plan.target, "w1:p1");
		return "w1:p2";
	});
	assert.equal(second.paneId, "w1:p2");
});

test("acquireTypeTab retries after the first creator fails", async () => {
	const layout = createSessionLayout();
	let creates = 0;
	const create = async () => {
		creates += 1;
		if (creates === 1) throw new Error("tab create failed");
		return { tabId: "w1:tScout", rootPaneId: "w1:p1" };
	};
	const first = layout.acquireTypeTab("scout", create);
	await assert.rejects(first, /tab create failed/);
	const second = await layout.acquireTypeTab("scout", create);
	assert.equal(second.tabId, "w1:tScout");
	assert.equal(creates, 2);
});

test("assignPane serializes two racing splits of the same type", async () => {
	const layout = createSessionLayout();
	await layout.acquireTypeTab("scout", async () => ({
		tabId: "w1:tScout",
		rootPaneId: "w1:p1",
	}));
	let concurrent = 0;
	let maxConcurrent = 0;
	const pane = async (plan: { target: string; direction: string }) => {
		concurrent += 1;
		maxConcurrent = Math.max(maxConcurrent, concurrent);
		await Promise.resolve();
		concurrent -= 1;
		return `${plan.target}-${plan.direction}`;
	};
	const [a, b] = await Promise.all([
		layout.assignPane("scout", pane),
		layout.assignPane("scout", pane),
	]);
	assert.equal(maxConcurrent, 1, "pane assignment must not overlap");
	assert.equal(a.paneId, "w1:p1", "first caller occupies the root");
	assert.equal(b.paneId, "w1:p1-right");
});

test("releasePane drops the type tab when the last pane is gone", async () => {
	const layout = createSessionLayout();
	await layout.acquireTypeTab("scout", async () => ({
		tabId: "w1:tScout",
		rootPaneId: "w1:p1",
	}));
	await layout.assignPane("scout", async () => "unused");
	const first = layout.releasePane("scout", "w1:p1");
	assert.equal(first.empty, true);
	assert.equal(first.tabId, "w1:tScout");
	assert.equal(layout.getTypeTab("scout"), undefined);
});
