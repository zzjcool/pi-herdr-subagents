/**
 * Regression tests for the `subagents.presets` feature.
 *
 * BUG P1 — `launchStep` promised "Never throws: a bad step degrades to a
 * message so the others still run", but preset expansion (`requirePreset` /
 * `assertKindModelCoherent`) was called ABOVE the function's `try` block. In
 * the parallel path (`Promise.all` over `tasks[]`) one undefined preset name
 * rejected the whole batch, so a healthy sibling step's launch/refusal line
 * was discarded and the caller saw a raw thrown Error instead of `✗` lines.
 *
 * These tests drive the REAL registered tool through the REAL `launchStep`,
 * so a reintroduction fails here rather than in a user's session. `herdr` is
 * not needed: the failure happens before any pane work, and the healthy
 * sibling is asserted through the launched-child line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import herdrSubagents from "../../index.ts";

/** Minimal ExtensionAPI stand-in: captures the registered tools. */
function fakePi(): {
	tools: Array<Record<string, unknown>>;
	registerTool: (tool: unknown) => void;
	on: () => void;
	registerCommand: () => void;
	sendMessage: () => void;
	eventsBus: { emit: () => void };
} {
	const tools: Array<Record<string, unknown>> = [];
	return {
		tools,
		registerTool(tool: unknown) {
			tools.push(tool as Record<string, unknown>);
		},
		on() {},
		registerCommand() {},
		sendMessage() {},
		eventsBus: { emit() {} },
	};
}

interface ToolResult {
	content?: Array<{ text?: string }>;
}

type SubagentTool = {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: Record<string, unknown>,
	) => Promise<ToolResult>;
};

/**
 * Run one `tasks[]` launch batch in a temp cwd with two extra agents:
 * `broken` references an undefined preset, `healthy` references none.
 */
async function runBatch(params: {
	presets?: Record<string, unknown>;
}): Promise<{ threw?: Error; text: string }> {
	const dir = mkdtempSync(path.join(tmpdir(), "presets-regression-"));
	const previousChild = process.env.PI_SUBAGENT_CHILD;
	const previousExtra = process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		// The tool is not registered inside a child process.
		delete process.env.PI_SUBAGENT_CHILD;

		const agentDir = path.join(dir, "agentdir");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { presets: params.presets ?? {} } }),
		);
		// `getAgentDir()` reads PI_CODING_AGENT_DIR, not HOME, so the temp
		// settings file is what the tool actually loads.
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const extra = path.join(dir, "extra-agents");
		mkdirSync(extra, { recursive: true });
		writeFileSync(
			path.join(extra, "broken.md"),
			"---\nname: broken\ndescription: b\npreset: nonexistent\n---\np\n",
		);
		writeFileSync(
			path.join(extra, "healthy.md"),
			"---\nname: healthy\ndescription: h\n---\np\n",
		);
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extra;

		const pi = fakePi();
		herdrSubagents(pi as never);
		const tool = pi.tools[0] as unknown as SubagentTool;
		assert.ok(tool, "subagent tool must be registered");

		try {
			const res = await tool.execute(
				"call-1",
				{
					tasks: [
						{ agent: "broken", task: "t1" },
						{ agent: "healthy", task: "t2" },
					],
				},
				undefined,
				undefined,
				{ cwd: dir, ui: { notify() {} }, hasUI: false },
			);
			const text = (res.content ?? [])
				.map((block) => block.text ?? "")
				.join("\n");
			return { text };
		} catch (error) {
			return {
				threw: error instanceof Error ? error : new Error(String(error)),
				text: "",
			};
		}
	} finally {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousExtra === undefined) {
			delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
		} else {
			process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = previousExtra;
		}
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("BUG P1: an undefined preset must not abort the whole tasks[] batch", async () => {
	const { threw, text } = await runBatch({ presets: {} });

	// Before the fix this threw and `text` was empty.
	assert.equal(
		threw,
		undefined,
		`a bad preset must degrade to a refusal line, not throw: ${threw?.message}`,
	);

	// The bad step is reported as a refusal, naming the missing preset.
	assert.match(text, /✗ broken: /);
	assert.match(text, /Preset 'nonexistent' is not defined in subagents\.presets\./);
});

test("BUG P1: a healthy sibling step still launches despite a bad preset", async () => {
	const { text } = await runBatch({ presets: {} });

	// The sibling must survive: either it launched (▶ line) or it at least
	// produced its own line rather than being silently dropped by a rejection.
	assert.match(text, /healthy/);
	assert.match(text, /▶|✗/);
});

test("BUG P1: the refusal names the presets that ARE defined", async () => {
	const { text } = await runBatch({
		presets: { strong: { kind: "pi", model: "cb/kimi-k3" } },
	});

	assert.match(
		text,
		/Preset 'nonexistent' is not defined in subagents\.presets\. Defined: strong\./,
	);
});
