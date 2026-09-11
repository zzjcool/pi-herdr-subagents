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

/** Escape RegExp specials except `*`, then translate `*` into `.*`. */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Test a resolved model against one allow pattern.
 * Both sides compare case-insensitively on the full `provider/id`.
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
	return globToRegExp(pattern).test(stripThinkingSuffix(model));
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
