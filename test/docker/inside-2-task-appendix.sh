#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/args.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types -e '
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPiArgs } from "./src/runs/args.ts";
const dir = mkdtempSync(path.join(tmpdir(), "task-"));
const built = buildPiArgs({
  agent: {
    name: "scout", description: "d", systemPrompt: "", systemPromptMode: "replace",
    inheritProjectContext: true, inheritSkills: false, kind: "pi", source: "user", filePath: "/f.md",
  },
  task: "Review src/foo.ts",
  sessionFile: "/tmp/s.jsonl",
  tempDir: dir,
});
const taskArg = built.args.find((a) => a.startsWith("@"));
const text = readFileSync(taskArg.slice(1), "utf8");
if (!text.includes("Frozen child constraints") || !text.includes("Review src/foo.ts")) {
  console.error(text);
  process.exit(1);
}
console.log(text);
rmSync(dir, { recursive: true, force: true });
console.log("===== RESULT: PASS task appendix injected =====");
'
