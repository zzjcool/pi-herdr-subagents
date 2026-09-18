import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mergeProgress,
	progressFromAgentInfo,
	progressFromPaneInfo,
	progressFromSession,
} from "../../src/shared/progress.ts";
import { parseSessionText } from "../../src/shared/session.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";

test("progressFromSession: model_change is enough before any assistant message", () => {
	const parsed = parseSessionText(
		[sessionHeader(), modelChange("cb/glm-5.3")].join("\n"),
	);
	assert.deepEqual(progressFromSession(parsed), { model: "cb/glm-5.3" });
});

test("progressFromSession: turns and in-flight tools come from the last assistant", () => {
	const parsed = parseSessionText(
		[
			sessionHeader(),
			modelChange("cb/glm-5.3"),
			userMsg("go"),
			assistantMsg({
				stopReason: "toolUse",
				tools: ["bash", "read"],
				model: "cb/glm-5.3",
			}),
			toolResult(),
			assistantMsg({
				stopReason: "toolUse",
				tools: ["edit"],
				model: "cb/glm-5.3",
			}),
		].join("\n"),
	);
	assert.deepEqual(progressFromSession(parsed), {
		model: "cb/glm-5.3",
		turns: 1,
		lastTools: ["edit"],
	});
});

test("progressFromSession: a finished text turn does not keep stale tools", () => {
	const parsed = parseSessionText(
		[
			userMsg("go"),
			assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
			toolResult(),
			assistantMsg({ stopReason: "stop", text: "done" }),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	assert.equal(live.turns, 1);
	assert.equal(live.lastTools, undefined);
});

test("progressFromAgentInfo: aligns cursor-like labels/tokens onto the pi fields", () => {
	assert.deepEqual(
		progressFromAgentInfo({
			name: "cursor-0",
			pane_id: "p1",
			tab_id: "t1",
			workspace_id: "w1",
			agent: "cursor",
			agent_status: "working",
			state_labels: { model: "cursor/gpt-4.1", tool: "edit", turns: "2" },
			tokens: { input: 10, output: 4, thinking: "high" },
		}),
		{
			herdrStatus: "working",
			model: "cursor/gpt-4.1",
			thinking: "high",
			turns: 2,
			lastTools: ["edit"],
		},
	);
});

test("progressFromAgentInfo: ignores usage-shaped tokens and finds a model-like label", () => {
	assert.deepEqual(
		progressFromAgentInfo({
			name: "c",
			pane_id: "p1",
			tab_id: "t1",
			workspace_id: "w1",
			agent: "claude",
			agent_status: "idle",
			state_labels: { activity: "Read", display: "anthropic/claude-sonnet-4" },
			tokens: { input: 1, output: 2, cost: 0.01 },
		}),
		{
			herdrStatus: "idle",
			model: "anthropic/claude-sonnet-4",
			lastTools: ["Read"],
		},
	);
});

test("progressFromPaneInfo: pulls a provider/id out of the terminal title", () => {
	assert.deepEqual(
		progressFromPaneInfo({
			pane_id: "p1",
			tab_id: "t1",
			workspace_id: "w1",
			agent_status: "working",
			terminal_title_stripped: "Cursor · cursor/gpt-4.1",
		}),
		{ herdrStatus: "working", model: "cursor/gpt-4.1" },
	);
});

test("mergeProgress: later sources win, empty parts do not clobber", () => {
	assert.deepEqual(
		mergeProgress(
			{ model: "launch/model", thinking: "medium" },
			{ herdrStatus: "working" },
			{ model: "cursor/gpt-4.1", lastTools: ["edit"], turns: 3 },
		),
		{
			model: "cursor/gpt-4.1",
			thinking: "medium",
			herdrStatus: "working",
			lastTools: ["edit"],
			turns: 3,
		},
	);
});
