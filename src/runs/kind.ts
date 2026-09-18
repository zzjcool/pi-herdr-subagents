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
 */
export function cursorModel(
	model: string,
	thinking?: string | false,
): string | undefined {
	const compact = model.trim().replace(/\s+/g, "-");
	if (!compact) return undefined;
	if (isPiShapedModel(compact)) return undefined;
	if (compact.includes("[")) return compact;

	const effort = cursorEffort(thinking);
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

	const bareGrok = lower.match(/^(?:cursor-)?grok-(\d+\.\d+)$/);
	if (bareGrok) return `cursor-grok-${bareGrok[1]}-${effort ?? "high"}`;

	const slugged = lower.match(
		/^(cursor-grok-\d+\.\d+)-(low|medium|high|xhigh)(-fast)?$/,
	);
	if (slugged) {
		if (effort === undefined) return compact;
		return `${slugged[1]}-${effort}${slugged[3] ?? ""}`;
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
