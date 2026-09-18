import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parsePresets,
	requirePreset,
	assertKindModelCoherent,
	applyPreset,
	resolvePresetName,
} from "../../src/agents/presets.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
		description: "d",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "p",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

// ─────────────────────────── parsePresets ───────────────────────────

test("presets: absent key yields undefined, not an error", () => {
	assert.equal(parsePresets(undefined, { filePath: "/s.json" }), undefined);
});

test("presets: rejects a non-object presets value", () => {
	for (const value of ["x", 42, true, [], null]) {
		assert.throws(
			() => parsePresets(value, { filePath: "/s.json" }),
			/presets/,
			`presets = ${JSON.stringify(value)} must be rejected`,
		);
	}
});

test("presets: rejects a non-object preset entry", () => {
	assert.throws(
		() => parsePresets({ cheap: "cb/flash" }, { filePath: "/s.json" }),
		/presets\.cheap/,
	);
});

test("presets: rejects an unknown kind", () => {
	assert.throws(
		() =>
			parsePresets(
				{ cheap: { kind: "not-a-kind", model: "cb/flash" } },
				{ filePath: "/s.json" },
			),
		/presets\.cheap\.kind/,
	);
});

test("presets: rejects an empty model and a non-string thinking", () => {
	assert.throws(
		() =>
			parsePresets({ cheap: { model: "  " } }, { filePath: "/s.json" }),
		/presets\.cheap\.model/,
	);
	assert.throws(
		() =>
			parsePresets({ cheap: { thinking: 3 } }, { filePath: "/s.json" }),
		/presets\.cheap\.thinking/,
	);
});

test("presets: accepts a full and a partial preset; thinking: false is kept", () => {
	const out = parsePresets(
		{
			strong: { kind: "pi", model: "cb/kimi-k3", thinking: "high" },
			cursor: { kind: "cursor", model: "grok-4.6" },
			quiet: { thinking: false },
		},
		{ filePath: "/s.json" },
	);
	assert.deepEqual(out, {
		strong: { kind: "pi", model: "cb/kimi-k3", thinking: "high" },
		cursor: { kind: "cursor", model: "grok-4.6" },
		quiet: { thinking: false },
	});
});

// ─────────────────────────── resolvePresetName ───────────────────────────

test("presets: tool param wins over the agent's own preset", () => {
	const r = resolvePresetName({
		toolPreset: "strong",
		agent: agent({ preset: "cheap" }),
	});
	assert.equal(r, "strong");
});

test("presets: falls back to the agent's preset; absent means undefined", () => {
	assert.equal(resolvePresetName({ agent: agent({ preset: "cheap" }) }), "cheap");
	assert.equal(resolvePresetName({ agent: agent() }), undefined);
});

test("presets: a blank tool param is ignored, not treated as a name", () => {
	assert.equal(
		resolvePresetName({ toolPreset: "   ", agent: agent({ preset: "cheap" }) }),
		"cheap",
	);
});

// ─────────────────────────── requirePreset ───────────────────────────

test("presets: requirePreset returns the entry when defined", () => {
	const presets = { cheap: { model: "cb/flash" } };
	assert.equal(requirePreset("cheap", presets), presets.cheap);
});

test("presets: requirePreset error names the defined presets", () => {
	assert.throws(
		() =>
			requirePreset("cheap", {
				strong: { model: "cb/kimi-k3" },
				medium: { model: "cb/glm" },
			}),
		/Preset 'cheap' is not defined in subagents\.presets\. Defined: strong, medium\./,
	);
});

test("presets: requirePreset says 'None are defined' for an empty/absent map", () => {
	assert.throws(
		() => requirePreset("cheap", undefined),
		/Preset 'cheap' is not defined in subagents\.presets\. None are defined\./,
	);
	assert.throws(
		() => requirePreset("cheap", {}),
		/None are defined\./,
	);
});

// ─────────────────────────── assertKindModelCoherent ───────────────────────────

test("presets: coherence guard rejects a pi-shaped model on cursor", () => {
	// nativeModelFor("cursor", "cb/kimi-k3") is undefined — the model would be
	// silently dropped at start, so the guard must throw first.
	assert.throws(
		() => assertKindModelCoherent("cursor", "cb/kimi-k3", "strong"),
		/Preset 'strong' selects kind 'cursor', but the resolved model 'cb\/kimi-k3'/,
	);
});

test("presets: coherence guard accepts a pi-shaped model on pi", () => {
	assert.doesNotThrow(() =>
		assertKindModelCoherent("pi", "cb/kimi-k3", "strong"),
	);
});

test("presets: coherence guard accepts a cursor slug on cursor and no model", () => {
	assert.doesNotThrow(() =>
		assertKindModelCoherent("cursor", "grok-4.6", "cur"),
	);
	assert.doesNotThrow(() =>
		assertKindModelCoherent("pi", undefined, "quiet"),
	);
});

test("presets: the guard reports where the model came from", () => {
	// The preset may not be the source of the model at all: a tool `model`,
	// `defaultModel` or the dispatch model can supply it. The message must not
	// claim the preset set a model it never mentioned.
	assert.throws(
		() =>
			assertKindModelCoherent(
				"cursor",
				"cb/kimi-k3",
				"visual",
				"subagents.defaultModel",
			),
		/from subagents\.defaultModel/,
	);
	// Omitting the origin keeps the message valid without inventing a source.
	assert.throws(
		() => assertKindModelCoherent("cursor", "cb/kimi-k3", "visual"),
		/Preset 'visual' selects kind 'cursor'/,
	);
});

// ─────────────────────────── applyPreset ───────────────────────────

test("presets: applyPreset replaces kind/model/thinking atomically", () => {
	const out = applyPreset(agent({ kind: "pi", model: "old" }), "cur", {
		kind: "cursor",
		model: "grok-4.6",
		thinking: "high",
	});
	assert.equal(out.kind, "cursor");
	assert.equal(out.model, "grok-4.6");
	assert.equal(out.thinking, "high");
	assert.equal(out.preset, "cur");
});

test("presets: applyPreset records provenance and copies the agent", () => {
	const original = agent({ model: "front" });
	const out = applyPreset(original, "strong", { model: "cb/kimi-k3" });
	assert.equal(out.model, "cb/kimi-k3");
	assert.deepEqual(out.modelSource, { type: "preset", model: "cb/kimi-k3" });
	// A copy: the caller's agent object must not be mutated.
	assert.equal(original.model, "front");
	assert.equal(original.modelSource, undefined);
});

test("presets: applyPreset keeps untouched fields; thinking: false disables", () => {
	const out = applyPreset(
		agent({ kind: "pi", model: "keep", thinking: "low" }),
		"quiet",
		{ thinking: false },
	);
	assert.equal(out.kind, "pi");
	assert.equal(out.model, "keep");
	assert.equal(out.thinking, false);
	// No model in the preset => no provenance claim.
	assert.equal(out.modelSource, undefined);
});
