/**
 * Per-child git worktree isolation.
 *
 * Design §6.1 says `worktree: true` is write isolation. herdr has no worktree
 * client yet, so this is `git worktree add --detach` under the run directory.
 * The pane's cwd is the worktree; retire leaves it on disk so the child's
 * writes survive the pane (same rationale as keeping the session file).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCodes, SubagentError } from "../shared/types.ts";
import { sanitizeNameForFs } from "./store.ts";

export function worktreePathFor(runDir: string, name: string): string {
	return path.join(runDir, "worktrees", sanitizeNameForFs(name));
}

export function isGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

export function createChildWorktree(opts: {
	repoCwd: string;
	runDir: string;
	name: string;
}): string {
	if (!isGitRepo(opts.repoCwd)) {
		throw new SubagentError(
			`worktree: true requires a git repository; ${opts.repoCwd} is not one`,
			ErrorCodes.INVALID_PARAMS,
		);
	}
	const dest = worktreePathFor(opts.runDir, opts.name);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	try {
		execFileSync(
			"git",
			["-C", opts.repoCwd, "worktree", "add", "--detach", dest, "HEAD"],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const stderr =
			error && typeof error === "object" && "stderr" in error
				? String((error as { stderr?: Buffer | string }).stderr ?? error)
				: String(error);
		throw new SubagentError(
			`git worktree add failed: ${stderr.slice(0, 500)}`,
			ErrorCodes.START_FAILED,
		);
	}
	return dest;
}

/** Best-effort rollback when launch fails after the worktree was created. */
export function removeChildWorktree(opts: {
	repoCwd: string;
	dest: string;
}): void {
	try {
		execFileSync(
			"git",
			["-C", opts.repoCwd, "worktree", "remove", "--force", opts.dest],
			{ stdio: "ignore" },
		);
	} catch {
		try {
			fs.rmSync(opts.dest, { recursive: true, force: true });
		} catch {
			/* leftover directory is diagnostic, not fatal */
		}
	}
}
