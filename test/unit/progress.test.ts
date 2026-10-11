import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mergeProgress,
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

test("mergeProgress: later sources win, empty parts do not clobber", () => {
	assert.deepEqual(
		mergeProgress(
			{ model: "launch/model" },
			{},
			{ model: "cursor/gpt-4.1", lastTools: ["edit"], turns: 3 },
		),
		{
			model: "cursor/gpt-4.1",
			lastTools: ["edit"],
			turns: 3,
		},
	);
});
