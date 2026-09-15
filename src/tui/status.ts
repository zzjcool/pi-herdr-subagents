/**
 * Live subagent status next to the parent input box.
 *
 * pi-subagents puts a fleet widget below the editor (`belowEditor`) and a
 * compact footer via `setStatus`. We match that placement: the user sees
 * running children without the child prompting the parent.
 */

export const STATUS_WIDGET_KEY = "herdr-subagent-status";
export const STATUS_FOOTER_KEY = "herdr-subagents";

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

export function formatWidgetLines(
	entries: StatusEntry[],
	now: number,
): string[] {
	if (entries.length === 0) return [];
	const noun = entries.length === 1 ? "agent" : "agents";
	const lines = [`  ${entries.length} active ${noun}`];
	for (const entry of entries) {
		const status = entry.herdrStatus ?? entry.state;
		const role = entry.agent && entry.agent !== entry.name ? ` (${entry.agent})` : "";
		lines.push(
			`  ● ${entry.name}${role}  ${status}  ${formatElapsed(now - entry.startedAt)}`,
		);
	}
	return lines;
}

type Theme = {
	fg(color: string, text: string): string;
};

export interface StatusUi {
	hasUI: boolean;
	ui: {
		theme: Theme;
		setStatus(key: string, text: string | undefined): void;
		setWidget(
			key: string,
			content: string[] | undefined,
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

function themeLines(lines: string[], theme: Theme): string[] {
	if (lines.length === 0) return lines;
	const [header, ...rest] = lines;
	const out = [theme.fg("muted", header ?? "")];
	for (const line of rest) out.push(theme.fg("dim", line));
	return out;
}

/**
 * Paint (or clear) the input-adjacent widget and footer.
 *
 * `belowEditor` is the pi-subagents fleet-status default: the roster sits
 * directly under the prompt, which is what users mean by "on the input box".
 */
export function applyStatus(ctx: StatusUi, entries: StatusEntry[], now: number): void {
	let hasUi = false;
	try {
		hasUi = ctx.hasUI;
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
		return;
	}
	if (!hasUi) return;

	const lines = formatWidgetLines(entries, now);
	const themed = themeLines(lines, ctx.ui.theme);
	try {
		ctx.ui.setWidget(
			STATUS_WIDGET_KEY,
			themed.length ? themed : undefined,
			{ placement: "belowEditor" },
		);
		ctx.ui.setStatus(STATUS_FOOTER_KEY, formatFooterStatus(entries));
	} catch (error) {
		if (!isStaleUiError(error)) throw error;
	}
}

export function clearStatus(ctx: StatusUi): void {
	applyStatus(ctx, [], Date.now());
}
