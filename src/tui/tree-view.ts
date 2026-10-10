import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	MouseRegion,
	ScrollView,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TUI,
} from "@earendil-works/pi-tui";
import type { LegionEvent } from "../extension/event-bus.ts";
import type { LegionNode, NodeStatus } from "../legion/nodes.ts";

const TREE_HEADER = "Legion tree · j/k move · enter toggle · / search · esc/q close";
const MAX_ACTIVITY_TOOLS = 2;
const ACTIVE_STATUSES = new Set<NodeStatus>(["starting", "running", "blocked"]);
const TERMINAL_STATUSES = new Set<NodeStatus>(["settled", "failed", "retired"]);

export interface TreeNodeSnapshot extends LegionNode {
	turn?: number;
	turns?: number;
	tools?: readonly string[];
	lastTools?: readonly string[];
}

export interface TreeViewTheme {
	fg(color: "accent" | "dim", text: string): string;
}

export interface TreeViewOptions {
	nodes: readonly TreeNodeSnapshot[];
	events?: readonly LegionEvent[];
	now?: () => number;
	theme?: TreeViewTheme;
	requestRender?: () => void;
}

export interface TreeViewState {
	selectedId: string | undefined;
	expandedIds: readonly string[];
	visibleIds: readonly string[];
	searchMode: boolean;
	searchQuery: string;
}

/** Component returned by the custom-UI factory; it has no context or DB dependency. */
export interface TreeViewComponent extends Component {
	updateSnapshot(nodes: readonly TreeNodeSnapshot[], events?: readonly LegionEvent[]): void;
	applyEvent(event: LegionEvent): void;
	getState(): TreeViewState;
	isExpanded(nodeId: string): boolean;
	dispose(): void;
}

export type TreeViewDone = (result?: undefined) => void;

/**
 * Construct the /legion tree custom component. Pass this component from a
 * `ctx.ui.custom()` factory; `done` is called once by Esc/q. The TUI's own
 * ScrollView layout clips and scrolls the flattened snapshot rows.
 */
export function createTreeView(
	options: TreeViewOptions,
	done: TreeViewDone = () => {},
): TreeViewComponent {
	const now = options.now ?? (() => Date.now());
	const theme = options.theme;
	const requestRender = options.requestRender ?? (() => {});
	const nodes = new Map<string, TreeNodeSnapshot>();
	const children = new Map<string, string[]>();
	const activity = new Map<string, TreeActivity>();
	const expanded = new Set<string>();
	const rowOffsets = new Map<string, number>();
	let selectedId: string | undefined;
	let searchMode = false;
	let searchQuery = "";
	let searchMatchIndex = -1;
	let closed = false;
	let rowLines: string[] = [];
	let contentWidth = 80;

	const rows = new TreeRows(
		(width) => {
			contentWidth = width;
			rowLines = buildRows();
			return rowLines;
		},
		(event) => handleTreeMouse(event),
	);
	const scrollContent = new MouseRegion(rows, (event) => handleTreeMouse(event));
	const scrollView = new ScrollView(scrollContent, {
		axis: "vertical",
		follow: "none",
		primary: true,
		scrollbar: "auto",
		overscroll: "contain",
	});

	function sortedChildren(parentId: string): string[] {
		return [...(children.get(parentId) ?? [])];
	}

	function rebuildIndexes(nextNodes: readonly TreeNodeSnapshot[]): void {
		nodes.clear();
		children.clear();
		for (const node of nextNodes) {
			nodes.set(node.id, { ...node });
			children.set(node.id, []);
		}
		for (const node of nextNodes) {
			if (node.parentId === null) continue;
			const siblings = children.get(node.parentId);
			if (siblings && nodes.has(node.id)) siblings.push(node.id);
		}
		for (const ids of children.values()) {
			ids.sort((leftId, rightId) => {
				const left = nodes.get(leftId)!;
				const right = nodes.get(rightId)!;
				return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
			});
		}
		// A snapshot may arrive in a different order; indexes are canonicalized from parent ids.
		for (const id of [...activity.keys()]) {
			if (!nodes.has(id)) activity.delete(id);
		}
		for (const id of [...expanded]) {
			if (!nodes.has(id)) expanded.delete(id);
		}
		if (!selectedId || !nodes.has(selectedId)) selectedId = rootIds()[0];
		initializeExpansion();
	}

	function rootIds(): string[] {
		return [...nodes.values()]
			.filter((node) => node.parentId === null)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map((node) => node.id);
	}

	function subtreeHasActiveNode(id: string): boolean {
		const seen = new Set<string>();
		const pending = [id];
		while (pending.length > 0) {
			const next = pending.pop();
			if (!next || seen.has(next)) continue;
			seen.add(next);
			const node = nodes.get(next);
			if (node && ACTIVE_STATUSES.has(node.status)) return true;
			pending.push(...sortedChildren(next));
		}
		return false;
	}

	function initializeExpansion(): void {
		const subtreeActive = new Map<string, boolean>();
		const visits = new Set<string>();
		const visiting = new Set<string>();
		const hasActiveDescendant = (id: string): boolean => {
			const memoized = subtreeActive.get(id);
			if (memoized !== undefined) return memoized;
			if (visiting.has(id) || visits.has(id)) return false;
			visiting.add(id);
			const node = nodes.get(id);
			const active = Boolean(node && ACTIVE_STATUSES.has(node.status));
			const descendantIsActive = sortedChildren(id).some((childId) => hasActiveDescendant(childId));
			visiting.delete(id);
			visits.add(id);
			subtreeActive.set(id, active || descendantIsActive);
			return active || descendantIsActive;
		};
		for (const id of nodes.keys()) hasActiveDescendant(id);

		for (const node of nodes.values()) {
			if (expanded.has(node.id)) continue;
			const hasChildren = sortedChildren(node.id).length > 0;
			const isCompleted = TERMINAL_STATUSES.has(node.status);
			const activePath = subtreeActive.get(node.id) === true;
			if (
				hasChildren &&
				(activePath || (!isCompleted && node.depth <= 2))
			) {
				expanded.add(node.id);
			}
		}
	}

	function searchVisibleNodeIds(): string[] {
		const query = searchQuery.trim();
		if (!searchMode || !query) return [];
		const included = new Set(findMatches());
		for (const id of [...included]) {
			let current = nodes.get(id);
			const ancestors = new Set<string>();
			while (current?.parentId && !ancestors.has(current.parentId)) {
				ancestors.add(current.parentId);
				included.add(current.parentId);
				current = nodes.get(current.parentId);
			}
		}
		return allNodeIds().filter((id) => included.has(id));
	}

	function isVisuallyExpanded(id: string, searchVisible?: ReadonlySet<string>): boolean {
		if (searchVisible) return sortedChildren(id).some((childId) => searchVisible.has(childId));
		return expanded.has(id);
	}

	function visibleNodeIds(): string[] {
		if (searchMode && searchQuery.trim()) return searchVisibleNodeIds();
		const result: string[] = [];
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			visited.add(id);
			result.push(id);
			if (!expanded.has(id)) return;
			for (const childId of sortedChildren(id)) visit(childId);
		};
		for (const id of rootIds()) visit(id);
		return result;
	}

	function allNodeIds(): string[] {
		const result: string[] = [];
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			visited.add(id);
			result.push(id);
			for (const childId of sortedChildren(id)) visit(childId);
		};
		for (const id of rootIds()) visit(id);
		// Include malformed/orphaned snapshots deterministically rather than silently dropping facts.
		for (const id of nodes.keys()) visit(id);
		return result;
	}

	function subtreeSize(id: string, visited = new Set<string>()): number {
		if (visited.has(id)) return 0;
		visited.add(id);
		return 1 + sortedChildren(id).reduce((sum, childId) => sum + subtreeSize(childId, visited), 0);
	}

	function formatElapsed(node: TreeNodeSnapshot): string {
		const elapsedEnd = TERMINAL_STATUSES.has(node.status) ? node.updatedAt : now();
		const elapsedSeconds = Math.max(0, Math.round((elapsedEnd - node.createdAt) / 1_000));
		return `${elapsedSeconds}s`;
	}

	function safeText(value: string | null | undefined): string {
		return value
			? stripTerminalSequences(value)
				.replace(/[\r\n\t]/g, " ")
				.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
			: "";
	}

	function fitLine(line: string, width: number): string {
		const safeWidth = Math.max(1, Math.floor(width));
		return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth);
	}

	function styleNodeLine(line: string, node: TreeNodeSnapshot, selected: boolean): string {
		if (TERMINAL_STATUSES.has(node.status) && theme) return theme.fg("dim", line);
		if (selected && theme) return theme.fg("accent", line);
		return line;
	}

	function rowHead(node: TreeNodeSnapshot, isSelected: boolean, forcedExpanded = false): string {
		const hasChildren = sortedChildren(node.id).length > 0;
		const marker = hasChildren ? (expanded.has(node.id) || forcedExpanded ? "▾" : "▸") : " ";
		const selection = isSelected ? "❯" : " ";
		const indent = "  ".repeat(Math.max(0, node.depth));
		const model = safeText(node.model);
		const head = [
			`● ${safeText(node.name)} (${safeText(node.role)})`,
			...(model ? [model] : []),
			formatElapsed(node),
		].join(" · ");
		return `${indent}${selection}${marker} ${head}`;
	}

	function rowDetail(node: TreeNodeSnapshot, isSelected: boolean): string {
		const info = activity.get(node.id);
		const turn = info?.turn ?? node.turn ?? node.turns;
		const tools = info?.tools.length ? info.tools : node.lastTools ?? node.tools ?? [];
		const detail = [safeText(info?.phase ?? node.phase ?? node.status)];
		if (turn !== undefined && turn > 0) detail.push(`turn ${turn}`);
		if (tools.length > 0) {
			detail.push(tools.slice(-MAX_ACTIVITY_TOOLS).map((tool) => safeText(tool)).join(", "));
		}
		return `${"  ".repeat(Math.max(0, node.depth))}${isSelected ? "│" : " "}   ⎿ ${detail.join(" · ")}`;
	}

	function buildRows(): string[] {
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const visibleIds = searchVisible ? [...searchVisible] : visibleNodeIds();
		const lines = [fitLine(TREE_HEADER, contentWidth)];
		if (searchMode) {
			const matches = findMatches();
			const suffix = matches.length
				? ` · ${Math.min(searchMatchIndex + 1, matches.length)}/${matches.length}`
				: " · no matches";
			lines.push(fitLine(`/${searchQuery}${searchMode ? "▏" : ""}${suffix}`, contentWidth));
		}
		rowOffsets.clear();
		for (const id of visibleIds) {
			const node = nodes.get(id);
			if (!node) continue;
			const start = lines.length;
			rowOffsets.set(id, start);
			const isSelected = selectedId === id;
			const childCount = sortedChildren(id).length;
			const isExpanded = isVisuallyExpanded(id, searchVisible);
			const hiddenCount = subtreeSize(id) - 1;
			const collapsedLine = `${"  ".repeat(Math.max(0, node.depth))}${isSelected ? "❯" : " "}▸ ${safeText(node.name)} +${hiddenCount} collapsed`;
			const head = childCount > 0 && !isExpanded
				? collapsedLine
				: rowHead(node, isSelected, Boolean(searchVisible && isExpanded));
			lines.push(fitLine(styleNodeLine(head, node, isSelected), contentWidth));
			if (childCount > 0 && !isExpanded) continue;
			lines.push(fitLine(styleNodeLine(rowDetail(node, isSelected), node, isSelected), contentWidth));
		}
		return lines;
	}

	function findMatches(): string[] {
		const query = searchQuery.trim().toLocaleLowerCase();
		if (!query) return [];
		return allNodeIds().filter((id) => {
			const node = nodes.get(id);
			return Boolean(
				node &&
				[id, node.name, node.role, node.model ?? ""]
					.some((value) => safeText(value).toLocaleLowerCase().includes(query)),
			);
		});
	}

	function notifyRender(): void {
		rows.invalidate();
		scrollView.invalidate();
		requestRender();
	}

	function ensureSelectionVisible(): void {
		if (!selectedId || scrollView.viewportHeight <= 0) return;
		const start = rowOffsets.get(selectedId);
		if (start === undefined) return;
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const end = start + (isVisuallyExpanded(selectedId, searchVisible) ? 2 : 1);
		if (start < scrollView.scrollTop) scrollView.scrollTo(start);
		else if (end > scrollView.scrollTop + scrollView.viewportHeight) {
			scrollView.scrollTo(end - scrollView.viewportHeight);
		}
	}

	function select(id: string): void {
		if (!nodes.has(id) || selectedId === id) return;
		selectedId = id;
		buildRows();
		ensureSelectionVisible();
		notifyRender();
	}

	function toggleExpanded(id: string): void {
		if (sortedChildren(id).length === 0) return;
		if (expanded.has(id)) {
			if (subtreeHasActiveNode(id)) return;
			expanded.delete(id);
			if (selectedId !== id && isDescendantOf(selectedId, id)) selectedId = id;
		} else {
			expanded.add(id);
		}
		buildRows();
		ensureSelectionVisible();
		notifyRender();
	}

	function isDescendantOf(nodeId: string | undefined, ancestorId: string): boolean {
		if (!nodeId) return false;
		let current = nodes.get(nodeId);
		const visited = new Set<string>();
		while (current?.parentId) {
			if (current.parentId === ancestorId) return true;
			if (visited.has(current.parentId)) return false;
			visited.add(current.parentId);
			current = nodes.get(current.parentId);
		}
		return false;
	}

	function reveal(id: string): void {
		const lineage: string[] = [];
		let current = nodes.get(id);
		const visited = new Set<string>();
		while (current?.parentId && !visited.has(current.parentId)) {
			visited.add(current.parentId);
			lineage.push(current.parentId);
			current = nodes.get(current.parentId);
		}
		for (const ancestor of lineage) expanded.add(ancestor);
	}

	function submitSearch(): void {
		const matches = findMatches();
		if (matches.length === 0) return;
		const selectedIndex = selectedId ? matches.indexOf(selectedId) : -1;
		searchMatchIndex = (selectedIndex + 1 + matches.length) % matches.length;
		const target = matches[searchMatchIndex];
		if (!target) return;
		searchMode = false;
		reveal(target);
		selectedId = target;
		buildRows();
		ensureSelectionVisible();
		notifyRender();
	}

	function moveSelection(delta: number): void {
		const ids = visibleNodeIds();
		if (ids.length === 0) return;
		const index = selectedId ? ids.indexOf(selectedId) : -1;
		const next = Math.max(0, Math.min(ids.length - 1, index + delta));
		const target = ids[next];
		if (target) select(target);
	}

	function finish(): void {
		if (closed) return;
		closed = true;
		done(undefined);
	}

	function toggleSelected(): void {
		if (selectedId) toggleExpanded(selectedId);
	}

	function handleInput(data: string): void {
		if (closed) return;
		if (matchesKey(data, Key.escape)) {
			if (searchMode) {
				searchMode = false;
				searchQuery = "";
				searchMatchIndex = -1;
				notifyRender();
			} else {
				finish();
			}
			return;
		}
		if (searchMode) {
			if (matchesKey(data, Key.enter)) {
				submitSearch();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				searchQuery = searchQuery.slice(0, -1);
				searchMatchIndex = -1;
				notifyRender();
				return;
			}
			if (matchesKey(data, Key.ctrl("u"))) {
				searchQuery = "";
				searchMatchIndex = -1;
				notifyRender();
				return;
			}
			if (matchesKey(data, "q")) {
				searchQuery += "q";
				notifyRender();
				return;
			}
			const searchChar = printableCharacter(data);
			if (searchChar) {
				searchQuery += searchChar;
				searchMatchIndex = -1;
				notifyRender();
			}
			return;
		}
		if (matchesKey(data, "q")) {
			finish();
		} else if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
			moveSelection(1);
		} else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
			moveSelection(-1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			toggleSelected();
		} else if (matchesKey(data, Key.right)) {
			if (selectedId && !expanded.has(selectedId)) toggleExpanded(selectedId);
			else if (selectedId) {
				const firstChild = sortedChildren(selectedId)[0];
				if (firstChild) select(firstChild);
			}
		} else if (matchesKey(data, Key.left)) {
			if (selectedId && expanded.has(selectedId)) toggleExpanded(selectedId);
			else if (selectedId) {
				const parentId = nodes.get(selectedId)?.parentId;
				if (parentId) select(parentId);
			}
		} else if (matchesKey(data, "/")) {
			searchMode = true;
			searchQuery = "";
			searchMatchIndex = -1;
			notifyRender();
		} else if (matchesKey(data, Key.pageDown)) {
			scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - 1));
		} else if (matchesKey(data, Key.pageUp)) {
			scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - 1));
		}
	}

	function handleTreeMouse(event: TuiMouseEvent): { handled: boolean; focus?: boolean } | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			scrollView.scrollBy(-event.wheelDelta);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		const lines = rowLines.length > 0 ? rowLines : buildRows();
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const visibleIds = searchVisible ? [...searchVisible] : visibleNodeIds();
		const contentY = event.y;
		for (const id of visibleIds) {
			const start = rowOffsets.get(id);
			if (start === undefined) continue;
			const node = nodes.get(id);
			if (!node) continue;
			const lineCount = sortedChildren(id).length > 0 && !isVisuallyExpanded(id, searchVisible) ? 1 : 2;
			if (contentY < start || contentY >= start + lineCount) continue;
			select(id);
			if (contentY === start && sortedChildren(id).length > 0) toggleExpanded(id);
			return { handled: true, focus: true };
		}
		if (lines.length === 0) return undefined;
		return undefined;
	}

	function applyStoredEvents(events: readonly LegionEvent[]): void {
		for (const event of events) applyEvent(event, false);
		initializeExpansion();
	}

	function applyEvent(event: LegionEvent, redraw = true): void {
		const current = nodes.get(event.nodeId);
		if (!current) return;
		const updated: TreeNodeSnapshot = { ...current };
		const data = recordOf(event.data);
		const details = activity.get(event.nodeId) ?? { tools: [] };
		let changed = false;
		switch (event.type) {
			case "node_launched":
				updated.status = "running";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_settled":
			case "agent_settled":
				updated.status = "settled";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_failed":
				updated.status = "failed";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_retired":
				updated.status = "retired";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_blocked":
				updated.status = "blocked";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_resumed":
				updated.status = "running";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "phase_change":
				if (typeof data?.to === "string") {
					updated.phase = data.to;
					details.phase = data.to;
					updated.phaseSince = event.ts;
					changed = true;
				}
				break;
			case "turn_start":
				details.turn =
					typeof data?.turn === "number"
						? data.turn
						: (details.turn ?? current.turn ?? current.turns ?? 0) + 1;
				changed = true;
				break;
			case "tool_call": {
				const toolName = stringField(data, "toolName") ?? stringField(data, "name");
				if (toolName) {
					details.tools.push(toolName);
					if (details.tools.length > MAX_ACTIVITY_TOOLS) details.tools.shift();
					changed = true;
				}
				break;
			}
			case "text_delta":
				// Text is intentionally not interpreted by the tree: RPC text is display-only elsewhere.
				break;
			default:
				break;
		}
		if (!changed) return;
		nodes.set(event.nodeId, updated);
		activity.set(event.nodeId, details);
		if (TERMINAL_STATUSES.has(updated.status) && !subtreeHasActiveNode(event.nodeId)) {
			expanded.delete(event.nodeId);
		}
		if (redraw) {
			initializeExpansion();
			buildRows();
			notifyRender();
		}
	}

	function getState(): TreeViewState {
		return {
			selectedId,
			expandedIds: [...expanded],
			visibleIds: visibleNodeIds(),
			searchMode,
			searchQuery,
		};
	}

	function dispose(): void {
		closed = true;
		scrollView.invalidate();
	}

	rebuildIndexes(options.nodes);
	if (options.events) applyStoredEvents(options.events);
	rowLines = buildRows();

	// ScrollView is itself the TUI Component; attach the public controller surface to it.
	return Object.assign(scrollView, {
		updateSnapshot(nextNodes: readonly TreeNodeSnapshot[], events: readonly LegionEvent[] = []) {
			rebuildIndexes(nextNodes);
			if (events.length > 0) applyStoredEvents(events);
			buildRows();
			notifyRender();
		},
		applyEvent(event: LegionEvent) {
			applyEvent(event);
		},
		getState,
		isExpanded(nodeId: string) {
			return expanded.has(nodeId);
		},
		dispose,
		handleInput,
	});
}

/** Build the factory shape accepted by `ctx.ui.custom(factory, { overlay: false })`. */
export function createTreeViewFactory(options: TreeViewOptions) {
	return <T>(
		tui: Pick<TUI, "requestRender">,
		theme: TreeViewTheme,
		_keybindings: unknown,
		done: (result: T) => void,
	): TreeViewComponent =>
		createTreeView(
			{
				...options,
				theme,
				requestRender: () => tui.requestRender(),
			},
			() => done(undefined as T),
		);
}

interface TreeActivity {
	turn?: number;
	phase?: string;
	tools: string[];
}

class TreeRows implements Component {
	private readonly renderRows: (width: number) => string[];
	private readonly handleMouseEvent: (event: TuiMouseEvent) =>
		| { handled: boolean; focus?: boolean }
		| undefined;

	constructor(
		renderRows: (width: number) => string[],
		handleMouseEvent: (event: TuiMouseEvent) =>
			| { handled: boolean; focus?: boolean }
			| undefined,
	) {
		this.renderRows = renderRows;
		this.handleMouseEvent = handleMouseEvent;
	}

	render(width: number): string[] {
		return this.renderRows(width);
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; focus?: boolean } | undefined {
		return this.handleMouseEvent(event);
	}

	invalidate(): void {}
}

function printableCharacter(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length !== 1) return undefined;
	const code = data.codePointAt(0);
	return code !== undefined && code >= 0x20 && code !== 0x7f ? data : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}
