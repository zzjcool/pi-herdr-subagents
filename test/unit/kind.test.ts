import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	cursorModel,
	nativeModelFor,
	planKindStart,
} from "../../src/runs/kind.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "d",
		systemPrompt: "You are a test agent.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

test("cursorModel keeps legacy Auto distinct from Auto Balance", () => {
	assert.equal(cursorModel("auto"), "auto");
	assert.equal(cursorModel("default"), "auto");
	assert.equal(cursorModel("auto", "max"), "auto");
	assert.equal(cursorModel("auto-smart"), "auto-smart[optimize_for=balanced]");
	assert.equal(cursorModel("Auto Balance"), "auto-smart[optimize_for=balanced]");
	assert.equal(
		cursorModel("auto-smart[optimize_for=balanced]"),
		"auto-smart[optimize_for=balanced]",
	);
});

test("cursorModel maps grok-4.6 plus thinking onto the CLI slug", () => {
	assert.equal(cursorModel("grok-4.6"), "cursor-grok-4.6-high");
	assert.equal(cursorModel("grok-4.6", "medium"), "cursor-grok-4.6-medium");
	assert.equal(
		cursorModel("cursor-grok-4.6-high", "low"),
		"cursor-grok-4.6-low",
	);
	assert.equal(cursorModel("cb/glm-5.3-flash"), undefined);
});

test("nativeModelFor drops inherited pi ids for non-pi kinds", () => {
	assert.equal(
		nativeModelFor("cursor", "cb/glm-5.3-flash", "medium"),
		undefined,
	);
	assert.equal(nativeModelFor("claude", "cb/glm-5.3"), undefined);
	assert.equal(
		nativeModelFor("pi", "cb/glm-5.3", "medium"),
		"cb/glm-5.3:medium",
	);
});

test("planKindStart: every kind omits the task from start argv", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "kind-plan-"));
	try {
		const pi = planKindStart({
			agent: agent(),
			task: "do the thing",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			model: "cb/glm-5.3",
		});
		assert.equal(
			pi.args.some((a) => a.startsWith("@")),
			false,
		);
		assert.ok(pi.args.includes("--session"));
		assert.match(pi.taskText, /do the thing/);

		const cursor = planKindStart({
			agent: agent({ kind: "cursor", onBlocked: "auto-approve" }),
			task: "do the thing",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			model: "grok-4.6",
			thinking: "high",
		});
		assert.deepEqual(cursor.args, [
			"--model",
			"cursor-grok-4.6-high",
			"--trust",
			"--force",
		]);
		assert.equal(cursor.recordModel, "cursor-grok-4.6-high");
		assert.match(cursor.taskText, /You are a test agent/);
		assert.match(cursor.taskText, /do the thing/);

		const trusted = planKindStart({
			agent: agent({ kind: "cursor" }),
			task: "do the thing",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			model: "grok-4.6",
		});
		assert.deepEqual(trusted.args, ["--model", "cursor-grok-4.6-high", "--trust"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
