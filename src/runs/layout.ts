/**
 * Session-wide layout: same agent type → one tab, each child a pane.
 *
 * The orchestrator used to key tabs by run id. Two parallel `subagent` tool
 * calls each created a run, so two scouts landed in two tabs. This registry
 * is process-scoped (the extension holds one) so concurrent launches of the
 * same type join the same tab. After a reload, herdr tabs are re-adopted by
 * a parent-scoped label (`scout@wA:p1`) so another Pi in the same Space
 * cannot join this tab.
 *
 * Panes inside a type tab are tiled automatically as a 3-column grid
 * (fill the first row left-to-right, then wrap down) instead of stacking
 * every child vertically off the root pane.
 *
 * Also coalesces `agent list` and reserves herdr names so two racing launches
 * do not both try `scout-0`.
 */

import { makeName } from "../shared/name.ts";

/**
 * Tab label for one agent type.
 *
 * Same type still shares one tab *inside one parent pane*. A second parent Pi
 * in the same Space must not adopt that tab — otherwise its recycle can
 * `tab close` the first parent's live children. `owner` is the parent
 * `HERDR_PANE_ID` (stable across `/reload` in the same pane).
 */
export function typeTabLabel(agentType: string, owner?: string): string {
	const tag = sanitizeTabOwner(owner);
	return tag ? `${agentType}@${tag}` : agentType;
}

/** Keep the owner fragment a single herdr-label-safe token. */
export function sanitizeTabOwner(owner: string | undefined): string | undefined {
	const cleaned = (owner ?? "")
		.trim()
		.replace(/\s+/g, "")
		.replace(/[^A-Za-z0-9:_-]/g, "")
		.slice(0, 32);
	return cleaned.length > 0 ? cleaned : undefined;
}

export interface TypeTab {
	tabId: string;
	rootPaneId: string;
	rootPaneUsed: boolean;
	/** Live pane ids in creation order, used to pick the next split target. */
	panes: string[];
}

export interface TypeTabCreateResult {
	tabId: string;
	rootPaneId: string;
	/** True when the root pane already hosts a child (adopted tab). */
	rootOccupied?: boolean;
	/** Live panes already in the tab (adopted). */
	panes?: string[];
}

export interface TileSplit {
	target: string;
	direction: "right" | "down";
}

/**
 * Next split for a 3-column grid.
 *
 *   1 pane → split it right     → [A | B]
 *   2 panes → split B right     → [A | B | C]
 *   3 panes → split A down      → [A/D | B | C]
 *   4 panes → split B down      → [A/D | B/E | C]
 *   5 panes → split C down      → [A/D | B/E | C/F]
 *
 * Empty `panes` means the caller should occupy the tab root instead.
 */
export const TILE_COLUMNS = 3;

export function tileSplit(panes: readonly string[]): TileSplit | undefined {
	if (panes.length === 0) return undefined;
	if (panes.length < TILE_COLUMNS) {
		const target = panes[panes.length - 1];
		return target ? { target, direction: "right" } : undefined;
	}
	const target = panes[panes.length - TILE_COLUMNS];
	return target ? { target, direction: "down" } : undefined;
}

export interface SessionLayout {
	liveNames(fetch: () => Promise<Set<string>>): Promise<Set<string>>;
	claimName(agentType: string, blocked: (name: string) => boolean): string;
	rememberName(name: string): void;
	acquireTypeTab(
		agentType: string,
		create: () => Promise<TypeTabCreateResult>,
	): Promise<TypeTab>;
	/**
	 * Occupy the type-tab root or split a live pane. Serialized per type so
	 * two racing launches cannot both split the same target.
	 */
	assignPane(
		agentType: string,
		split: (plan: TileSplit) => Promise<string>,
	): Promise<{ paneId: string; tabId: string }>;
	releasePane(
		agentType: string,
		paneId: string,
	): { tabId: string | undefined; empty: boolean };
	getTypeTab(agentType: string): TypeTab | undefined;
	dropTypeTab(agentType: string): void;
}

export interface SessionLayoutOptions {
	now?: () => number;
	listTtlMs?: number;
}

const DEFAULT_LIST_TTL_MS = 1_500;

export function createSessionLayout(
	opts: SessionLayoutOptions = {},
): SessionLayout {
	const now = opts.now ?? Date.now;
	const listTtlMs = opts.listTtlMs ?? DEFAULT_LIST_TTL_MS;
	const claimed = new Set<string>();
	const tabs = new Map<string, TypeTab>();
	const pendingTabs = new Map<string, Promise<TypeTab>>();
	const paneChains = new Map<string, Promise<unknown>>();
	let listCache: { names: Set<string>; at: number } | undefined;
	let listPending: Promise<Set<string>> | undefined;

	const enqueue = <T>(key: string, work: () => Promise<T>): Promise<T> => {
		const prev = paneChains.get(key) ?? Promise.resolve();
		const next = prev.then(work, work);
		paneChains.set(
			key,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	};

	return {
		async liveNames(fetch) {
			const cached = listCache;
			if (cached && now() - cached.at < listTtlMs) {
				return new Set([...cached.names, ...claimed]);
			}
			if (!listPending) {
				listPending = fetch()
					.then((names) => {
						listCache = { names, at: now() };
						return names;
					})
					.finally(() => {
						listPending = undefined;
					});
			}
			const names = await listPending;
			return new Set([...names, ...claimed]);
		},

		claimName(agentType, blocked) {
			for (let i = 0; i < 1000; i += 1) {
				const candidate = makeName(agentType, i);
				if (claimed.has(candidate) || blocked(candidate)) continue;
				claimed.add(candidate);
				return candidate;
			}
			const fallback = makeName(agentType, 1000);
			claimed.add(fallback);
			return fallback;
		},

		rememberName(name) {
			claimed.add(name);
		},

		async acquireTypeTab(agentType, create) {
			for (;;) {
				const existing = tabs.get(agentType);
				if (existing) return existing;
				const inflight = pendingTabs.get(agentType);
				if (inflight) {
					try {
						return await inflight;
					} catch {
						continue;
					}
				}

				const work = create().then((created) => {
					const panes = created.panes
						? [...created.panes]
						: created.rootOccupied
							? [created.rootPaneId]
							: [];
					const slot: TypeTab = {
						tabId: created.tabId,
						rootPaneId: created.rootPaneId,
						rootPaneUsed: panes.length > 0,
						panes,
					};
					tabs.set(agentType, slot);
					return slot;
				});
				pendingTabs.set(agentType, work);
				try {
					return await work;
				} finally {
					if (pendingTabs.get(agentType) === work) {
						pendingTabs.delete(agentType);
					}
				}
			}
		},

		assignPane(agentType, split) {
			return enqueue(agentType, async () => {
				const slot = tabs.get(agentType);
				if (!slot) {
					throw new Error(`no type tab registered for ${agentType}`);
				}
				const plan = tileSplit(slot.panes);
				if (!plan) {
					slot.panes.push(slot.rootPaneId);
					slot.rootPaneUsed = true;
					return { paneId: slot.rootPaneId, tabId: slot.tabId };
				}
				const paneId = await split(plan);
				slot.panes.push(paneId);
				return { paneId, tabId: slot.tabId };
			});
		},

		releasePane(agentType, paneId) {
			const slot = tabs.get(agentType);
			if (!slot) return { tabId: undefined, empty: true };
			slot.panes = slot.panes.filter((id) => id !== paneId);
			if (slot.panes.length > 0) {
				return { tabId: slot.tabId, empty: false };
			}
			const tabId = slot.tabId;
			tabs.delete(agentType);
			return { tabId, empty: true };
		},

		getTypeTab(agentType) {
			return tabs.get(agentType);
		},

		dropTypeTab(agentType) {
			tabs.delete(agentType);
		},
	};
}
