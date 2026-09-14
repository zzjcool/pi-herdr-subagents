/**
 * Build the `pi` CLI argv for a child agent.
 *
 * Design refs: §9 (launch), §6.1 (agent config).
 * Measured refs: F1 (session path), F3/F4 (session pre-creation), F17 (name rules).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AgentConfig,
	THINKING_LEVELS,
	isThinkingLevel,
} from "../shared/types.ts";

/** Re-exported for callers that only need the level list. */
export { THINKING_LEVELS };

/**
 * Append `:<thinking>` to a model id, unless it already carries a known suffix.
 *
 * Mirrors pi-subagents: an explicit `provider/model:level` wins over the
 * agent's `thinking` setting unless `replaceExisting` is set.
 */
export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting = false,
): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && isThinkingLevel(model.slice(colonIdx + 1))) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

/** Task text longer than this is passed via a file to avoid argv limits. */
export const TASK_ARG_LIMIT = 8_000;

export interface BuildArgsInput {
	agent: AgentConfig;
	task: string;
	/** Absolute path to the (pre-created) session file. */
	sessionFile: string;
	/** Resolved model id, may already include a `:thinking` suffix. */
	model?: string;
	thinking?: string | false;
	/** Where to write an oversized task / system prompt. */
	tempDir: string;
	cwd?: string;
	/** Whether the child may spawn its own subagents. */
	allowNestedSubagents?: boolean;
}

export interface BuildArgsResult {
	args: string[];
	/** Files created under tempDir that the caller should clean up. */
	tempFiles: string[];
}

/**
 * Compose the child argv.
 *
 * Ordering follows pi's CLI: session → model → tools → extensions → skills →
 * system prompt → task.
 */
export function buildPiArgs(input: BuildArgsInput): BuildArgsResult {
	const args: string[] = [];
	const tempFiles: string[] = [];

	// Ordering follows pi's CLI: session → model → tools → extensions → skills
	// → system prompt → task. Each helper appends its own flags.
	args.push("--session", input.sessionFile);
	pushModelArgs(args, input);
	pushToolArgs(args, input.agent);
	pushSkillArgs(args, input.agent);
	pushSystemPromptArgs(args, tempFiles, input);
	pushTaskArg(args, tempFiles, input);

	return { args, tempFiles };
}

/** `--model provider/id[:thinking]`, omitted when no model resolved. */
function pushModelArgs(args: string[], input: BuildArgsInput): void {
	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) args.push("--model", modelArg);
}

/** `--tools a,b`, plus one `--extension` per explicitly listed extension. */
function pushToolArgs(args: string[], agent: AgentConfig): void {
	const tools = agent.tools?.filter(Boolean) ?? [];
	if (tools.length > 0) args.push("--tools", tools.join(","));

	// Only pass through what the agent explicitly lists: a child must not
	// silently inherit every extension the parent happens to have loaded.
	const extensions = [
		...(agent.extensions ?? []),
		...(agent.subagentOnlyExtensions ?? []),
	];
	for (const ext of extensions) args.push("--extension", ext);
}

/**
 * Skills and project context.
 *
 * `inheritSkills: false` must suppress the parent's skills, which `--no-skills`
 * does; otherwise the agent's own list plus any explicit paths are added.
 */
function pushSkillArgs(args: string[], agent: AgentConfig): void {
	if (agent.inheritSkills === false) {
		args.push("--no-skills");
	} else if (Array.isArray(agent.skills) && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}
	for (const skillPath of agent.skillPath ?? []) {
		args.push("--skill", skillPath);
	}

	if (agent.inheritProjectContext === false) args.push("--no-context-files");
}

/**
 * Write the system prompt to a file and reference it.
 *
 * Passed by path rather than inline so a long prompt cannot hit the argv limit,
 * and so the file's mode (0600) keeps it out of other users' reach.
 */
function pushSystemPromptArgs(
	args: string[],
	tempFiles: string[],
	input: BuildArgsInput,
): void {
	const systemPrompt = input.agent.systemPrompt?.trim();
	if (!systemPrompt) return;

	const file = path.join(input.tempDir, "system-prompt.md");
	fs.writeFileSync(file, systemPrompt, { mode: 0o600 });
	tempFiles.push(file);
	args.push(
		input.agent.systemPromptMode === "replace"
			? "--system-prompt"
			: "--append-system-prompt",
		file,
	);
}

/**
 * The task itself, inline unless it would exceed the argv budget.
 * An over-long task is written to a file and referenced with `@path`, which pi
 * expands — the alternative is an E2BIG failure at exec time.
 */
function pushTaskArg(
	args: string[],
	tempFiles: string[],
	input: BuildArgsInput,
): void {
	const taskText = `Task: ${input.task}`;
	if (taskText.length <= TASK_ARG_LIMIT) {
		args.push(taskText);
		return;
	}
	const file = path.join(input.tempDir, "task.md");
	fs.writeFileSync(file, taskText, { mode: 0o600 });
	tempFiles.push(file);
	args.push(`@${file}`);
}
