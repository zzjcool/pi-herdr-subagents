/**
 * Guards that run inside a child Pi process.
 *
 * The parent session already blocks the herdr launch ritual. Children do not
 * load parent-only tools, so without this module they can still `herdr agent
 * prompt` the parent pane. The launcher always injects this extension into
 * child argv and sets PI_SUBAGENT_CHILD=1.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	budgetExceededReason,
	childBudgetFromEnv,
	wrapBashWithTimeout,
} from "./budget.ts";
import { shellChunks } from "./playbook.ts";

export const CHILD_ROLE_ENV = "PI_SUBAGENT_ROLE";
export const CHILD_ACCEPTANCE_ROLE_ENV = "PI_SUBAGENT_ACCEPTANCE_ROLE";

export function childTaskAppendix(opts?: {
	allowNested?: boolean;
	worktreeBranch?: string;
}): string {
	const nested = opts?.allowNested
		? "- Nested subagents are allowed via the `subagent` tool. Do not use herdr to spawn them."
		: "- Do not spawn nested agents.";
	const worktree = opts?.worktreeBranch
		? [
				`- You are in an isolated git worktree on branch \`${opts.worktreeBranch}\`. Do not write the parent checkout.`,
				"- Commit on this branch and open a merge request / pull request into the repository default branch. Do not merge locally. Do not push to main or master. Put the MR/PR URL in your verdict reason.",
			]
		: [];
	return [
		"## Frozen child constraints (injected by herdr-subagents)",
		"- Do not message, prompt, wait on, or send keys to any other pane. The parent extension delivers your result.",
		"- Do not read or close panes that are not yours.",
		nested,
		...worktree,
		"- End with machine-readable JSON on its own: {\"ok\": true|false, \"reason\": \"...\"}.",
	].join("\n");
}

export const CHILD_TASK_APPENDIX = childTaskAppendix();

export function formatChildTask(
	task: string,
	opts?: { allowNested?: boolean; worktreeBranch?: string },
): string {
	return `Task: ${task}\n\n${childTaskAppendix(opts)}\n`;
}

/** Refusal shown inside the child — never the parent launch playbook. */
export function blockChildMessage(reason: string): string {
	return `${reason}\n\n${CHILD_TASK_APPENDIX}`;
}

export function isReadOnlyRole(role: string | undefined): boolean {
	return role === "read-only";
}

export interface ChildGuardEnv {
	paneId?: string;
	acceptanceRole?: string;
}

function herdrArgv(chunk: string): string[] | undefined {
	const match = chunk.match(/^(?:command\s+-v\s+)?herdr(?:\s+(.*))?$/);
	if (!match) {
		const embedded = chunk.match(/\bherdr(?:\s+(.*))$/);
		if (!embedded) return undefined;
		return ["herdr", ...(embedded[1] ? embedded[1].split(" ") : [])];
	}
	return ["herdr", ...(match[1] ? match[1].split(" ") : [])];
}

const CHILD_AGENT_SUBS = new Set([
	"start",
	"prompt",
	"wait",
	"send-keys",
]);

function classifyChildHerdr(
	argv: string[],
	env: ChildGuardEnv,
): string | undefined {
	const args = argv.slice(1).filter((part) => part.length > 0);
	const group = args[0] ?? "";
	const sub = args[1];

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return "a child must not probe the herdr CLI.";
	}
	if (group === "agent" && sub && CHILD_AGENT_SUBS.has(sub)) {
		return "a child must not dispatch herdr agent start/prompt/wait/send-keys; the parent delivers completion.";
	}
	if (group === "pane" && sub === "split") {
		return "a child must not split panes.";
	}
	if (group === "tab" && (sub === "create" || sub === "close")) {
		return "a child must not create or close tabs.";
	}
	if (group === "pane" && (sub === "read" || sub === "close")) {
		const target = args[2];
		if (!env.paneId) {
			return "a child may not read or close panes when its own pane id is unknown.";
		}
		if (target && target !== env.paneId) {
			return `a child may only ${sub} its own pane (${env.paneId}), not ${target}.`;
		}
	}
	return undefined;
}

const WRITE_HEADS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"ln",
	"install",
	"tee",
	"dd",
	"truncate",
]);

const WRITE_GIT = new Set([
	"add",
	"commit",
	"push",
	"checkout",
	"reset",
	"rebase",
	"merge",
	"stash",
	"tag",
	"cherry-pick",
	"clean",
	"restore",
	"mv",
	"rm",
]);

const WRITE_NPM = new Set(["install", "uninstall", "ci", "publish", "link"]);

function firstToken(chunk: string): string {
	const trimmed = chunk.trim();
	const match = trimmed.match(/^(\S+)/);
	return match?.[1] ?? "";
}

function hasFilesystemRedirect(command: string): boolean {
	return /(?:^|[^0-9&])>{1,2}\s*(?!\/dev\/null\b)/.test(command);
}

function classifyReadonlyBash(command: string): string | undefined {
	if (hasFilesystemRedirect(command)) {
		return "read-only child must not redirect output onto the filesystem.";
	}
	for (const chunk of shellChunks(command)) {
		const head = firstToken(chunk).replace(/^\\/, "");
		if (WRITE_HEADS.has(head)) {
			return `read-only child must not run \`${head}\`.`;
		}
		if (head === "git") {
			const sub = chunk.trim().split(/\s+/)[1] ?? "";
			if (WRITE_GIT.has(sub)) {
				return `read-only child must not run \`git ${sub}\`.`;
			}
		}
		if (head === "npm" || head === "npx" || head === "pnpm" || head === "yarn") {
			const sub = chunk.trim().split(/\s+/)[1] ?? "";
			if (WRITE_NPM.has(sub) || head !== "npm") {
				return `read-only child must not run package-manager writes (\`${head} ${sub}\`).`;
			}
			if (sub === "install" || sub === "i") {
				return "read-only child must not run npm install.";
			}
		}
		if (head === "sed" && /(^|\s)-i(\s|$)/.test(chunk)) {
			return "read-only child must not run `sed -i`.";
		}
	}
	return undefined;
}

/**
 * If this bash command is forbidden inside a child session, return why.
 */
export function forbiddenChildReason(
	command: string,
	env: ChildGuardEnv = {},
): string | undefined {
	for (const chunk of shellChunks(command)) {
		const argv = herdrArgv(chunk);
		if (!argv) continue;
		const reason = classifyChildHerdr(argv, env);
		if (reason) return reason;
	}

	if (isReadOnlyRole(env.acceptanceRole)) {
		const write = classifyReadonlyBash(command);
		if (write) return write;
	}

	return undefined;
}

export function childGuardEnvFromProcess(
	env: NodeJS.ProcessEnv = process.env,
): ChildGuardEnv {
	return {
		...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}),
		...(env[CHILD_ACCEPTANCE_ROLE_ENV]
			? { acceptanceRole: env[CHILD_ACCEPTANCE_ROLE_ENV] }
			: {}),
	};
}

/** Child-only extension: intercept tools, do not register the subagent tool. */
export function registerChildGuard(pi: ExtensionAPI): void {
	const budget = childBudgetFromEnv();
	let toolCalls = 0;
	let turns = 0;

	pi.on("turn_start", () => {
		turns += 1;
	});

	pi.on("tool_call", (event) => {
		toolCalls += 1;
		if (
			budget.maxToolCalls !== undefined &&
			toolCalls > budget.maxToolCalls
		) {
			return {
				block: true,
				reason: blockChildMessage(
					budgetExceededReason("tool", budget.maxToolCalls),
				),
			};
		}
		if (budget.maxTurns !== undefined && turns > budget.maxTurns) {
			return {
				block: true,
				reason: blockChildMessage(
					budgetExceededReason("turn", budget.maxTurns),
				),
			};
		}

		if (event.toolName !== "bash") return;
		const command =
			typeof event.input.command === "string" ? event.input.command : "";
		const reason = forbiddenChildReason(command, childGuardEnvFromProcess());
		if (reason) {
			return { block: true, reason: blockChildMessage(reason) };
		}
		if (budget.toolTimeoutMs && budget.toolTimeoutMs > 0) {
			event.input.command = wrapBashWithTimeout(
				command,
				budget.toolTimeoutMs,
			);
		}
		return undefined;
	});
}
