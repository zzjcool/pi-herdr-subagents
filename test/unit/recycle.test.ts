import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canUseCachedCollect,
	formatAlreadyRecycled,
} from "../../src/extension/recycle.ts";

test("formatAlreadyRecycled is a no-op explanation, not a new close", () => {
	const text = formatAlreadyRecycled("worker-0", "/tmp/w.jsonl");
	assert.match(text, /Already recycled worker-0/);
	assert.match(text, /no-op/);
	assert.match(text, /\/tmp\/w\.jsonl/);
});

test("canUseCachedCollect is true after collect, not while the child is working", () => {
	assert.equal(canUseCachedCollect("working"), false);
	assert.equal(canUseCachedCollect("launching"), false);
	assert.equal(canUseCachedCollect("retired"), true);
	assert.equal(canUseCachedCollect("awaiting"), true);
	assert.equal(canUseCachedCollect("blocked"), true);
	assert.equal(canUseCachedCollect("exited"), true);
});
