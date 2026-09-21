/**
 * Structured collection for cursor-kind children.
 *
 * cursor-agent persists every chat under `~/.cursor/chats/<projectHash>/<chatId>/`
 * as a SQLite store (`store.db`, WAL mode) whose `blobs(id, data)` rows hold the
 * conversation: user and assistant messages as JSON, tool traffic as protobuf
 * blobs. herdr reports the chat id as `agent_session.value` (`source:
 * "herdr:cursor"`), so locating the store is deterministic — no screen scraping.
 * Why this beats reading the pane (measured 2026-09-20, v2026.09.18-9a7762b):
 *   - the assistant reply is stored verbatim — the TUI word-wraps long lines,
 *     which corrupted streamed verdict JSON enough to break JSON.parse;
 *   - a message is written atomically on turn completion: across every live
 *     chat, the last row is a complete assistant message, never a half-stream.
 *     "last message is assistant with text" IS the turn-settled signal;
 *   - F7's "non-pi kinds can only report unknown" no longer holds: the store
 *     carries the reply, so outcome/verdict derivation can use it directly.
 *
 * Schema notes (`meta.json` sits beside `store.db`):
 *   {"schemaVersion": 1, "cwd": "...", "title": "...", "createdAtMs": ...}
 * `schemaVersion` is checked on read; a bump means the shape below changed and
 * the parser should refuse rather than mis-parse.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ParsedSession, TurnRecord } from "./types.ts";
import { emptyParsedSession } from "./session.ts";

/** The only schemaVersion observed in the wild so far. */
const SUPPORTED_SCHEMA_VERSION = 1;

interface ChatMessage {
	role: "user" | "assistant";
	content: unknown;
}

/**
 * Locate the chat directory for a herdr cursor session id.
 *
 * The id is the directory name; the project hash parent is found by scanning
 * `~/.cursor/chats/<project>/<id>/` and matching `meta.json`'s `cwd` when the
 * child's cwd is known (a worktree child must not bind to the parent
 * checkout's chat).
 */
export function findCursorChatDir(
	chatId: string,
	opts: { cwd?: string; chatsRoot?: string } = {},
): string | null {
	if (!chatId) return null;
	const root = opts.chatsRoot ?? path.join(os.homedir(), ".cursor", "chats");
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return null;
	}
	const candidates: string[] = [];
	for (const project of entries) {
		const dir = path.join(root, project, chatId);
		if (fs.existsSync(dir)) candidates.push(dir);
	}
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0] ?? null;
	// Several projects share the id (cursor reused it): prefer the one whose
	// meta cwd matches the child's, else the newest.
	if (opts.cwd) {
		for (const dir of candidates) {
			const meta = readMeta(path.join(dir, "meta.json"));
			if (meta?.cwd && sameDir(meta.cwd, opts.cwd)) return dir;
		}
	}
	return candidates.sort(
		(a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
	)[0] ?? null;
}

function sameDir(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b);
}

function readMeta(file: string): {
	schemaVersion?: number;
	cwd?: string;
	title?: string;
} | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Parse a cursor chat store into the same `ParsedSession` shape the pi jsonl
 * parser produces, so `collect()`'s main verdict/acceptance path applies
 * unchanged.
 *
 * Empty session (unreadable/unsupported/turn not started) → `turns: []`, which
 * the caller treats as "keep waiting", never as failure.
 */
export function parseCursorChat(chatDir: string): ParsedSession {
	const dbPath = path.join(chatDir, "store.db");
	if (!fs.existsSync(dbPath)) return emptyParsedSession();

	const meta = readMeta(path.join(chatDir, "meta.json"));
	if (
		meta?.schemaVersion !== undefined &&
		meta.schemaVersion !== SUPPORTED_SCHEMA_VERSION
	) {
		// Unknown future schema: refuse rather than mis-parse.
		return emptyParsedSession();
	}

	const messages = readMessages(dbPath);
	if (messages.length === 0) return emptyParsedSession();
	return sessionFromMessages(messages);
}

/** Open the store read-only and pull the ordered user/assistant messages. */
function readMessages(dbPath: string): ChatMessage[] {
	// readOnly keeps the child's WAL untouched; a missing db is an empty turn.
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return [];
	}
	try {
		const out: ChatMessage[] = [];
		for (const row of db
			.prepare("SELECT data FROM blobs ORDER BY rowid")
			.iterate() as IterableIterator<{ data: unknown }>) {
			const msg = parseMessageBlob(row.data);
			if (msg) out.push(msg);
		}
		return out;
	} catch {
		return [];
	} finally {
		db.close();
	}
}

function parseMessageBlob(data: unknown): ChatMessage | null {
	if (typeof data !== "string" && !(data instanceof Uint8Array)) return null;
	const text =
		typeof data === "string" ? data : new TextDecoder().decode(data);
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const role = (parsed as { role?: unknown }).role;
	if (role !== "user" && role !== "assistant") return null;
	return { role, content: (parsed as { content?: unknown }).content };
}

function sessionFromMessages(messages: ChatMessage[]): ParsedSession {
	const turns: TurnRecord[] = [];
	let current: TurnRecord | null = null;
	for (const msg of messages) {
		if (msg.role === "user") {
			// A user message starts a new turn. Skip injected non-task rows
			// (cursor prepends <user_info>/<environment_context> payloads).
			const text = textOf(msg.content);
			if (turns.length === 0 && isInjectedUserRow(text)) continue;
			const turn: TurnRecord = {
				userText: text ?? "",
				assistants: [],
				toolResults: 0,
				toolErrors: 0,
			};
			turns.push(turn);
			current = turn;
			continue;
		}
		// Assistant message: attach to the current turn, or an implicit turn
		// when cursor wrote a reply without a task user row in the store.
		if (!current) {
			const turn: TurnRecord = {
				userText: "",
				assistants: [],
				toolResults: 0,
				toolErrors: 0,
			};
			turns.push(turn);
			current = turn;
		}
		current.assistants.push({
			stopReason: "stop",
			text: textOf(msg.content),
			errorMessage: null,
			tools: [],
		});
	}
	const last = turns.at(-1);
	return {
		...emptyParsedSession(),
		turns,
		output: last?.assistants.at(-1)?.text ?? "",
		lastTurnOutput: last?.assistants.at(-1)?.text ?? null,
		model: null,
	};
}

function textOf(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const texts: string[] = [];
	for (const blk of content) {
		if (
			typeof blk === "object" &&
			blk !== null &&
			(blk as { type?: unknown }).type === "text"
		) {
			const t = (blk as { text?: unknown }).text;
			if (typeof t === "string") texts.push(t);
		}
	}
	return texts.length > 0 ? texts.join("\n\n") : null;
}

/**
 * Injected context rows cursor writes before the task. They carry no user
 * text and must not open a phantom turn.
 */
function isInjectedUserRow(text: string | null): boolean {
	if (!text) return true;
	return /^\s*<(?:user_info|environment_context|timestamp)\b/.test(text);
}

/**
 * The turn-settled signal: the store's last message is an assistant reply with
 * text. Measured across every live chat: rows are written atomically on turn
 * completion, so a half-streamed answer never appears as a final row.
 */
export function cursorTurnSettled(parsed: ParsedSession): boolean {
	const last = parsed.turns.at(-1);
	if (!last || last.assistants.length === 0) return false;
	return Boolean(last.assistants.at(-1)?.text);
}
