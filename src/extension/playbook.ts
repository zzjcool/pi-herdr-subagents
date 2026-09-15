/**
 * Frozen parent playbook.
 *
 * The LLM must not improvise `herdr --help` / pane split / agent start every
 * time it wants a child. One tool call is the whole launch path; this module
 * is the text of that path and the detector that blocks the old ritual.
 */

export const PLAYBOOK_NAME = "herdr-subagent-playbook";

/** Injected into the tool description, the skill, and the system prompt. */
export const PARENT_PLAYBOOK = [
	"Herdr subagent playbook (frozen — do not invent a launch recipe):",
	"1. Call the `subagent` tool immediately. Do not run bash, herdr, --help, env checks, pane list, or agent list first.",
	"   One child:  subagent({ agent: \"worker\", task: \"...\" })",
	"   Parallel:   subagent({ tasks: [{ agent, task }, { agent, task }] })",
	"2. Same agent type shares one tab (each child is a pane). Different types get different tabs. Prefer tasks[] over two separate tool calls.",
	"3. Then return control. Running children show next to the input. A completion message wakes this session. Finished children recycle their pane (and the type tab when it is empty) automatically — do not retire or close panes. Resume from the session file if you need the child again.",
	"4. Later control is only `subagent({ action: \"steer\"|\"continue\"|\"resume\"|\"collect\"|\"status\"|\"list\", name })`.",
	"Forbidden: `herdr --help`, bare `herdr agent|pane|tab`, `herdr pane split`, `herdr agent start|prompt|wait`, `test HERDR_ENV`, telling a child to prompt this pane.",
].join("\n");

export const TOOL_DESCRIPTION = [
	PARENT_PLAYBOOK,
	"Launch is async by default. Outcomes come from the child session JSONL, not herdr's agent_status.",
	"Actions: launch (default), continue, steer, resume, status, collect, list. Panes recycle automatically when a turn finishes.",
].join(" ");

const DISCOVERY_GROUPS = new Set([
	"agent",
	"pane",
	"tab",
	"workspace",
	"worktree",
	"terminal",
	"notification",
	"integration",
	"session",
	"machine",
]);

const DISPATCH_AGENT_SUBS = new Set([
	"start",
	"prompt",
	"wait",
	"send-keys",
]);

/** Split a shell line into sequential chunks (`&&` / `||` / `;` / newlines). */
export function shellChunks(command: string): string[] {
	return command
		.split(/\s*(?:&&|\|\||;|\n)\s*/)
		.map((chunk) => chunk.replace(/\s+/g, " ").trim())
		.filter((chunk) => chunk.length > 0);
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

function classifyHerdr(argv: string[]): string | undefined {
	const args = argv.slice(1).filter((part) => part.length > 0);
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		return "herdr CLI discovery is not part of launch; call `subagent({ agent, task })`.";
	}
	const group = args[0] ?? "";
	const sub = args[1];
	if (DISCOVERY_GROUPS.has(group) && (!sub || sub.startsWith("-"))) {
		return `do not probe \`herdr ${group}\`; the subagent tool already knows how to launch.`;
	}
	if (group === "agent" && sub && DISPATCH_AGENT_SUBS.has(sub)) {
		return `do not \`${argv.join(" ")}\`; that is the old dispatch ritual. Call \`subagent({ agent, task })\`.`;
	}
	if (group === "pane" && sub === "split") {
		return "do not split panes to start a child; `subagent` creates the tab/pane/start sequence.";
	}
	return undefined;
}

function isHerdrEnvProbe(chunk: string): boolean {
	if (!/\bHERDR_ENV\b/.test(chunk)) return false;
	return /(?:^|[\s;&|])(?:test|\[)\s/.test(chunk);
}

/**
 * If this bash command is the old "prepare to launch a subagent" ritual,
 * return the refusal the model should see. Otherwise `undefined` (allow).
 */
export function forbiddenDispatchReason(command: string): string | undefined {
	for (const chunk of shellChunks(command)) {
		if (isHerdrEnvProbe(chunk)) {
			return "skip HERDR_ENV probes; the subagent tool checks herdr itself.";
		}
		const argv = herdrArgv(chunk);
		if (!argv) continue;
		const reason = classifyHerdr(argv);
		if (reason) return reason;
	}
	return undefined;
}

export function blockMessage(reason: string): string {
	return `${reason}\n\n${PARENT_PLAYBOOK}`;
}
