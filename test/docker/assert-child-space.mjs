import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ids = JSON.parse(readFileSync("/tmp/space-pin-ids.json", "utf8"));

function workspaceOf(id) {
	if (!id || typeof id !== "string") return null;
	const cut = id.indexOf(":");
	return cut === -1 ? id : id.slice(0, cut);
}

const r = spawnSync("herdr", ["agent", "list"], { encoding: "utf8" });
let agents = [];
try {
	agents = JSON.parse(r.stdout || r.stderr || "{}").result?.agents ?? [];
} catch {
	agents = [];
}
console.log("live agents:");
for (const a of agents) {
	console.log(
		`  name=${a.name} kind=${a.agent} ws=${a.workspace_id} pane=${a.pane_id} status=${a.agent_status}`,
	);
}

const children = [];
for (const a of agents) {
	if (a.name && String(a.name).startsWith("scout")) {
		children.push({
			name: a.name,
			workspaceId: a.workspace_id,
			paneId: a.pane_id,
			tabId: a.tab_id,
			source: "agent-list",
		});
	}
}

const runsRoot = "/root/work/.pi-subagents/runs";
if (existsSync(runsRoot)) {
	for (const runId of readdirSync(runsRoot)) {
		const file = path.join(runsRoot, runId, "run.json");
		if (!existsSync(file)) continue;
		const run = JSON.parse(readFileSync(file, "utf8"));
		console.log(`run ${run.runId} herdr.tabId=${run.herdr?.tabId}`);
		for (const child of run.children ?? []) {
			if (!String(child.name ?? "").startsWith("scout")) continue;
			children.push({
				name: child.name,
				workspaceId:
					workspaceOf(child.tabId) ??
					workspaceOf(child.paneId) ??
					workspaceOf(run.herdr?.tabId),
				paneId: child.paneId,
				tabId: child.tabId ?? run.herdr?.tabId,
				state: child.state,
				source: "run.json",
			});
		}
	}
}

if (children.length === 0) {
	console.error("FAIL: no scout child in agent list or run.json");
	process.exit(1);
}

let bad = 0;
for (const child of children) {
	const ws = child.workspaceId;
	const inGroup = ws === ids.group;
	const inFocused = ws === ids.other;
	console.log(
		`child ${child.name} source=${child.source} workspace=${ws} tab=${child.tabId} pane=${child.paneId} group=${ids.group} focused=${ids.other} inGroup=${inGroup} inFocused=${inFocused}`,
	);
	if (!inGroup || inFocused) {
		console.error(
			`FAIL: ${child.name} must land in parent Space ${ids.group}, not focused ${ids.other}`,
		);
		bad += 1;
	}
}
if (bad) process.exit(1);
console.log("PASS: every scout child is in the parent herdr Space");
