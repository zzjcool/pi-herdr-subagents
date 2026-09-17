/**
 * Post-collect verification of writer acceptance criteria.
 *
 * L2 (`{"ok": true}`) is only attested — the agent is marking its own homework.
 * When a required criterion asks for `verification-output`, this module runs a
 * frozen command in the child's cwd and promotes the result to `verified`
 * or rejects it. Semantic criteria without that evidence stay a checklist.
 */

import { spawn } from "node:child_process";
import type {
	AcceptanceCriterion,
	AcceptanceResult,
} from "../shared/types.ts";

export const VERIFY_COMMAND = "npm run typecheck && npm test";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type VerifyRunner = (
	command: string,
	cwd: string,
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

export function defaultVerifyRunner(
	command: string,
	cwd: string,
): Promise<CommandResult> {
	return new Promise((resolve) => {
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
		child.on("error", (error) => {
			resolve({ code: 1, stdout, stderr: String(error) });
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

export async function applyVerification(
	acceptance: AcceptanceResult,
	opts: {
		cwd: string;
		criteria?: AcceptanceCriterion[];
		run?: VerifyRunner;
	},
): Promise<AcceptanceResult> {
	if (acceptance.status !== "accepted") return acceptance;
	if (!needsVerification(opts.criteria)) return acceptance;

	const run = opts.run ?? defaultVerifyRunner;
	const result = await run(VERIFY_COMMAND, opts.cwd);
	const output = `${result.stdout}\n${result.stderr}`.trim();
	if (result.code === 0) {
		return {
			...acceptance,
			status: "accepted",
			level: "verified",
			reason: `verified by \`${VERIFY_COMMAND}\``,
		};
	}
	return {
		...acceptance,
		status: "rejected",
		level: "attested",
		reason: `verification failed (\`${VERIFY_COMMAND}\`): ${output.slice(0, 1_500)}`,
		pendingCriteria: acceptance.pendingCriteria,
	};
}
