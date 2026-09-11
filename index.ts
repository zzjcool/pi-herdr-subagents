/**
 * Subagent tool — the model-facing surface.
 *
 * Design refs: §11 (tool API), §12 (persistence).
 * All heavy lifting lives in src/runs/orchestrator.ts; this file is the adapter.
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHerdrClient } from "./src/herdr/client.ts";
import { discoverAgents } from "./src/agents/agents.ts";
import {
	applyAgentOverrides,
	applyDefaultModel,
} from "./src/agents/overrides.ts";
import { resolveModel, providerOf } from "./src/agents/model-resolution.ts";
import { checkModelScope } from "./src/agents/model-scope.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "./src/agents/settings.ts";
import { Orchestrator } from "./src/runs/orchestrator.ts";
import { RunStore } from "./src/runs/store.ts";
import {
	type AgentConfig,
	type AgentScope,
	DEFAULTS,
	ErrorCodes,
	type Placement,
	SubagentError,
} from "./src/shared/types.ts";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const PlacementSchema = Type.Union([
	Type.Literal("split-down"),
	Type.Literal("split-right"),
	Type.Literal("new-tab"),
]);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
});

const SubagentParams = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("launch"),
				Type.Literal("continue"),
				Type.Literal("steer"),
				Type.Literal("resume"),
				Type.Literal("retire"),
				Type.Literal("status"),
				Type.Literal("collect"),
				Type.Literal("list"),
			],
			{ description: "Defaults to launch." },
		),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent name (single launch)" }),
	),
	task: Type.Optional(
		Type.String({ description: "Task text (single launch)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Parallel launches" }),
	),
	chain: Type.Optional(
		Type.Array(TaskItem, {
			description: "Sequential launches; {previous} is substituted",
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description: "Return after launch instead of waiting. Default true.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override for this run" }),
	),
	cwd: Type.Optional(Type.String()),
	placement: Type.Optional(PlacementSchema),
	agentScope: Type.Optional(
		Type.Union(
			[Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
			{
				description: 'Which agent directories to load. Default "user".',
			},
		),
	),
	name: Type.Optional(
		Type.String({ description: "Child handle name (control actions)" }),
	),
	message: Type.Optional(
		Type.String({ description: "Text for steer/continue" }),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function herdrSubagents(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to child Pi agents running in Herdr panes.",
			"Children are visible, steerable, and resumable; their sessions outlive this process.",
			"Actions: launch (default), continue, steer, resume, retire, status, collect, list.",
			"Outcomes are derived from the child session JSONL, not from herdr's agent status.",
		].join(" "),
		parameters: SubagentParams,

		async execute(
			_id,
			params,
			signal,
			onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			const client = createHerdrClient();
			if (!(await client.available())) {
				return fail(
					"herdr is not available. Install it (https://herdr.dev) or check HERDR_BIN.",
					ErrorCodes.HERDR_UNAVAILABLE,
				);
			}

			const action = params.action ?? "launch";
			const cwd = params.cwd ?? ctx.cwd;
			const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });

			// ── agent discovery ────────────────────────────────────────────────
			const scope: AgentScope = params.agentScope ?? "user";

			const settingsPath = path.join(ctx.cwd, ".pi", "settings.json");
			const settings = resolveSubagentSettings(
				loadSubagentSettings({ userSettingsPath: settingsPath }),
				{},
			);

			// The bundled roles ship with the package, so a fresh install has a
			// working set with no user setup at all. `subagents.disableBuiltins`
			// opts out for users who want only their own definitions.
			const discovery = discoverAgents(cwd, scope, {
				includeBuiltin: settings.disableBuiltins !== true,
			});

			const agents = applyDefaultModel(
				applyAgentOverrides(discovery.agents, settings.agentOverrides),
				settings.defaultModel,
			);

			// ── control actions ───────────────────────────────────────────────
			if (action === "list") return listAgents(agents);

			if (action !== "launch") {
				if (!params.name) {
					return fail(
						`\`name\` is required for the "${action}" action.`,
						ErrorCodes.INVALID_PARAMS,
					);
				}
				const found = findChild(store.listRuns(), params.name);
				if (!found) {
					// Child records live under `<cwd>/.pi-subagents`, so a control call
					// from a different directory cannot see them. Say so explicitly —
					// a bare "unknown child" sends the caller hunting for a typo.
					const known = store
						.listRuns()
						.flatMap((r) => r.children.map((c) => c.name));
					return fail(
						`unknown child: ${params.name} (no run under ${cwd}/.pi-subagents` +
							`${known.length ? `; known here: ${known.join(", ")}` : ""}). ` +
							`Child records are scoped to the \`cwd\` they were launched from — ` +
							`pass the same \`cwd\` you used for \`launch\`.`,
						ErrorCodes.NOT_FOUND,
					);
				}

				// Rehydrate from the persisted run: each tool invocation runs in a
				// fresh process, so in-memory orchestrator state is gone and the
				// control actions must be driven from run.json.
				//
				// `onChildUpdate` is synchronous but RunStore is async, so the
				// callback only mirrors state in memory; persistence happens
				// explicitly below, after the operation completes.
				const orchestrator = new Orchestrator({
					client,
					runDir: store.runDir(found.runId),
					cwd,
				});
				orchestrator.restore(found.run);

				if (action === "status") return renderChild(found.child, "status");

				if (action === "steer") {
					if (!params.message)
						return fail(
							"`message` is required for steer.",
							ErrorCodes.INVALID_PARAMS,
						);
					try {
						await orchestrator.steer(params.name, params.message);
						return ok(`Steered ${params.name}.`);
					} catch (error) {
						return fail(`steer failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
					}
				}

				if (action === "collect") {
					try {
						const collected = await orchestrator.collect(params.name, {
							timeoutMs: DEFAULTS.turnTimeoutMs,
						});
						await persistChild(store, found.runId, orchestrator, params.name);
						return ok(renderCollect(params.name, collected));
					} catch (error) {
						return fail(
							`collect failed: ${String(error)}`,
							ErrorCodes.NOT_FOUND,
						);
					}
				}

				if (action === "retire") {
					// Actually recycle: snapshot the outcome, exit the agent, close the pane.
					try {
						const child = await orchestrator.retire(params.name);
						await persistChild(store, found.runId, orchestrator, params.name);
						return ok(
							`Retired ${params.name} (execution=${child.execution?.status ?? "unknown"}). ` +
								`Pane closed; session kept for resume: ${child.sessionFile}`,
						);
					} catch (error) {
						return fail(
							`retire failed: ${String(error)}`,
							ErrorCodes.RETIRE_FAILED,
						);
					}
				}

				if (action === "continue" || action === "resume") {
					if (!params.message) {
						return fail(
							`\`message\` is required for ${action}.`,
							ErrorCodes.INVALID_PARAMS,
						);
					}
					const agentDef = agents.find((a) => a.name === found.child.agent);
					if (!agentDef) {
						return fail(
							`agent "${found.child.agent}" is no longer defined`,
							ErrorCodes.UNKNOWN_AGENT,
						);
					}

					try {
						// A live agent is prompted in place; an exited one is rebuilt
						// from its persisted session so context survives.
						const alive = (await client.agentGet(params.name)).ok;
						if (alive) {
							await orchestrator.steer(params.name, params.message);
							return ok(
								`${action === "resume" ? "Resumed" : "Continued"} ${params.name} (live agent prompted).`,
							);
						}

						const handle = await orchestrator.launch({
							agent: agentDef,
							task: params.message,
							name: params.name,
							...(found.child.model ? { model: found.child.model } : {}),
						});
						return ok(
							`Resumed ${handle.name} from its session (pane ${handle.paneId}). ` +
								`Context preserved from ${handle.sessionFile}`,
						);
					} catch (error) {
						return fail(
							`${action} failed: ${String(error)}`,
							ErrorCodes.START_FAILED,
						);
					}
				}

				return fail(`unhandled action: ${action}`, ErrorCodes.INVALID_PARAMS);
			}

			// ── launch-family actions ─────────────────────────────────────────
			const dispatchModel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: undefined;

			const plan = buildPlan(params);
			if (!plan.ok) return fail(plan.message, ErrorCodes.INVALID_PARAMS);

			const run = store.createRun({ task: plan.task, cwd });
			const orchestrator = new Orchestrator({
				client,
				runDir: store.runDir(run.runId),
				cwd,
				// Enforce the session spawn budget so a runaway fan-out cannot
				// exhaust the machine (ErrorCodes.BUDGET_EXCEEDED).
				maxSpawns: settings.maxSubagentSpawnsPerSession ?? null,
			});

			const results: string[] = [];
			const handles: string[] = [];

			for (const step of plan.steps) {
				const agent = agents.find((a) => a.name === step.agent);
				if (!agent) {
					results.push(
						`✗ unknown agent "${step.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
					);
					continue;
				}
				if (agent.disabled) {
					results.push(`✗ agent "${step.agent}" is disabled`);
					continue;
				}

				const resolved = resolveModel({
					agent,
					...((step.model ?? params.model)
						? { override: step.model ?? params.model }
						: {}),
					...(dispatchModel ? { dispatchModel } : {}),
					...(settings.defaultModel
						? { defaultModel: settings.defaultModel }
						: {}),
					// Enables `agentOverridesByProvider.<provider>.<agent>` (design
					// §6.2, level 2). Without this the provider-scoped overrides
					// parsed from settings would never apply.
					...(dispatchModel
						? { parentProvider: providerOf(dispatchModel) }
						: {}),
					settings,
				});

				const violation = checkModelScope(
					resolved.model,
					settings.modelScope,
					"explicit",
				);
				if (violation && violation.severity === "error") {
					results.push(`✗ ${violation.message}`);
					continue;
				}

				try {
					// Let `launch()` allocate: it consults the GLOBAL herdr name
					// namespace. Pre-allocating here from local state alone would
					// bypass that check and collide with another session's agent.
					const handle = await orchestrator.launch({
						agent,
						task: step.task,
						...(resolved.model ? { model: resolved.model } : {}),
						...(params.placement
							? { placement: params.placement as Placement }
							: {}),
					});
					await store.addChild(run.runId, handle.child);
					handles.push(handle.name);
					results.push(
						`▶ ${handle.name} (${agent.name}) pane=${handle.paneId}`,
					);
				} catch (error) {
					const message =
						error instanceof SubagentError
							? `${error.code}: ${error.message}`
							: String(error);
					results.push(`✗ ${step.agent}: ${message}`);
				}
			}

			// ── collect (unless async) ────────────────────────────────────────
			const isAsync = params.async ?? true;
			if (!isAsync && handles.length > 0) {
				for (const name of handles) {
					try {
						const collected = await orchestrator.collect(name, {
							timeoutMs: DEFAULTS.turnTimeoutMs,
						});
						results.push(renderCollect(name, collected));
					} catch (error) {
						results.push(`✗ ${name}: collect failed: ${String(error)}`);
					}
				}
			}

			// Persist whatever the run produced (children + their outcomes).
			for (const name of handles)
				await persistChild(store, run.runId, orchestrator, name);
			return {
				content: [{ type: "text", text: results.join("\n") }],
				details: { runId: run.runId, handles, async: isAsync },
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Plan =
	| {
			ok: true;
			task: string;
			steps: Array<{ agent: string; task: string; model?: string }>;
	  }
	| { ok: false; message: string };

function buildPlan(params: {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; model?: string }>;
	chain?: Array<{ agent: string; task: string; model?: string }>;
}): Plan {
	const hasSingle = Boolean(params.agent && params.task);
	const hasTasks = Boolean(params.tasks?.length);
	const hasChain = Boolean(params.chain?.length);
	const count = Number(hasSingle) + Number(hasTasks) + Number(hasChain);

	if (count === 0)
		return {
			ok: false,
			message: "Provide one of: (agent+task), tasks[], or chain[].",
		};
	if (count > 1)
		return {
			ok: false,
			message: "Provide exactly one of: (agent+task), tasks[], or chain[].",
		};

	if (hasSingle) {
		return {
			ok: true,
			task: params.task as string,
			steps: [{ agent: params.agent as string, task: params.task as string }],
		};
	}
	if (hasTasks) {
		const tasks = params.tasks as Array<{
			agent: string;
			task: string;
			model?: string;
		}>;
		return { ok: true, task: `${tasks.length} parallel tasks`, steps: tasks };
	}

	// Chain: substitute {previous} with the prior step's output at runtime.
	const chain = params.chain as Array<{
		agent: string;
		task: string;
		model?: string;
	}>;
	const steps = chain.map((step, i) => ({
		...step,
		task:
			i === 0
				? step.task
				: step.task.replace(/\{previous\}/g, "(previous step output)"),
	}));
	return { ok: true, task: `chain of ${chain.length}`, steps };
}

/**
 * Persist the orchestrator's current view of one child.
 *
 * RunStore is async while Orchestrator's `onChildUpdate` is synchronous, so
 * persistence is done explicitly here rather than from inside the callback
 * (which would leave floating promises).
 */
async function persistChild(
	store: RunStore,
	runId: string,
	orchestrator: Orchestrator,
	name: string,
): Promise<void> {
	const child = orchestrator.childrenSnapshot().find((c) => c.name === name);
	if (!child) return;
	try {
		await store.updateChild(runId, name, (c) => Object.assign(c, child));
	} catch {
		// Not persisted yet (or already removed) — the caller's own addChild wins.
	}
}

function listAgents(agents: AgentConfig[]): AgentToolResult<unknown> {
	if (agents.length === 0) {
		return ok(
			"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		);
	}
	const lines = agents.map(
		(a) =>
			`${a.name} [${a.source}] — ${a.description}${a.model ? ` (model: ${a.model})` : ""}`,
	);
	return ok(lines.join("\n"));
}

function findChild(
	runs: ReturnType<RunStore["listRuns"]>,
	name: string,
): {
	runId: string;
	run: ReturnType<RunStore["listRuns"]>[number];
	child: NonNullable<ReturnType<RunStore["findChild"]>>;
} | null {
	for (const run of runs) {
		const child = run.children.find((c) => c.name === name);
		if (child) return { runId: run.runId, run, child };
	}
	return null;
}

function renderChild(
	child: NonNullable<ReturnType<RunStore["findChild"]>>,
	action: string,
): AgentToolResult<unknown> {
	const lines = [
		`${child.name} — state=${child.state} agent=${child.agent ?? "?"} kind=${child.kind ?? "?"}`,
		`pane=${child.paneId ?? "(recycled)"}`,
		`session=${child.sessionFile}`,
	];
	if (child.execution) {
		lines.push(
			`execution: ${child.execution.status}${child.execution.reason ? ` (${child.execution.reason})` : ""}`,
		);
		if (child.execution.usage) {
			lines.push(
				`usage: in=${child.execution.usage.input} out=${child.execution.usage.output} cost=${child.execution.usage.cost.toFixed(4)}`,
			);
		}
	}
	if (child.acceptance)
		lines.push(
			`acceptance: ${child.acceptance.status} (${child.acceptance.level})`,
		);
	if (action === "collect" && !child.execution)
		lines.push("(not yet collected — call collect while the agent is alive)");
	return ok(lines.join("\n"));
}

function renderCollect(
	name: string,
	collected: {
		execution: { status: string; reason?: string };
		output: string;
		acceptance: { status: string };
	},
): string {
	return [
		`── ${name} ──`,
		`execution: ${collected.execution.status}${collected.execution.reason ? ` (${collected.execution.reason})` : ""}`,
		`acceptance: ${collected.acceptance.status}`,
		collected.output || "(no output)",
	].join("\n");
}

function ok(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

/**
 * Render a failure to the model.
 *
 * `AgentToolResult` has no `isError` field — the error code travels in
 * `details` and the message text carries the failure signal.
 */
function fail(text: string, code: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: { error: code } };
}
