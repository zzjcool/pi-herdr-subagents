import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseContextSetting,
	resolveContextValue,
} from "../../src/agents/context.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import { buildPiArgs } from "../../src/runs/args.ts";
import { planKindStart } from "../../src/runs/kind.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "d",
		systemPrompt: "You are a worker.",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

// ── context.ts: value forms ─────────────────────────────────────────────

test("parseContextSetting passes inline markdown through", () => {
	assert.equal(
		parseContextSetting("be kind", "parentContext", "/base"),
		"be kind",
	);
});

test("parseContextSetting resolves @file references against baseDir", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-ref-"));
	try {
		writeFileSync(path.join(dir, "policy.md"), "  dispatch discipline  \n");
		assert.equal(
			parseContextSetting("@policy.md", "childContext", dir),
			"dispatch discipline",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseContextSetting expands ~ in a file reference", () => {
	// A missing home-relative file must fail resolution with the EXPANDED
	// path in the message, proving ~ was expanded rather than treated as a
	// relative segment.
	assert.throws(
		() => resolveContextValue("@~/definitely-missing-ctx.md", "childContext", "/base"),
		(e: Error) =>
			/definitely-missing-ctx\.md/.test(e.message) &&
			!e.message.includes("@~/"),
	);
});

test("parseContextSetting throws on a missing referenced file", () => {
	assert.throws(
		() => parseContextSetting("@nope.md", "parentContext", "/base"),
		/parentContext.*nope\.md.*cannot be read/,
	);
});

test("parseContextSetting throws on an empty referenced file", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-empty-"));
	try {
		writeFileSync(path.join(dir, "empty.md"), "   \n");
		assert.throws(
			() => parseContextSetting("@empty.md", "childContext", dir),
			/empty/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseContextSetting joins an array of entries", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-arr-"));
	try {
		writeFileSync(path.join(dir, "a.md"), "alpha");
		const text = parseContextSetting(
			["inline", "@a.md"],
			"childContext",
			dir,
		);
		assert.equal(text, "inline\n\nalpha");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── settings.ts: load + merge ───────────────────────────────────────────

test("settings load parentContext/childContext with @file resolution", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-settings-"));
	try {
		writeFileSync(path.join(dir, "policy.md"), "policy text");
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				subagents: {
					parentContext: "parent inline",
					childContext: "@policy.md",
				},
			}),
		);
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(dir, "settings.json"),
		});
		assert.equal(settings.parentContext, "parent inline");
		assert.equal(settings.childContext, "policy text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project settings replace user context wholesale", () => {
	const merged = resolveSubagentSettings(
		{ parentContext: "user text", childContext: "user child" },
		{ parentContext: "project text" },
	);
	assert.equal(merged.parentContext, "project text");
	assert.equal(merged.childContext, "user child");
});

// ── args.ts: pi child system prompt ─────────────────────────────────────

test("buildPiArgs appends childContext after the role prompt", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "extra discipline",
		});
		const idx = built.args.indexOf("--append-system-prompt");
		assert.ok(idx >= 0, "role mode append stays append");
		const file = built.args[idx + 1];
		assert.ok(typeof file === "string");
		const text = readFileSync(file, "utf-8");
		const roleIdx = text.indexOf("You are a worker.");
		const ctxIdx = text.indexOf("extra discipline");
		assert.ok(roleIdx >= 0 && ctxIdx > roleIdx, "context follows the role prompt");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs emits append (not replace) for a context-only replace-mode child", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-only-"));
	try {
		const built = buildPiArgs({
			agent: agent({ systemPrompt: "", systemPromptMode: "replace" }),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "ctx only",
		});
		const appendIdx = built.args.indexOf("--append-system-prompt");
		const replaceIdx = built.args.indexOf("--system-prompt");
		assert.ok(appendIdx >= 0, "context-only child must append, not replace");
		assert.equal(replaceIdx, -1);
		const file = built.args[appendIdx + 1];
		assert.ok(typeof file === "string");
		assert.match(readFileSync(file, "utf-8"), /ctx only/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs omits the system-prompt flag without prompts", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-none-"));
	try {
		const built = buildPiArgs({
			agent: agent({ systemPrompt: "" }),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		assert.equal(built.args.indexOf("--append-system-prompt"), -1);
		assert.equal(built.args.indexOf("--system-prompt"), -1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── kind.ts: non-pi prompt composition ──────────────────────────────────

test("planKindStart rides childContext in a non-pi task prompt", () => {
	const plan = planKindStart({
		agent: agent({ kind: "cursor", systemPrompt: "role prompt" }),
		task: "do the thing",
		sessionFile: "/tmp/s.jsonl",
		tempDir: "/tmp/unused",
		childContext: "cursor discipline",
	});
	const roleIdx = plan.taskText.indexOf("role prompt");
	const ctxIdx = plan.taskText.indexOf("cursor discipline");
	const taskIdx = plan.taskText.indexOf("do the thing");
	assert.ok(
		roleIdx >= 0 && ctxIdx > roleIdx && taskIdx > ctxIdx,
		"order: role < context < task",
	);
});

test("planKindStart keeps a pi task prompt free of the context", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-kind-pi-"));
	try {
		const plan = planKindStart({
			agent: agent(),
			task: "do the thing",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "pi discipline",
		});
		assert.ok(!plan.taskText.includes("pi discipline"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
