/**
 * Child-process budgets: tool calls, turns, and per-bash timeouts.
 *
 * The parent injects these as env on the pane; `registerChildGuard` reads them
 * and blocks or wraps tool calls. 0 means "none allowed", not "unlimited".
 */

export const MAX_TOOL_CALLS_ENV = "PI_SUBAGENT_MAX_TOOL_CALLS";
export const MAX_TURNS_ENV = "PI_SUBAGENT_MAX_TURNS";
export const TOOL_TIMEOUT_MS_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";
export const ALLOW_NESTED_ENV = "PI_SUBAGENT_ALLOW_NESTED";

/** Parse a non-negative integer env value. Empty / garbage → undefined. */
export function parseBudgetInt(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined;
	return n;
}

export function budgetExceededReason(
	kind: "tool" | "turn",
	limit: number,
): string {
	return kind === "tool"
		? `tool budget exceeded (${limit} calls)`
		: `turn budget exceeded (${limit} turns)`;
}

/**
 * Wrap a bash command so the OS kills it after `timeoutMs`.
 *
 * Mutate `event.input.command` with this — the tool_call hook cannot otherwise
 * abort an in-flight bash. Already-wrapped commands are left alone.
 */
export function wrapBashWithTimeout(
	command: string,
	timeoutMs: number,
): string {
	if (!(timeoutMs > 0)) return command;
	if (/^\s*timeout(\s|$)/.test(command)) return command;
	const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
	return `timeout --kill-after=2s ${secs}s bash -lc ${JSON.stringify(command)}`;
}

export interface ChildBudget {
	maxToolCalls?: number;
	maxTurns?: number;
	toolTimeoutMs?: number;
}

export function childBudgetFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): ChildBudget {
	const maxToolCalls = parseBudgetInt(env[MAX_TOOL_CALLS_ENV]);
	const maxTurns = parseBudgetInt(env[MAX_TURNS_ENV]);
	const toolTimeoutMs = parseBudgetInt(env[TOOL_TIMEOUT_MS_ENV]);
	return {
		...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
	};
}
