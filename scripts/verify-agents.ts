import { loadAgentsFromDir } from "../src/agents/agents.ts";
const agents = loadAgentsFromDir(new URL("../agents", import.meta.url).pathname, "user");
console.log(`parsed ${agents.length} agents\n`);
for (const a of agents) {
  console.log(`-- ${a.name} (kind=${a.kind}) --`);
  console.log(`  desc:   ${a.description.slice(0, 70)}`);
  console.log(`  model:  ${a.model ?? "(inherit)"}  thinking=${a.thinking ?? "-"}`);
  console.log(`  tools:  ${a.tools?.join(",") ?? "(default)"}`);
  console.log(`  prompt: ${a.systemPrompt.length} chars`);
  if (!a.systemPrompt.trim()) console.log("  !! EMPTY PROMPT");
}
const reviewer = agents.find((a) => a.name === "reviewer");
if (reviewer) {
  const bad = (reviewer.tools ?? []).filter((t) => ["edit", "write"].includes(t));
  console.log(`\nreviewer read-only: ${bad.length === 0 ? "PASS" : "FAIL has " + bad.join(",")}`);
}
