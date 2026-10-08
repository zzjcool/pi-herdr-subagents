/** Named subagent teams: role selection plus per-member overrides. */

import { findAgent } from "./agents.ts";
import { applyOverride } from "./overrides.ts";
import type { AgentConfig, SubagentsSettings } from "../shared/types.ts";

export const TEAM_ENV = "PI_SUBAGENTS_TEAM";
export const DEFAULT_TEAM = "default";

export interface ActiveTeam {
	name: string;
	source: "env" | "settings" | "default";
}

/** Resolve the active team using the environment > settings > default order. */
export function resolveActiveTeamName(
	settings: SubagentsSettings,
	env: Record<string, string | undefined> = process.env,
): ActiveTeam {
	const fromEnv = env[TEAM_ENV]?.trim();
	if (fromEnv) return { name: fromEnv, source: "env" };
	const fromSettings = settings.team?.trim();
	if (fromSettings) return { name: fromSettings, source: "settings" };
	return { name: DEFAULT_TEAM, source: "default" };
}

/** List the built-in default plus configured teams in settings order. */
export function listTeamNames(settings: SubagentsSettings): string[] {
	return [DEFAULT_TEAM, ...Object.keys(settings.teams ?? {})];
}

/** Apply the selected team to a fully discovered agent list. */
export function applyTeam(
	agents: AgentConfig[],
	settings: SubagentsSettings,
	env: Record<string, string | undefined> = process.env,
): { agents: AgentConfig[]; team: ActiveTeam; warnings: string[] } {
	const team = resolveActiveTeamName(settings, env);
	if (team.name === DEFAULT_TEAM) {
		return { agents, team, warnings: [] };
	}

	const teams = settings.teams ?? {};
	const config = Object.hasOwn(teams, team.name) ? teams[team.name] : undefined;
	if (!config) {
		const available = listTeamNames(settings).join(", ");
		return {
			agents,
			team,
			warnings: [
				`Subagent team "${team.name}" is not defined; using all agents. Available teams: ${available}.`,
			],
		};
	}

	const selected = new Map<string, AgentConfig>();
	const warnings: string[] = [];
	const warnMissing = (reference: string): void => {
		warnings.push(
			`Subagent team "${team.name}" references missing agent "${reference}"; skipped.`,
		);
	};

	for (const member of config.members) {
		if (typeof member === "string") {
			const reference = member.trim();
			if (reference === "*") {
				for (const agent of agents) {
					if (!selected.has(agent.name)) selected.set(agent.name, agent);
				}
				continue;
			}
			const agent = findAgent(agents, reference);
			if (!agent) {
				warnMissing(reference);
				continue;
			}
			if (!selected.has(agent.name)) selected.set(agent.name, agent);
			continue;
		}

		const reference = member.agent.trim();
		const base = findAgent(agents, reference);
		if (!base) {
			warnMissing(reference);
			continue;
		}
		// Members are ordered operations: a later mention (or `*`) restores a
		// role removed by `disabled`, so the last applicable member wins.
		if (member.disabled === true) {
			selected.delete(base.name);
			continue;
		}
		selected.set(
			base.name,
			applyOverride(selected.get(base.name) ?? base, member),
		);
	}

	return { agents: [...selected.values()], team, warnings };
}
