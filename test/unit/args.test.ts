import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	buildPiArgs,
	childGuardExtensionPath,
} from "../../src/runs/args.ts";
import { CHILD_TASK_APPENDIX } from "../../src/extension/child-guard.ts";

function agent() {
	return {
		name: "scout",
		description: "d",
		systemPrompt: "",
		systemPromptMode: "replace" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/f.md",
		tools: ["read", "bash"],
	};
}

test("buildPiArgs injects the child-guard extension", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-ext-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		const idx = built.args.indexOf("--extension");
		assert.ok(idx >= 0, "child argv must load an extension");
		assert.equal(built.args[idx + 1], childGuardExtensionPath());
		assert.equal(
			built.args.filter((a) => a === "--extension").length,
			1,
			"must not duplicate the guard extension",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs writes the frozen task appendix", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-task-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "Review src/foo.ts",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		const taskArg = built.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg);
		const text = readFileSync(taskArg!.slice(1), "utf8");
		assert.match(text, /Task: Review src\/foo\.ts/);
		assert.ok(text.includes(CHILD_TASK_APPENDIX));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
