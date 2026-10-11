import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function herdr(args) {
	const r = spawnSync("herdr", args, { encoding: "utf8" });
	const text = (r.stdout || r.stderr || "").trim();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`herdr ${args.join(" ")}: ${text.slice(0, 500)}`);
	}
}

const group = herdr([
	"workspace",
	"create",
	"--cwd",
	"/root/work",
	"--label",
	"group-agent",
	"--no-focus",
]);
const other = herdr([
	"workspace",
	"create",
	"--cwd",
	"/root/other",
	"--label",
	"distractor",
	"--focus",
]);
const gid = group.result?.workspace?.workspace_id;
const oid = other.result?.workspace?.workspace_id;
if (!gid || !oid) {
	console.error("FAIL: workspace create", JSON.stringify({ group, other }).slice(0, 1500));
	process.exit(1);
}
herdr(["workspace", "focus", oid]);
const wl = herdr(["workspace", "list"]);
for (const w of wl.result?.workspaces ?? []) {
	console.log(`${w.focused ? "*" : " "} ${w.workspace_id} ${w.label}`);
}

const env = [
	`GROUP_WS=${gid}`,
	`OTHER_WS=${oid}`,
	`GROUP_TAB=${group.result?.tab?.tab_id ?? ""}`,
	`GROUP_PANE=${group.result?.root_pane?.pane_id ?? ""}`,
].join("\n");
writeFileSync("/tmp/space-pin-env.sh", `${env}\n`);
writeFileSync(
	"/tmp/space-pin-ids.json",
	JSON.stringify({
		group: gid,
		other: oid,
		groupTab: group.result?.tab?.tab_id ?? null,
		groupPane: group.result?.root_pane?.pane_id ?? null,
	}),
);
console.log("wrote /tmp/space-pin-ids.json", { group: gid, other: oid });
