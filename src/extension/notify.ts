/**
 * Parent-session completion delivery.
 *
 * pi-subagents does NOT let a child prompt the parent. The extension watches
 * the child, then injects a custom message into the parent session with
 * `triggerTurn` so the parent wakes up and reads the result.
 *
 * Every notice is `display: true` so the transcript records the completion.
 * pi-subagents kept success quiet (`display: false`) to avoid a 4 KB purple
 * block per child; we render instead of hiding: `notice-renderer.ts` collapses
 * a completed notice to one line (`ctrl+o` expands it), and failures fall
 * through to Pi's default Markdown block. The payload the LLM sees is the same
 * either way — `display` only steers the TUI.
 *
 * Delivery is `followUp`, not the default `steer`. Steer would hijack the
 * parent's next LLM call while it is still in a tool loop. Follow-up waits
 * until that turn is idle; if the parent is already idle, `triggerTurn`
 * still starts a new turn immediately.
 */

export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";

export type CompletionStatus = "completed" | "failed" | "stopped";

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
	/** TUI-only metadata; persisted with the entry, never sent to the LLM. */
	details: CompletionDetails;
}

/**
 * Structured copy of a notice for the TUI renderer.
 *
 * Kept free of the (up to 4 KB) output preview so the collapsed line can be
 * laid out without parsing `content` back apart.
 */
export interface CompletionDetails {
	status: CompletionStatus;
	name: string;
	agent?: string;
	execution: { status: string; reason?: string };
	acceptance?: { status: string; level?: string };
	sessionFile?: string;
	outputBytes: number;
	recycled?: boolean;
}

/** `1234` -> `1.2 KB`, so the collapsed line says how much landed. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Strip what would break a one-row TUI line: control characters (newline,
 * ESC included) and any escape sequence they could have introduced.
 *
 * Child names are usually sanitized in `src/shared/name.ts`, but `agent`
 * labels and labels from non-pi kinds come from pane titles and frontmatter
 * the extension does not control. Everything the headline interpolates
 * passes through here.
 */
export function sanitizeNoticeField(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, "");
}

/** `✓ worker-0 (worker) · success · acceptance accepted (verified) · 1.2 KB`. */
export function formatNoticeHeadline(details: CompletionDetails): string {
	const glyph =
		details.status === "completed"
			? "✓"
			: details.status === "stopped"
				? "■"
				: "✗";
	const label = sanitizeNoticeField(
		details.agent
			? `${details.name} (${details.agent})`
			: details.name,
	);
	const reason = details.execution.reason
		? sanitizeNoticeField(details.execution.reason)
		: "";
	const bits = [
		`${sanitizeNoticeField(details.execution.status)}${reason ? ` (${reason})` : ""}`,
	];
	if (details.acceptance) {
		const level = details.acceptance.level
			? ` (${sanitizeNoticeField(details.acceptance.level)})`
			: "";
		bits.push(
			`acceptance ${sanitizeNoticeField(details.acceptance.status)}${level}`,
		);
	}
	bits.push(formatSize(details.outputBytes));
	return `${glyph} ${label} · ${bits.join(" · ")}`;
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
 */
export function completionStatusOf(
	executionStatus: string,
	acceptanceStatus?: string,
): CompletionStatus {
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
	const label = input.agent ? `${input.name} (${input.agent})` : input.name;
	const reason = input.execution.reason
		? ` (${input.execution.reason})`
		: "";
	const acceptance = input.acceptance
		? `acceptance: ${input.acceptance.status}${input.acceptance.level ? ` (${input.acceptance.level})` : ""}`
		: undefined;
	const preview = previewOutput(input.output);
	const content = [
		`Background task ${status}: **${label}**`,
		"",
		`execution: ${input.execution.status}${reason}`,
		acceptance,
		"",
		preview,
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
		display: true,
		status,
		details: {
			status,
			name: input.name,
			agent: input.agent,
			execution: {
				status: input.execution.status,
				reason: input.execution.reason,
			},
			acceptance: input.acceptance
				? {
						status: input.acceptance.status,
						level: input.acceptance.level,
					}
				: undefined,
			sessionFile: input.sessionFile,
			outputBytes: Buffer.byteLength(preview),
			recycled: input.recycled,
		},
	};
}

export function formatCollectFailure(name: string, error: unknown): CompletionNotice {
	return formatCompletionNotice({
		name,
		execution: { status: "failed", reason: String(error) },
		output: String(error),
		recycled: false,
	});
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
			details?: unknown;
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
				details: notice.details,
			},
			completionDeliveryOptions(triggerTurn),
		);
		return true;
	} catch {
		return false;
	}
}
