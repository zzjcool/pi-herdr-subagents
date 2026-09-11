/**
 * Agent discovery: load `agents/*.md` definitions.
 *
 * Design refs: §6.1 (frontmatter fields), §6.2 (model precedence).
 * A single malformed file must never take down the rest of discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentConfig,
	AgentDiscoveryResult,
	AgentKind,
	AgentScope,
	AgentSource,
	AcceptanceConfig,
	OnBlockedPolicy,
	Placement,
	SystemPromptMode,
	ToolBudgetConfig,
	TurnBudgetConfig,
} from "../shared/types.ts";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";

export const BUILTIN_AGENT_NAMES = [
	"scout",
	"planner",
	"reviewer",
	"worker",
	"oracle",
] as const;

/**
 * Agent definitions shipped with this package.
 *
 * Anchored to the module rather than to `~/.pi/agent`, because pi's package
 * resource conventions (`extensions/`, `skills/`, `prompts/`, `themes/`) have no
 * slot for `agents/`. A package manifest entry would be silently ignored, so the
 * bundled roles would never be discovered. Resolving `../../agents` from
 * `src/agents/agents.ts` lands on the package root.
 */
export const BUILTIN_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

/**
 * Extra read-only directories to scan for agent definitions, PATH-style.
 *
 * Lets a hermetic install (Nix store, container, read-only mount) expose bundled
 * or vendored roles without copying them into the writable user agent dir. These
 * load as `user`-level, at LOWER precedence than the real user directory, so a
 * user's own definition of the same name still wins.
 */
export const EXTRA_AGENT_DIRS_ENV = "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS";

/** Split `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` into absolute directory paths. */
function extraAgentDirs(): string[] {
	const raw = process.env[EXTRA_AGENT_DIRS_ENV];
	if (!raw) return [];
	return raw.split(path.delimiter).flatMap((entry) => {
		const trimmed = entry.trim();
		return trimmed ? [path.resolve(trimmed)] : [];
	});
}

const VALID_KINDS: ReadonlySet<string> = new Set([
	"pi",
	"claude",
	"codex",
	"cursor",
	"gemini",
	"opencode",
	"copilot",
	"droid",
	"kimi",
	"qwen",
]);

const VALID_PLACEMENTS: ReadonlySet<string> = new Set([
	"split-down",
	"split-right",
	"new-tab",
]);
const VALID_ON_BLOCKED: ReadonlySet<string> = new Set([
	"forward",
	"auto-approve",
	"notify",
]);
const VALID_ACCEPTANCE_LEVELS: ReadonlySet<string> = new Set([
	"none",
	"attested",
	"verified",
]);

/** Raw frontmatter values are `unknown`: a YAML scalar or collection may appear. */
type AgentFrontmatter = Record<string, unknown>;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function int(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim()))
		return Number(value.trim());
	return undefined;
}

/**
 * Accept `tools: read, bash`, `tools: [read, bash]`, and block-list spellings.
 *
 * The frontmatter parser stores flow arrays as the raw string `[read, bash]`,
 * so strip the brackets before splitting on commas.
 */
function list(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		const inner =
			trimmed.startsWith("[") && trimmed.endsWith("]")
				? trimmed.slice(1, -1)
				: trimmed;
		return parseFrontmatterList(inner);
	}
	return undefined;
}

/** `false` is meaningful for skills (disable inheritance), so it is distinct from absent. */
function listOrFalse(value: unknown): string[] | false | undefined {
	if (value === false || value === "false") return false;
	return list(value);
}

function parseAcceptance(value: unknown): AcceptanceConfig | undefined {
	const raw = str(value);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const level = str(parsed.level);
		if (!level || !VALID_ACCEPTANCE_LEVELS.has(level)) return undefined;
		const out: AcceptanceConfig = { level: level as AcceptanceConfig["level"] };
		const role = str(parsed.role);
		if (role === "read-only" || role === "writer" || role === "unknown")
			out.role = role;
		if (Array.isArray(parsed.criteria)) {
			out.criteria = parsed.criteria
				.filter(
					(c): c is Record<string, unknown> =>
						Boolean(c) && typeof c === "object",
				)
				.map((c) => ({
					id: str(c.id) ?? "",
					must: str(c.must) ?? "",
					...(list(c.evidence) ? { evidence: list(c.evidence) } : {}),
					...(str(c.severity) === "required" || str(c.severity) === "optional"
						? { severity: str(c.severity) as "required" | "optional" }
						: {}),
				}))
				.filter((c) => c.id && c.must);
		}
		return out;
	} catch {
		return undefined;
	}
}

function parseBudget(value: unknown): ToolBudgetConfig | undefined {
	const raw = str(value);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const max = int(parsed.maxToolCalls);
		return max !== undefined ? { maxToolCalls: max } : undefined;
	} catch {
		return undefined;
	}
}

function parseTurnBudget(value: unknown): TurnBudgetConfig | undefined {
	const raw = str(value);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const max = int(parsed.maxTurns);
		return max !== undefined ? { maxTurns: max } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Convert one markdown document into an AgentConfig.
 * Returns `null` (never throws) when the file is not a usable agent definition.
 */
export function parseAgentDocument(
	content: string,
	filePath: string,
	source: AgentSource,
): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter(content);
	const fm = frontmatter as AgentFrontmatter;

	const name = str(fm.name);
	const description = str(fm.description);
	if (!name || !description) return null;

	// Validate enums; an invalid value falls back to the default rather than
	// failing the whole file, so a typo degrades instead of breaking discovery.
	const rawKind = str(fm.kind);
	const kind: AgentKind =
		rawKind && VALID_KINDS.has(rawKind) ? (rawKind as AgentKind) : "pi";

	const rawPlacement = str(fm.placement);
	const placement: Placement | undefined =
		rawPlacement && VALID_PLACEMENTS.has(rawPlacement)
			? (rawPlacement as Placement)
			: undefined;

	const rawOnBlocked = str(fm.onBlocked);
	const onBlocked: OnBlockedPolicy | undefined =
		rawOnBlocked && VALID_ON_BLOCKED.has(rawOnBlocked)
			? (rawOnBlocked as OnBlockedPolicy)
			: undefined;

	const rawMode = str(fm.systemPromptMode);
	const systemPromptMode: SystemPromptMode =
		rawMode === "append" ? "append" : "replace";

	const config: AgentConfig = {
		name,
		description,
		systemPromptMode,
		// Defaults chosen to match pi-subagents conventions (design §6.1).
		inheritProjectContext: bool(fm.inheritProjectContext) ?? true,
		inheritSkills: bool(fm.inheritSkills) ?? false,
		kind,
		systemPrompt: body,
		source,
		filePath,
		frontmatterFields: new Set(Object.keys(frontmatter)),
	};

	const model = str(fm.model);
	if (model) config.model = model;
	const fallback = list(fm.fallbackModels);
	if (fallback) config.fallbackModels = fallback;

	const thinking = fm.thinking;
	if (thinking === false || thinking === "false") config.thinking = false;
	else if (str(thinking)) config.thinking = str(thinking);

	const tools = list(fm.tools);
	if (tools) config.tools = tools;
	const skills = listOrFalse(fm.skills);
	if (skills !== undefined) config.skills = skills;
	const skillPath = list(fm.skillPath);
	if (skillPath) config.skillPath = skillPath;
	const extensions = list(fm.extensions);
	if (extensions) config.extensions = extensions;
	const subagentOnly = list(fm.subagentOnlyExtensions);
	if (subagentOnly) config.subagentOnlyExtensions = subagentOnly;
	const alias = list(fm.alias) ?? list(fm.aliases);
	if (alias) config.alias = alias;

	const output = str(fm.output);
	if (output) config.output = output;
	const defaultReads = list(fm.defaultReads);
	if (defaultReads) config.defaultReads = defaultReads;

	const progress = bool(fm.defaultProgress);
	if (progress !== undefined) config.defaultProgress = progress;
	const async = bool(fm.async);
	if (async !== undefined) config.async = async;
	const timeoutMs = int(fm.timeoutMs);
	if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
	const toolTimeoutMs = int(fm.toolTimeoutMs);
	if (toolTimeoutMs !== undefined) config.toolTimeoutMs = toolTimeoutMs;
	const guard = bool(fm.completionGuard);
	if (guard !== undefined) config.completionGuard = guard;
	const depth = int(fm.maxSubagentDepth);
	if (depth !== undefined) config.maxSubagentDepth = depth;
	const nested = bool(fm.allowNestedSubagents);
	if (nested !== undefined) config.allowNestedSubagents = nested;
	const disabled = bool(fm.disabled);
	if (disabled !== undefined) config.disabled = disabled;
	const worktree = bool(fm.worktree);
	if (worktree !== undefined) config.worktree = worktree;
	const steer = bool(fm.steer);
	if (steer !== undefined) config.steer = steer;

	const acceptance = parseAcceptance(fm.acceptance);
	if (acceptance) config.acceptance = acceptance;
	const toolBudget = parseBudget(fm.toolBudget);
	if (toolBudget) config.toolBudget = toolBudget;
	const turnBudget = parseTurnBudget(fm.turnBudget);
	if (turnBudget) config.turnBudget = turnBudget;

	if (placement) config.placement = placement;
	if (onBlocked) config.onBlocked = onBlocked;

	return config;
}

/** Load every usable `*.md` agent definition from a directory. */
export function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents; // missing/unreadable directory is not an error
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgentDocument(content, filePath, source);
		if (agent) agents.push(agent);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk up from `cwd` looking for `.pi/agents`.
 * Stops at the filesystem root so a project without the directory is cheap.
 */
export function findNearestProjectAgentsDir(
	cwd: string,
	configDirName = ".pi",
): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface DiscoverOptions {
	/** Override the user-level agents directory (tests). */
	userAgentsDir?: string;
	/** Override the project config directory name. */
	configDirName?: string;
	/** Override the bundled agents directory (tests). */
	builtinAgentsDir?: string;
	/**
	 * Whether the package's own `agents/` definitions take part.
	 * Defaults to true; `subagents.disableBuiltins` turns it off.
	 */
	includeBuiltin?: boolean;
	/** Extra user-level directories, below the real user dir in precedence. */
	extraAgentDirs?: string[];
}

/**
 * Discover agents for a scope.
 *
 * Precedence, lowest to highest:
 *   builtin (shipped with the package)
 *   extra dirs (`PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS`)
 *   user    (`~/.pi/agent/agents`)
 *   project (`<nearest>/.pi/agents`)
 *
 * Later layers override earlier ones by name. The bundled roles are always
 * present unless `includeBuiltin` is false, which is what makes a fresh install
 * useful without any user setup.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	opts: DiscoverOptions = {},
): AgentDiscoveryResult {
	const builtinAgentsDir = opts.builtinAgentsDir ?? BUILTIN_AGENTS_DIR;
	const userDir = opts.userAgentsDir ?? path.join(homeAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, opts.configDirName);

	// The bundled roles are scope-independent: they are the shipped defaults.
	const builtinAgents =
		opts.includeBuiltin === false
			? []
			: loadAgentsFromDir(builtinAgentsDir, "builtin");

	const extras =
		scope === "project"
			? []
			: (opts.extraAgentDirs ?? extraAgentDirs()).flatMap((dir) =>
					loadAgentsFromDir(dir, "user"),
				);

	const userAgents =
		scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	const byName = new Map<string, AgentConfig>();
	const order: string[] = [];

	const add = (agent: AgentConfig, overwrite: boolean) => {
		if (!byName.has(agent.name)) order.push(agent.name);
		else if (!overwrite) return;
		byName.set(agent.name, agent);
	};

	// Lower precedence first; each later layer may overwrite.
	for (const agent of builtinAgents) add(agent, false);
	for (const agent of extras) add(agent, false);

	if (scope === "project") {
		for (const agent of projectAgents) add(agent, true);
	} else if (scope === "user") {
		for (const agent of userAgents) add(agent, true);
	} else {
		for (const agent of userAgents) add(agent, true);
		for (const agent of projectAgents) add(agent, true);
	}

	return {
		agents: order.map((name) => byName.get(name) as AgentConfig),
		projectAgentsDir,
		builtinAgentsDir,
	};
}

/** Resolve `~/.pi/agent` without importing pi internals. */
function homeAgentDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return path.join(home, ".pi", "agent");
}

/** Render a compact agent list for tool output. */
export function formatAgentList(agents: AgentConfig[], maxItems = 50): string {
	if (agents.length === 0) return "none";
	return agents
		.slice(0, maxItems)
		.map((a) => `${a.name} (${a.source}): ${a.description}`)
		.join("; ");
}
