import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	cursorModel,
	isPiShapedModel,
	nativeModelFor,
	planKindStart,
} from "../../src/runs/kind.ts";
import { applyThinkingSuffix } from "../../src/runs/args.ts";
import { assertKindModelCoherent } from "../../src/agents/presets.ts";
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

// grok-4.7 dropped the `cursor-` prefix AND switched its SDK effort param to
// `reasoning_effort`, adding a `context` (256k|500k) variant param — measured
// against `cursor-agent --list-models` + Cursor.models.list() 2026-09-27.

test("cursorModel maps bare grok onto version-correct CLI slugs", () => {
	// 4.6 keeps the legacy prefix; 4.7+ lost it.
	assert.equal(cursorModel("grok-4.7"), "grok-4.7-high");
	assert.equal(cursorModel("grok-4.7", "xhigh"), "grok-4.7-xhigh");
	assert.equal(cursorModel("grok-4.10", "low"), "grok-4.10-low");
});

test("cursorModel repairs a wrongly-prefixed grok-4.7 slug", () => {
	// Pre-fix mapping emitted `cursor-grok-4.7-xhigh`, which the CLI rejects.
	assert.equal(cursorModel("cursor-grok-4.7-xhigh"), "grok-4.7-xhigh");
	assert.equal(
		cursorModel("cursor-grok-4.7-xhigh", "low"),
		"grok-4.7-low",
	);
	assert.equal(cursorModel("cursor-grok-4.6-xhigh"), "cursor-grok-4.6-xhigh");
	assert.equal(cursorModel("grok-4.7-xhigh-fast"), "grok-4.7-xhigh-fast");
});

test("cursorModel expands pi-cursor-sdk context aliases to the bracket form", () => {
	// `grok-4.7@500k` (settings preset) — the bug that crashed advisor.
	assert.equal(
		cursorModel("grok-4.7@500k", "xhigh"),
		"grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]",
	);
	// Full pi-cursor-sdk id with provider prefix and embedded :level; the
	// suffix wins over the `thinking` arg, mirroring pi's applyThinkingSuffix.
	assert.equal(
		cursorModel("cursor/grok-4.7@500k:xhigh", "low"),
		"grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]",
	);
	// No thinking at all → effort defaults to high, never omitted: the CLI
	// rejects a partial bracket (measured).
	assert.equal(
		cursorModel("grok-4.7@500k"),
		"grok-4.7[context=500k,reasoning_effort=high,fast=false]",
	);
	// 256k context variant, pi thinking → cursor effort mapping.
	assert.equal(
		cursorModel("grok-4.7@256k", "max"),
		"grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]",
	);
	// 1M spelling normalization.
	assert.equal(
		cursorModel("grok-4.7@1m"),
		"grok-4.7[context=1m,reasoning_effort=high,fast=false]",
	);
	// A non-grok @alias has no verified schema to expand to: undefined, so an
	// explicit choice is refused up front instead of crashing the child.
	assert.equal(cursorModel("cursor/claude-opus-4-8@300k"), undefined);
	assert.equal(cursorModel("model@500k"), undefined);
	// grok-4.6 has no context variants; future grok schemas are unverified.
	assert.equal(cursorModel("grok-4.6@500k"), undefined);
	assert.equal(cursorModel("grok-5.0@500k"), undefined);
});

test("cursorModel maps thinking=false to the lowest effort in every branch", () => {
	assert.equal(
		cursorModel("grok-4.7@500k", false),
		"grok-4.7[context=500k,reasoning_effort=low,fast=false]",
	);
	assert.equal(cursorModel("grok-4.6", false), "cursor-grok-4.6-low");
	assert.equal(
		cursorModel("cursor-grok-4.6-xhigh-fast", false),
		"cursor-grok-4.6-low-fast",
	);
});

test("cursorModel passes an unknown :level-suffixed slug through unchanged", () => {
	// Not ours to rewrite — the suffix must not be silently dropped.
	assert.equal(cursorModel("composer-1.5:high"), "composer-1.5:high");
});

test("cursorModel leaves explicit bracket forms untouched", () => {
	const bracket = "grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]";
	assert.equal(cursorModel(bracket, "low"), bracket);
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

// The coherence guard (src/agents/presets.ts) leans on these predicates; the
// direct coverage lives here, next to the code they exercise.

test("isPiShapedModel accepts provider/id(:level) and rejects CLIs' bare slugs", () => {
	assert.equal(isPiShapedModel("cb/kimi-k3"), true);
	assert.equal(isPiShapedModel("cb/glm-5.3:high"), true);
	assert.equal(isPiShapedModel("grok-4.6"), false);
	assert.equal(isPiShapedModel("auto-smart[optimize_for=balanced]"), false);
});

test("applyThinkingSuffix appends :level for pi and drops it for false", () => {
	assert.equal(applyThinkingSuffix("cb/kimi-k3", "high"), "cb/kimi-k3:high");
	assert.equal(applyThinkingSuffix("cb/kimi-k3", false), "cb/kimi-k3");
	assert.equal(applyThinkingSuffix("cb/kimi-k3", undefined), "cb/kimi-k3");
	assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
});

test("kind/model coherence guard: cursor + pi-shaped model throws, pi accepts", () => {
	// This is the silent-drop the presets feature must never allow:
	// nativeModelFor("cursor", "cb/kimi-k3") === undefined, so the launch
	// would otherwise start on the CLI default while the preset claims a model.
	assert.equal(nativeModelFor("cursor", "cb/kimi-k3"), undefined);
	assert.throws(
		() => assertKindModelCoherent("cursor", "cb/kimi-k3", "strong"),
		/Preset 'strong'/,
	);
	assert.doesNotThrow(() =>
		assertKindModelCoherent("pi", "cb/kimi-k3", "strong"),
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
