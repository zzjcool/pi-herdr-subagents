/**
 * Tests for the `subagent` tool's request planning.
 *
 * `buildPlan` decides which of the three request shapes was used and turns it
 * into the list of steps to launch. It is the last gate before resources are
 * allocated, so every malformed input must be rejected HERE rather than
 * surfacing later as a child that starts with nothing to do.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, unknownAgentLine } from "../../index.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

test("plan: exactly one request shape must be provided", () => {
	const none = buildPlan({});
	assert.equal(none.ok, false);

	const both = buildPlan({
		agent: "worker",
		task: "do it",
		tasks: [{ agent: "worker", task: "other" }],
	});
	assert.equal(both.ok, false, "ambiguous requests must be refused");
});

test("plan: a single agent+task is accepted", () => {
	const plan = buildPlan({ agent: "worker", task: "do it" });
	assert.equal(plan.ok, true);
	assert.deepEqual(plan.steps, [{ agent: "worker", task: "do it" }]);
});

test("plan: a single request with a blank task is refused", () => {
	for (const task of ["", "   ", "\n", "\t"]) {
		const plan = buildPlan({ agent: "worker", task });
		assert.equal(
			plan.ok,
			false,
			`a blank task must be refused (got ${JSON.stringify(task)})`,
		);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 19: `tasks[]` and `chain[]` entries were taken on trust, so a missing or
// blank `agent`/`task` produced a step that launched a child with nothing to do
// — or with an empty agent name that failed only after a pane was allocated.
// ─────────────────────────────────────────────────────────────────────────────

test("plan: tasks[] entries are validated", () => {
	const bad: Array<[string, unknown]> = [
		["empty task", { tasks: [{ agent: "worker", task: "" }] }],
		["whitespace task", { tasks: [{ agent: "worker", task: "   " }] }],
		["empty agent", { tasks: [{ agent: "", task: "do it" }] }],
		["missing agent", { tasks: [{ task: "do it" }] }],
		["missing task", { tasks: [{ agent: "worker" }] }],
		[
			"second entry bad",
			{
				tasks: [
					{ agent: "a", task: "x" },
					{ agent: "", task: "y" },
				],
			},
		],
	];
	for (const [label, params] of bad) {
		const plan = buildPlan(params as Parameters<typeof buildPlan>[0]);
		assert.equal(plan.ok, false, `tasks[] must reject: ${label}`);
	}

	const good = buildPlan({
		tasks: [
			{ agent: "worker", task: "a" },
			{ agent: "reviewer", task: "b", model: "cb/glm-5.3" },
		],
	});
	assert.equal(good.ok, true);
	assert.equal(good.steps.length, 2);
});

test("plan: chain[] entries are validated", () => {
	const bad: Array<[string, unknown]> = [
		["empty task", { chain: [{ agent: "worker", task: "" }] }],
		["whitespace task", { chain: [{ agent: "worker", task: "  " }] }],
		["empty agent", { chain: [{ agent: "", task: "x" }] }],
		["missing agent", { chain: [{ task: "x" }] }],
		["missing task", { chain: [{ agent: "worker" }] }],
	];
	for (const [label, params] of bad) {
		const plan = buildPlan(params as Parameters<typeof buildPlan>[0]);
		assert.equal(plan.ok, false, `chain[] must reject: ${label}`);
	}
});

test("plan: chain substitutes {previous} in every step after the first", () => {
	const plan = buildPlan({
		chain: [
			{ agent: "scout", task: "survey the repo" },
			{ agent: "worker", task: "implement based on {previous}" },
			{ agent: "reviewer", task: "review {previous} carefully" },
		],
	});
	assert.equal(plan.ok, true);
	assert.equal(plan.steps.length, 3);
	// The first step keeps its literal task.
	assert.equal(plan.steps[0]?.task, "survey the repo");
	// Later steps must not carry a placeholder the runtime never fills.
	for (const step of plan.steps.slice(1)) {
		assert.ok(
			!step.task.includes("{previous}"),
			`unsubstituted placeholder left in: ${step.task}`,
		);
	}
	assert.match(plan.steps[1]?.task ?? "", /implement based on/);
});

test("plan: the unknown-agent refusal is a single, complete line", () => {
	// This is the ONLY feedback a typo'd agent name produces, and the marker was
	// accidentally doubled during a refactor without any test noticing. Assert the
	// exact string so a future rewrite cannot silently re-prefix it.
	const agents = [{ name: "scout" }, { name: "worker" }] as AgentConfig[];
	assert.equal(
		unknownAgentLine(agents, "nope"),
		'✗ unknown agent "nope". Available: scout, worker',
	);
	// One marker, not two (the regression that prompted this test).
	assert.equal((unknownAgentLine(agents, "nope").match(/✗/g) ?? []).length, 1);
});

test("plan: the unknown-agent refusal says \"none\" when no agent is known", () => {
	assert.match(unknownAgentLine([], "nope"), /Available: none$/);
});
