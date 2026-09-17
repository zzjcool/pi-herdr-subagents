import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyOnBlockedPolicy,
	followUpFor,
	formatBlockedPrompt,
} from "../../src/extension/blocked.ts";

test("formatBlockedPrompt names the child and the reason", () => {
	assert.match(formatBlockedPrompt("worker-0"), /worker-0/);
	assert.match(
		formatBlockedPrompt("worker-0", "edit src/foo.ts"),
		/edit src\/foo\.ts/,
	);
});

test("followUpFor: a decision resumes the watch; notify holds the pane", () => {
	assert.equal(followUpFor("approved"), "resume");
	assert.equal(followUpFor("rejected"), "resume");
	assert.equal(followUpFor("notified"), "hold");
});

test("forward: parent confirm yes approves the child", async () => {
	const log: string[] = [];
	const decision = await applyOnBlockedPolicy({
		policy: "forward",
		name: "w1",
		confirm: async (message) => {
			assert.match(message, /w1/);
			return true;
		},
		approve: async () => {
			log.push("approve");
		},
		reject: async () => {
			log.push("reject");
		},
		notify: () => {
			log.push("notify");
		},
	});
	assert.equal(decision, "approved");
	assert.deepEqual(log, ["approve"]);
});

test("forward: parent confirm no rejects the child", async () => {
	const log: string[] = [];
	const decision = await applyOnBlockedPolicy({
		policy: "forward",
		name: "w1",
		confirm: async () => false,
		approve: async () => {
			log.push("approve");
		},
		reject: async () => {
			log.push("reject");
		},
		notify: () => {
			log.push("notify");
		},
	});
	assert.equal(decision, "rejected");
	assert.deepEqual(log, ["reject"]);
});

test("forward without a TUI falls back to notify", async () => {
	const notices: string[] = [];
	const decision = await applyOnBlockedPolicy({
		policy: "forward",
		name: "w1",
		approve: async () => {
			throw new Error("must not approve");
		},
		reject: async () => {
			throw new Error("must not reject");
		},
		notify: (message) => {
			notices.push(message);
		},
	});
	assert.equal(decision, "notified");
	assert.equal(notices.length, 1);
});

test("auto-approve skips the parent confirm", async () => {
	const log: string[] = [];
	const decision = await applyOnBlockedPolicy({
		policy: "auto-approve",
		name: "w1",
		confirm: async () => {
			throw new Error("must not confirm");
		},
		approve: async () => {
			log.push("approve");
		},
		reject: async () => {
			log.push("reject");
		},
		notify: () => {
			log.push("notify");
		},
	});
	assert.equal(decision, "approved");
	assert.deepEqual(log, ["approve"]);
});

test("notify only tells the parent; the child stays blocked", async () => {
	const notices: string[] = [];
	const decision = await applyOnBlockedPolicy({
		policy: "notify",
		name: "w1",
		approve: async () => {
			throw new Error("must not approve");
		},
		reject: async () => {
			throw new Error("must not reject");
		},
		notify: (message) => {
			notices.push(message);
		},
	});
	assert.equal(decision, "notified");
	assert.equal(notices.length, 1);
});
