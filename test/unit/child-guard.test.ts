import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_TASK_APPENDIX,
	forbiddenChildReason,
	formatChildTask,
	isReadOnlyRole,
} from "../../src/extension/child-guard.ts";

test("child: herdr agent prompt/wait/send-keys/start are blocked", () => {
	const blocked = [
		"herdr agent prompt orchestrator please take this",
		"herdr agent wait orchestrator",
		"herdr agent send-keys orchestrator ctrl+d",
		"herdr agent start nested --kind pi --pane w1:p2",
	];
	for (const command of blocked) {
		assert.ok(
			forbiddenChildReason(command, { paneId: "w1:p1" }),
			`child must not ${command}`,
		);
	}
});

test("child: may read its own pane but not another", () => {
	assert.equal(
		forbiddenChildReason("herdr pane read w1:p1 --lines 40", {
			paneId: "w1:p1",
		}),
		undefined,
	);
	assert.ok(
		forbiddenChildReason("herdr pane read w1:p2", { paneId: "w1:p1" }),
		"foreign pane read must be blocked",
	);
	assert.ok(
		forbiddenChildReason("herdr pane close w1:p2", { paneId: "w1:p1" }),
		"foreign pane close must be blocked",
	);
});

test("child: pane split / tab create stay blocked", () => {
	assert.ok(forbiddenChildReason("herdr pane split --direction down"));
	assert.ok(forbiddenChildReason("herdr tab create --label extra"));
});

test("child: unknown own pane blocks every pane read", () => {
	assert.ok(forbiddenChildReason("herdr pane read w1:p1"));
});

test("child: herdr --help is blocked without the parent launch playbook", () => {
	const reason = forbiddenChildReason("herdr --help", { paneId: "w1:p1" });
	assert.ok(reason);
	assert.match(reason, /must not probe the herdr CLI/);
	assert.doesNotMatch(reason, /subagent\(\{ agent/);
});

test("child block reasons do not tell the child to call subagent", () => {
	const reason = forbiddenChildReason(
		"herdr agent prompt orchestrator please take this",
		{ paneId: "w1:p1" },
	);
	assert.ok(reason);
	assert.match(reason, /must not dispatch herdr agent/);
	assert.doesNotMatch(reason, /Call `subagent/);
	assert.doesNotMatch(reason, /old dispatch ritual/);
});

test("formatChildTask appends the frozen constraints", () => {
	const text = formatChildTask("Review src/foo.ts");
	assert.match(text, /^Task: Review src\/foo\.ts/m);
	assert.match(text, /Frozen child constraints/);
	assert.match(text, /\{\"ok\":/);
	assert.ok(text.includes(CHILD_TASK_APPENDIX));
});

test("read-only role: writes and herdr prompts are blocked, recon commands pass", () => {
	assert.equal(isReadOnlyRole("read-only"), true);
	assert.equal(isReadOnlyRole("writer"), false);

	const env = { paneId: "w1:p1", acceptanceRole: "read-only" as const };
	assert.ok(forbiddenChildReason("rm -rf /tmp/x", env));
	assert.ok(forbiddenChildReason("git commit -am wip", env));
	assert.ok(forbiddenChildReason("echo hi > /tmp/out", env));
	assert.ok(forbiddenChildReason("npm install left-pad", env));
	assert.equal(forbiddenChildReason("rg TODO src", env), undefined);
	assert.equal(forbiddenChildReason("git log -1 --oneline", env), undefined);
	assert.equal(forbiddenChildReason("ls src", env), undefined);
});

test("writer role may run npm test", () => {
	assert.equal(
		forbiddenChildReason("npm test", {
			paneId: "w1:p1",
			acceptanceRole: "writer",
		}),
		undefined,
	);
});
