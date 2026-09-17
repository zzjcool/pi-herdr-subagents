/**
 * Parent-side handling when a child is waiting on a tool approval.
 *
 * Design §5.3: `blocked` is not a terminal state. Recycle must not run.
 * `onBlocked: forward` asks the parent TUI to confirm instead of waiting
 * for the parent model to invent a `steer`.
 */

import type { OnBlockedPolicy } from "../shared/types.ts";

export type BlockedDecision = "approved" | "rejected" | "notified";
export type BlockedFollowUp = "resume" | "hold";

export function formatBlockedPrompt(name: string, reason?: string): string {
	const detail = reason ? ` (${reason})` : "";
	return `Subagent ${name} is blocked on a tool approval${detail}. Approve the pending request?`;
}

export function followUpFor(decision: BlockedDecision): BlockedFollowUp {
	return decision === "notified" ? "hold" : "resume";
}

export async function applyOnBlockedPolicy(input: {
	policy: OnBlockedPolicy;
	name: string;
	reason?: string;
	confirm?: (message: string) => Promise<boolean>;
	approve: () => Promise<void>;
	reject: () => Promise<void>;
	notify: (message: string) => void;
}): Promise<BlockedDecision> {
	const prompt = formatBlockedPrompt(input.name, input.reason);
	if (input.policy === "auto-approve") {
		await input.approve();
		return "approved";
	}
	if (input.policy === "notify") {
		input.notify(prompt);
		return "notified";
	}
	if (input.confirm) {
		const yes = await input.confirm(prompt);
		if (yes) {
			await input.approve();
			return "approved";
		}
		await input.reject();
		return "rejected";
	}
	input.notify(prompt);
	return "notified";
}
