/**
 * Session jsonl parsing + execution-outcome derivation.
 *
 * This is the ONLY trustworthy source for success/failure (findings F26-F31):
 * herdr's `agent_status` reports "done" for success, LLM errors, AND kills alike.
 *
 * Authoritative stopReason enum (pi docs, session-format.md:88):
 *   "stop" | "length" | "toolUse" | "error" | "aborted"
 *
 * Measured semantics:
 *   F29 — `"aborted"` is never actually written. A graceful interrupt (esc) writes
 *         `error` + an errorMessage containing "aborted". A hard kill writes NO
 *         assistant message at all, so "missing reply" IS the abort signal.
 *   F30 — tool errors are per-turn and do NOT make a turn fail.
 *   F31 — only the LAST turn decides the outcome.
 */

import * as fs from "node:fs";
import type {
	Execution,
	ParsedSession,
	StopReason,
	TurnRecord,
	Usage,
} from "./types.ts";

const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
]);
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function emptyParsedSession(): ParsedSession {
	return {
		output: "",
		lastTurnOutput: null,
		usage: emptyUsage(),
		model: null,
		stopReason: null,
		turns: [],
		toolErrors: 0,
		lastTurnMissing: false,
		tornLines: 0,
	};
}

function asStopReason(value: unknown): StopReason | null {
	return typeof value === "string" && KNOWN_STOP_REASONS.has(value)
		? (value as StopReason)
		: null;
}

function textOf(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	let last: string | null = null;
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text"
		) {
			const t = (part as { text?: unknown }).text;
			if (typeof t === "string" && t.trim()) last = t;
		}
	}
	return last;
}

function toolsOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "toolCall"
		) {
			const n = (part as { name?: unknown }).name;
			if (typeof n === "string") out.push(n);
		}
	}
	return out;
}

function userTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (
			part &&
			typeof part === "object" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join(" ");
}

/** Accumulate token usage from an assistant message into the running total. */
function accumulateUsage(
	target: Usage,
	message: Record<string, unknown>,
): void {
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return;
	const cost = usage.cost as Record<string, unknown> | undefined;
	target.input += num(usage.input);
	target.output += num(usage.output);
	target.cacheRead += num(usage.cacheRead);
	target.cacheWrite += num(usage.cacheWrite);
	target.cost += num(cost?.total);
}

/** Find (or create) the turn an assistant/toolResult message belongs to. */
function currentTurn(parsed: ParsedSession): TurnRecord {
	const existing = parsed.turns.at(-1);
	if (existing) return existing;
	const created: TurnRecord = {
		userText: "",
		assistants: [],
		toolResults: 0,
		toolErrors: 0,
	};
	parsed.turns.push(created);
	return created;
}

function applyAssistant(
	parsed: ParsedSession,
	message: Record<string, unknown>,
): void {
	const turn = currentTurn(parsed);
	const stopReason = asStopReason(message.stopReason);
	const text = textOf(message.content);

	turn.assistants.push({
		stopReason,
		...(typeof message.stopReason === "string"
			? { rawStopReason: message.stopReason }
			: {}),
		errorMessage:
			typeof message.errorMessage === "string" ? message.errorMessage : null,
		text,
		tools: toolsOf(message.content),
	});

	accumulateUsage(parsed.usage, message);
	if (typeof message.model === "string") parsed.model = message.model;
	if (stopReason) parsed.stopReason = stopReason;
	// `output`: the last non-empty text anywhere (kept for display/back-compat).
	if (text) parsed.output = text;
}

function applyToolResult(
	parsed: ParsedSession,
	message: Record<string, unknown>,
): void {
	const turn = parsed.turns.at(-1);
	if (!turn) return;
	turn.toolResults += 1;
	if (message.isError === true) {
		turn.toolErrors += 1;
		parsed.toolErrors += 1;
	}
}

/**
 * Parse session JSONL text into a structured view.
 * Tolerates torn/partial lines (F12: a mid-turn kill leaves no corruption,
 * but a crash could still truncate the final write).
 */
export function parseSessionText(text: string): ParsedSession {
	const parsed = emptyParsedSession();
	if (!text) return parsed;

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;

		const event = decodeEvent(line);
		if (!event) {
			parsed.tornLines += 1;
			continue;
		}
		applyEvent(parsed, event);
	}

	const last = parsed.turns.at(-1);
	parsed.lastTurnMissing = Boolean(last && last.assistants.length === 0);
	// Derived from the definition rather than tracked incrementally: "the final
	// assistant message of the last turn". Tracking it as messages arrive leaves
	// an earlier turn's text in place whenever the last turn has no assistant
	// message at all (a hard kill), which is exactly the stale-verdict bug (F39).
	parsed.lastTurnOutput = last?.assistants.at(-1)?.text ?? null;
	return parsed;
}

/**
 * Decode one JSONL line into an event object.
 *
 * Returns `null` for anything that is not a plain object, which covers both a
 * syntax error and a bare scalar: `JSON.parse` happily yields `null`, `42`,
 * `true` and `"x"`, and reading `.type` off `null` would take down the whole
 * parse. The session file is external input — a pane can be closed mid-write —
 * so a damaged line must never be fatal.
 */
function decodeEvent(line: string): Record<string, unknown> | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		decoded === null ||
		typeof decoded !== "object" ||
		Array.isArray(decoded)
	) {
		return null;
	}
	return decoded as Record<string, unknown>;
}

/** Fold one decoded event into the parsed session. */
function applyEvent(
	parsed: ParsedSession,
	event: Record<string, unknown>,
): void {
	if (event.type === "model_change") {
		const model =
			typeof event.model === "string" ? event.model.trim() : "";
		if (model) parsed.model = model;
		return;
	}
	if (event.type !== "message") return;
	const message = event.message as Record<string, unknown> | undefined;
	if (!message || typeof message !== "object") return;

	switch (message.role) {
		case "user":
			parsed.turns.push({
				userText: userTextOf(message.content),
				assistants: [],
				toolResults: 0,
				toolErrors: 0,
			});
			break;
		case "assistant":
			applyAssistant(parsed, message);
			break;
		case "toolResult":
		case "tool":
			applyToolResult(parsed, message);
			break;
		default:
			break;
	}
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse a session file. A missing file yields an empty (not throwing) result. */
export function parseSessionFile(path: string): ParsedSession {
	try {
		return parseSessionText(fs.readFileSync(path, "utf-8"));
	} catch {
		return emptyParsedSession();
	}
}

/**
 * Derive the execution outcome from a parsed session.
 *
 * Order matters: "no reply to the last prompt" is checked BEFORE stopReason,
 * because a hard kill leaves the last assistant message as a stale `toolUse`.
 */
export function deriveOutcome(parsed: ParsedSession): Execution {
	const turns = parsed.turns;

	if (turns.length === 0) {
		return {
			status: "unknown",
			reason: "no messages in session",
			turns: 0,
			toolErrors: parsed.toolErrors,
		};
	}

	const last = turns.at(-1);
	if (!last) {
		return {
			status: "unknown",
			reason: "no messages in session",
			turns: 0,
			toolErrors: parsed.toolErrors,
		};
	}

	// F29: hard kill / interrupt before any reply was persisted.
	if (last.assistants.length === 0) {
		return {
			status: "aborted",
			reason: "no assistant message for the last prompt",
			turns: turns.length,
			toolErrors: parsed.toolErrors,
			lastTurn: { stopReason: null, toolErrors: last.toolErrors },
			model: parsed.model,
			usage: parsed.usage,
		};
	}

	const final = last.assistants.at(-1);
	if (!final) {
		return {
			status: "aborted",
			reason: "no assistant message for the last prompt",
			turns: turns.length,
			toolErrors: parsed.toolErrors,
		};
	}

	const base = {
		turns: turns.length,
		toolErrors: parsed.toolErrors,
		lastTurn: { stopReason: final.stopReason, toolErrors: last.toolErrors },
		model: parsed.model,
		usage: parsed.usage,
	};

	return outcomeFromFinalMessage(final, base);
}

/** Map the final assistant message's stop reason onto an execution status. */
function outcomeFromFinalMessage(
	final: {
		stopReason: StopReason | null;
		rawStopReason?: string;
		errorMessage: string | null;
	},
	base: Omit<Execution, "status" | "reason">,
): Execution {
	switch (final.stopReason) {
		case "stop":
			return { status: "success", stopReason: "stop", ...base };

		case "length":
			return { status: "truncated", stopReason: "length", ...base };

		case "error": {
			// F29: a graceful interrupt surfaces as `error` with an abort-ish message.
			const msg = final.errorMessage ?? "";
			if (/abort/i.test(msg)) {
				return {
					status: "aborted",
					stopReason: "error",
					errorMessage: msg,
					reason: msg,
					...base,
				};
			}
			return {
				status: "failed",
				stopReason: "error",
				errorMessage: msg,
				reason: msg,
				...base,
			};
		}

		case "toolUse":
			// Terminated while a tool call was outstanding.
			return {
				status: "aborted",
				stopReason: "toolUse",
				reason: "terminated during tool call",
				...base,
			};

		case "aborted":
			// F29 measured that pi does not currently write this value, but the type
			// allows it, so it must map to `aborted` rather than falling through to
			// the `failed` catch-all.
			return {
				status: "aborted",
				stopReason: "aborted",
				reason: "agent aborted the turn",
				...base,
			};

		case null:
			// Distinguish "the field was absent" (a truncated stream — treat like an
			// abort) from "the field held a value we do not recognize" (report it as
			// a failure so the unexpected value is visible rather than hidden).
			if (final.rawStopReason === undefined) {
				return {
					status: "aborted",
					stopReason: null,
					reason: "assistant message has no stopReason",
					...base,
				};
			}
			return {
				status: "failed",
				stopReason: null,
				errorMessage: final.errorMessage,
				reason: `unknown stopReason: ${final.rawStopReason}`,
				...base,
			};

		default:
			return {
				status: "failed",
				stopReason: final.stopReason,
				errorMessage: final.errorMessage,
				reason: `unknown stopReason: ${String(final.stopReason)}`,
				...base,
			};
	}
}

/**
 * Extract a machine-readable self-reported verdict from agent output (F33).
 *
 * Two conventions are recognized, in order:
 *   1. A JSON object with a boolean `ok` (bare, fenced, or embedded in prose).
 *   2. A textual report whose FIRST non-empty line starts with `FAILED:` —
 *      the convention the design's F32 example uses. This is deliberately
 *      strict (first line only) to avoid flagging a report that merely
 *      mentions failure somewhere in its body.
 */
export function extractVerdict(
	text: string,
): { ok: boolean; reason?: string } | null {
	if (!text) return null;

	const jsonVerdict = extractJsonVerdict(text);
	if (jsonVerdict) return jsonVerdict;

	return extractTextualFailure(text);
}

/**
 * Remove the launch prompt from pane text once, so a later copy of the same
 * JSON (the child's real verdict) can still be parsed.
 */
export function stripPromptEcho(output: string, prompt?: string): string {
	if (!output) return "";
	const needle = prompt?.trim();
	if (!needle) return output;
	let rest = stripOnce(output, needle);
	if (rest === output) {
		for (const fence of fencedBlocks(needle)) {
			if (extractVerdict(fence)) rest = stripOnce(rest, fence);
		}
	}
	return rest.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Whether cursor's TUI is mid-turn: the spinner, a live token counter, or the
 * `ctrl+c to stop` affordance only appear while a turn is running.
 *
 * Checked BEFORE the reply test. `paneHasLiveReply` strips `Working` as noise
 * (it sits inside the text a reply would be measured from), which means a
 * half-streamed answer counts as a finished one — and the answer gets cut off
 * and the child reported as failed.
 */
export function paneIsBusy(output: string): boolean {
	return (
		/ctrl\+c to stop/i.test(output) ||
		/\bWorking\b/i.test(output) ||
		/\d+\s+tokens?\b/i.test(output)
	);
}

/** Cursor TUI still sitting on trust / a paste preview, not a finished turn. */
export function paneLooksStuck(output: string, prompt?: string): boolean {
	// A live reply settles the question: leftover `[Pasted text #N]` chrome in
	// the scrollback must not keep the pane "stuck" after the child has answered.
	// This check comes FIRST for exactly that reason.
	if (paneHasLiveReply(stripPromptEcho(output, prompt))) return false;
	// No reply yet, but the TUI is waiting for Enter (trust dialog, or a paste
	// that was never submitted): that is the stuck shape we must nudge.
	if (paneNeedsSubmitNudge(output)) return true;
	// Mid-turn with a live spinner / token counter: working, not stuck.
	if (paneIsBusy(output)) return false;
	if (!prompt?.trim()) return false;
	return true;
}

const TRUST_PANE = /Workspace Trust Required|Do you trust/i;

/**
 * The TUI's input-box line: the LAST line opening with `→`, e.g.
 * `→ Add a follow-up` or `→ [Pasted text #1 +82 lines]`.
 */
function lastInputLine(output: string): string | undefined {
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (line !== undefined && /^\s*→/.test(line)) return line;
	}
	return undefined;
}

/**
 * Whether this pane needs an Enter to submit its collapsed paste (or to
 * confirm a trust dialog).
 *
 * The decision is STRUCTURAL, never wording-based. The placeholder inside the
 * input box ROTATES between runs (observed: `Add a follow-up`,
 * `Plan, search, build anything`, `Ask anything`), so only the `→` line's own
 * content — a still-pending `[Pasted text #N]` — decides. This also keeps a
 * `[Pasted text]` left in scrollback from re-triggering Enters after the paste
 * was accepted and the child is already answering.
 */
export function paneNeedsSubmitNudge(output: string): boolean {
	if (TRUST_PANE.test(output)) return true;
	const input = lastInputLine(output);
	// With no `→` chrome in view (other terminals / older fixtures) the paste
	// marker itself is the only available signal.
	return /\[Pasted text #\d+/i.test(input ?? output);
}

function stripOnce(haystack: string, needle: string): string {
	if (!needle) return haystack;
	const at = haystack.indexOf(needle);
	if (at < 0) return haystack;
	return haystack.slice(0, at) + haystack.slice(at + needle.length);
}

function fencedBlocks(text: string): string[] {
	return text.match(/```(?:json)?\s*\n([\s\S]*?)```/g) ?? [];
}

/**
 * Cursor's TUI chrome. It sits above the prompt and is NOT a reply: product
 * name, version, the rotating `Tip:` line, an empty `→` cursor, the
 * `Run Everything` status bar, the `~/cwd · branch` footer, and the
 * `Add a follow-up` placeholder.
 *
 * The `Tip:` wording ROTATES between runs (observed in the wild: "Tip: Try
 * Cursor Grok…", "Tip: Use /debug…", "Tip: Type ? in the prompt bar…"), so it
 * is matched by SHAPE, never by its wording. Enumerating tip strings rots the
 * moment cursor ships a new one — which is exactly how the banner was read as
 * a reply and a live child recycled ~3s after launch, before its pasted prompt
 * was ever submitted.
 */
const CURSOR_TUI_CHROME: readonly RegExp[] = [
	// Product name + version may share one line (`Cursor Agent v2026.09.18-…`),
	// so these two are substring matches — a `^…$` line anchor silently fails
	// when the TUI squeezes them together (measured on a live pane).
	/Cursor Agent\s+v\d+\.\d+\.\d+[-\w.]*/gi,
	/^\s*Cursor Agent\s*$/gim,
	/^\s*v\d+\.\d+\.\d+[-\w.]*\s*$/gim,
	/^\s*Tip: .*$/gim,
	/^\s*→.*$/gim,
	/^.*\bRun Everything\b.*$/gim,
	// The model-name status line, whether it renders ALONE (`Cursor Grok 4.6
	// Extra High` on its own row) or fused with the rest of the bar. A line is
	// chrome only when it is BOTH: (a) built purely from status glyphs — ASCII
	// letters, digits, `. % · : -` and spaces — AND (b) names a model family.
	// Replies are prose (Chinese, markdown, sentences) and never match (a), so
	// they survive even when they mention a model.
	/^[\w\s.%·:\-–—]*\b(?:Grok|Claude|GPT|Gemini|Sonnet|Opus|Haiku|DeepSeek|Kimi|GLM|Auto)\b[\w\s.%·:\-–—]*$/gim,
	// The footer, e.g. `~/code/herdr-subagents · master`. Requires the leading
	// `~`/`/` and the ` · ` separator so a real reply containing ` · ` survives.
	/^\s*~?\/[^\n·]*·\s*\S+\s*$/gim,
	/^\s*Add a follow-up\s*$/gim,
];

/** TUI chrome for every kind, stripped before deciding whether a reply exists. */
const PANE_NOISE: readonly RegExp[] = [
	/\x1b\[[0-9;]*[A-Za-z]/g,
	/\[Pasted text[^\]]*\]/gi,
	/Workspace Trust Required/gi,
	/Do you trust the contents of this directory[^\n]*/gi,
	/Do you trust[^\n]*/gi,
	/cursor-agent(?:[ \t]+\S+)*/gi,
	// The ➜ prompt line can render as `➜  <model cursor-grok-4.6-xhigh …>`;
	// after the ➜-line strip what is left is a bare `--model …` argument
	// fragment. It is launch chrome, not a reply (measured on a live pane where
	// it was the only residue keeping a never-submitted prompt "live").
	/^[<([]model\s[^\n]*$/gim,
	/^.*➜.*$/gm,
	/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g,
	/\bWorking\b/gi,
	...CURSOR_TUI_CHROME,
];

/**
 * Whether the pane already shows a real reply (as opposed to launch chrome or
 * an idle spinner). A false positive here recycles a live child mid-turn; a
 * false negative only costs one extra poll, so the bar prefers the latter.
 */
export function paneHasLiveReply(text: string): boolean {
	let cleaned = text;
	for (const pattern of PANE_NOISE) cleaned = cleaned.replace(pattern, "");
	cleaned = cleaned.trim();
	if (!cleaned) return false;
	if (extractVerdict(cleaned)) return true;
	return cleaned.replace(/\s+/g, " ").length >= 24;
}

function extractJsonVerdict(
	text: string,
): { ok: boolean; reason?: string } | null {
	const candidates: string[] = [];
	const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/g);
	if (fenced) {
		for (const block of fenced) {
			const inner = block
				.replace(/```(?:json)?\s*\n?/, "")
				.replace(/```$/, "")
				.trim();
			if (inner) candidates.push(inner);
		}
	}
	candidates.push(text.trim());

	// Also try the last balanced {...} span, so prose around the JSON still works.
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) {
		const span = text.slice(first, last + 1);
		candidates.push(span);
		// The cursor TUI word-wraps long lines, which breaks a streamed verdict
		// JSON mid-string (`…top reason:\n  arithmetic identity"}`). A newline
		// inside a JSON string literal is invalid JSON, so joining wrapped lines
		// is a safe repair: the unwrapped original is still tried first above.
		candidates.push(span.replace(/\n\s+/g, " "));
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.ok !== "boolean") continue;
		const out: { ok: boolean; reason?: string } = { ok: obj.ok };
		if (typeof obj.reason === "string") out.reason = obj.reason;
		return out;
	}
	return null;
}

/** `FAILED: ...` on the first non-empty line means the agent gave up. */
const TEXTUAL_FAILURE = /^[*_`\s]*FAILED\s*:\s*(.*)$/i;

function extractTextualFailure(
	text: string,
): { ok: boolean; reason?: string } | null {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return null;

	const match = firstLine.match(TEXTUAL_FAILURE);
	if (!match) return null;

	const reason = (match[1] ?? "").trim();
	return reason ? { ok: false, reason } : { ok: false };
}

/**
 * Whether the last turn already has a terminal assistant reply.
 *
 * Used by `collect()` to avoid waiting when the turn has already settled —
 * without this, a collect issued after completion would block for the full
 * timeout because no NEW message ever appears.
 */
export function isLastTurnComplete(parsed: ParsedSession): boolean {
	const last = parsed.turns.at(-1);
	if (!last || last.assistants.length === 0) return false;
	// A trailing `toolUse` means the agent is still mid-tool, not settled.
	return last.assistants.at(-1)?.stopReason !== "toolUse";
}

/** Count assistant messages — used to detect turn progress while polling. */
export function countAssistantMessages(parsed: ParsedSession): number {
	return parsed.turns.reduce((n, t) => n + t.assistants.length, 0);
}
