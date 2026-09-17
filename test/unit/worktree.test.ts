import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	createChildWorktree,
	isGitRepo,
	removeChildWorktree,
	worktreePathFor,
} from "../../src/runs/worktree.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initRepo(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-repo-"));
	execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
	writeFileSync(path.join(dir, "README"), "hi\n");
	execFileSync("git", ["-C", dir, "add", "README"], { stdio: "ignore" });
	execFileSync("git", ["-C", dir, "commit", "-m", "init"], {
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	return dir;
}

test("worktreePathFor nests under the run dir", () => {
	assert.equal(
		worktreePathFor("/tmp/run", "worker-0"),
		path.join("/tmp/run", "worktrees", "worker-0"),
	);
});

test("createChildWorktree refuses a non-git cwd", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "wt-nogit-"));
	try {
		assert.equal(isGitRepo(dir), false);
		assert.throws(
			() =>
				createChildWorktree({
					repoCwd: dir,
					runDir: path.join(dir, "run"),
					name: "w",
				}),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createChildWorktree adds a detached checkout and remove rolls it back", {
	skip: !hasGit(),
}, () => {
	const repo = initRepo();
	const runDir = mkdtempSync(path.join(tmpdir(), "wt-run-"));
	try {
		const dest = createChildWorktree({
			repoCwd: repo,
			runDir,
			name: "worker-0",
		});
		assert.ok(existsSync(path.join(dest, "README")));
		assert.equal(dest, worktreePathFor(runDir, "worker-0"));
		removeChildWorktree({ repoCwd: repo, dest });
		assert.equal(existsSync(dest), false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	}
});
