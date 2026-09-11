/**
 * herdr agent-name generation.
 *
 * F17: herdr requires names matching `[a-z][a-z0-9_-]{0,31}` (lowercase,
 * no spaces, at most 32 chars). F16: names are freed on exit and reusable,
 * but `agent_name_taken` while the agent is alive.
 */

const MAX_NAME_LENGTH = 32;
const VALID_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidAgentName(name: string): boolean {
	return VALID_NAME.test(name);
}

/**
 * Build a valid, unique-ish agent name from a role and an index.
 *
 * Guarantees the result matches `[a-z][a-z0-9_-]{0,31}`:
 *  - lowercases, replaces invalid runs with `-`
 *  - strips leading non-letters (the first char must be a letter)
 *  - truncates to 32 chars, leaving room for the `-<index>` suffix
 */
export function makeName(agent: string, index: number): string {
	const suffix = `-${Math.max(0, Math.trunc(index))}`;
	const normalized = agent
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/[-_]+$/, "");

	const room = MAX_NAME_LENGTH - suffix.length;
	const base =
		(normalized || "agent").slice(0, Math.max(1, room)).replace(/[-_]+$/, "") ||
		"agent";
	const name = `${base}${suffix}`;

	// Defensive: if truncation somehow produced something invalid, fall back.
	return VALID_NAME.test(name) ? name : `agent${suffix}`;
}
