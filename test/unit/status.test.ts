import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyStatus,
	createStatusBoard,
	formatBusyLabel,
	formatElapsed,
	formatFooterStatus,
	formatWidgetLines,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
	STATUS_WIDGET_PLACEMENT,
	type StatusEntry,
	type StatusUi,
	type WidgetFactory,
} from "../../src/tui/status.ts";

const entries: StatusEntry[] = [
	{ name: "worker-0", agent: "worker", state: "working", startedAt: 1_000 },
	{ name: "reviewer-1", agent: "reviewer", state: "working", startedAt: 2_000 },
];

const theme = { fg: (_color: string, text: string) => text };

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

test("formatWidgetLines matches the pi-subagents async roster", () => {
	assert.deepEqual(formatWidgetLines([], 5_000), []);
	assert.deepEqual(formatWidgetLines(entries.slice(0, 1), 5_000), [
		"● worker-0 (worker) · 4s",
		"  ⎿  working",
	]);
	const lines = formatWidgetLines(entries, 5_000);
	assert.equal(lines[0], "● Async agents · herdr");
	assert.equal(lines[1], "├─ ● worker-0 (worker) · 4s");
	assert.equal(lines[2], "│    ⎿  working");
	assert.equal(lines[3], "└─ ● reviewer-1 (reviewer) · 3s");
	assert.equal(lines[4], "     ⎿  working");
});

test("applyStatus paints above the editor and in the footer", () => {
	const widgets: unknown[] = [];
	const statuses: unknown[] = [];
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
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
	assert.equal(widget.options.placement, STATUS_WIDGET_PLACEMENT);
	assert.equal(widget.options.placement, "aboveEditor");
	assert.match(widget.content[0] ?? "", /Async agents/);
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
				theme,
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

test("status board registers a persistent factory and then requestRender", () => {
	const widgets: unknown[] = [];
	const statuses: unknown[] = [];
	let renders = 0;
	const tui = { requestRender: () => { renders += 1; } };
	const ctx: StatusUi = {
		hasUI: true,
		ui: {
			theme,
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			setWidget(key, content, options) {
				widgets.push({ key, content, options });
				if (typeof content === "function") {
					(content as WidgetFactory)(tui, theme);
				}
			},
		},
	};
	const board = createStatusBoard();
	board.bind(ctx);
	board.paint(entries, 5_000);
	assert.equal(widgets.length, 1);
	const first = widgets[0] as {
		content: WidgetFactory;
		options: { placement: string };
	};
	assert.equal(typeof first.content, "function");
	assert.equal(first.options.placement, "aboveEditor");
	const component = first.content(tui, theme);
	assert.match(component.render().join("\n"), /worker-0/);

	board.paint(entries, 6_000);
	assert.equal(widgets.length, 1, "must not remount the widget on every tick");
	assert.equal(renders, 1);

	board.paint([], 7_000);
	const cleared = widgets.at(-1) as { content: undefined };
	assert.equal(cleared.content, undefined);
	assert.deepEqual(statuses.at(-1), { key: STATUS_FOOTER_KEY, text: undefined });
});
