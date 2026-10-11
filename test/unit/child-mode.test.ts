import { test } from "node:test";
import assert from "node:assert/strict";
import herdrSubagents from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function fakePi() {
	const tools: unknown[] = [];
	const events = new Map<string, unknown>();
	return {
		tools,
		registeredEvents: events,
		events: { emit() {} },
		registerTool(tool: unknown) { tools.push(tool); },
		registerMessageRenderer() {},
		on(name: string, handler: unknown) { events.set(name, handler); },
		registerCommand() {},
		sendMessage() {},
	};
}

test("child process without nested dispatch registers only the child guard", () => {
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const pi = fakePi();
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		assert.equal(pi.tools.length, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
});

test("nested-allowed RPC child still registers the subagent tool", () => {
	const previousChild = process.env.PI_SUBAGENT_CHILD;
	const previousNested = process.env.PI_SUBAGENT_ALLOW_NESTED;
	process.env.PI_SUBAGENT_CHILD = "1";
	process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
	try {
		const pi = fakePi();
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		assert.equal(pi.tools.length, 1);
	} finally {
		if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChild;
		if (previousNested === undefined) delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		else process.env.PI_SUBAGENT_ALLOW_NESTED = previousNested;
	}
});
