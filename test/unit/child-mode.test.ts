import { test } from "node:test";
import assert from "node:assert/strict";
import herdrSubagents from "../../index.ts";

function fakePi() {
	const tools: unknown[] = [];
	const events = new Map<string, unknown>();
	return {
		tools,
		events,
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		on(name: string, handler: unknown) {
			events.set(name, handler);
		},
		registerCommand() {},
		sendMessage() {},
		eventsBus: { emit() {} },
	};
}

test("child process does not register the subagent tool", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const pi = fakePi();
		herdrSubagents(pi as never);
		assert.equal(pi.tools.length, 0);
		assert.equal(typeof pi.events.get("tool_call"), "function");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
});

test("child bash interceptor blocks herdr agent prompt", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	try {
		const pi = fakePi();
		herdrSubagents(pi as never);
		const handler = pi.events.get("tool_call") as (
			event: { toolName: string; input: { command: string } },
		) => { block?: boolean; reason?: string } | undefined;
		const blocked = handler({
			toolName: "bash",
			input: { command: "herdr agent prompt orchestrator hi" },
		});
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /herdr agent/);
		assert.doesNotMatch(blocked?.reason ?? "", /Call `subagent/);
		assert.match(blocked?.reason ?? "", /Frozen child constraints/);
		const allowed = handler({
			toolName: "bash",
			input: { command: "ls" },
		});
		assert.equal(allowed, undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
		delete process.env.HERDR_PANE_ID;
	}
});
