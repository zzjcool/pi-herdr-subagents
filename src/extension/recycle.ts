/**
 * Helpers for the parent model calling collect/retire after auto-recycle.
 *
 * Watch already collected and closed the pane. A later tool call must not
 * wait on a dead agent or try to close the pane again.
 */

import type { TaskState } from "../shared/types.ts";

export function formatAlreadyRecycled(
	name: string,
	sessionFile: string,
): string {
	return (
		`Already recycled ${name}. This is a no-op — the pane is already closed. ` +
		`Session kept for resume: ${sessionFile}`
	);
}

/** States where collect should return the snapshot already on the child. */
export function canUseCachedCollect(state: TaskState): boolean {
	return (
		state === "retired" ||
		state === "awaiting" ||
		state === "blocked" ||
		state === "exited"
	);
}
