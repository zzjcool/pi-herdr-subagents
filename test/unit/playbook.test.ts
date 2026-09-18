import { test } from "node:test";
import assert from "node:assert/strict";
import {
	forbiddenDispatchReason,
	PARENT_PLAYBOOK,
	shellChunks,
	TOOL_DESCRIPTION,
} from "../../src/extension/playbook.ts";

test("playbook text is the frozen launch recipe", () => {
	assert.match(PARENT_PLAYBOOK, /subagent\(\{ agent:/);
	assert.match(PARENT_PLAYBOOK, /matching role/);
	assert.match(PARENT_PLAYBOOK, /Forbidden/);
	assert.match(PARENT_PLAYBOOK, /Isolation is YOUR call/);
	assert.match(PARENT_PLAYBOOK, /worktree: true/);
	assert.match(TOOL_DESCRIPTION, /async by default/);
	assert.match(TOOL_DESCRIPTION, /scout\/planner\/worker\/reviewer\/oracle/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /agent: "worker"/);
});

test("shellChunks splits compound commands", () => {
	assert.deepEqual(shellChunks('test "$HERDR_ENV" = 1 && herdr --help'), [
		'test "$HERDR_ENV" = 1',
		"herdr --help",
	]);
});

test("forbiddenDispatchReason: the herdr skill discovery ritual", () => {
	const blocked = [
		"herdr --help",
		"herdr -h",
		"herdr agent",
		"herdr pane",
		"herdr tab",
		"herdr workspace",
		"herdr agent --help",
		"herdr pane --help",
	];
	for (const command of blocked) {
		assert.ok(
			forbiddenDispatchReason(command),
			`must block discovery: ${command}`,
		);
	}
});

test("forbiddenDispatchReason: the old dispatch ritual", () => {
	const blocked = [
		"herdr agent start worker-0 --kind pi --pane w1:p2",
		"herdr agent prompt worker-0 hello",
		"herdr agent wait worker-0 --timeout 900000",
		"herdr agent send-keys worker-0 ctrl+d",
		"herdr pane split --current --direction down --no-focus",
	];
	for (const command of blocked) {
		assert.ok(
			forbiddenDispatchReason(command),
			`must block dispatch: ${command}`,
		);
	}
});

test("forbiddenDispatchReason: HERDR_ENV prelude", () => {
	assert.ok(forbiddenDispatchReason('test "${HERDR_ENV:-}" = 1'));
	assert.ok(forbiddenDispatchReason('test "$HERDR_ENV" = 1 && herdr --help'));
	assert.ok(forbiddenDispatchReason('[ -n "$HERDR_ENV" ]'));
});

test("forbiddenDispatchReason: inspection commands stay allowed", () => {
	const allowed = [
		"herdr pane list",
		"herdr pane read w1:p1",
		"herdr pane close w1:p2",
		"herdr agent list",
		"herdr agent get worker-0",
		"herdr agent read worker-0",
		"herdr tab list",
		"ls",
		"npm test",
		"echo hello",
	];
	for (const command of allowed) {
		assert.equal(
			forbiddenDispatchReason(command),
			undefined,
			`must allow: ${command}`,
		);
	}
});
