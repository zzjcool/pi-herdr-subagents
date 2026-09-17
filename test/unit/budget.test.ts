import { test } from "node:test";
import assert from "node:assert/strict";
import {
	budgetExceededReason,
	parseBudgetInt,
	wrapBashWithTimeout,
} from "../../src/extension/budget.ts";

test("parseBudgetInt accepts 0 and positive integers", () => {
	assert.equal(parseBudgetInt("0"), 0);
	assert.equal(parseBudgetInt("12"), 12);
	assert.equal(parseBudgetInt(undefined), undefined);
	assert.equal(parseBudgetInt(""), undefined);
	assert.equal(parseBudgetInt("1.5"), undefined);
	assert.equal(parseBudgetInt("-1"), undefined);
	assert.equal(parseBudgetInt("nope"), undefined);
});

test("wrapBashWithTimeout prefixes GNU timeout and does not double-wrap", () => {
	const wrapped = wrapBashWithTimeout("ls -la", 1_500);
	assert.match(wrapped, /^timeout --kill-after=2s 2s bash -lc /);
	assert.match(wrapped, /ls -la/);
	assert.equal(wrapBashWithTimeout(wrapped, 9_000), wrapped);
	assert.equal(wrapBashWithTimeout("ls", 0), "ls");
});

test("budgetExceededReason names the limit", () => {
	assert.match(budgetExceededReason("tool", 3), /tool budget exceeded \(3/);
	assert.match(budgetExceededReason("turn", 2), /turn budget exceeded \(2/);
});
