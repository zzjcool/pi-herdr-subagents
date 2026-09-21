/**
 * Subagent tool — the model-facing surface.
 *
 * Design refs: §11 (tool API), §12 (persistence).
 * All heavy lifting lives in src/runs/orchestrator.ts; this file is the adapter.
 *
 * Completion follows pi-subagents, not "child prompts parent":
 *   launch is async by default → this process watches the child →
 *   `pi.sendMessage({ customType: "subagent-notify" }, { triggerTurn, deliverAs: "followUp" })`
 *   wakes the parent when idle, or waits out the current turn if the parent
 *   is still working. Running children are painted next to the input box.
 */

import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createHerdrClient } from "./src/herdr/client.ts";
import { discoverAgents, findAgent, formatAgentRoster } from "./src/agents/agents.ts";
import {
	applyAgentOverrides,
	applyDefaultModel,
} from "./src/agents/overrides.ts";
import { resolveModel } from "./src/agents/model-resolution.ts";
import { resolveStepModel } from "./src/agents/step-model.ts";
import { checkModelScope } from "./src/agents/model-scope.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "./src/agents/settings.ts";
import { createSessionRuntime, type SessionRuntime, shouldRecycleAfterCollect, type WaitResult } from "./src/extension/runtime.ts";
import { DEFAULT_FLUSH_MS, DEFAULT_JOIN_MODE } from "./src/extension/join.ts";
import { registerChildGuard } from "./src/extension/child-guard.ts";
import { ALLOW_NESTED_ENV } from "./src/extension/budget.ts";
import {
	applyOnBlockedPolicy,
	followUpFor,
} from "./src/extension/blocked.ts";
import { formatAlreadyRecycled } from "./src/extension/recycle.ts";
import {
	SUBAGENT_NOTIFY_TYPE,
} from "./src/extension/notify.ts";
import { registerProfileCommands } from "./src/extension/slash.ts";
import {
	blockMessage,
	forbiddenDispatchReason,
	PARENT_PLAYBOOK,
	TOOL_DESCRIPTION,
} from "./src/extension/playbook.ts";
import { getAgentDir } from "./src/agents/paths.ts";
import { Orchestrator } from "./src/runs/orchestrator.ts";
import {
	createSessionLayout,
	type SessionLayout,
} from "./src/runs/layout.ts";
import { RunStore, pickChildByName } from "./src/runs/store.ts";
import { resolveLaunchWorktree } from "./src/runs/worktree.ts";
import {
	type AgentConfig,
	type AgentScope,
	DEFAULTS,
	ErrorCodes,
	type HerdrClient,
	type ModelOrigin,
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
	preset: Type.Optional(
		Type.String({ description: "Named kind+model+thinking preset" }),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Parent decides isolation for this child. true = own git branch, child opens an MR. false = write the current checkout.",
		}),
	),
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
				Type.Literal("wait"),
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
	preset: Type.Optional(
		Type.String({ description: "Named kind+model+thinking preset" }),
	),
	cwd: Type.Optional(Type.String()),
	placement: Type.Optional(PlacementSchema),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Parent decides isolation. true = isolated git branch, child opens an MR. false = edit the current checkout. Omit to use the role default (bundled worker: true).",
		}),
	),
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
	all: Type.Optional(
		Type.Boolean({
			description: "wait: wait for every currently-running child in this session",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "wait: per-child timeout in ms (default: role turnTimeoutMs)",
		}),
	),
	message: Type.Optional(
		Type.String({ description: "Text for steer/continue" }),
	),
});

/** The validated tool parameters, as the model supplies them. */
type SubagentParams = Static<typeof SubagentParams>;

const blockedUi = new WeakMap<
	SessionRuntime,
	{
		getConfirm: () => ((message: string) => Promise<boolean>) | undefined;
		notifyBlocked: (message: string) => void;
	}
>();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function herdrSubagents(pi: ExtensionAPI) {
	const isChild = process.env.PI_SUBAGENT_CHILD === "1";
	const allowNested = process.env[ALLOW_NESTED_ENV] === "1";
	if (isChild) {
		registerChildGuard(pi);
		if (!allowNested) return;
	}

	const layout = createSessionLayout();
	let lastModelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let lastConfirm: ((message: string) => Promise<boolean>) | undefined;
	let lastCwd = process.cwd();
	// turn_start/turn_end maintain this so a flush window can wait out a
	// busy parent instead of queueing behind the whole turn (join extends
	// the window at most MAX_BUSY_EXTENSIONS times).
	let parentTurnActive = false;
	const runtime = createSessionRuntime({
		sendMessage: (message, options) => pi.sendMessage(message, options),
		emitBusy: (active, label) => {
			try {
				pi.events.emit(
					"herdr:busy",
					active ? { active: true, label } : { active: false },
				);
			} catch {
				// herdr's busy overlay is optional; the TUI widget is the primary signal.
			}
		},
	});
	blockedUi.set(runtime, {
		getConfirm: () => lastConfirm,
		notifyBlocked: (message) => {
			try {
				pi.sendMessage(
					{
						customType: SUBAGENT_NOTIFY_TYPE,
						content: message,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// Parent session is gone; the child pane stays open for a later steer.
			}
		},
	});

	registerProfileCommands(pi, {
		getModelRegistry: () => lastModelRegistry,
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: TOOL_DESCRIPTION,
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
			runtime.bind(ctx);
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
			runtime.setJoinConfig({
				mode: settings.joinMode ?? DEFAULT_JOIN_MODE,
				flushMs: settings.joinFlushMs ?? DEFAULT_FLUSH_MS,
				parentBusy: () => parentTurnActive,
			});

			if (action === "list") return listAgents(agents);

			// Control actions address an EXISTING child; launch-family actions
			// create new ones. The two share almost nothing, so they are separate.
			if (action !== "launch") {
				return controlAction({
					action,
					params,
					client,
					store,
					cwd,
					agents,
					runtime,
					layout,
				});
			}

			return launchFamily({
				params,
				ctx,
				client,
				store,
				cwd,
				agents,
				settings,
				runtime,
				layout,
				onUpdate,
			});
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (isChild && !allowNested) return;
		const tools = event.systemPromptOptions?.selectedTools;
		if (Array.isArray(tools) && !tools.includes("subagent")) return;
		if (ctx?.cwd) lastCwd = ctx.cwd;
		const { agents } = loadCatalog(lastCwd, lastCwd, undefined);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PARENT_PLAYBOOK}\n\n${formatAgentRoster(agents)}`,
		};
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command =
			typeof event.input.command === "string" ? event.input.command : "";
		const reason = forbiddenDispatchReason(command);
		if (!reason) return;
		return { block: true, reason: blockMessage(reason) };
	});

	const bindUi = (_event: unknown, ctx: ExtensionContext): void => {
		lastModelRegistry = ctx.modelRegistry;
		if (ctx.cwd) lastCwd = ctx.cwd;
		runtime.bind(ctx);
		lastConfirm =
			ctx.hasUI && typeof ctx.ui?.confirm === "function"
				? (message) => ctx.ui.confirm("", message)
				: undefined;
	};

	pi.on("session_start", bindUi);
	pi.on("session_info_changed", bindUi);
	pi.on("turn_start", (event, ctx) => {
		parentTurnActive = true;
		bindUi(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		parentTurnActive = false;
		bindUi(event, ctx);
	});
	pi.on("agent_start", bindUi);
	pi.on("agent_end", bindUi);
	pi.on("input", bindUi);
	pi.on("tool_result", (_event, ctx) => {
		bindUi(_event, ctx);
		runtime.refreshUi();
	});
	pi.on("session_shutdown", () => {
		runtime.dispose();
	});
}

/**
 * Load the effective agent catalog for a request.
 *
 * User settings (`~/.pi/agent/settings.json`, including a loaded profile) merge
 * with project `.pi/settings.json`. Agent directories are resolved from the
 * run's `cwd`. Bundled roles are included unless `subagents.disableBuiltins`
 * opts out.
 */
function loadCatalog(
	sessionCwd: string,
	runCwd: string,
	scope: AgentScope | undefined,
): {
	agents: AgentConfig[];
	settings: ReturnType<typeof loadSubagentSettings>;
} {
	const settings = loadSubagentSettings({
		userSettingsPath: path.join(getAgentDir(), "settings.json"),
		projectSettingsPath: path.join(sessionCwd, ".pi", "settings.json"),
	});
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
 * The extension stays loaded for the session, but a control call may arrive
 * after a reload — so the orchestrator is rebuilt from `run.json` when we do
 * not already have a live tracker. `onChildUpdate` is synchronous while
 * RunStore is async, so persistence happens explicitly after each operation.
 */
async function controlAction(input: {
	action: string;
	params: SubagentParams;
	client: HerdrClient;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	runtime: SessionRuntime;
	layout: SessionLayout;
}): Promise<AgentToolResult<unknown>> {
	const { action, params, store, cwd } = input;

	if (action === "wait") {
		if (params.name && params.all) {
			return fail(
				"`name` and `all` are mutually exclusive for wait.",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (!params.name && !params.all) {
			return fail(
				"`name` or `all` is required for wait",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		return waitAction({
			params,
			runtime: input.runtime,
			agents: input.agents,
			store,
			cwd,
		});
	}

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
		layout: input.layout,
		workspaceId: process.env.HERDR_WORKSPACE_ID,
		parentPaneId: process.env.HERDR_PANE_ID,
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
	runtime: SessionRuntime;
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
	const known = store
		.listRuns()
		.filter((r) => {
			const owner = process.env.HERDR_PANE_ID?.trim();
			if (!owner) return true;
			return r.herdr.parentPaneId === owner;
		})
		.flatMap((r) => r.children.map((c) => c.name));
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
		followChild(ctx, { watch: true });
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
		const pending = ctx.runtime.consumeCollect(ctx.name);
		if (pending) {
			const collected = await pending;
			await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
			return ok(renderCollect(ctx.name, collected));
		}

		const cached = ctx.orchestrator.cachedCollect(ctx.name);
		if (cached) return ok(renderCollect(ctx.name, cached));

		const agentDef = ctx.agents.find((a) => a.name === ctx.found.child.agent);
		const timeoutMs = agentDef?.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		const collected = await ctx.orchestrator.collect(ctx.name, { timeoutMs });
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		if (
			shouldRecycleAfterCollect(collected.execution.status) &&
			!collected.blocked
		) {
			await ctx.orchestrator.retire(ctx.name);
			await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		}
		ctx.runtime.release(ctx.name);
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
		const live = ctx.orchestrator
			.childrenSnapshot()
			.find((child) => child.name === ctx.name);
		if (live?.state === "retired") {
			ctx.runtime.release(ctx.name);
			return ok(formatAlreadyRecycled(ctx.name, live.sessionFile));
		}
		ctx.runtime.release(ctx.name);
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
			followChild(ctx, { watch: true });
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
		followChild(ctx, { watch: true });
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
	runtime: SessionRuntime;
	layout: SessionLayout;
	onUpdate?: AgentToolUpdateCallback;
}): Promise<AgentToolResult<unknown>> {
	const { params, ctx, store, cwd, agents, settings, runtime, layout, onUpdate } =
		input;

	const plan = buildPlan(params);
	if (!plan.ok) return fail(plan.message, ErrorCodes.INVALID_PARAMS);

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `playbook: ${plan.steps.map((s) => s.agent).join(", ")} → type-tab → pane → start → watch`,
			},
		],
		details: {},
	});

	const run = store.createRun({
		task: plan.task,
		cwd,
		herdr: {
			...(process.env.HERDR_WORKSPACE_ID
				? { workspaceId: process.env.HERDR_WORKSPACE_ID }
				: {}),
			...(process.env.HERDR_PANE_ID
				? { parentPaneId: process.env.HERDR_PANE_ID }
				: {}),
		},
	});
	const orchestrator = new Orchestrator({
		client: input.client,
		runDir: store.runDir(run.runId),
		cwd,
		layout,
		// Enforce the session spawn budget so a runaway fan-out cannot exhaust
		// the machine (ErrorCodes.BUDGET_EXCEEDED).
		maxSpawns: settings.maxSubagentSpawnsPerSession ?? null,
		workspaceId: process.env.HERDR_WORKSPACE_ID,
		parentPaneId: process.env.HERDR_PANE_ID,
	});

	const session: LaunchSession = {
		params,
		store,
		agents,
		settings,
		runId: run.runId,
		orchestrator,
		runtime,
		onUpdate,
		dispatchModel: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined,
		results: [],
		handles: [],
		timeoutByName: new Map(),
	};

	// Chain steps depend on prior output; everything else launches in parallel
	// so two scouts do not wait on each other's agentStart.
	if (params.chain?.length) {
		for (const step of plan.steps) await launchStep(session, step);
	} else {
		await Promise.all(plan.steps.map((step) => launchStep(session, step)));
	}

	// Persist children first so a crash during the wait still leaves a record.
	for (const name of session.handles) {
		await persistChild(store, run.runId, orchestrator, name);
	}

	// Collect inline unless the caller asked for async (the default).
	// Async: the session runtime watches each child and wakes the parent
	// with a completion message — children must not prompt the parent.
	const isAsync = params.async ?? true;
	for (const name of session.handles) {
		followLaunched(session, name, { watch: isAsync });
	}
	if (!isAsync) {
		await collectInline(session);
		for (const name of session.handles) {
			const child = orchestrator
				.childrenSnapshot()
				.find((c) => c.name === name);
			if (
				child?.execution &&
				shouldRecycleAfterCollect(child.execution.status)
			) {
				await orchestrator.retire(name);
			}
			await persistChild(store, run.runId, orchestrator, name);
			runtime.release(name);
		}
	}

	// Record the type-tab the children joined so a later process can see it.
	if (orchestrator.tabId) {
		await store.updateRun(run.runId, (r) => {
			r.herdr = {
				...r.herdr,
				tabId: orchestrator.tabId ?? undefined,
			};
		});
	}

	if (isAsync && session.handles.length > 0) {
		session.results.push(
			"↳ async: a completion message is queued when each child finishes. If this session is idle it wakes immediately; if it is still working the notice waits until the current turn ends. Running children show next to the input. Do not tell children to message the parent; do not poll just to wait.",
		);
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
	runtime: SessionRuntime;
	onUpdate?: AgentToolUpdateCallback;
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
	step: { agent: string; task: string; model?: string; preset?: string; worktree?: boolean },
): Promise<void> {
	const agent = findAgent(session.agents, step.agent);
	if (!agent) {
		session.results.push(unknownAgentLine(session.agents, step.agent));
		return;
	}
	if (agent.disabled) {
		session.results.push(`✗ agent "${step.agent}" is disabled`);
		return;
	}

	try {
		// Preset expansion and the scope check can THROW (an undefined preset is
		// a loud error by design), so both run INSIDE the guard. Leaving them
		// above it let a single bad `preset:` reject the whole `Promise.all`,
		// discarding the refusal lines of every healthy sibling step.
		const model = resolveStep(session, agent, step);
		// When a preset is referenced this carries the preset's kind/model/thinking;
		// otherwise it is the ORIGINAL agent object (zero drift for no-preset runs).
		const effective = model.agent;
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

		// Let `launch()` allocate: it consults the GLOBAL herdr name namespace.
		// Pre-allocating here from local state alone would bypass that check and
		// collide with another session's agent.
		const handle = await session.orchestrator.launch({
			agent: effective,
			task: step.task,
			...(resolved.model ? { model: resolved.model } : {}),
			// The origin decides whether an unacceptable model is refused or
			// dropped, and only this layer can tell them apart (a parent model
			// arrives as the same `dispatch` source as a per-run override).
			modelOrigin: model.modelOrigin,
			...(model.placement ? { placement: model.placement } : {}),
			worktree: resolveLaunchWorktree({
				roleDefault: effective.worktree,
				launch: session.params.worktree,
				step: step.worktree,
			}),
		});
		await session.store.addChild(session.runId, handle.child);
		session.handles.push(handle.name);
		if (effective.timeoutMs !== undefined) {
			session.timeoutByName.set(handle.name, effective.timeoutMs);
		}
		session.results.push(
			`▶ ${handle.name} (${effective.name}) pane=${handle.paneId}`,
		);
		// An inherited model the target CLI cannot express is dropped on purpose
		// (the parent's pi model means nothing to cursor). Say so, or the user
		// reasonably believes the child is running the model they see on the
		// parent — the same silent surprise this whole guard exists to remove.
		if (handle.child.modelDropped?.length) {
			session.results.push(
				`  ⚠ ${effective.name} runs on ${effective.kind}'s own default: ` +
					`${handle.child.modelDropped.join(", ")} does not apply to that CLI.`,
			);
		}
		session.onUpdate?.({
			content: [
				{
					type: "text",
					text: `playbook: ${handle.name} started in ${handle.paneId}`,
				},
			],
			details: {},
		});
		// Surface frontmatter keys that are accepted but inert, so a user does
		// not believe an unenforced setting is protecting them.
		if (effective.unenforcedFields?.length) {
			session.results.push(
				`  ⚠ ${effective.name} sets fields that are not enforced yet: ` +
					`${effective.unenforcedFields.join(", ")}`,
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
 * Resolve the model and placement one step will launch with.
 *
 * The precedence logic itself lives in `resolveStepModel`
 * (`src/agents/step-model.ts`), which is pure and unit-tested; this wrapper
 * only adapts the session shape onto it. An undefined preset name, or a
 * resolved kind/model pair that would be silently dropped at start, throws —
 * `launchStep` renders that as a refusal line, never a silent fallback.
 */
function resolveStep(
	session: LaunchSession,
	agent: AgentConfig,
	step: { model?: string; preset?: string },
): {
	resolved: ReturnType<typeof resolveModel>;
	placement?: Placement;
	agent: AgentConfig;
	modelOrigin: ModelOrigin;
} {
	const { params, settings } = session;
	const result = resolveStepModel({
		agent,
		step,
		params,
		...(session.dispatchModel ? { dispatchModel: session.dispatchModel } : {}),
		settings,
	});
	return {
		resolved: result.resolved,
		...(params.placement ? { placement: params.placement as Placement } : {}),
		agent: result.agent,
		modelOrigin: result.modelOrigin,
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
			steps: Array<{
				agent: string;
				task: string;
				model?: string;
				preset?: string;
				worktree?: boolean;
			}>;
	  }
	| { ok: false; message: string };

export function buildPlan(params: {
	agent?: string;
	task?: string;
	preset?: string;
	tasks?: Array<{
		agent: string;
		task: string;
		model?: string;
		preset?: string;
		worktree?: boolean;
	}>;
	chain?: Array<{
		agent: string;
		task: string;
		model?: string;
		preset?: string;
		worktree?: boolean;
	}>;
	worktree?: boolean;
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
			steps: [
				{
					agent: params.agent as string,
					task: params.task as string,
					...(params.preset ? { preset: params.preset } : {}),
				},
			],
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
	preset?: string;
	worktree?: boolean;
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
 * Keep a live child on the session runtime so the input-box widget can
 * show it, and so a background collect can wake the parent.
 *
 * If a watch is already in flight (steer mid-turn), leave it: that collect
 * covers the current turn. Starting a second watch would double-notify.
 */
function followJob(
	runtime: SessionRuntime,
	input: {
		name: string;
		runId: string;
		agent: string;
		sessionFile: string;
		timeoutMs: number;
		orchestrator: Orchestrator;
		store: RunStore;
		watch: boolean;
	},
): void {
	const child = input.orchestrator
		.childrenSnapshot()
		.find((entry) => entry.name === input.name);
	const existing = runtime.get(input.name);
	const nonPi = child?.kind && child.kind !== "pi";
	runtime.track({
		name: input.name,
		runId: input.runId,
		agent: input.agent,
		sessionFile: input.sessionFile,
		timeoutMs: input.timeoutMs,
		...(child?.kind ? { kind: child.kind } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(child?.thinking !== undefined ? { thinking: child.thinking } : {}),
		...(child?.worktreeBranch ? { worktreeBranch: child.worktreeBranch } : {}),
		...(nonPi
			? { probe: () => input.orchestrator.probeProgress(input.name) }
			: {}),
		collect: () =>
			input.orchestrator.collect(input.name, { timeoutMs: input.timeoutMs }),
		persist: async () =>
			persistChild(input.store, input.runId, input.orchestrator, input.name),
		retire: async () => {
			await input.orchestrator.retire(input.name);
			await persistChild(
				input.store,
				input.runId,
				input.orchestrator,
				input.name,
			);
		},
		handleBlocked: async (snapshot) => {
			const current = input.orchestrator
				.childrenSnapshot()
				.find((entry) => entry.name === input.name);
			const ui = blockedUi.get(runtime);
			const decision = await applyOnBlockedPolicy({
				policy: current?.onBlocked ?? "forward",
				name: input.name,
				reason: snapshot.execution.reason,
				confirm: ui?.getConfirm(),
				approve: () => input.orchestrator.approveBlocked(input.name),
				reject: () => input.orchestrator.rejectBlocked(input.name),
				notify: (message) => {
					ui?.notifyBlocked(message);
				},
			});
			return followUpFor(decision);
		},
	});
	if (!input.watch) return;
	if (existing?.watching) return;
	runtime.watch(input.name);
}

function followChild(ctx: ChildContext, opts: { watch: boolean }): void {
	const timeoutMs =
		ctx.agents.find((a) => a.name === ctx.found.child.agent)?.timeoutMs ??
		DEFAULTS.turnTimeoutMs;
	followJob(ctx.runtime, {
		name: ctx.name,
		runId: ctx.found.runId,
		agent: ctx.found.child.agent ?? "subagent",
		sessionFile: ctx.found.child.sessionFile,
		timeoutMs,
		orchestrator: ctx.orchestrator,
		store: ctx.store,
		watch: opts.watch,
	});
}

function followLaunched(
	session: LaunchSession,
	name: string,
	opts: { watch: boolean },
): void {
	const child = session.orchestrator
		.childrenSnapshot()
		.find((c) => c.name === name);
	followJob(session.runtime, {
		name,
		runId: session.runId,
		agent: child?.agent ?? name,
		sessionFile: child?.sessionFile ?? "",
		timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
		orchestrator: session.orchestrator,
		store: session.store,
		watch: opts.watch,
	});
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

// ---------------------------------------------------------------------------
// wait (§1.5): block for results instead of relying on async notices
// ---------------------------------------------------------------------------

/**
 * Resolve which children a wait targets.
 *
 * `all` covers every LIVE child of this session runtime (working or blocked);
 * `name` targets one. Both pre-check against the runtime so an untracked name
 * fails loudly instead of hanging on a wait that can never resolve.
 */
export function resolveWaitTargets(
	params: { name?: string; all?: boolean },
	jobs: Array<{ name: string; state: string }>,
): { ok: true; names: string[] } | { ok: false; message: string } {
	const live = jobs.filter(
		(job) => job.state === "working" || job.state === "blocked",
	);
	if (params.all) {
		if (live.length === 0) {
			return { ok: false, message: "no running children to wait for." };
		}
		return { ok: true, names: live.map((job) => job.name) };
	}
	const name = params.name;
	if (!name) return { ok: false, message: "`name` or `all` is required for wait" };
	if (live.some((job) => job.name === name)) {
		return { ok: true, names: [name] };
	}
	return {
		ok: false,
		message: `unknown child: ${name} (not a live child of this session).`,
	};
}

/** Render one wait result, reusing the collect shape for finished children. */
export function renderWait(results: WaitResult[]): string {
	let done = 0;
	let running = 0;
	const parts: string[] = [];
	for (const result of results) {
		if (result.snapshot) {
			done += 1;
			parts.push(renderCollect(result.name, result.snapshot));
		} else if (result.stillRunning) {
			running += 1;
			parts.push(`── ${result.name} ──\nstill running`);
		} else {
			parts.push(`── ${result.name} ──\nnot tracked (no live job, no finished cache)`);
		}
	}
	parts.push(`${done} done, ${running} still running`);
	return parts.join("\n");
}

export async function waitAction(input: {
	params: SubagentParams;
	runtime: SessionRuntime;
	agents: AgentConfig[];
	store: RunStore;
	cwd: string;
}): Promise<AgentToolResult<unknown>> {
	const { params, runtime, agents, store, cwd } = input;
	const jobs = runtime.activeJobs();
	let targets = resolveWaitTargets(
		{ name: params.name, all: params.all },
		jobs,
	);
	if (!targets.ok) {
		// A name that is merely finished (not live) is still waitable via the
		// runtime's finished cache — probe it with consumeCollect, which is
		// side-effect free for a job that is not in the live set.
		if (params.name && !params.all) {
			const cached = runtime.consumeCollect(params.name);
			if (cached) {
				targets = { ok: true, names: [params.name] };
			} else {
				return unknownChild(params.name, store, cwd);
			}
		} else {
			return fail(targets.message, ErrorCodes.INVALID_PARAMS);
		}
	}
	// Default timeout: the strictest (smallest) role timeout among the
	// targets. Each child's own collect gives up at its role timeout, so a
	// wait that outlasts it only suppresses the notice without buying data.
	const timeoutMs =
		params.timeoutMs ??
		Math.min(
			...targets.names.map((name) => {
				const role = jobs.find((job) => job.name === name)?.agent;
				return (
					agents.find((a) => a.name === role)?.timeoutMs ??
					DEFAULTS.turnTimeoutMs
				);
			}),
		);
	const results = await runtime.wait(targets.names, { timeoutMs });
	return ok(renderWait(results));
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
	const picked = pickChildByName(runs, name, {
		parentPaneId: process.env.HERDR_PANE_ID,
	});
	if (!picked) return null;
	return { runId: picked.run.runId, run: picked.run, child: picked.child };
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
		blocked?: boolean;
	},
): string {
	const lines = [
		`── ${name} ──`,
		`execution: ${collected.execution.status}${collected.execution.reason ? ` (${collected.execution.reason})` : ""}`,
		`acceptance: ${collected.acceptance.status}${collected.acceptance.level ? ` (${collected.acceptance.level})` : ""}`,
	];
	if (collected.blocked) {
		lines.push(
			"blocked: waiting for a tool approval — the pane is still open. Approve in the parent confirm, or steer the child.",
		);
	}

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
