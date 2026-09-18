/**
 * Live progress for the parent status widget.
 *
 * Pi children expose this from session jsonl. Other herdr kinds (cursor,
 * claude, …) have no jsonl (F7), so the same shape is filled from
 * `agent get` / pane title when those fields exist.
 */

import { parseSessionFile } from "./session.ts";
import type { AgentInfo, PaneInfo, ParsedSession } from "./types.ts";

export interface LiveProgress {
	model?: string;
	thinking?: string;
	herdrStatus?: string;
	turns?: number;
	lastTools?: string[];
}

const MODEL_KEYS = [
	"model",
	"model_id",
	"modelid",
	"llm",
	"display_model",
	"displaymodel",
];
const THINKING_KEYS = ["thinking", "reasoning", "effort", "thinking_level"];
const TOOL_KEYS = ["tool", "tools", "activity", "action", "last_tool"];
const TURN_KEYS = ["turn", "turns", "step", "steps"];
const SKIP_TOKEN_KEYS = new Set([
	"input",
	"output",
	"cache",
	"cacheread",
	"cachewrite",
	"cache_read",
	"cache_write",
	"cost",
	"total",
]);

const MODEL_LIKE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;

export function progressFromSession(parsed: ParsedSession): LiveProgress {
	const lastTools = lastInflightTools(parsed);
	return {
		...(parsed.model ? { model: parsed.model } : {}),
		...(parsed.turns.length > 0 ? { turns: parsed.turns.length } : {}),
		...(lastTools.length > 0 ? { lastTools } : {}),
	};
}

export function progressFromSessionFile(path: string): LiveProgress {
	if (!path) return {};
	return progressFromSession(parseSessionFile(path));
}

export function progressFromAgentInfo(info: AgentInfo): LiveProgress {
	const labels = info.state_labels ?? {};
	const tokenFields = asStringMap(info.tokens);
	const model =
		labeled(labels, MODEL_KEYS) ??
		labeled(tokenFields, MODEL_KEYS) ??
		firstModelLike([...Object.values(labels), ...Object.values(tokenFields)]);
	const thinking =
		labeled(labels, THINKING_KEYS) ?? labeled(tokenFields, THINKING_KEYS);
	const toolRaw =
		labeled(labels, TOOL_KEYS) ?? labeled(tokenFields, TOOL_KEYS);
	const lastTools = splitTools(toolRaw);
	const turns =
		labeledNumber(labels, TURN_KEYS) ?? labeledNumber(tokenFields, TURN_KEYS);
	return {
		...(info.agent_status ? { herdrStatus: info.agent_status } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		...(turns !== undefined ? { turns } : {}),
		...(lastTools.length > 0 ? { lastTools } : {}),
	};
}

export function progressFromPaneInfo(pane: PaneInfo): LiveProgress {
	const title = pane.terminal_title_stripped?.trim();
	const model = title ? firstModelLike([title, ...title.split(/\s+/)]) : undefined;
	return {
		...(pane.agent_status ? { herdrStatus: pane.agent_status } : {}),
		...(model ? { model } : {}),
	};
}

/** Later sources win when they actually have a value. */
export function mergeProgress(...parts: Array<LiveProgress | undefined>): LiveProgress {
	const out: LiveProgress = {};
	for (const part of parts) {
		if (!part) continue;
		if (part.model) out.model = part.model;
		if (part.thinking) out.thinking = part.thinking;
		if (part.herdrStatus) out.herdrStatus = part.herdrStatus;
		if (part.turns && part.turns > 0) out.turns = part.turns;
		if (part.lastTools && part.lastTools.length > 0) out.lastTools = part.lastTools;
	}
	return out;
}

function lastInflightTools(parsed: ParsedSession): string[] {
	const last = parsed.turns.at(-1)?.assistants.at(-1);
	if (!last?.tools.length) return [];
	return unique(last.tools);
}

function asStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (SKIP_TOKEN_KEYS.has(key.toLowerCase())) continue;
		if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
		else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = String(raw);
	}
	return out;
}

function labeled(
	fields: Record<string, string>,
	keys: string[],
): string | undefined {
	const wanted = new Set(keys.map((k) => k.toLowerCase()));
	for (const [key, value] of Object.entries(fields)) {
		if (wanted.has(key.toLowerCase()) && value.trim()) return value.trim();
	}
	return undefined;
}

function labeledNumber(
	fields: Record<string, string>,
	keys: string[],
): number | undefined {
	const raw = labeled(fields, keys);
	if (!raw) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.round(n);
}

function firstModelLike(values: string[]): string | undefined {
	for (const value of values) {
		const trimmed = value.trim();
		if (MODEL_LIKE.test(trimmed)) return trimmed;
		const match = trimmed.match(
			/(?:^|\s)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?)(?:\s|$)/,
		);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

function splitTools(raw: string | undefined): string[] {
	if (!raw) return [];
	return unique(
		raw
			.split(/[,|/]+/)
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}
