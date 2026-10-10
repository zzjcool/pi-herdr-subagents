/**
 * Extra prompt context injected by settings: `subagents.parentContext` and
 * `subagents.childContext`.
 *
 * Both keys accept either inline markdown or a file reference in pi's own
 * `@path` form. This exists so machine-specific operating discipline (parallel
 * dispatch policy, worker guardrails, …) can live in the plugin's settings
 * chain instead of polluting the user's global AGENTS.md — which is read by
 * every pi session, subagent or not.
 *
 * Relative paths resolve against the settings file that declared them, so a
 * project `.pi/settings.json` and the user file can point at nearby files
 * without surprising each other. A missing referenced file is a loud error:
 * silent context loss would look like the agent misbehaving.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedContext {
	/** Final markdown text, or undefined when nothing is configured. */
	text: string | undefined;
}

/** A value is a file reference when it starts with `@`. */
export function isFileReference(value: string): boolean {
	return value.trimStart().startsWith("@");
}

/** Expand a leading `~` or `~/` against the real home directory. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Best-effort read of an implicit convention file. Unlike an explicit `@path`
 * reference, a missing, unreadable, or blank convention file simply means no
 * context was supplied.
 */
export function readConventionContext(
	baseDir: string,
	filename: string,
): string | undefined {
	try {
		const text = fs.readFileSync(path.join(baseDir, filename), "utf-8").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve one settings value into final context text.
 *
 * `baseDir` is the directory of the settings file that declared the key; it
 * anchors relative `@path` references. Throws on an unreadable referenced file
 * so the misconfiguration surfaces in the parent's tool call, not as a child
 * that silently runs without its guardrails.
 */
export function resolveContextValue(
	value: string,
	field: string,
	baseDir: string,
): string {
	const trimmed = value.trim();
	if (!trimmed) return "";

	if (!isFileReference(trimmed)) return trimmed;

	const ref = expandHome(trimmed.slice(1).trim());
	const file = path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		throw new Error(
			`Subagent settings '${field}' references '${ref}' ` +
				`(resolved: '${file}') which cannot be read: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const body = text.trim();
	if (!body) {
		throw new Error(
			`Subagent settings '${field}' references '${ref}' which is empty.`,
		);
	}
	return body;
}

/** Parse the raw settings value (string | array) for one context key. */
export function parseContextSetting(
	value: unknown,
	field: string,
	baseDir: string,
): string | undefined {
	if (value === undefined) return undefined;
	const parts: string[] = [];
	const collect = (entry: unknown, index: number): void => {
		if (typeof entry !== "string" || !entry.trim()) {
			throw new Error(
				`Subagent settings have invalid '${field}' entry ${index}; ` +
					`expected a non-empty string.`,
			);
		}
		parts.push(resolveContextValue(entry, field, baseDir));
	};
	if (Array.isArray(value)) {
		value.forEach(collect);
	} else {
		collect(value, 0);
	}
	const joined = parts.filter(Boolean).join("\n\n").trim();
	return joined || undefined;
}
