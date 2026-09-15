import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyStatus,
	formatBusyLabel,
	formatElapsed,
	formatFooterStatus,
	formatWidgetLines,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
	type StatusEntry,
	type StatusUi,
} from "../../src/tui/status.ts";

const entries: StatusEntry[] = [
	{ name: "worker-0", agent: "worker", state: "working", startedAt: 1_000 },
	{ name: "reviewer-1", agent: "reviewer", state: "working", startedAt: 2_000 },
];

test("formatElapsed rounds to seconds", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(1_400), "1s");
	assert.equal(formatElapsed(12_499), "12s");
});

test("formatFooterStatus is empty when nothing is running", () => {
	assert.equal(formatFooterStatus([]), undefined);
	assert.equal(formatFooterStatus(entries.slice(0, 1)), "1 agent running");
	assert.equal(formatFooterStatus(entries), "2 agents running");
});

test("formatBusyLabel matches the herdr overlay copy", () => {
	assert.equal(formatBusyLabel([]), undefined);
	assert.equal(formatBusyLabel(entries.slice(0, 1)), "⏳ 1 subagent (worker-0)");
	assert.equal(
		formatBusyLabel(entries),
		"⏳ 2 subagents (worker-0, reviewer-1)",
	);
});

test("formatWidgetLines puts a roster under the input", () => {
	assert.deepEqual(formatWidgetLines([], 5_000), []);
	const lines = formatWidgetLines(entries, 5_000);
	assert.equal(lines[0], "  2 active agents");
	assert.match(lines[1] ?? "", /● worker-0 \(worker\)  working  4s/);
	assert.match(lines[2] ?? "", /● reviewer-1 \(reviewer\)  working  3s/);
});

test("applyStatus paints below the editor and in the footer", () => {
	const widgets: unknown[] = [];
	const statuses: unknown[] = [];
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			setWidget(key, content, options) {
				widgets.push({ key, content, options });
			},
		},
	};
	applyStatus(ctx, entries, 5_000);
	assert.equal(widgets.length, 1);
	const widget = widgets[0] as {
		key: string;
		content: string[];
		options: { placement: string };
	};
	assert.equal(widget.key, STATUS_WIDGET_KEY);
	assert.equal(widget.options.placement, "belowEditor");
	assert.equal(widget.content.length, 3);
	assert.deepEqual(statuses, [
		{ key: STATUS_FOOTER_KEY, text: "2 agents running" },
	]);

	applyStatus(ctx, [], 5_000);
	const cleared = widgets[1] as { content: undefined };
	assert.equal(cleared.content, undefined);
	assert.deepEqual(statuses[1], { key: STATUS_FOOTER_KEY, text: undefined });
});

test("applyStatus is a no-op without UI", () => {
	let called = 0;
	applyStatus(
		{
			hasUI: false,
			ui: {
				theme: { fg: (_c, t) => t },
				setStatus() {
					called += 1;
				},
				setWidget() {
					called += 1;
				},
			},
		},
		entries,
		5_000,
	);
	assert.equal(called, 0);
});
