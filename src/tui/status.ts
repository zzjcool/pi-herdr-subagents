/**
 * Live subagent status above the parent input box.
 *
 * pi-subagents' async widget uses Pi's default `aboveEditor` placement and a
 * persistent component so elapsed time keeps ticking after the tool call
 * returns (the execute ctx is then stale). We match that: a factory widget
 * plus `requestRender`, not a one-shot `string[]` on a dying context.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isThinkingLevel } from "../shared/types.ts";

export const STATUS_WIDGET_KEY = "herdr-subagent-status";
export const STATUS_FOOTER_KEY = "herdr-subagents";
export const STATUS_WIDGET_PLACEMENT = "aboveEditor" as const;

export interface StatusEntry {
	name: string;
	agent: string;
	state: string;
	startedAt: number;
	herdrStatus?: string;
	kind?: string;
	model?: string;
	thinking?: string | false;
	worktreeBranch?: string;
	turns?: number;
	lastTools?: string[];
}

export function formatElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFooterStatus(entries: StatusEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	return entries.length === 1
		? "1 agent running"
		: `${entries.length} agents running`;
}

export function formatBusyLabel(entries: StatusEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const names = entries.map((entry) => entry.name);
	const who =
		names.length > 0
			? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`
			: "";
	return `⏳ ${entries.length} subagent${entries.length === 1 ? "" : "s"}${who}`;
}

function roleSuffix(entry: StatusEntry): string {
	return entry.agent && entry.agent !== entry.name ? ` (${entry.agent})` : "";
}

function entryStatus(entry: StatusEntry): string {
	return entry.herdrStatus ?? entry.state;
}

function formatModel(entry: StatusEntry): string | undefined {
	const raw = entry.model?.trim();
	if (!raw) return undefined;
	const idx = raw.lastIndexOf(":");
	const suffix = idx === -1 ? undefined : raw.slice(idx + 1);
	const suffixIsThinking = Boolean(suffix && isThinkingLevel(suffix));
	const base = suffixIsThinking ? raw.slice(0, idx) : raw;
	const fromModel =
		suffixIsThinking && suffix !== "off" ? suffix : undefined;
	const thinking =
		fromModel ??
		(typeof entry.thinking === "string" &&
		entry.thinking !== "off" &&
		isThinkingLevel(entry.thinking)
			? entry.thinking
			: undefined);
	return thinking ? `${base}:${thinking}` : base;
}

function formatWorktreeBranch(branch: string): string {
	return branch.replace(/^pi-subagent\//, "");
}

function headlineBits(entry: StatusEntry, now: number): string[] {
	const bits = [`${entry.name}${roleSuffix(entry)}`];
	if (entry.kind && entry.kind !== "pi") bits.push(entry.kind);
	const model = formatModel(entry);
	if (model) bits.push(model);
	bits.push(formatElapsed(now - entry.startedAt));
	return bits;
}

function detailBits(entry: StatusEntry): string[] {
	const bits = [entryStatus(entry)];
	if (entry.turns && entry.turns > 0) bits.push(`turn ${entry.turns}`);
	if (entry.lastTools?.length) {
		bits.push(entry.lastTools.slice(0, 2).join(", "));
	}
	if (entry.worktreeBranch) {
		bits.push(`wt ${formatWorktreeBranch(entry.worktreeBranch)}`);
	}
	return bits;
}

function formatEntryLines(
	entry: StatusEntry,
	now: number,
	prefix: { head: string; detail: string },
): string[] {
	return [
		`${prefix.head}● ${headlineBits(entry, now).join(" · ")}`,
		`${prefix.detail}  ⎿  ${detailBits(entry).join(" · ")}`,
	];
}

/**
 * Compact roster copied from pi-subagents' async widget: a header plus
 * `● name · elapsed` / `⎿  state` rows.
 */
export function formatWidgetLines(
	entries: StatusEntry[],
	now: number,
): string[] {
	if (entries.length === 0) return [];
	if (entries.length === 1) {
		return formatEntryLines(entries[0]!, now, { head: "", detail: "" });
	}
	const lines = [`● Async agents · herdr`];
	for (const [index, entry] of entries.entries()) {
		const last = index === entries.length - 1;
		lines.push(
			...formatEntryLines(entry, now, {
				head: last ? "└─ " : "├─ ",
				detail: last ? "   " : "│  ",
			}),
		);
	}
	return lines;
}

type Theme = {
	fg(color: string, text: string): string;
};

type WidgetTui = { requestRender(): void };

export type WidgetFactory = (
	tui: WidgetTui,
	theme: Theme,
) => {
	render: (width?: number) => string[];
	dispose?: () => void;
};

export interface StatusUi {
	hasUI: boolean;
	ui: {
		theme: Theme;
		setStatus(key: string, text: string | undefined): void;
		setWidget(
			key: string,
			content: string[] | WidgetFactory | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

function isStaleUiError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("This extension ctx is stale") ||
			error.message.includes("Extension context no longer active"))
	);
}

function liveHasUi(ctx: StatusUi): boolean {
	try {
		return ctx.hasUI;
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
		return false;
	}
}

function themeLines(lines: string[], theme: Theme): string[] {
	if (lines.length === 0) return lines;
	const [header, ...rest] = lines;
	const out = [theme.fg("accent", header ?? "")];
	for (const line of rest) out.push(theme.fg("dim", line));
	return out;
}

/** Pi TUI asserts every rendered line's visibleWidth <= columns. */
function fitLines(lines: string[], width?: number): string[] {
	if (width === undefined || !Number.isFinite(width) || width <= 0) {
		return lines;
	}
	return lines.map((line) =>
		visibleWidth(line) <= width ? line : truncateToWidth(line, width),
	);
}

export interface StatusBoard {
	bind(ctx: StatusUi): void;
	paint(entries: StatusEntry[], now: number): void;
	clear(): void;
}

/**
 * Session-scoped painter: register the widget once, then `requestRender`.
 *
 * Calling `setWidget` on the tool-execute context after it returns is a
 * no-op (stale ctx). The factory keeps a TUI handle that outlives that ctx.
 */
export function createStatusBoard(): StatusBoard {
	let ctx: StatusUi | undefined;
	let ui: StatusUi["ui"] | undefined;
	let entries: StatusEntry[] = [];
	let registered = false;
	let tui: WidgetTui | undefined;

	const renderLines = (now: number, theme: Theme): string[] =>
		themeLines(formatWidgetLines(entries, now), theme);

	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			if (!isStaleUiError(error)) throw error;
		}
	};

	const dropWidget = (): void => {
		if (registered && ui) {
			safe(() => ui!.setWidget(STATUS_WIDGET_KEY, undefined));
		}
		if (ui) safe(() => ui!.setStatus(STATUS_FOOTER_KEY, undefined));
		registered = false;
		tui = undefined;
	};

	const paint = (): void => {
		if (!ctx || !liveHasUi(ctx)) return;
		safe(() => ctx!.ui.setStatus(STATUS_FOOTER_KEY, formatFooterStatus(entries)));
		if (entries.length === 0) {
			dropWidget();
			return;
		}
		if (registered && tui) {
			tui.requestRender();
			return;
		}
		safe(() => {
			ctx!.ui.setWidget(
				STATUS_WIDGET_KEY,
				(nextTui, theme) => {
					tui = nextTui;
					return {
						render: (width) => fitLines(renderLines(Date.now(), theme), width),
						dispose: () => {
							if (tui === nextTui) {
								tui = undefined;
								registered = false;
							}
						},
					};
				},
				{ placement: STATUS_WIDGET_PLACEMENT },
			);
			registered = true;
		});
	};

	return {
		bind(next) {
			if (ui && ui !== next.ui) dropWidget();
			ctx = next;
			ui = next.ui;
			paint();
		},
		paint(next, _now) {
			entries = next;
			paint();
		},
		clear() {
			entries = [];
			dropWidget();
			ctx = undefined;
			ui = undefined;
		},
	};
}

/**
 * One-shot paint used by tests. Production uses `createStatusBoard` so the
 * widget survives a stale execute context.
 */
export function applyStatus(
	ctx: StatusUi,
	entries: StatusEntry[],
	now: number,
): void {
	if (!liveHasUi(ctx)) return;
	const lines = formatWidgetLines(entries, now);
	const themed = themeLines(lines, ctx.ui.theme);
	try {
		ctx.ui.setWidget(
			STATUS_WIDGET_KEY,
			themed.length ? themed : undefined,
			{ placement: STATUS_WIDGET_PLACEMENT },
		);
		ctx.ui.setStatus(STATUS_FOOTER_KEY, formatFooterStatus(entries));
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
	}
}

export function clearStatus(ctx: StatusUi): void {
	applyStatus(ctx, [], Date.now());
}
