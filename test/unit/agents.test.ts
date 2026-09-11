import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseFrontmatter,
	parseFrontmatterList,
} from "../../src/agents/frontmatter.ts";
import {
	parseAgentDocument,
	loadAgentsFromDir,
	findNearestProjectAgentsDir,
	discoverAgents,
	BUILTIN_AGENT_NAMES,
} from "../../src/agents/agents.ts";

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "agents-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ─────────────────────────── frontmatter ───────────────────────────

test("frontmatter: no fence yields empty frontmatter", () => {
	const r = parseFrontmatter("just a body");
	assert.deepEqual(r.frontmatter, {});
	assert.equal(r.body, "just a body");
});

test("frontmatter: unterminated fence is treated as body", () => {
	const r = parseFrontmatter("---\nname: x\nbody without close");
	assert.deepEqual(r.frontmatter, {});
});

test("frontmatter: simple key/value + body", () => {
	const r = parseFrontmatter(
		"---\nname: scout\ndescription: finds things\n---\nYou are scout.",
	);
	assert.equal(r.frontmatter.name, "scout");
	assert.equal(r.frontmatter.description, "finds things");
	assert.equal(r.body, "You are scout.");
});

test("frontmatter: quoted values are unquoted", () => {
	const r = parseFrontmatter("---\na: \"hello: world\"\nb: 'single'\n---\nx");
	assert.equal(r.frontmatter.a, "hello: world");
	assert.equal(r.frontmatter.b, "single");
});

test("frontmatter: CRLF is normalized", () => {
	const r = parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");
	assert.equal(r.frontmatter.name, "a");
	assert.equal(r.body, "body");
});

test("frontmatter: literal block scalar preserves newlines", () => {
	const r = parseFrontmatter(
		"---\nsystemPrompt: |\n  line one\n  line two\n---\nx",
	);
	assert.equal(r.frontmatter.systemPrompt, "line one\nline two");
});

test("frontmatter: folded block scalar joins lines with spaces", () => {
	const r = parseFrontmatter("---\nnote: >\n  one\n  two\n---\nx");
	assert.equal(r.frontmatter.note, "one two");
});

test("frontmatter: block list is preserved for list parsing", () => {
	const r = parseFrontmatter("---\ntools:\n  - read\n  - bash\n---\nx");
	assert.deepEqual(parseFrontmatterList(r.frontmatter.tools), ["read", "bash"]);
});

test("frontmatter: comments and blank lines are ignored", () => {
	const r = parseFrontmatter(
		"---\n# a comment\nname: a\n\ndescription: b\n---\nx",
	);
	assert.equal(r.frontmatter.name, "a");
	assert.equal(r.frontmatter.description, "b");
});

test("parseFrontmatterList: comma separated", () => {
	assert.deepEqual(parseFrontmatterList("read, bash , ls"), [
		"read",
		"bash",
		"ls",
	]);
});

test("parseFrontmatterList: hyphenated values survive", () => {
	assert.deepEqual(parseFrontmatterList("gpt-5-mini, claude-sonnet-4"), [
		"gpt-5-mini",
		"claude-sonnet-4",
	]);
});

test("parseFrontmatterList: undefined yields undefined", () => {
	assert.equal(parseFrontmatterList(undefined), undefined);
});

// ─────────────────────────── agent documents ───────────────────────────

test("agent: requires name and description", () => {
	assert.equal(
		parseAgentDocument("---\nname: x\n---\nbody", "/f.md", "user"),
		null,
	);
	assert.equal(
		parseAgentDocument("---\ndescription: y\n---\nbody", "/f.md", "user"),
		null,
	);
	assert.ok(
		parseAgentDocument(
			"---\nname: x\ndescription: y\n---\nbody",
			"/f.md",
			"user",
		),
	);
});

test("agent: defaults match the documented conventions", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\n---\nprompt",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a.systemPromptMode, "replace");
	assert.equal(a.inheritProjectContext, true);
	assert.equal(a.inheritSkills, false);
	assert.equal(a.kind, "pi");
	assert.equal(a.systemPrompt, "prompt");
});

test("agent: invalid kind degrades to pi instead of failing", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nkind: not-a-kind\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a.kind, "pi");
});

test("agent: valid non-pi kind is honored", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nkind: cursor\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.kind, "cursor");
});

test("agent: tools parse from comma string and array spellings", () => {
	const s = parseAgentDocument(
		"---\nname: r\ndescription: d\ntools: read, bash\n---\np",
		"/f.md",
		"user",
	);
	assert.deepEqual(s?.tools, ["read", "bash"]);
	const arr = parseAgentDocument(
		"---\nname: r\ndescription: d\ntools: [read, bash]\n---\np",
		"/f.md",
		"user",
	);
	assert.deepEqual(arr?.tools, ["read", "bash"]);
});

test("agent: skills false is distinct from absent", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nskills: false\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.skills, false);
	const b = parseAgentDocument(
		"---\nname: r\ndescription: d\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(b?.skills, undefined);
});

test("agent: numeric and boolean fields are coerced", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\ntimeoutMs: 1000\nmaxSubagentDepth: 2\nasync: true\nsteer: false\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.timeoutMs, 1000);
	assert.equal(a?.maxSubagentDepth, 2);
	assert.equal(a?.async, true);
	assert.equal(a?.steer, false);
});

test("agent: acceptance JSON is parsed", () => {
	const a = parseAgentDocument(
		'---\nname: r\ndescription: d\nacceptance: {"level":"attested","role":"read-only"}\n---\np',
		"/f.md",
		"user",
	);
	assert.equal(a?.acceptance?.level, "attested");
	assert.equal(a?.acceptance?.role, "read-only");
});

test("agent: malformed acceptance JSON is ignored, not fatal", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nacceptance: {not json\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a?.acceptance, undefined);
});

test("agent: frontmatterFields records provenance", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nmodel: x\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a?.frontmatterFields?.has("model"));
	assert.ok(a?.frontmatterFields?.has("name"));
});

// ─────────────────────────── discovery ───────────────────────────

test("discovery: loadAgentsFromDir skips bad files without throwing", () => {
	withDir((dir) => {
		writeFileSync(
			path.join(dir, "good.md"),
			"---\nname: good\ndescription: d\n---\np",
		);
		writeFileSync(path.join(dir, "bad.md"), "no frontmatter here");
		writeFileSync(
			path.join(dir, "ignored.txt"),
			"---\nname: x\ndescription: y\n---\np",
		);
		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 1);
		assert.equal(agents[0]?.name, "good");
	});
});

test("discovery: missing directory yields empty list", () => {
	assert.deepEqual(loadAgentsFromDir("/nonexistent/path/xyz", "user"), []);
});

test("discovery: findNearestProjectAgentsDir walks up", () => {
	withDir((dir) => {
		const nested = path.join(dir, "a", "b", "c");
		mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		assert.equal(
			findNearestProjectAgentsDir(nested),
			path.join(dir, ".pi", "agents"),
		);
	});
});

test("discovery: returns null when no project dir exists", () => {
	withDir((dir) => {
		assert.equal(findNearestProjectAgentsDir(dir), null);
	});
});

test("discovery: project overrides user on name collision in 'both'", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "dup.md"),
			"---\nname: dup\ndescription: from-user\n---\nuser prompt",
		);
		writeFileSync(
			path.join(projDir, "dup.md"),
			"---\nname: dup\ndescription: from-project\n---\nproj prompt",
		);

		const res = discoverAgents(path.join(root, "proj"), "both", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.equal(res.agents.length, 1);
		assert.equal(res.agents[0]?.description, "from-project");
		assert.equal(res.agents[0]?.source, "project");
	});
});

test("discovery: scope 'user' excludes project agents", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "u.md"),
			"---\nname: u\ndescription: d\n---\np",
		);
		writeFileSync(
			path.join(projDir, "p.md"),
			"---\nname: p\ndescription: d\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "user", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.deepEqual(
			res.agents.map((a) => a.name),
			["u"],
		);
	});
});

test("discovery: scope 'project' excludes user agents", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "u.md"),
			"---\nname: u\ndescription: d\n---\np",
		);
		writeFileSync(
			path.join(projDir, "p.md"),
			"---\nname: p\ndescription: d\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "project", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.deepEqual(
			res.agents.map((a) => a.name),
			["p"],
		);
	});
});

test("discovery: bundled roles are present by default", () => {
	withDir((root) => {
		const res = discoverAgents(root, "user", {
			userAgentsDir: path.join(root, "empty-user-dir"),
		});
		const names = res.agents.map((a) => a.name);
		for (const expected of BUILTIN_AGENT_NAMES) {
			assert.ok(
				names.includes(expected),
				`bundled role "${expected}" must load`,
			);
		}
		const scout = res.agents.find((a) => a.name === "scout");
		assert.equal(scout?.source, "builtin");
	});
});

test("discovery: includeBuiltin false drops the bundled roles", () => {
	withDir((root) => {
		const res = discoverAgents(root, "user", {
			userAgentsDir: path.join(root, "empty-user-dir"),
			includeBuiltin: false,
		});
		assert.deepEqual(res.agents, []);
	});
});

test("discovery: a user definition overrides a bundled role of the same name", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		mkdirSync(userDir, { recursive: true });
		// `scout` is a bundled role; the user redefines it.
		writeFileSync(
			path.join(userDir, "scout.md"),
			"---\nname: scout\ndescription: my-own-scout\n---\np",
		);

		const res = discoverAgents(root, "user", { userAgentsDir: userDir });
		const scout = res.agents.find((a) => a.name === "scout");
		assert.equal(scout?.description, "my-own-scout");
		assert.equal(scout?.source, "user");
		// The other bundled roles must still be present.
		assert.ok(res.agents.length >= BUILTIN_AGENT_NAMES.length);
	});
});

test("discovery: a project definition overrides a bundled role in 'both'", () => {
	withDir((root) => {
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(projDir, "reviewer.md"),
			"---\nname: reviewer\ndescription: project-reviewer\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "both", {
			userAgentsDir: path.join(root, "empty-user-dir"),
		});
		const reviewer = res.agents.find((a) => a.name === "reviewer");
		assert.equal(reviewer?.description, "project-reviewer");
		assert.equal(reviewer?.source, "project");
	});
});

test("discovery: extra agent dirs load below the user dir in precedence", () => {
	withDir((root) => {
		const extraDir = path.join(root, "extra-agents");
		const userDir = path.join(root, "user-agents");
		mkdirSync(extraDir, { recursive: true });
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			path.join(extraDir, "vendored.md"),
			"---\nname: vendored\ndescription: from-extra\n---\np",
		);
		// Same name in both layers: the user dir must win.
		writeFileSync(
			path.join(extraDir, "dup.md"),
			"---\nname: dup\ndescription: from-extra\n---\np",
		);
		writeFileSync(
			path.join(userDir, "dup.md"),
			"---\nname: dup\ndescription: from-user\n---\np",
		);

		const res = discoverAgents(root, "user", {
			userAgentsDir: userDir,
			includeBuiltin: false,
			extraAgentDirs: [extraDir],
		});
		const names = res.agents.map((a) => a.name);
		assert.ok(names.includes("vendored"), "extra dir roles must load");
		assert.equal(
			res.agents.find((a) => a.name === "dup")?.description,
			"from-user",
			"the user dir must outrank the extra dirs",
		);
	});
});
