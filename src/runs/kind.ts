/**
 * Kind-specific fill-ins for a Herdr-only control plane.
 *
 * Every child, including pi, is driven the same way:
 *   herdr agent start --kind K --pane P -- <native argv>
 *   herdr agent prompt <name> <task>
 *   herdr agent wait <name>
 *   herdr pane read / session jsonl   (result parser, not a second pipeline)
 *
 * This module only decides the native argv after `--`, how to spell `--model`,
 * and the prompt text. It does not own wait, notify, or recycle.
 */

import {
	type AgentConfig,
	type AgentKind,
	isThinkingLevel,
} from "../shared/types.ts";
import { splitThinkingSuffix } from "../agents/model-scope.ts";
import { formatChildTask } from "../extension/child-guard.ts";
import {
	applyThinkingSuffix,
	type BuildArgsInput,
	buildPiArgs,
} from "./args.ts";

const CURSOR_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
type CursorEffort = (typeof CURSOR_EFFORTS)[number];

const PI_SHAPED_MODEL =
	/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/;

export interface KindStartPlan {
	/** Native CLI argv after `herdr agent start --`. Never includes the task. */
	args: string[];
	tempFiles: string[];
	/** Always delivered with `herdr agent prompt` after start is ready. */
	taskText: string;
	/** `--model` value actually sent. */
	nativeModel?: string;
	/** Stored on ChildRecord; pi keeps the unsuffixed candidate. */
	recordModel?: string;
}

export function planKindStart(input: BuildArgsInput): KindStartPlan {
	const nativeModel = nativeModelFor(
		input.agent.kind,
		input.model,
		input.thinking,
	);
	const taskText = composePrompt(input);
	if (input.agent.kind === "pi") {
		const built = buildPiArgs({ ...input, includeTask: false });
		return {
			args: built.args,
			tempFiles: built.tempFiles,
			taskText,
			...(input.model ? { recordModel: input.model } : {}),
			...(nativeModel ? { nativeModel } : {}),
		};
	}
	return {
		args: nativeStartArgs(input.agent, nativeModel),
		tempFiles: [],
		taskText,
		...(nativeModel ? { nativeModel, recordModel: nativeModel } : {}),
	};
}

/** Map a resolved model id onto the flag the target CLI actually accepts. */
export function nativeModelFor(
	kind: AgentKind,
	model: string | undefined,
	thinking?: string | false,
): string | undefined {
	if (kind === "pi") return applyThinkingSuffix(model, thinking);
	const raw = model?.trim();
	if (!raw) return undefined;
	if (kind === "cursor") return cursorModel(raw, thinking);
	if (isPiShapedModel(raw)) return undefined;
	return raw;
}

export function isPiShapedModel(model: string): boolean {
	return PI_SHAPED_MODEL.test(model.trim());
}

function nativeStartArgs(
	agent: AgentConfig,
	nativeModel: string | undefined,
): string[] {
	const args: string[] = [];
	if (nativeModel) args.push("--model", nativeModel);
	if (agent.kind === "cursor") {
		// `--force` skips command approval. Workspace trust is a different
		// dialog; without `--trust` the TUI sits on "Workspace Trust Required"
		// and `herdr agent prompt` never starts a turn.
		args.push("--trust");
		if (agent.onBlocked === "auto-approve") args.push("--force");
	}
	return args;
}

function composePrompt(input: BuildArgsInput): string {
	const task = formatChildTask(input.task, {
		allowNested: input.allowNestedSubagents === true,
		...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
	});
	// Pi gets the system prompt via `--system-prompt` on start. Other CLIs
	// have no equivalent flag, so it rides along in the Herdr prompt.
	if (input.agent.kind === "pi") return task;
	const system = input.agent.systemPrompt?.trim();
	return system ? `${system}\n\n${task}` : task;
}

/**
 * Cursor CLI slugs look like `cursor-grok-4.6-high`, not `provider/id:thinking`.
 * A parent pi model (`cb/glm-5.3`) is dropped rather than forwarded.
 *
 * Grok slug schema, measured against `cursor-agent --list-models` (2026-09-27):
 *   grok-4.5 / 4.6 → `cursor-grok-<v>-<effort>(-fast)?`  (prefixed)
 *   grok-4.7+      → `grok-<v>-<effort>(-fast)?`        (NO prefix)
 * SDK parameter schemas (Cursor.models.list(), ~/.pi/agent/cursor-sdk-model-list.json):
 *   grok-4.5 / 4.6 → effort, fast
 *   grok-4.7       → context(256k|500k), reasoning_effort, fast
 */

/** `grok-4.6` → 406, `grok-4.7` → 407, `grok-4.10` → 410. Dot-decimal would misorder 4.10 < 4.7. */
function grokVersion(id: string): number | undefined {
	const m = id.match(/^grok-(\d+)\.(\d+)$/);
	if (!m || m[1] === undefined || m[2] === undefined) return undefined;
	return Number(m[1]) * 100 + Number(m[2]);
}

/** Highest grok whose CLI slug still carries the `cursor-` prefix (measured: 4.6). */
const GROK_LAST_PREFIXED = 406;

/** grok ≤4.6 slugs carry the `cursor-` prefix; 4.7+ dropped it. */
function grokSlugPrefix(version: number): string {
	return version <= GROK_LAST_PREFIXED ? "cursor-grok" : "grok";
}

/**
 * Expand a pi-cursor-sdk style context alias — `grok-4.7@500k`,
 * `cursor/grok-4.7@500k` — into the bracket form the CLI accepts:
 * `grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]`.
 *
 * Measured (2026-09-27): the CLI rejects PARTIAL bracket lists, so every SDK
 * param of the model must be present — `fast` gets an explicit `false`.
 * Only grok-4.7+ exposes `context` (4.5/4.6 have no context variants), so an
 * @-alias for an older grok is not a real cursor id and passes through
 * untouched for the CLI to report.
 */
function expandCursorSdkAlias(
	compact: string,
	effort: CursorEffort,
): string {
	const alias = compact.match(/^(?:cursor\/)?(.+?)@(\d+[km])$/);
	if (!alias || alias[1] === undefined || alias[2] === undefined) return compact;
	const base = alias[1];
	const context = alias[2].toLowerCase();
	const version = grokVersion(base);
	if (version === undefined || version < 407) return compact;
	return `${base}[context=${context},reasoning_effort=${effort},fast=false]`;
}

export function cursorModel(
	model: string,
	thinking?: string | false,
): string | undefined {
	// A pi-style `:level` suffix (`grok-4.7@500k:xhigh`) is the embedded form
	// of `thinking`; the suffix wins, mirroring pi's applyThinkingSuffix
	// precedence for provider/id:level ids.
	const split = splitThinkingSuffix(model.trim());
	const effectiveThinking = split.thinking ?? thinking;
	const compact = split.baseModel.trim().replace(/\s+/g, "-");
	if (!compact) return undefined;
	if (isPiShapedModel(compact)) return undefined;
	if (compact.includes("[")) return compact;

	const effort = cursorEffort(effectiveThinking);
	const lower = compact.toLowerCase();

	// Cursor ships two Autos: legacy `auto`/`default` (bundled Auto pricing)
	// and Router `auto-smart` (Balance/Intelligence bill the routed model).
	// Do not collapse `auto` into Auto Balance — cheap search agents want the
	// legacy slug, and billing lists them as distinct line items.
	if (lower === "auto" || lower === "default") return "auto";

	if (
		lower === "auto-smart" ||
		lower === "auto-balance" ||
		lower === "autobalance"
	) {
		return "auto-smart[optimize_for=balanced]";
	}

	// pi-cursor-sdk context alias: preserve the context variant via the
	// bracket form instead of degrading to the default-context slug.
	if (compact.includes("@")) {
		return expandCursorSdkAlias(lower, effort ?? "high");
	}

	const bareGrok = lower.match(/^(?:cursor-)?grok-(\d+\.\d+)$/);
	if (bareGrok && bareGrok[1] !== undefined) {
		const version = grokVersion(`grok-${bareGrok[1]}`) ?? 0;
		return `${grokSlugPrefix(version)}-${bareGrok[1]}-${effort ?? "high"}`;
	}

	// An already-slugged grok, with or without the `cursor-` prefix: rebuild
	// the prefix per version so a pre-fix `cursor-grok-4.7-xhigh` is repaired,
	// and swap the effort when thinking was given.
	const slugged = lower.match(
		/^(?:cursor-)?grok-(\d+\.\d+)-(low|medium|high|xhigh)(-fast)?$/,
	);
	if (slugged && slugged[1] !== undefined && slugged[2] !== undefined) {
		const version = grokVersion(`grok-${slugged[1]}`) ?? 0;
		const keep = effort ?? slugged[2];
		return `${grokSlugPrefix(version)}-${slugged[1]}-${keep}${slugged[3] ?? ""}`;
	}

	return compact;
}

function cursorEffort(thinking?: string | false): CursorEffort | undefined {
	if (thinking === undefined) return undefined;
	if (thinking === false || thinking === "off") return "low";
	if (thinking === "minimal") return "low";
	if (thinking === "max") return "xhigh";
	if ((CURSOR_EFFORTS as readonly string[]).includes(thinking)) {
		return thinking as CursorEffort;
	}
	return isThinkingLevel(thinking) ? "high" : undefined;
}
