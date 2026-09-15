---
name: herdr-subagents
description: "Delegate work with the subagent tool: one call launches child Pi agents in Herdr panes. Use when the user asks for parallel/delegated subagent work. Do not run herdr CLI to launch agents."
---

# Herdr Subagents

The launch path is frozen. Do not invent herdr commands.

```text
subagent({ agent: "worker", task: "<task card>" })
subagent({ tasks: [
  { agent: "reviewer", task: "<lane A>" },
  { agent: "reviewer", task: "<lane B>" },
] })
```

That is the entire dispatch. The tool creates the type tab, splits panes, starts
agents, shows status next to the input, and wakes this session when a child
finishes. **Same agent type = one tab, different panes.** A scout and a
reviewer get two tabs; two scouts share one.

**First action is the `subagent` tool.** Do not `test HERDR_ENV`, do not
`herdr --help`, do not `herdr agent` / `herdr pane`, do not `pane split` /
`agent start` / `agent prompt` / `agent wait`. Those are the old ritual; the
plugin will block them. Prefer one `tasks[]` call over two separate launches.

Then return control. Completions arrive as `Background task completed: **name**`.
The plugin recycles the child's pane (and the type tab when empty) when the
turn finishes. Do not `retire` or close panes yourself. `resume` from the
session file if you need the child again. Call `collect` only when this turn
must have the result (headless). Pass `async: false` only for a short
foreground run.

## Task cards

1. Concrete task (files in/out, constraints).
2. Scope: which paths the child may touch; no spawning further agents; no
   reading or prompting other panes.
3. Output path + format. **No wakeup instruction.** Never tell a child to
   `herdr agent prompt` this pane.
4. Final line must be machine-readable: `{"ok": true|false, "reason": "..."}`.

## Later control

```text
subagent({ action: "steer", name, message })
subagent({ action: "continue", name, message })
subagent({ action: "resume", name, message })
subagent({ action: "list" })
```

## Model profiles

Roles do not pin a vendor model. To bind capability tiers without switching the
parent session each time:

```text
/subagents-refresh-provider-models <provider>
/subagents-generate-profiles <provider>
/subagents-load-profile <provider>.quota
```

`scout` → cheap, `planner` → medium, `worker`/`reviewer`/`oracle` → strong.
`/subagents-profiles` lists saved files; `/subagents-check-profile <name>`
verifies they still resolve.

## Isolation

A child can `herdr pane read` any pane in the session. Never put secrets on
screen while children run. Do not treat a pane as a sandbox.
