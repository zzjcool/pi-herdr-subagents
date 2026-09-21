---
name: herdr-subagents
description: "Delegate with the subagent tool whenever a loaded role matches the job (search, scout, planner, worker, reviewer, oracle, or any user agent in ~/.pi/agent/agents). Prefer subagent over doing that work yourself. Do not run herdr CLI to launch agents."
---

# Herdr Subagents

The launch path is frozen. Do not invent herdr commands.

The system prompt lists **every loaded role** each turn, including user agents
such as `search`. Use the matching name. Do not curl the web yourself when a
search/research role exists.

```text
subagent({ agent: "search", task: "<query>" })
subagent({ agent: "worker", task: "<task card>" })
subagent({ agent: "worker", task: "<task card>", worktree: true })
subagent({ tasks: [
  { agent: "reviewer", task: "<lane A>" },
  { agent: "reviewer", task: "<lane B>" },
] })
```

That is the entire dispatch. The tool creates the type tab, splits panes, starts
agents, shows status **above the input**, and queues a completion when a child
finishes. If this session is idle it wakes immediately; if it is still working,
the notice waits until the current turn ends. **Same agent type = one tab,
different panes.** A scout and a reviewer get two tabs; two scouts share one.

**First action is the `subagent` tool.** Do not `test HERDR_ENV`, do not
`herdr --help`, do not `herdr agent` / `herdr pane`, do not `pane split` /
`agent start` / `agent prompt` / `agent wait`. Those are the old ritual; the
plugin will block them. Prefer one `tasks[]` call over two separate launches.

**Isolation is your call.** Pass `worktree: true` when another parent may write
this repo, or when the child should ship via MR (own branch, do not touch the
current checkout). Pass `worktree: false` to edit this checkout in place. Omit
it to use the role default (bundled `worker` isolates).

Then return control. Completions arrive as `Background task completed: **name**`.
The plugin recycles the child's pane (and the type tab when empty) when the
turn finishes. Do not `retire` or close panes yourself. `resume` from the
session file if you need the child again. `collect` after auto-watch returns
the cached snapshot; `retire` after auto-recycle is a no-op. Pass `async: false`
only for a short foreground run.

Parallel children launched together finish at different times; their completion
notices are merged and delivered as one grouped message — read it once and
synthesize a combined summary instead of reacting per child. If you need
first-finished-first or know runtimes differ wildly, call
`subagent({ action: "wait", all: true, timeoutMs })` (or `wait` with `name`)
to block for results.

## Task cards

Write the work, the paths, and the output location. The plugin **already
appends** frozen constraints to every child:

- do not prompt / wait on / send-keys to any other pane
- do not read or close panes that are not yours
- do not spawn nested agents
- writers: isolated worktree branch; commit there and open an MR, do not write the parent checkout
- end with `{"ok": true|false, "reason": "..."}` on its own line

Do **not** add a wakeup instruction. Never tell a child to
`herdr agent prompt` this pane.

Read-only roles (`scout`, `reviewer`) still have `bash` for reconnaissance;
writes are blocked by the child-guard. You do not need to repeat “do not `rm`”
in the task unless you want extra emphasis.

## Later control

```text
subagent({ action: "steer", name, message })
subagent({ action: "continue", name, message })
subagent({ action: "resume", name, message })
subagent({ action: "status", name })
subagent({ action: "list" })
```

If a child is waiting on a tool approval, the parent TUI gets a confirm
(`onBlocked: forward`). Do not invent a `steer` just to type `y`.

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

Child-guard blocks `herdr agent prompt` and foreign `pane read`, and it blocks
writes for read-only roles. Writer roles (`worker`) run in an isolated git
worktree on their own branch and ship via MR — they must not write the parent
checkout. Herdr is still **one trust domain**: never put secrets on screen
while children run. Do not treat a pane as a sandbox.
