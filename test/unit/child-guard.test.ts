import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CHILD_TASK_APPENDIX,
	forbiddenChildReason,
	formatChildTask,
	isReadOnlyRole,
	registerChildGuard,
} from "../../src/extension/child-guard.ts";
import {
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
} from "../../src/extension/budget.ts";

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

test("formatChildTask allowNested changes the nested-agents bullet", () => {
	const nested = formatChildTask("do it", { allowNested: true });
	assert.match(nested, /Nested subagents are allowed/);
	assert.doesNotMatch(nested, /Do not spawn nested agents/);
	assert.match(formatChildTask("do it"), /Do not spawn nested agents/);
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

function guardPi() {
	const events = new Map<string, unknown>();
	return {
		events,
		on(name: string, handler: unknown) {
			events.set(name, handler);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage() {},
		eventsBus: { emit() {} },
	};
}

test("child-guard counts every tool call against toolBudget", () => {
	const previous = process.env[MAX_TOOL_CALLS_ENV];
	process.env[MAX_TOOL_CALLS_ENV] = "1";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: Record<string, unknown>;
		}) => { block?: boolean; reason?: string } | undefined;
		assert.equal(
			handler({ toolName: "read", input: { path: "a" } }),
			undefined,
		);
		const blocked = handler({ toolName: "read", input: { path: "b" } });
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /tool budget exceeded \(1/);
	} finally {
		if (previous === undefined) delete process.env[MAX_TOOL_CALLS_ENV];
		else process.env[MAX_TOOL_CALLS_ENV] = previous;
	}
});

test("child-guard wraps bash with timeout after classifying", () => {
	const previous = process.env[TOOL_TIMEOUT_MS_ENV];
	process.env[TOOL_TIMEOUT_MS_ENV] = "1500";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: { command: string };
		}) => unknown;
		const event = { toolName: "bash" as const, input: { command: "ls -la" } };
		assert.equal(handler(event), undefined);
		assert.match(event.input.command, /^timeout --kill-after=2s 2s /);
	} finally {
		if (previous === undefined) delete process.env[TOOL_TIMEOUT_MS_ENV];
		else process.env[TOOL_TIMEOUT_MS_ENV] = previous;
	}
});

test("child-guard turn budget blocks tools after too many turns", () => {
	const previous = process.env[MAX_TURNS_ENV];
	process.env[MAX_TURNS_ENV] = "0";
	try {
		const pi = guardPi();
		registerChildGuard(pi as never);
		const turn = pi.events.get("turn_start") as () => void;
		const handler = pi.events.get("tool_call") as (event: {
			toolName: string;
			input: Record<string, unknown>;
		}) => { block?: boolean } | undefined;
		turn();
		const blocked = handler({ toolName: "read", input: {} });
		assert.equal(blocked?.block, true);
	} finally {
		if (previous === undefined) delete process.env[MAX_TURNS_ENV];
		else process.env[MAX_TURNS_ENV] = previous;
	}
});
