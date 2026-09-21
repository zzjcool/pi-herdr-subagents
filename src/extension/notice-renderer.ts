/**
 * TUI renderer for the `subagent-notify` completion card.
 *
 * Every completion is now `display: true` so the transcript records the
 * finish. The renderer carries the burden `display: false` used to carry in
 * pi-subagents — not flooding the parent's screen: a `completed` notice
 * collapses to one row, hard-truncated at the live terminal width, and
 * `ctrl+o` (`app.tools.expand`, which Pi forwards to every chat component)
 * expands it back to the default Markdown block.
 *
 * Failures and stops return `undefined`, which makes Pi fall back to its
 * default rendering — the full block, exactly as before this renderer existed.
 * Notices without structured `details` (older sessions) do the same.
 */

import { Box, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import {
	type CompletionDetails,
	formatNoticeHeadline,
} from "./notify.ts";

function isCompletionDetails(value: unknown): value is CompletionDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<CompletionDetails>;
	return (
		typeof candidate.status === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.execution === "object" &&
		candidate.execution !== null
	);
}

/**
 * A `Text` that never wraps: whatever the width, the headline stays one row.
 *
 * `Text` word-wraps, so a narrow pane (a split the subagent tool itself
 * created) would turn the notice into the very screenful this renderer exists
 * to prevent. Truncate to the live width instead, ANSI-aware.
 */
class OneRowText implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [truncateToWidth(this.text, Math.max(1, width), "…")];
	}
}

export const renderSubagentNotice: MessageRenderer<CompletionDetails> = (
	message,
	options,
	theme: Theme,
) => {
	const details = isCompletionDetails(message.details)
		? message.details
		: undefined;
	if (!details || details.status !== "completed" || options.expanded) {
		return undefined;
	}
	const box = new Box(1, 0, (t) => theme.bg("customMessageBg", t));
	box.addChild(
		new OneRowText(theme.fg("success", formatNoticeHeadline(details))),
	);
	return box;
};
