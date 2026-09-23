/**
 * Parent-pane state labels in herdr's sidebar (research: option C).
 *
 * The parent's agent_status comes from herdr's own integration
 * (`herdr-agent-state.ts`): it reports `idle` the moment the parent's turn
 * settles — which in the async orchestration model is exactly when the parent
 * is WAITING on live subagents. herdr's sidebar then reads "done".
 *
 * This module annotates (never overrides) that status: while tracked children
 * exist, the parent pane gets a state-label like `idle=⏳ 2 subagents (w-0)`
 * via `pane report-metadata --state-label`, refreshed with a TTL so a crashed
 * reporter leaves no stale text. When the last child settles, the label is
 * cleared. The status ICON stays herdr's own call — this is display-layer
 * only.
 *
 * The refresh cadence is the runtime's busy hook (500ms UI timer, de-duped by
 * syncBusy), so each report carries a TTL comfortably above two missed
 * refreshes and is best-effort: herdr unavailable → silently skipped.
 */

import type { HerdrClient } from "../shared/types.ts";

export const PARENT_LABEL_SOURCE = "pi-herdr-subagents";

/**
 * Label TTL: the runtime refreshes every ~500ms, so 15s covers ~30 missed
 * refreshes (sleep, herdr busy, GC pause) before the annotation self-clears.
 */
export const PARENT_LABEL_TTL_MS = 15_000;

export interface ParentPaneLabelerDeps {
	client: HerdrClient;
	/** The parent's own pane, when running inside herdr (`HERDR_PANE_ID`). */
	paneId?: string;
	/** Injectable for tests. */
	now?: () => number;
}

/**
 * De-duplicating state-label reporter.
 *
 * `report` skips when the text is unchanged and the last report is still
 * comfortably inside the TTL window — the busy hook fires every refresh tick,
 * and a shell-out per tick would be pure noise.
 */
export class ParentPaneLabeler {
	private readonly client: HerdrClient;
	private readonly paneId: string | undefined;
	private readonly now: () => number;
	private lastText: string | undefined;
	private lastReportAt = 0;
	private inFlight = false;

	constructor(deps: ParentPaneLabelerDeps) {
		this.client = deps.client;
		this.paneId = deps.paneId?.trim() || undefined;
		this.now = deps.now ?? (() => Date.now());
	}

	/** Annotate the parent pane with `label`, or clear when undefined. */
	report(label: string | undefined): void {
		if (!this.paneId) return;
		if (label === undefined) {
			void this.clear();
			return;
		}
		const t = this.now();
		// Skip an unchanged label that was reported recently enough that its
		// TTL still has more than half its window left.
		if (
			label === this.lastText &&
			t - this.lastReportAt < PARENT_LABEL_TTL_MS / 2
		) {
			return;
		}
		void this.send({ stateLabel: { status: "idle", text: label } }, label, t);
	}

	/** Drop this source's labels from the parent pane. */
	clear(): Promise<void> {
		if (!this.paneId) return Promise.resolve();
		this.lastText = undefined;
		return this.send({ clearStateLabels: true }, undefined, this.now());
	}

	private async send(
		opts: {
			stateLabel?: { status: string; text: string };
			clearStateLabels?: boolean;
		},
		nextText: string | undefined,
		at: number,
	): Promise<void> {
		if (this.inFlight || !this.paneId) return;
		this.inFlight = true;
		try {
			const res = await this.client.paneReportMetadata({
				paneId: this.paneId,
				source: PARENT_LABEL_SOURCE,
				...(opts.stateLabel ? { stateLabel: opts.stateLabel } : {}),
				...(opts.clearStateLabels ? { clearStateLabels: true } : {}),
				...(opts.stateLabel ? { ttlMs: PARENT_LABEL_TTL_MS } : {}),
			});
			// A failed report must not pin `lastText`: the next tick retries.
			if (res.ok) {
				this.lastText = nextText;
				this.lastReportAt = at;
			}
		} catch {
			// Best-effort: the sidebar label is cosmetic, never load-bearing.
		} finally {
			this.inFlight = false;
		}
	}
}
