/**
 * Post-collect verification of writer acceptance criteria.
 *
 * L2 (`{"ok": true}`) is only attested — the agent is marking its own homework.
 * When a required criterion asks for `verification-output`, this module runs a
 * command in the child's cwd and promotes the result to `verified`
 * or rejects it. Semantic criteria without that evidence stay a checklist.
 *
 * The command is the first required `verification-output` criterion's
 * `command` field, or `VERIFY_COMMAND` when none is set. Semantic `must`
 * strings are never parsed (F32 / F44).
 */

import { spawn } from "node:child_process";
import type {
	AcceptanceCriterion,
	AcceptanceResult,
} from "../shared/types.ts";

export const VERIFY_COMMAND = "npm run typecheck && npm test";
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type VerifyRunner = (
	command: string,
	cwd: string,
	timeoutMs?: number,
) => Promise<CommandResult>;

export function needsVerification(
	criteria: AcceptanceCriterion[] | undefined,
): boolean {
	return (criteria ?? []).some(
		(criterion) =>
			criterion.severity !== "optional" &&
			(criterion.evidence ?? []).includes("verification-output"),
	);
}

/** First required verification-output command, else the frozen default. */
export function verifyCommandOf(
	criteria: AcceptanceCriterion[] | undefined,
): string {
	for (const criterion of criteria ?? []) {
		if (criterion.severity === "optional") continue;
		if (!(criterion.evidence ?? []).includes("verification-output")) continue;
		const command = criterion.command?.trim();
		if (command) return command;
	}
	return VERIFY_COMMAND;
}

export function defaultVerifyRunner(
	command: string,
	cwd: string,
	timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<CommandResult> {
	const limit = timeoutMs > 0 ? timeoutMs : DEFAULT_VERIFY_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000);
			finish({
				code: 1,
				stdout,
				stderr: `${stderr}\nverification timed out after ${limit}ms`,
			});
		}, limit);
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({ code: 1, stdout, stderr: String(error) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ code: code ?? 1, stdout, stderr });
		});
	});
}

export async function applyVerification(
	acceptance: AcceptanceResult,
	opts: {
		cwd: string;
		criteria?: AcceptanceCriterion[];
		run?: VerifyRunner;
		timeoutMs?: number;
	},
): Promise<AcceptanceResult> {
	if (acceptance.status !== "accepted") return acceptance;
	if (!needsVerification(opts.criteria)) return acceptance;

	const command = verifyCommandOf(opts.criteria);
	const run = opts.run ?? defaultVerifyRunner;
	const result = await run(command, opts.cwd, opts.timeoutMs);
	const output = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code === 0) {
		return {
			...acceptance,
			status: "accepted",
			level: "verified",
			reason: `verified by \`${command}\``,
		};
	}
	return {
		...acceptance,
		status: "rejected",
		level: "attested",
		reason: `verification failed (\`${command}\`): ${output.slice(0, 1_500)}`,
		pendingCriteria: acceptance.pendingCriteria,
	};
}
