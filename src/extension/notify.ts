/**
 * Parent-session completion delivery.
 *
 * pi-subagents does NOT let a child prompt the parent. The extension watches
 * the child, then injects a custom message into the parent session with
 * `triggerTurn` so the parent wakes up and reads the result.
 *
 * `display` is false on success (the LLM still sees it; the transcript stays
 * quiet) and true on failure/stop, matching pi-subagents' notify.ts.
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
}

const PREVIEW_CHARS = 4_000;

export function completionStatusOf(
	executionStatus: string,
): CompletionStatus {
	if (executionStatus === "success") return "completed";
	if (executionStatus === "aborted") return "stopped";
	return "failed";
}

export function previewOutput(text: string, max = PREVIEW_CHARS): string {
	const trimmed = text.trim() || "(no output)";
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}\n…`;
}

export function formatCompletionNotice(input: CompletionInput): CompletionNotice {
	const status = completionStatusOf(input.execution.status);
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

export function formatCollectFailure(name: string, error: unknown): CompletionNotice {
	return formatCompletionNotice({
		name,
		execution: { status: "failed", reason: String(error) },
		output: String(error),
		recycled: false,
	});
}

export interface SendMessageApi {
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
		},
		options?: { triggerTurn?: boolean },
	): void;
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
			{ triggerTurn },
		);
		return true;
	} catch {
		return false;
	}
}
