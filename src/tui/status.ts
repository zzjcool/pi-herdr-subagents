/**
 * Live subagent status above the parent input box.
 *
 * pi-subagents' async widget uses Pi's default `aboveEditor` placement and a
 * persistent component so elapsed time keeps ticking after the tool call
 * returns (the execute ctx is then stale). We match that: a factory widget
 * plus `requestRender`, not a one-shot `string[]` on a dying context.
 */

export const STATUS_WIDGET_KEY = "herdr-subagent-status";
export const STATUS_FOOTER_KEY = "herdr-subagents";
export const STATUS_WIDGET_PLACEMENT = "aboveEditor" as const;

export interface StatusEntry {
	name: string;
	agent: string;
	state: string;
	startedAt: number;
	herdrStatus?: string;
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
		const entry = entries[0]!;
		return [
			`● ${entry.name}${roleSuffix(entry)} · ${formatElapsed(now - entry.startedAt)}`,
			`  ⎿  ${entryStatus(entry)}`,
		];
	}
	const lines = [`● Async agents · herdr`];
	for (const [index, entry] of entries.entries()) {
		const last = index === entries.length - 1;
		const branch = last ? "└─" : "├─";
		const cont = last ? "   " : "│  ";
		lines.push(
			`${branch} ● ${entry.name}${roleSuffix(entry)} · ${formatElapsed(now - entry.startedAt)}`,
		);
		lines.push(`${cont}  ⎿  ${entryStatus(entry)}`);
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
						render: () => renderLines(Date.now(), theme),
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
