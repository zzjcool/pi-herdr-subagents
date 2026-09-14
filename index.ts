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
import { Type, type Static } from "typebox";
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
	type HerdrClient,
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
	task: Type.Optional(Type.String({ description: "Task text (single launch)" })),
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

/** The validated tool parameters, as the model supplies them. */
type SubagentParams = Static<typeof SubagentParams>;

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

		// The parameter list is fixed by Pi's `ExtensionAPI.registerTool`
		// contract — an options object is not ours to choose.
		// pi-lens-ignore: long-parameter-list
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
			const { agents, settings } = loadCatalog(ctx.cwd, cwd, params.agentScope);

			if (action === "list") return listAgents(agents);

			// Control actions address an EXISTING child; launch-family actions
			// create new ones. The two share almost nothing, so they are separate.
			if (action !== "launch") {
				return controlAction({ action, params, client, store, cwd, agents });
			}

			return launchFamily({
				params,
				ctx,
				client,
				store,
				cwd,
				agents,
				settings,
			});
		},
	});
}

/**
 * Load the effective agent catalog for a request.
 *
 * Settings come from the PROJECT (`.pi/settings.json` under the session cwd),
 * while agent directories are resolved from the run's `cwd`. Bundled roles are
 * included unless `subagents.disableBuiltins` opts out.
 */
function loadCatalog(
	sessionCwd: string,
	runCwd: string,
	scope: AgentScope | undefined,
): {
	agents: AgentConfig[];
	settings: ReturnType<typeof resolveSubagentSettings>;
} {
	const settingsPath = path.join(sessionCwd, ".pi", "settings.json");
	const settings = resolveSubagentSettings(
		loadSubagentSettings({ userSettingsPath: settingsPath }),
		{},
	);
	const discovery = discoverAgents(runCwd, scope ?? "user", {
		includeBuiltin: settings.disableBuiltins !== true,
	});
	return {
		agents: applyDefaultModel(
			applyAgentOverrides(discovery.agents, settings.agentOverrides),
			settings.defaultModel,
		),
		settings,
	};
}

/**
 * Act on an EXISTING child: status, steer, collect, retire, continue, resume.
 *
 * Each tool invocation runs in a fresh process, so the orchestrator is rebuilt
 * from `run.json` rather than from memory. `onChildUpdate` is synchronous while
 * RunStore is async, so persistence happens explicitly after each operation.
 */
async function controlAction(input: {
	action: string;
	params: SubagentParams;
	client: HerdrClient;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
}): Promise<AgentToolResult<unknown>> {
	const { action, params, store, cwd } = input;

	if (!params.name) {
		return fail(
			`\`name\` is required for the "${action}" action.`,
			ErrorCodes.INVALID_PARAMS,
		);
	}

	const found = findChild(store.listRuns(), params.name);
	if (!found) return unknownChild(params.name, store, cwd);

	const orchestrator = new Orchestrator({
		client: input.client,
		runDir: store.runDir(found.runId),
		cwd,
		// Reuse the task tab this run created in an EARLIER process, so adding an
		// agent here lands in the same tab instead of fragmenting the task (§8.1).
		...(found.run.herdr?.tabId ? { runTabId: found.run.herdr.tabId } : {}),
	});
	orchestrator.restore(found.run);

	const ctx: ChildContext = {
		...input,
		name: params.name,
		found,
		orchestrator,
	};

	if (action === "status") return renderChild(found.child, "status");
	if (action === "steer") return steerChild(ctx);
	if (action === "collect") return collectChild(ctx);
	if (action === "retire") return retireChild(ctx);
	if (action === "continue" || action === "resume") return reviveChild(ctx);

	return fail(`unhandled action: ${action}`, ErrorCodes.INVALID_PARAMS);
}

/** A resolved child plus the collaborators every control action needs. */
interface ChildContext {
	action: string;
	params: SubagentParams;
	/** Always set: `controlAction` rejects a request without a name. */
	name: string;
	client: HerdrClient;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	found: NonNullable<ReturnType<typeof findChild>>;
	orchestrator: Orchestrator;
}

/**
 * Explain a lookup miss.
 *
 * Child records live under `<cwd>/.pi-subagents`, so a control call from a
 * different directory cannot see them. Saying so — and listing what IS visible —
 * saves the caller from hunting for a typo that does not exist.
 */
function unknownChild(
	name: string,
	store: RunStore,
	cwd: string,
): AgentToolResult<unknown> {
	const known = store.listRuns().flatMap((r) => r.children.map((c) => c.name));
	return fail(
		`unknown child: ${name} (no run under ${cwd}/.pi-subagents` +
			`${known.length ? `; known here: ${known.join(", ")}` : ""}). ` +
			`Child records are scoped to the \`cwd\` they were launched from — ` +
			`pass the same \`cwd\` you used for \`launch\`.`,
		ErrorCodes.NOT_FOUND,
	);
}

/** Send a message to a running child without waiting for its reply. */
async function steerChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	if (!ctx.params.message) {
		return fail("`message` is required for steer.", ErrorCodes.INVALID_PARAMS);
	}
	try {
		await ctx.orchestrator.steer(ctx.name, ctx.params.message);
		return ok(`Steered ${ctx.name}.`);
	} catch (error) {
		return fail(`steer failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/** Wait for the child's current turn and derive its outcome from the session. */
async function collectChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	try {
		// Honour the agent's own `timeoutMs`: the bundled roles declare budgets
		// (worker 30min, oracle 20min) that were previously parsed and ignored.
		const agentDef = ctx.agents.find((a) => a.name === ctx.found.child.agent);
		const collected = await ctx.orchestrator.collect(ctx.name, {
			timeoutMs: agentDef?.timeoutMs ?? DEFAULTS.turnTimeoutMs,
		});
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		return ok(renderCollect(ctx.name, collected));
	} catch (error) {
		return fail(`collect failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/** Recycle the child: snapshot the outcome, exit the agent, close the pane. */
async function retireChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	try {
		const child = await ctx.orchestrator.retire(ctx.name);
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		return ok(
			`Retired ${ctx.name} (execution=${child.execution?.status ?? "unknown"}). ` +
				`Pane closed; session kept for resume: ${child.sessionFile}`,
		);
	} catch (error) {
		return fail(`retire failed: ${String(error)}`, ErrorCodes.RETIRE_FAILED);
	}
}

/**
 * Continue or resume a child.
 *
 * A live agent is prompted in place; an exited one is relaunched from its
 * persisted session so its context survives the pane being gone (F12).
 */
async function reviveChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	const { action, params, client, name, found, orchestrator } = ctx;

	if (!params.message) {
		return fail(
			`\`message\` is required for ${action}.`,
			ErrorCodes.INVALID_PARAMS,
		);
	}

	const agentDef = ctx.agents.find((a) => a.name === found.child.agent);
	if (!agentDef) {
		return fail(
			`agent "${found.child.agent}" is no longer defined`,
			ErrorCodes.UNKNOWN_AGENT,
		);
	}

	try {
		const agentState = await client.agentGet(name);
		if (agentState.ok) {
			await orchestrator.steer(name, params.message);
			return ok(
				`${action === "resume" ? "Resumed" : "Continued"} ${name} (live agent prompted).`,
			);
		}

		const handle = await orchestrator.launch({
			agent: agentDef,
			task: params.message,
			name,
			...(found.child.model ? { model: found.child.model } : {}),
		});
		return ok(
			`Resumed ${handle.name} from its session (pane ${handle.paneId}). ` +
				`Context preserved from ${handle.sessionFile}`,
		);
	} catch (error) {
		return fail(`${action} failed: ${String(error)}`, ErrorCodes.START_FAILED);
	}
}

/**
 * Create children: a single `agent`+`task`, a `tasks[]` fan-out, or a `chain[]`.
 *
 * One child failure must not abort the rest, so each step reports its own line.
 */
async function launchFamily(input: {
	params: SubagentParams;
	ctx: ExtensionContext;
	client: HerdrClient;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	settings: ReturnType<typeof resolveSubagentSettings>;
}): Promise<AgentToolResult<unknown>> {
	const { params, ctx, store, cwd, agents, settings } = input;

	const plan = buildPlan(params);
	if (!plan.ok) return fail(plan.message, ErrorCodes.INVALID_PARAMS);

	const run = store.createRun({ task: plan.task, cwd });
	const orchestrator = new Orchestrator({
		client: input.client,
		runDir: store.runDir(run.runId),
		cwd,
		// Enforce the session spawn budget so a runaway fan-out cannot exhaust
		// the machine (ErrorCodes.BUDGET_EXCEEDED).
		maxSpawns: settings.maxSubagentSpawnsPerSession ?? null,
	});

	const session: LaunchSession = {
		params,
		store,
		agents,
		settings,
		runId: run.runId,
		orchestrator,
		dispatchModel: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined,
		results: [],
		handles: [],
		timeoutByName: new Map(),
	};

	// One child failing must not abort the rest, so each step reports its own line.
	for (const step of plan.steps) await launchStep(session, step);

	// Collect inline unless the caller asked for async (the default).
	const isAsync = params.async ?? true;
	if (!isAsync) await collectInline(session);

	// Persist whatever the run produced (children + their outcomes).
	for (const name of session.handles) {
		await persistChild(store, run.runId, orchestrator, name);
	}

	// Record the task tab this run owns (design §8.1). Written once, after the
	// launches, because the tab is created lazily by the first child; a later
	// process reads it back to know where the task's panes belong.
	if (orchestrator.tabId) {
		await store.updateRun(run.runId, (r) => {
			r.herdr = {
				...r.herdr,
				tabId: orchestrator.tabId ?? undefined,
				tabLabel: `task:${run.runId}`,
			};
		});
	}

	return {
		content: [{ type: "text", text: session.results.join("\n") }],
		details: { runId: run.runId, handles: session.handles, async: isAsync },
	};
}

/** Accumulated state for one launch-family request. */
interface LaunchSession {
	params: SubagentParams;
	store: RunStore;
	agents: AgentConfig[];
	settings: ReturnType<typeof resolveSubagentSettings>;
	runId: string;
	orchestrator: Orchestrator;
	dispatchModel: string | undefined;
	results: string[];
	handles: string[];
	timeoutByName: Map<string, number>;
}

/**
 * Launch one step, recording either a launch line or a refusal.
 * Never throws: a bad step degrades to a message so the others still run.
 */
async function launchStep(
	session: LaunchSession,
	step: { agent: string; task: string; model?: string },
): Promise<void> {
	const agent = session.agents.find((a) => a.name === step.agent);
	if (!agent) {
		session.results.push(unknownAgentLine(session.agents, step.agent));
		return;
	}
	if (agent.disabled) {
		session.results.push(`✗ agent "${step.agent}" is disabled`);
		return;
	}

	const model = resolveStepModel(session, agent, step);
	const resolved = model.resolved;

	const violation = checkModelScope(
		resolved.model,
		session.settings.modelScope,
		"explicit",
	);
	if (violation && violation.severity === "error") {
		session.results.push(`✗ ${violation.message}`);
		return;
	}

	try {
		// Let `launch()` allocate: it consults the GLOBAL herdr name namespace.
		// Pre-allocating here from local state alone would bypass that check and
		// collide with another session's agent.
		const handle = await session.orchestrator.launch({
			agent,
			task: step.task,
			...(resolved.model ? { model: resolved.model } : {}),
			...(model.placement ? { placement: model.placement } : {}),
		});
		await session.store.addChild(session.runId, handle.child);
		session.handles.push(handle.name);
		if (agent.timeoutMs !== undefined) {
			session.timeoutByName.set(handle.name, agent.timeoutMs);
		}
		session.results.push(
			`▶ ${handle.name} (${agent.name}) pane=${handle.paneId}`,
		);
		// Surface frontmatter keys that are accepted but inert, so a user does
		// not believe an unenforced setting is protecting them.
		if (agent.unenforcedFields?.length) {
			session.results.push(
				`  ⚠ ${agent.name} sets fields that are not enforced yet: ` +
					`${agent.unenforcedFields.join(", ")}`,
			);
		}
	} catch (error) {
		const message =
			error instanceof SubagentError
				? `${error.code}: ${error.message}`
				: String(error);
		session.results.push(`✗ ${step.agent}: ${message}`);
	}
}

/**
 * The complete "no such agent" refusal line, marker included.
 *
 * Exported because the refusal lines are the ONLY feedback a caller gets on a
 * typo'd agent name, and this one regressed once to a doubled `✗` marker with
 * no test noticing. Owning the marker here (rather than at the call site)
 * makes that mistake impossible to repeat.
 */
export function unknownAgentLine(
	agents: AgentConfig[],
	requested: string,
): string {
	const available = agents.map((a) => a.name).join(", ") || "none";
	return `✗ unknown agent "${requested}". Available: ${available}`;
}

/**
 * Resolve the model and placement a step will launch with.
 *
 * `parentProvider` is derived from the dispatching model so that
 * `agentOverridesByProvider.<provider>.<agent>` (design §6.2, level 2) applies;
 * without it the provider-scoped overrides parsed from settings are dead.
 */
function resolveStepModel(
	session: LaunchSession,
	agent: AgentConfig,
	step: { model?: string },
): { resolved: ReturnType<typeof resolveModel>; placement?: Placement } {
	const { params, settings } = session;
	const override = step.model ?? params.model;
	const resolved = resolveModel({
		agent,
		...(override ? { override } : {}),
		...(session.dispatchModel ? { dispatchModel: session.dispatchModel } : {}),
		...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
		...(session.dispatchModel
			? { parentProvider: providerOf(session.dispatchModel) }
			: {}),
		settings,
	});
	return {
		resolved,
		...(params.placement ? { placement: params.placement as Placement } : {}),
	};
}

/** Wait for each launched child's turn, appending its outcome. */
async function collectInline(session: LaunchSession): Promise<void> {
	for (const name of session.handles) {
		try {
			const collected = await session.orchestrator.collect(name, {
				timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
			});
			session.results.push(renderCollect(name, collected));
		} catch (error) {
			session.results.push(`✗ ${name}: collect failed: ${String(error)}`);
		}
	}
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

export function buildPlan(params: {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; model?: string }>;
	chain?: Array<{ agent: string; task: string; model?: string }>;
}): Plan {
	const hasSingle = isPresent(params.agent) && isPresent(params.task);
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

	// `tasks[]` and `chain[]` entries were previously taken on trust, so a
	// missing or blank `agent`/`task` produced a step that launched a child with
	// nothing to do (or an empty agent name that failed later, after resources
	// were allocated). Validate every entry up front instead.

	if (hasTasks) {
		const tasks = params.tasks as PlanStep[];
		const problem = firstInvalidStep(tasks, "tasks[]");
		if (problem) return { ok: false, message: problem };
		return { ok: true, task: `${tasks.length} parallel tasks`, steps: tasks };
	}

	// Chain: substitute {previous} with the prior step's output at runtime.
	const chain = params.chain as PlanStep[];
	const problem = firstInvalidStep(chain, "chain[]");
	if (problem) return { ok: false, message: problem };

	const steps = chain.map((step, i) => ({
		...step,
		task:
			i === 0
				? step.task
				: step.task.replace(/\{previous\}/g, "(previous step output)"),
	}));
	return { ok: true, task: `chain of ${chain.length}`, steps };
}

/** One entry of `tasks[]` or `chain[]`. */
interface PlanStep {
	agent: string;
	task: string;
	model?: string;
}

/**
 * True when a value is a non-blank string.
 * `Boolean("   ")` is true, so a whitespace-only task would otherwise pass and
 * launch a child with a meaningless prompt.
 */
function isPresent(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Report the first entry that would launch a child with nothing to do.
 * Returns `null` when every entry is usable.
 */
function firstInvalidStep(steps: PlanStep[], label: string): string | null {
	for (let i = 0; i < steps.length; i += 1) {
		const step = steps[i] ?? ({} as PlanStep);
		if (!isPresent(step.agent))
			return `${label}: step ${i + 1} has no \`agent\`.`;
		if (!isPresent(step.task)) {
			return `${label}: step ${i + 1} has an empty \`task\`.`;
		}
	}
	return null;
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
	const lines = agents.map((a) => {
		const model = a.model ? ` (model: ${a.model})` : "";
		// A frontmatter key that is accepted but does nothing is worse than an
		// unknown one, because the user believes it is in effect.
		const inert = a.unenforcedFields?.length
			? `\n    ⚠ not enforced yet: ${a.unenforcedFields.join(", ")}`
			: "";
		return `${a.name} [${a.source}] — ${a.description}${model}${inert}`;
	});
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
		acceptance: {
			status: string;
			level?: string;
			pendingCriteria?: Array<{
				id: string;
				must: string;
				severity?: string;
			}>;
		};
	},
): string {
	const lines = [
		`── ${name} ──`,
		`execution: ${collected.execution.status}${collected.execution.reason ? ` (${collected.execution.reason})` : ""}`,
		`acceptance: ${collected.acceptance.status}${collected.acceptance.level ? ` (${collected.acceptance.level})` : ""}`,
	];

	// L3: semantic criteria the runtime cannot decide. An agent claiming success
	// is exactly the signal that cannot be trusted (F32), so these are handed to
	// the caller as an explicit checklist rather than assumed to hold.
	const pending = collected.acceptance.pendingCriteria ?? [];
	if (pending.length > 0) {
		lines.push(
			`unverified criteria — you must confirm these before trusting the result:`,
		);
		for (const c of pending) {
			const tag = c.severity === "optional" ? " (optional)" : "";
			lines.push(`  [ ] ${c.id}${tag}: ${c.must}`);
		}
	}

	lines.push(collected.output || "(no output)");
	return lines.join("\n");
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
