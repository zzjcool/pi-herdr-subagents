import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyVerification,
	defaultVerifyRunner,
	needsVerification,
	verifyCommandOf,
} from "../../src/runs/acceptance.ts";
import type { AcceptanceResult } from "../../src/shared/types.ts";

const attested: AcceptanceResult = {
	status: "accepted",
	level: "attested",
	reason: "self-report",
};

const criteria = [
	{
		id: "typecheck-test-pass",
		must: "npm run typecheck 与 npm test 全绿",
		evidence: ["verification-output"],
		severity: "required" as const,
	},
];

test("needsVerification is true only for required verification-output criteria", () => {
	assert.equal(needsVerification(undefined), false);
	assert.equal(needsVerification([]), false);
	assert.equal(
		needsVerification([{ id: "facts", must: "paths", evidence: ["facts"] }]),
		false,
	);
	assert.equal(needsVerification(criteria), true);
	assert.equal(
		needsVerification([
			{ ...criteria[0]!, severity: "optional" },
		]),
		false,
	);
});

test("applyVerification skips when there is nothing to run", async () => {
	const runs: string[] = [];
	const out = await applyVerification(attested, {
		cwd: "/tmp",
		criteria: [{ id: "facts", must: "paths", evidence: ["facts"] }],
		run: async (command) => {
			runs.push(command);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	assert.equal(runs.length, 0);
	assert.equal(out.level, "attested");
});

test("applyVerification keeps attested when the criterion has no command", async () => {
	const runs: string[] = [];
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria,
		run: async (command) => {
			runs.push(command);
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	});
	assert.equal(runs.length, 0, "must not guess a command");
	assert.equal(out.status, "accepted");
	assert.equal(out.level, "attested");
	assert.match(out.reason ?? "", /no command/);
	assert.ok(
		out.pendingCriteria?.some((c) => c.id === "typecheck-test-pass"),
		"criterion surfaces as pending for the parent",
	);
});

test("applyVerification rejects when the command fails", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				...criteria[0]!,
				command: "make test",
			},
		],
		run: async () => ({ code: 1, stdout: "fail\n", stderr: "boom" }),
	});
	assert.equal(out.status, "rejected");
	assert.equal(out.level, "attested");
	assert.match(out.reason ?? "", /boom|fail/);
});

test("applyVerification does not run on an already-rejected turn", async () => {
	const runs: string[] = [];
	const out = await applyVerification(
		{ status: "rejected", level: "none", reason: "aborted" },
		{
			cwd: "/work",
			criteria,
			run: async (command) => {
				runs.push(command);
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	);
	assert.equal(runs.length, 0);
	assert.equal(out.status, "rejected");
});

test("verifyCommandOf returns the criterion command, else undefined", () => {
	assert.equal(verifyCommandOf(undefined), undefined);
	assert.equal(verifyCommandOf(criteria), undefined);
	assert.equal(
		verifyCommandOf([
			{
				id: "custom",
				must: "pytest",
				evidence: ["verification-output"],
				severity: "required",
				command: "pytest -q",
			},
		]),
		"pytest -q",
	);
});

test("applyVerification runs the criterion command", async () => {
	const out = await applyVerification(attested, {
		cwd: "/work",
		criteria: [
			{
				id: "custom",
				must: "pytest",
				evidence: ["verification-output"],
				severity: "required",
				command: "pytest -q",
			},
		],
		run: async (command, cwd) => {
			assert.equal(command, "pytest -q");
			assert.equal(cwd, "/work");
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	});
	assert.equal(out.level, "verified");
	assert.match(out.reason ?? "", /pytest -q/);
});

test("defaultVerifyRunner times out a hung command", async () => {
	const started = Date.now();
	const result = await defaultVerifyRunner("sleep 30", process.cwd(), 80);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /timed out/);
	assert.ok(Date.now() - started < 5_000);
});
