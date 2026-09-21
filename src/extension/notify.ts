/**
 * Parent-session completion delivery.
 *
 * pi-subagents does NOT let a child prompt the parent. The extension watches
 * the child, then injects a custom message into the parent session with
 * `triggerTurn` so the parent wakes up and reads the result.
 *
 * `display` is false on success (the LLM still sees it; the transcript stays
 * quiet) and true on failure/stop, matching pi-subagents' notify.ts.
 *
 * Delivery is `followUp`, not the default `steer`. Steer would hijack the
 * parent's next LLM call while it is still in a tool loop. Follow-up waits
 * until that turn is idle; if the parent is already idle, `triggerTurn`
 * still starts a new turn immediately.
 */

export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";

export type CompletionStatus = "completed" | "failed" | "stopped" | "running";

export interface CompletionInput {
	name: string;
	agent?: string;
	execution: { status: string; reason?: string };
	output: string;
	sessionFile?: string;
	acceptance?: { status: string; level?: string };
	recycled?: boolean;
}

export interface CompletionNotice {
	content: string;
	display: boolean;
	status: CompletionStatus;
}

const PREVIEW_CHARS = 4_000;

/**
 * Map an execution status onto the coarse notification label.
 *
 * `unknown` needs a witness: non-pi kinds cannot produce a stopReason (F7),
 * so a finished cursor child reports `unknown`. When its own verdict was
 * still parsed (acceptance accepted/rejected), the turn demonstrably ran and
 * finished — report completion and let the `acceptance:` line carry the
 * verdict. Without that witness, `unknown` stays `failed` (pi kind, no
 * messages at all). The old blanket mapping labelled every successful
 * cursor answer "Background task failed".
 *
 * `running` is NOT a completion and is reported as itself (B). It used to fall
 * through to the `failed` default, so a collect timeout on a live child sent
 * "Background task failed" while the body said "still alive". A running
 * snapshot must never be formatted at all — `formatCompletionNotice` (and
 * `JoinCoordinator.onTerminal`) throw on it instead.
 */
export function completionStatusOf(
	executionStatus: string,
	acceptanceStatus?: string,
): CompletionStatus {
	if (executionStatus === "running") return "running";
	if (executionStatus === "success") return "completed";
	if (executionStatus === "aborted") return "stopped";
	if (
		executionStatus === "unknown" &&
		(acceptanceStatus === "accepted" || acceptanceStatus === "rejected")
	) {
		return "completed";
	}
	return "failed";
}

export function previewOutput(text: string, max = PREVIEW_CHARS): string {
	const trimmed = text.trim() || "(no output)";
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}\n…`;
}

export function formatCompletionNotice(input: CompletionInput): CompletionNotice {
	const status = completionStatusOf(
		input.execution.status,
		input.acceptance?.status,
	);
	if (status === "running") {
		// Fail loud (B): a still-alive child is a progress signal, not a verdict.
		// watch() re-arms on a running snapshot instead of notifying, so reaching
		// here means a caller lost that guard — never silently label it.
		throw new Error("running snapshot is not a completion");
	}
	const label = input.agent ? `${input.name} (${input.agent})` : input.name;
	const reason = input.execution.reason
		? ` (${input.execution.reason})`
		: "";
	const acceptance = input.acceptance
		? `acceptance: ${input.acceptance.status}${input.acceptance.level ? ` (${input.acceptance.level})` : ""}`
		: undefined;
	const content = [
		`Background task ${status}: **${label}**`,
		"",
		`execution: ${input.execution.status}${reason}`,
		acceptance,
		"",
		previewOutput(input.output),
		input.sessionFile ? "" : undefined,
		input.sessionFile ? `Session file: ${input.sessionFile}` : undefined,
		input.recycled === false
			? undefined
			: "Pane recycled. Resume from the session file if you need this child again.",
	]
		.filter((line) => line !== undefined)
		.join("\n");
	return {
		content,
		display: status !== "completed",
		status,
	};
}

export function collectFailureInput(
	name: string,
	error: unknown,
): CompletionInput {
	return {
		name,
		execution: { status: "failed", reason: String(error) },
		output: String(error),
		recycled: false,
	};
}

export function formatCollectFailure(name: string, error: unknown): CompletionNotice {
	return formatCompletionNotice(collectFailureInput(name, error));
}

// ---------------------------------------------------------------------------
// Grouped (smart-join) delivery
// ---------------------------------------------------------------------------

export interface GroupedEntry extends CompletionInput {
	status: CompletionStatus;
}

export interface GroupedCompletionInput {
	/** Omitted run header when absent. */
	runId?: string;
	entries: GroupedEntry[];
	/** Members still running at flush time (partial flush). */
	stillRunning?: string[];
}

/**
 * Merge several terminal children into ONE notice so a fan-out wakes the
 * parent once, not once per child:
 *
 *   Background tasks completed (2 of 3):
 *   - worker-0 (worker): completed — acceptance: accepted (attested)
 *     <previewOutput, per-entry cap max(500, PREVIEW_CHARS/entries.length)>
 *   - reviewer-1: failed (model error)
 *   Still running: slow-2 (notifies separately when it finishes)
 *
 * Recycle is per-entry (a wait()-released sibling can race the flush, so a
 * blanket "Pane recycled" footer could lie): entries whose pane was actually
 * recycled carry an inline "(pane recycled)" marker.
 * Aggregate status: any failed → "failed"; else any stopped → "stopped";
 * else "completed". `display` follows the single-notice rule.
 */
export function formatGroupedNotice(
	input: GroupedCompletionInput,
): CompletionNotice {
	const entries = input.entries;
	const stillRunning = input.stillRunning ?? [];
	const perEntryMax = Math.max(
		500,
		Math.floor(PREVIEW_CHARS / Math.max(1, entries.length)),
	);
	const header =
		stillRunning.length > 0
			? `Background tasks completed (${entries.length} of ${entries.length + stillRunning.length}):`
			: `Background tasks completed (${entries.length}):`;
	const lines: string[] = [];
	if (input.runId) lines.push(`Run: ${input.runId}`);
	lines.push(header);
	let anyFailed = false;
	let anyStopped = false;
	for (const entry of entries) {
		if (entry.status === "failed") anyFailed = true;
		if (entry.status === "stopped") anyStopped = true;
		const label = entry.agent
			? `${entry.name} (${entry.agent})`
			: entry.name;
		const reason = entry.execution.reason
			? ` (${entry.execution.reason})`
			: "";
		const acceptance = entry.acceptance
			? ` — acceptance: ${entry.acceptance.status}${entry.acceptance.level ? ` (${entry.acceptance.level})` : ""}`
			: "";
		// recycled is per-entry truth: a wait()-consumed sibling may already
		// be released while this pane is still open, so no blanket footer.
		const recycled = entry.recycled === false ? "" : " (pane recycled)";
		lines.push(`- ${label}: ${entry.status}${reason}${acceptance}${recycled}`);
		lines.push(`  ${previewOutput(entry.output, perEntryMax)}`);
	}
	if (stillRunning.length > 0) {
		lines.push(
			`Still running: ${stillRunning.join(", ")} (notifies separately when it finishes)`,
		);
	}
	const status: CompletionStatus = anyFailed
		? "failed"
		: anyStopped
			? "stopped"
			: "completed";
	return {
		content: lines.join("\n"),
		display: status !== "completed",
		status,
	};
}

export interface SendMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface SendMessageApi {
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
		},
		options?: SendMessageOptions,
	): void;
}

/**
 * How a completion notice should enter the parent session.
 *
 * `triggerTurn: false` only records the message. `true` wakes the parent, but
 * via `followUp` so an in-flight parent turn is not steered mid-work.
 */
export function completionDeliveryOptions(
	triggerTurn: boolean,
): SendMessageOptions {
	if (!triggerTurn) return { triggerTurn: false };
	return { triggerTurn: true, deliverAs: "followUp" };
}

/**
 * Inject the notice into the parent session.
 *
 * Returns false when the runtime rejected the send (session gone, shutdown).
 * The child's session file is still on disk; the parent can `collect` later.
 */
export function deliverCompletion(
	pi: SendMessageApi,
	notice: CompletionNotice,
	triggerTurn = true,
): boolean {
	try {
		pi.sendMessage(
			{
				customType: SUBAGENT_NOTIFY_TYPE,
				content: notice.content,
				display: notice.display,
			},
			completionDeliveryOptions(triggerTurn),
		);
		return true;
	} catch {
		return false;
	}
}
