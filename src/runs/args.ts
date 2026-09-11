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

	// ── session (F1/F4): always explicit so the path is known and durable. ──
	args.push("--session", input.sessionFile);

	// ── model ──
	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) args.push("--model", modelArg);

	// ── tools ──
	const tools = input.agent.tools?.filter(Boolean) ?? [];
	if (tools.length > 0) args.push("--tools", tools.join(","));

	// ── extensions: only pass through what the agent explicitly lists. ──
	const extensions = [
		...(input.agent.extensions ?? []),
		...(input.agent.subagentOnlyExtensions ?? []),
	];
	if (extensions.length > 0) {
		for (const ext of extensions) args.push("--extension", ext);
	}

	// ── skills ──
	if (input.agent.inheritSkills === false) {
		args.push("--no-skills");
	} else if (
		Array.isArray(input.agent.skills) &&
		input.agent.skills.length > 0
	) {
		for (const skill of input.agent.skills) args.push("--skill", skill);
	}
	for (const skillPath of input.agent.skillPath ?? [])
		args.push("--skill", skillPath);

	// ── project context (AGENTS.md etc.) ──
	if (input.agent.inheritProjectContext === false)
		args.push("--no-context-files");

	// ── system prompt ──
	const systemPrompt = input.agent.systemPrompt?.trim();
	if (systemPrompt) {
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

	// ── task ──
	const taskText = `Task: ${input.task}`;
	if (taskText.length > TASK_ARG_LIMIT) {
		const file = path.join(input.tempDir, "task.md");
		fs.writeFileSync(file, taskText, { mode: 0o600 });
		tempFiles.push(file);
		args.push(`@${file}`);
	} else {
		args.push(taskText);
	}

	return { args, tempFiles };
}
