/**
 * Temporary-directory helper for filesystem tests (IMPLEMENTATION.md convention:
 * mkdtempSync + rmSync, never write outside a temp dir).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Run `fn` with a fresh temp dir; the dir is always removed afterwards. */
export async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-subagents-test-"));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
