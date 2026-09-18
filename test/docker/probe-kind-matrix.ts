/**
 * Print and assert the Herdr start/prompt plan for each kind we care about.
 * Runs inside the docker sandbox against the mounted plugin.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	nativeModelFor,
	planKindStart,
} from "../../src/runs/kind.ts";
import type { AgentConfig, AgentKind } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "probe",
		description: "docker kind probe",
		systemPrompt: "You are a probe agent.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

interface Case {
	title: string;
	kind: AgentKind;
	model?: string;
	thinking?: string | false;
	expectNative?: string;
	expectStartHas: string[];
	expectStartOmits: string[];
}

const cases: Case[] = [
	{
		title: "pi + CodeBuddy provider model",
		kind: "pi",
		model: "cb/glm-5.3-flash",
		thinking: "medium",
		expectNative: "cb/glm-5.3-flash:medium",
		expectStartHas: ["--session", "--model", "cb/glm-5.3-flash:medium"],
		expectStartOmits: ["@"],
	},
	{
		title: "cursor + grok 4.6",
		kind: "cursor",
		model: "grok-4.6",
		thinking: "high",
		expectNative: "cursor-grok-4.6-high",
		expectStartHas: ["--model", "cursor-grok-4.6-high"],
		expectStartOmits: ["--session", "--extension", "@"],
	},
	{
		title: "cursor drops inherited pi/cb model",
		kind: "cursor",
		model: "cb/glm-5.3-flash",
		thinking: "medium",
		expectStartHas: [],
		expectStartOmits: ["--model", "--session"],
	},
	{
		title: "claude generic model passthrough",
		kind: "claude",
		model: "sonnet",
		expectNative: "sonnet",
		expectStartHas: ["--model", "sonnet"],
		expectStartOmits: ["--session"],
	},
	{
		title: "grok herdr kind (xAI CLI, not Cursor Grok)",
		kind: "grok",
		model: "grok-4",
		expectNative: "grok-4",
		expectStartHas: ["--model", "grok-4"],
		expectStartOmits: ["--session"],
	},
];

const dir = mkdtempSync(path.join(tmpdir(), "kind-matrix-"));
const rows: string[] = [];
try {
	for (const c of cases) {
		const plan = planKindStart({
			agent: agent({
				kind: c.kind,
				systemPrompt: "You are a probe agent.",
			}),
			task: "Reply with KIND_PROBE_OK",
			sessionFile: "/tmp/probe.jsonl",
			tempDir: dir,
			model: c.model,
			thinking: c.thinking,
			includeTask: false,
		});
		const argv = plan.args.join(" ");
		for (const token of c.expectStartHas) {
			assert.ok(
				plan.args.includes(token) || argv.includes(token),
				`${c.title}: start argv missing ${token}: ${argv}`,
			);
		}
		for (const token of c.expectStartOmits) {
			if (token === "@") {
				assert.equal(
					plan.args.some((a) => a.startsWith("@")),
					false,
					`${c.title}: task leaked onto start argv`,
				);
			} else {
				assert.equal(
					plan.args.includes(token),
					false,
					`${c.title}: unexpected ${token} in ${argv}`,
				);
			}
		}
		if (c.expectNative !== undefined) {
			assert.equal(
				nativeModelFor(c.kind, c.model, c.thinking),
				c.expectNative,
				c.title,
			);
			if (c.expectNative) assert.equal(plan.nativeModel, c.expectNative);
		}
		assert.match(plan.taskText, /KIND_PROBE_OK/);
		rows.push(
			[
				c.title,
				`kind=${c.kind}`,
				`model=${c.model ?? "-"}`,
				`native=${plan.nativeModel ?? "(omitted)"}`,
				`start: herdr agent start n --kind ${c.kind} --pane P -- ${plan.args.join(" ")}`.trim(),
			].join(" | "),
		);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log("===== KIND MATRIX =====");
for (const row of rows) console.log(row);
console.log("===== RESULT: PASS kind matrix =====");
