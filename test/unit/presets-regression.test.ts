/**
 * Launch-path regression tests for `subagents.presets`.
 *
 * These drive the REAL registered tool through the REAL `launchStep`, but the
 * herdr CLI is replaced by `test/helpers/fake-herdr-bin.mjs` via `HERDR_BIN`,
 * so no real agent, pane or workspace is ever touched. Everything the launcher
 * passes to herdr is recorded to `FAKE_HERDR_LOG`, which is how the tests prove
 * what model/kind actually reached the child.
 *
 * BUG P1 — `launchStep` promises "Never throws: a bad step degrades to a
 * message so the others still run", but preset expansion ran ABOVE its `try`
 * block. In the parallel path (`Promise.all` over `tasks[]`) one undefined
 * preset name rejected the whole batch: the caller saw a raw thrown Error and
 * every healthy sibling's launch/refusal line was discarded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import herdrSubagents from "../../index.ts";

const FAKE_HERDR_BIN = fileURLToPath(
	new URL("../helpers/fake-herdr-bin.mjs", import.meta.url),
);

/** Minimal ExtensionAPI stand-in: captures the registered tools. */
function fakePi(): {
	tools: Array<Record<string, unknown>>;
	registerTool: (tool: unknown) => void;
	registerMessageRenderer: () => void;
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
		registerMessageRenderer() {},
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

interface BatchOutcome {
	threw?: Error;
	text: string;
	/** Every herdr invocation the launcher made, one line per call. */
	herdrCalls: string[];
}

/**
 * Run one `tasks[]` launch batch in a temp cwd. `settings` is written as the
 * user settings.json; `agents` maps extra agent filenames to frontmatter.
 */
async function runBatch(params: {
	settings: Record<string, unknown>;
	agents: Record<string, string>;
	tasks: Array<Record<string, unknown>>;
	/**
	 * The parent session's model. Supplying this exercises the full end-to-end
	 * path — tool → resolveStep → classifyModelOrigin → launch → `⚠` — for the
	 * inherited-model case, which the orchestrator-level tests bypass by passing
	 * `modelOrigin` directly.
	 */
	dispatchModel?: string;
}): Promise<BatchOutcome> {
	const dir = mkdtempSync(path.join(tmpdir(), "presets-launch-"));
	const previous = {
		child: process.env.PI_SUBAGENT_CHILD,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		bin: process.env.HERDR_BIN,
		log: process.env.FAKE_HERDR_LOG,
	};
	const logPath = path.join(dir, "herdr-calls.log");
	try {
		// The tool is not registered inside a child process.
		delete process.env.PI_SUBAGENT_CHILD;

		const agentDir = path.join(dir, "agentdir");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: params.settings }),
		);
		// `getAgentDir()` reads PI_CODING_AGENT_DIR, so the temp settings file is
		// what the tool actually loads.
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const extra = path.join(dir, "extra-agents");
		mkdirSync(extra, { recursive: true });
		for (const [file, frontmatter] of Object.entries(params.agents)) {
			writeFileSync(path.join(extra, file), frontmatter);
		}
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extra;

		// Hermetic herdr: no real panes, and every call is recorded.
		// A shell wrapper is generated instead of relying on the stub's own exec
		// bit, which git does not preserve dependably across checkouts.
		const stub = path.join(dir, "fake-herdr");
		writeFileSync(
			stub,
			`#!/bin/sh\nexec "${process.execPath}" "${FAKE_HERDR_BIN}" "$@"\n`,
		);
		chmodSync(stub, 0o755);
		process.env.HERDR_BIN = stub;
		process.env.FAKE_HERDR_LOG = logPath;
		writeFileSync(logPath, "");

		const pi = fakePi();
		herdrSubagents(pi as never);
		const tool = pi.tools[0] as unknown as SubagentTool;
		assert.ok(tool, "subagent tool must be registered");

		const readLog = (): string[] => {
			try {
				return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
			} catch {
				return [];
			}
		};

			try {
				const res = await tool.execute(
					"call-1",
					// `async: false` collects inline instead of leaving a background
					// watcher polling: a unit test must not depend on timers to exit.
					{ tasks: params.tasks, async: false },
					undefined,
					undefined,
					{
						cwd: dir,
						ui: { notify() {} },
						hasUI: false,
						...(params.dispatchModel
							? {
									model: {
										provider: params.dispatchModel.split("/")[0],
										id: params.dispatchModel.split("/").slice(1).join("/"),
									},
								}
							: {}),
					},
				);
			const text = (res.content ?? []).map((b) => b.text ?? "").join("\n");
			return { text, herdrCalls: readLog() };
		} catch (error) {
			return {
				threw: error instanceof Error ? error : new Error(String(error)),
				text: "",
				herdrCalls: readLog(),
			};
		}
	} finally {
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.extra === undefined)
			delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
		else process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = previous.extra;
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.bin === undefined) delete process.env.HERDR_BIN;
		else process.env.HERDR_BIN = previous.bin;
		if (previous.log === undefined) delete process.env.FAKE_HERDR_LOG;
		else process.env.FAKE_HERDR_LOG = previous.log;
		rmSync(dir, { recursive: true, force: true });
	}
}

const BROKEN = "---\nname: broken\ndescription: b\npreset: nonexistent\n---\np\n";
const HEALTHY = "---\nname: healthy\ndescription: h\n---\np\n";

// ────────────────────── BUG P1: sibling survival ──────────────────────

test("BUG P1: an undefined preset must not abort the whole tasks[] batch", async () => {
	const { threw, text } = await runBatch({
		settings: { presets: {} },
		agents: { "broken.md": BROKEN, "healthy.md": HEALTHY },
		tasks: [
			{ agent: "broken", task: "t1" },
			{ agent: "healthy", task: "t2" },
		],
	});

	// Before the fix this threw and `text` was empty.
	assert.equal(
		threw,
		undefined,
		`a bad preset must degrade to a refusal line, not throw: ${threw?.message}`,
	);
	assert.match(text, /✗ broken: /);
	assert.match(text, /Preset 'nonexistent' is not defined in subagents\.presets\./);
});

test("BUG P1: the healthy sibling actually LAUNCHES despite the bad preset", async () => {
	const { text, herdrCalls } = await runBatch({
		settings: { presets: {} },
		agents: { "broken.md": BROKEN, "healthy.md": HEALTHY },
		tasks: [
			{ agent: "broken", task: "t1" },
			{ agent: "healthy", task: "t2" },
		],
	});

	// Correlate the marker with the healthy step: `/▶|✗/` alone would pass on
	// the broken step's own refusal line.
	assert.match(text, /▶\s+\S*healthy/);
	// And the sibling really reached herdr.
	assert.ok(
		herdrCalls.some((call) => call.startsWith("agent start")),
		`expected an agent start call, saw: ${JSON.stringify(herdrCalls)}`,
	);
});

test("BUG P1: the refusal names the presets that ARE defined", async () => {
	const { text } = await runBatch({
		settings: { presets: { strong: { kind: "pi", model: "cb/kimi-k3" } } },
		agents: { "broken.md": BROKEN, "healthy.md": HEALTHY },
		tasks: [{ agent: "broken", task: "t1" }],
	});
	assert.match(
		text,
		/Preset 'nonexistent' is not defined in subagents\.presets\. Defined: strong\./,
	);
});

// ───────────── happy path: the preset actually reaches herdr ─────────────

test("launch: a defined preset's model reaches the herdr argv", async () => {
	const { text, herdrCalls } = await runBatch({
		settings: {
			presets: { strong: { kind: "pi", model: "cb/kimi-k3", thinking: "max" } },
		},
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: strong\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
	});

	assert.match(text, /▶\s+\S*healthy/);
	const start = herdrCalls.find((c) => c.startsWith("agent start"));
	assert.ok(start, `expected a start call, saw: ${JSON.stringify(herdrCalls)}`);
	assert.match(start!, /--model\s+cb\/kimi-k3/);
});

test("launch: a preset beats a folded agentOverrides model, end to end", async () => {
	const { herdrCalls } = await runBatch({
		settings: {
			agentOverrides: { healthy: { model: "cb/deepseek-v4.1-flash" } },
			presets: { strong: { kind: "pi", model: "cb/kimi-k3" } },
		},
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: strong\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
	});

	const start = herdrCalls.find((c) => c.startsWith("agent start"));
	assert.ok(start, `expected a start call, saw: ${JSON.stringify(herdrCalls)}`);
	// The whole point of the feature: the preset wins over the profile pin.
	assert.match(start!, /--model\s+cb\/kimi-k3/);
	assert.doesNotMatch(start!, /cb\/deepseek-v4\.1-flash/);
});

test("launch: the tool `preset` param selects a different preset", async () => {
	const { herdrCalls } = await runBatch({
		settings: {
			presets: {
				cheap: { kind: "pi", model: "cb/deepseek-v4.1-flash" },
				strong: { kind: "pi", model: "cb/kimi-k3" },
			},
		},
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: cheap\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1", preset: "strong" }],
	});

	const start = herdrCalls.find((c) => c.startsWith("agent start"));
	assert.ok(start, `expected a start call, saw: ${JSON.stringify(herdrCalls)}`);
	assert.match(start!, /--model\s+cb\/kimi-k3/);
});

// ────── end-to-end: the kind/model guard through the real tool ──────
//
// The orchestrator-level tests pass `modelOrigin` directly, so they cannot
// catch a break in the wiring that CLASSIFIES it (resolveStep →
// classifyModelOrigin). These drive the real registered tool instead, with a
// parent model supplied, so the whole chain is exercised.

test("e2e: an inherited parent model is dropped and reported, not refused", async () => {
	// The parent is pi; this cursor role has no model of its own, so it inherits
	// the parent's pi-shaped model — which cursor cannot express.
	const { threw, text, herdrCalls } = await runBatch({
		settings: {},
		agents: {
			"websearch.md": "---\nname: websearch\ndescription: w\nkind: cursor\n---\np\n",
		},
		tasks: [{ agent: "websearch", task: "t" }],
		dispatchModel: "cb/kimi-k3",
	});

	assert.equal(threw, undefined, `inherited model must not refuse: ${threw?.message}`);
	assert.match(text, /▶\s+\S*websearch/, "the child must still launch");
	// The user is told, rather than silently getting a different model.
	assert.match(text, /⚠/);
	assert.match(text, /cb\/kimi-k3/);
	// And no --model was handed to a CLI that cannot take it.
	const start = herdrCalls.find((c) => c.startsWith("agent start"));
	assert.ok(start, `expected a start call, saw: ${JSON.stringify(herdrCalls)}`);
	assert.doesNotMatch(start!, /--model/);
});

test("e2e: an explicit model the kind cannot express is refused, launching nothing", async () => {
	const { text, herdrCalls } = await runBatch({
		settings: {},
		agents: {
			// frontmatter is an EXPLICIT choice, unlike the inherited case above.
			"websearch.md":
				"---\nname: websearch\ndescription: w\nkind: cursor\nmodel: cb/kimi-k3\n---\np\n",
		},
		tasks: [{ agent: "websearch", task: "t" }],
		dispatchModel: "cb/kimi-k3",
	});

	assert.match(text, /✗ websearch: /);
	assert.match(text, /cannot be used with kind 'cursor'/);
	assert.equal(
		herdrCalls.filter((c) => c.startsWith("agent start")).length,
		0,
		"an explicit mismatch must not start an agent at all",
	);
});
