/**
 * Lineage path handling (design §4.2).
 *
 * A flat array of ancestors rather than a nested object, because it is:
 *   1. serialization-friendly (fits in an env var),
 *   2. inherently cycle-proof (bounded length),
 *   3. injection-safe (ids are validated),
 *   4. per-entry salvageable (bad entries are dropped, not fatal).
 */

import * as path from "node:path";
import { MAX_NESTED_PATH_ENTRIES, type NestedPathEntry } from "./types.ts";

const MAX_NESTED_ID_LENGTH = 128;

/**
 * Reject anything that could escape a path or inject structure.
 * Blocks absolute paths and any separator / traversal sequence.
 */
export function isSafeNestedPathId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_NESTED_ID_LENGTH &&
		!path.isAbsolute(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("..")
	);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function nonEmptyString(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0
		? value.slice(0, max)
		: undefined;
}

/**
 * Sanitize an untrusted lineage path (e.g. from an env var set by a parent).
 * Invalid entries are dropped; the result is capped at MAX_NESTED_PATH_ENTRIES.
 */
export function sanitizeNestedPath(value: unknown): NestedPathEntry[] {
	if (!Array.isArray(value)) return [];
	const out: NestedPathEntry[] = [];
	for (const part of value) {
		if (out.length >= MAX_NESTED_PATH_ENTRIES) break;
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (!isSafeNestedPathId(record.runId)) continue;

		const entry: NestedPathEntry = { runId: record.runId };
		const stepIndex = finiteNumber(record.stepIndex);
		if (stepIndex !== undefined) entry.stepIndex = stepIndex;
		const agent = nonEmptyString(record.agent, 128);
		if (agent) entry.agent = agent;
		out.push(entry);
	}
	return out;
}

/** Encode a lineage path for passing through an environment variable. */
export function encodeNestedPath(entries: NestedPathEntry[]): string {
	return JSON.stringify(entries.slice(0, MAX_NESTED_PATH_ENTRIES));
}

/** Decode a lineage path from an environment variable; never throws. */
export function parseNestedPathEnv(raw: string | undefined): NestedPathEntry[] {
	if (!raw) return [];
	try {
		return sanitizeNestedPath(JSON.parse(raw));
	} catch {
		return [];
	}
}
