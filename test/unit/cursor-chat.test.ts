import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

test("regression: no source file may statically import node:sqlite or bun:sqlite", () => {
	// Pi ships as a Bun-compiled binary. Bun lacks `node:sqlite`, so the RPC
	// mainline must not statically import either runtime's SQLite driver.
	const pkgRoot = path.resolve(import.meta.dirname, "../..");
	const walkTs = (dir: string): string[] => {
		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walkTs(file));
			else if (entry.name.endsWith(".ts")) out.push(file);
		}
		return out;
	};
	const files = [path.join(pkgRoot, "index.ts"), ...walkTs(path.join(pkgRoot, "src"))];
	assert.ok(files.length > 1, "sanity: source walk found files");
	for (const file of files) {
		const source = fs.readFileSync(file, "utf-8");
		assert.doesNotMatch(
			source,
			/^\s*import[^;\n]*from\s*["'](node:sqlite|bun:sqlite)["']/m,
			`${file}: sqlite must be loaded lazily, never by static import`,
		);
	}
});
