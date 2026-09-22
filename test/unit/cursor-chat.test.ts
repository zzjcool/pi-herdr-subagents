import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	cursorTurnSettled,
	findCursorChatDir,
	parseCursorChat,
} from "../../src/shared/cursor-chat.ts";

/** Build a chat dir mirroring cursor's on-disk shape (schemaVersion 1). */
function makeChat(
	root: string,
	chatId: string,
	messages: Array<{ role: "user" | "assistant"; text: string }>,
	opts: { cwd?: string } = {},
): string {
	const dir = path.join(root, "projhash", chatId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({
			schemaVersion: 1,
			cwd: opts.cwd ?? "/repo",
			title: "test",
			createdAtMs: Date.now(),
		}),
	);
	const db = new DatabaseSync(path.join(dir, "store.db"));
	db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
	const ins = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
	let n = 0;
	for (const m of messages) {
		const content =
			m.role === "assistant"
				? [{ type: "reasoning", text: "" }, { type: "text", text: m.text }]
				: m.text;
		ins.run(`id${(n += 1)}`, JSON.stringify({ role: m.role, content }));
	}
	// A protobuf-looking binary row, as real stores carry tool traffic.
	ins.run("bin1", new Uint8Array([0x0a, 0x03, 0xff, 0xfe, 0x00]));
	db.close();
	return dir;
}

test("findCursorChatDir locates by id and prefers a matching cwd", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	const a = makeChat(root, "chat-1", [], { cwd: "/repo-a" });
	const b = makeChat(root, "chat-2", [], { cwd: "/repo-b" });
	assert.equal(findCursorChatDir("chat-1", { cwd: "/repo-a", chatsRoot: root }), a);
	assert.equal(findCursorChatDir("chat-2", { cwd: "/repo-b", chatsRoot: root }), b);
	assert.equal(findCursorChatDir("nope", { chatsRoot: root }), null);
	assert.equal(findCursorChatDir("", { chatsRoot: root }), null);
});

test("parseCursorChat skips injected rows and derives turns atomically", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	makeChat(root, "chat-1", [
		{ role: "user", text: "<user_info>\nOS: linux\n</user_info>" },
		{ role: "user", text: "Task: answer 5+5" },
		{
			role: "assistant",
			text: '等于 10。\n\n{"ok": true, "reason": "arithmetic"}',
		},
	]);
	const parsed = parseCursorChat(
		findCursorChatDir("chat-1", { chatsRoot: root })!,
	);
	assert.equal(parsed.turns.length, 1);
	assert.equal(parsed.turns[0]?.userText, "Task: answer 5+5");
	assert.match(parsed.lastTurnOutput ?? "", /等于 10/);
	assert.equal(cursorTurnSettled(parsed), true);
});

test("parseCursorChat reports an unanswered turn as unsettled", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	makeChat(root, "chat-1", [{ role: "user", text: "Task: answer" }]);
	const parsed = parseCursorChat(
		findCursorChatDir("chat-1", { chatsRoot: root })!,
	);
	// A lone user row opens the turn but never settles it: no assistant
	// answer → the caller keeps waiting. (Same shape as pi's jsonl: a turn
	// with zero assistants is `isLastTurnComplete === false`.)
	assert.equal(parsed.turns.length, 1);
	assert.equal(parsed.turns[0]?.assistants.length, 0);
	assert.equal(cursorTurnSettled(parsed), false);
});

test("parseCursorChat refuses a future schemaVersion", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	const dir = makeChat(root, "chat-1", [
		{ role: "user", text: "hi" },
		{ role: "assistant", text: "hello" },
	]);
	const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"));
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({ ...meta, schemaVersion: 99 }),
	);
	const parsed = parseCursorChat(dir);
	assert.equal(parsed.turns.length, 0);
});

test("parseCursorChat on a missing store is an empty session", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	const dir = path.join(root, "projhash", "chat-empty");
	fs.mkdirSync(dir, { recursive: true });
	const parsed = parseCursorChat(dir);
	assert.equal(parsed.turns.length, 0);
});

test("parseCursorChat on an unopenable store is an empty session", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
	const dir = path.join(root, "projhash", "chat-corrupt");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({ schemaVersion: 1, cwd: "/repo", title: "t" }),
	);
	// A db file that exists but is not SQLite: opening must fail soft, not throw.
	fs.writeFileSync(path.join(dir, "store.db"), "definitely not a sqlite file");
	const parsed = parseCursorChat(dir);
	assert.equal(parsed.turns.length, 0);
});

test("parseCursorChat on a zero-byte store is an empty session", () => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), "chats-"));
const dir = path.join(root, "projhash", "chat-zero");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
	path.join(dir, "meta.json"),
	JSON.stringify({ schemaVersion: 1, cwd: "/repo", title: "t" }),
);
// SQLite opens a 0-byte file as an empty db; the missing `blobs` table
// then fails at prepare() — must fail soft, never throw.
fs.writeFileSync(path.join(dir, "store.db"), "");
const parsed = parseCursorChat(dir);
assert.equal(parsed.turns.length, 0);
});

test("regression: no source file may statically import node:sqlite or bun:sqlite", () => {
// pi ships as a Bun-compiled binary. Bun lacks `node:sqlite`, and a STATIC
// import fails at module-resolution time — the whole extension dies on load
// even when no cursor child ever runs. SQLite must be required lazily at
// call time and branched per runtime (bun:sqlite vs node:sqlite). Guard
// EVERY shipped source file, not just cursor-chat.ts: moving the read into
// a new module with a static import would otherwise slip through.
const pkgRoot = path.resolve(import.meta.dirname, "../..");
const walkTs = (dir: string): string[] => {
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
const p = path.join(dir, ent.name);
if (ent.isDirectory()) out.push(...walkTs(p));
else if (ent.name.endsWith(".ts")) out.push(p);
	}
	return out;
};
const files = [path.join(pkgRoot, "index.ts"), ...walkTs(path.join(pkgRoot, "src"))];
assert.ok(files.length > 1, "sanity: source walk found files");
for (const file of files) {
	const src = fs.readFileSync(file, "utf-8");
	assert.doesNotMatch(
src,
/^\s*import[^;\n]*from\s*["'](node:sqlite|bun:sqlite)["']/m,
`${file}: sqlite must be loaded lazily (require at call time), never via a static import`,
	);
}
});
