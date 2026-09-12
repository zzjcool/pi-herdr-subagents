/**
 * Model-scope enforcement (design §6.2).
 *
 * An allow-list of glob patterns constraining which models a subagent may use.
 * Violations are ERRORS when the model was requested explicitly (a deliberate
 * choice we can reject up front) and WARNINGS when inherited (so an existing
 * configuration keeps working).
 */

import {
	type ModelScopeConfig,
	type ModelScopeViolation,
	isThinkingLevel,
} from "../shared/types.ts";

/**
 * Strip a trailing `:thinking` suffix, returning both parts.
 * Only known levels are stripped, so `provider/model:variant` survives.
 * The level list lives in shared/types.ts so it cannot drift from the
 * argv builder's copy.
 */
export function splitThinkingSuffix(model: string): {
	baseModel: string;
	thinking?: string;
} {
	const idx = model.lastIndexOf(":");
	if (idx === -1) return { baseModel: model };
	const suffix = model.slice(idx + 1);
	if (!isThinkingLevel(suffix)) return { baseModel: model };
	return { baseModel: model.slice(0, idx), thinking: suffix };
}

export function stripThinkingSuffix(model: string): string {
	return splitThinkingSuffix(model).baseModel;
}

/**
 * Match a `*`-glob against `text`, case-insensitively, as a FULL match.
 *
 * Deliberately NOT a RegExp. Translating a glob into `.*` produces nested
 * quantifiers (`*a*a*a…b` becomes `.*a.*a.*a…b`), which backtracks
 * exponentially on a non-matching input. Since the patterns come from
 * `.pi/settings.json` — a file that travels with a cloned repository — a
 * hostile pattern would otherwise hang the host process (measured: a 100-star
 * pattern took 14.5s, doubling per added star).
 *
 * This greedy two-pointer scan never revisits a position more than once per
 * pattern literal, so it is bounded by O(text × pattern) with no exponential
 * blow-up. `*` is the only metacharacter: no `?`, no character classes.
 */
export function globMatches(text: string, pattern: string): boolean {
	let t = 0;
	let p = 0;
	// Position of the most recent `*`, and the text index it was matched at.
	let starP = -1;
	let starT = 0;

	while (t < text.length) {
		const pc = p < pattern.length ? pattern[p] : undefined;
		if (pc === "*") {
			starP = p;
			starT = t;
			p += 1;
		} else if (pc !== undefined && pc.toLowerCase() === text[t]?.toLowerCase()) {
			p += 1;
			t += 1;
		} else if (starP !== -1) {
			// Backtrack to just after the last `*` and let it absorb one more
			// character. Only the most recent star is retried, so this cannot
			// compound into exponential work.
			starT += 1;
			t = starT;
			p = starP + 1;
		} else {
			return false;
		}
	}

	// Any trailing `*`s may match the empty remainder.
	while (p < pattern.length && pattern[p] === "*") p += 1;
	return p === pattern.length;
}

/**
 * Test a resolved model against one allow pattern.
 * Both sides compare case-insensitively on the full `provider/id`.
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
	return globMatches(stripThinkingSuffix(model), pattern);
}

/**
 * Pure scope decision.
 * Returns a violation when the model is out of scope and enforcement is on.
 * Enforcement with no `allow` list is a no-op.
 */
export function checkModelScope(
	model: string | undefined,
	scope: ModelScopeConfig | undefined,
	source: "explicit" | "inherited",
): ModelScopeViolation | undefined {
	if (!model || !scope?.enforce) return undefined;
	const allow = scope.allow;
	if (!allow || allow.length === 0) return undefined;
	if (allow.some((pattern) => matchesScopePattern(model, pattern)))
		return undefined;

	const baseModel = stripThinkingSuffix(model);
	return {
		model: baseModel,
		severity: source === "explicit" ? "error" : "warn",
		allowedPatterns: [...allow],
		message:
			`Model '${baseModel}' is outside the configured subagent model scope. ` +
			`Allowed patterns: ${allow.join(", ")}.`,
	};
}

/**
 * Validate and normalize a raw `subagents.modelScope` value.
 * Throws a descriptive error for malformed configs.
 */
export function parseModelScopeConfig(
	value: unknown,
	meta: { filePath: string },
): ModelScopeConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' have invalid 'modelScope'; expected an object.`,
		);
	}
	const input = value as Record<string, unknown>;
	const out: ModelScopeConfig = { enforce: false, allow: [] };

	if ("enforce" in input) {
		if (typeof input.enforce !== "boolean") {
			throw new Error(
				`Subagent settings in '${meta.filePath}' have invalid 'modelScope.enforce'; expected a boolean.`,
			);
		}
		out.enforce = input.enforce;
	}

	if ("allow" in input) {
		const allow = input.allow;
		if (
			!Array.isArray(allow) ||
			allow.some((v) => typeof v !== "string" || !v.trim())
		) {
			throw new Error(
				`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected a non-empty string array.`,
			);
		}
		out.allow = (allow as string[]).map((v) => v.trim());
	}

	if (out.enforce && out.allow.length === 0) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' enable 'modelScope.enforce' without an 'allow' list.`,
		);
	}

	return out;
}
