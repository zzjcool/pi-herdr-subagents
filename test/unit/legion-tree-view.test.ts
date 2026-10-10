import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createTreeView, type TreeNodeSnapshot } from "../../src/tui/tree-view.ts";

const BASE_TIME = 1_000;

function treeFixture(): TreeNodeSnapshot[] {
	return [
		node("root", null, "root", 0, "root", "running"),
		node("root.centurion", "root", "centurion", 1, "centurion", "running"),
		node("root.centurion.worker-a2", "root.centurion", "worker-a2", 2, "worker", "running"),
		node(
			"root.centurion.worker-a2.deep-manager",
			"root.centurion.worker-a2",
			"deep-manager",
			3,
			"centurion",
			"settled",
		),
		node(
			"root.centurion.worker-a2.deep-manager.deep-worker",
			"root.centurion.worker-a2.deep-manager",
			"deep-worker",
			4,
			"worker",
			"settled",
		),
		{
			...node("root.centurion.peer", "root.centurion", "peer", 2, "worker", "settled"),
			createdAt: BASE_TIME + 201,
			updatedAt: BASE_TIME + 201,
		},
	];
}

function node(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	role: string,
	status: TreeNodeSnapshot["status"],
): TreeNodeSnapshot {
	const timestamp = BASE_TIME + depth * 100;
	return {
		id,
		parentId,
		name,
		role,
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: "provider/model",
		team: null,
		status,
		phase: status === "running" ? "implementing" : null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

test("tree view folds settled nodes below depth two and displays one collapsed row", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		const lines = view.render(100);
		assert.equal(view.isExpanded("root"), true);
		assert.equal(view.isExpanded("root.centurion"), true);
		assert.equal(view.isExpanded("root.centurion.worker-a2"), true);
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);
		assert.ok(
			lines.some((line) => line.includes("▸ deep-manager +1 collapsed")),
			"the depth-three branch is represented by a single collapsed row",
		);
		assert.ok(!lines.some((line) => line.includes("deep-worker")));
	} finally {
		view.dispose();
	}
});

test("tree view ignores unrelated mail events when preserving machine status timestamps", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		view.applyEvent({
			nodeId: "root.centurion.peer",
			type: "mail_delivered",
			data: { messageId: 1 },
			ts: BASE_TIME + 100_000,
		});
		const peerLine = view.render(100).find((line) => line.includes("peer (worker)"));
		assert.ok(peerLine);
		assert.match(stripTerminalSequences(peerLine), /peer \(worker\).*0s/);
	} finally {
		view.dispose();
	}
});

test("tree view forcibly expands a running descendant's complete path", () => {
	const view = createTreeView({ nodes: treeFixture(), now: () => BASE_TIME + 5_000 });
	try {
		view.applyEvent({
			nodeId: "root.centurion.worker-a2.deep-manager.deep-worker",
			type: "node_resumed",
			data: null,
			ts: BASE_TIME + 6_000,
		});
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);
		assert.ok(view.getState().visibleIds.includes("root.centurion.worker-a2.deep-manager.deep-worker"));

		view.handleInput?.("j");
		view.handleInput?.("j");
		view.handleInput?.("j");
		view.handleInput?.("\r");
		assert.equal(
			view.isExpanded("root.centurion.worker-a2.deep-manager"),
			true,
			"Enter cannot fold a subtree while any descendant is running",
		);
	} finally {
		view.dispose();
	}
});

test("tree keyboard state machine supports j/k, arrows, Enter, Space, search, Esc and q", () => {
	let doneCount = 0;
	const view = createTreeView({ nodes: treeFixture() }, () => doneCount++);
	view.render(100);
	assert.equal(view.getState().selectedId, "root");

	view.handleInput?.("j");
	assert.equal(view.getState().selectedId, "root.centurion");
	view.handleInput?.("\u001b[B");
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2");
	view.handleInput?.("k");
	assert.equal(view.getState().selectedId, "root.centurion");
	view.handleInput?.("j");
	view.handleInput?.("j");
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager");

	view.handleInput?.("\r");
	assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);
	view.handleInput?.(" ");
	assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);

	view.handleInput?.("/");
	for (const character of "deep-worker") view.handleInput?.(character);
	assert.equal(view.getState().searchMode, true);
	view.handleInput?.("\r");
	assert.equal(view.getState().searchMode, false);
	assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager.deep-worker");
	assert.ok(view.getState().visibleIds.includes("root.centurion.worker-a2.deep-manager.deep-worker"));
	view.handleInput?.("\u001b");
	view.handleInput?.("q");
	assert.equal(doneCount, 1, "Esc/q complete the custom UI at most once");
	view.dispose();

	let qDoneCount = 0;
	const quitWithQ = createTreeView({ nodes: treeFixture() }, () => qDoneCount++);
	quitWithQ.handleInput?.("q");
	assert.equal(qDoneCount, 1);
	quitWithQ.dispose();
});

test("tree mouse click toggles the selected row head; narrow layouts never overflow", () => {
	const longNodes = treeFixture().map((entry) =>
		entry.id === "root.centurion.peer"
			? { ...entry, name: "very-long-worker-name-that-needs-truncation" }
			: entry,
	);
	const view = createTreeView({ nodes: longNodes });
	try {
		const wideLines = view.render(100);
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), false);
		const managerRow = wideLines.findIndex((line) => line.includes("deep-manager +1 collapsed"));
		assert.ok(managerRow > 0);
		const mouseResult = view.handleMouse?.({
			type: "click",
			button: "left",
			x: 4,
			y: managerRow,
			screenX: 4,
			screenY: managerRow,
			width: 100,
			height: wideLines.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.ok(mouseResult?.handled);
		assert.equal(view.getState().selectedId, "root.centurion.worker-a2.deep-manager");
		assert.equal(view.isExpanded("root.centurion.worker-a2.deep-manager"), true);

		const narrowLines = view.render(18);
		assert.ok(narrowLines.every((line) => visibleWidth(line) <= 18));
	} finally {
		view.dispose();
	}
});
