---
name: pi-herdr-subagents
npm: "@zzjcool/pi-herdr-subagents"
description: "Delegate work to child Pi agents running in Herdr panes: visible, steerable, resumable, with accurate success/failure accounting. Use when a task would benefit from parallel workers, fresh-context adversarial review, or long-running background subtasks that must survive the parent. Do not use for trivial single-file edits, running tests, or answering simple questions. Requires HERDR_ENV=1."
---

# @zzjcool/pi-herdr-subagents

Delegate work to child Pi agents running in **Herdr panes**. Unlike one-shot spawn
models, a herdr subagent is a **supervised live process**: it stays resident across
turns, can be steered mid-flight, resumed after the pane is gone, and its pane stays
visible to you and the user.

Before using any `herdr` command, verify you are inside Herdr:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, do not attempt delegation; tell the user this extension requires
running inside Herdr.

## Install

```bash
pi install npm:@zzjcool/pi-herdr-subagents
```

Or from a local checkout / git:

```bash
pi install /path/to/pi-herdr-subagents
pi install git:github.com/zzjcool/pi-herdr-subagents
```

Requires [Herdr](https://herdr.dev) and `HERDR_ENV=1`. Five roles ship with the
package (`scout`, `planner`, `worker`, `reviewer`, `oracle`) and are available
immediately after install — see [Bundled roles](#bundled-roles).

> **Name note.** This package is scoped (`@zzjcool/...`) on purpose: the unscoped
> name `pi-herdr-subagents` on npm belongs to an unrelated third-party project.
> Installing that one will not give you this code.

## Bundled roles

Five role definitions ship inside the package and load with **zero setup**. They are
anchored to the package itself (not to `~/.pi/agent/agents`), so they are present
right after install — pi's package resource conventions have no `agents/` slot, so a
manifest entry alone would be silently ignored.

| Role | Purpose | Default model |
| --- | --- | --- |
| `scout` | Read-only reconnaissance: map code, conventions, environment. Facts only. | parent session (or `subagents.defaultModel`) |
| `planner` | Turn a task into a parallelisable, verifiable plan; freeze interfaces. | parent session (or `subagents.defaultModel`) |
| `worker` | Implement a frozen plan; run tests; self-report a verdict. | parent session (or `subagents.defaultModel`) |
| `reviewer` | Read-only adversarial review; findings with path + severity. | parent session (or `subagents.defaultModel`) |
| `oracle` | Final arbitration on a contested plan. | parent session (or `subagents.defaultModel`) |

Bundled roles do **not** pin a vendor model. A child uses the parent session's model unless you set `subagents.defaultModel`, `subagents.agentOverrides.<name>.model`, pass `model` on the tool call, or [load a model profile](#model-profiles-cheap--medium--strong).

Precedence, lowest to highest — later layers override earlier ones by name:

```text
builtin (shipped)  <  extra dirs  <  ~/.pi/agent/agents  <  <project>/.pi/agents
```

So you can shadow any bundled role with your own definition of the same name.

- `subagents.disableBuiltins: true` in settings drops the bundled layer entirely.
- `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` (PATH-style) injects extra read-only role
directories — for a Nix store, a container, or a read-only mount, where copying
into `~/.pi/agent/agents` is not possible.
- `subagent action=list` shows every role with its provenance tag (`builtin`,
`user`, or `project`).

## Model profiles (cheap / medium / strong)

Same workflow as pi-subagents: classify a provider's models into three capability
tiers, then bind roles to those tiers so you do not have to change the parent
session model every time.

| Tier | Roles |
| --- | --- |
| cheap | `scout` |
| medium | `planner` |
| strong | `worker`, `reviewer`, `oracle` |

```text
/subagents-refresh-provider-models <provider>
/subagents-generate-profiles <provider>
/subagents-load-profile <provider>.quota
```

That writes two profiles (`<provider>.quota` leans cheaper, `<provider>.quality`
leans stronger) under `~/.pi/agent/profiles/pi-herdr-subagents/` and, on load,
copies `agentOverrides` into `~/.pi/agent/settings.json`. Project
`.pi/settings.json` still wins on overlapping keys.

Other commands: `/subagents-profiles` lists saved profiles;
`/subagents-check-profile <name>` re-checks each assigned model against the
current registry (and a live probe unless you pass `--no-probe`). Refresh and
generate accept `--force` and `--no-probe`.

You can still hand-write the same mapping:

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "model": "your-provider/fast-model" },
      "planner": { "model": "your-provider/mid-model" },
      "worker": { "model": "your-provider/strong-model" },
      "reviewer": { "model": "your-provider/strong-model" },
      "oracle": { "model": "your-provider/strong-model" }
    }
  }
}
```

## The mental model

| You might assume | Reality (measured) |
| --- | --- |
| Subagent is a function call | It is a supervised live process in a pane |
| `done` means finished | `done` means "finished this turn" — the process is still alive |
| `agent_status` tells success/failure | It does **not**: success, model error, and kill all report `done` |
| Parent death kills children | Children keep running and complete their task |
| Isolation is enforced | **It is not** — see [Isolation](#isolation-discipline-not-enforcement) |

Two orthogonal dimensions, never conflate them:

- **Lifecycle** (`launching → working → awaiting → retired/exited`): is the process alive?
- **Execution outcome** (`success / failed / aborted / truncated / running`): did the
  task succeed? Derived ONLY from the session jsonl `stopReason` of the last turn.

`state: retired` + `execution.status: failed` is a normal, expected combination.

## Quick start

Use the `subagent` tool. One call is the whole launch path (tab → pane → start
→ watch). **Do not run herdr CLI or env checks first.** The child runs in a
Herdr pane, status shows next to the parent input, and this extension wakes
the parent with a completion message. **Do not tell the child to prompt the
parent.**

```text
subagent({
  agent: "reviewer",
  task: "Review src/foo.ts for regressions. Write findings to /tmp/review.md. End with {\"ok\": true|false, \"reason\": \"...\"}."
})
```

Parallel fan-out — one tool call, then return control:

```text
subagent({ tasks: [
  { agent: "worker", task: "<task A>" },
  { agent: "worker", task: "<task B>" },
  { agent: "reviewer", task: "<task C>" },
] })
```

Steer a running agent (its current task is abandoned, context kept):

```text
subagent({ action: "steer", name: "reviewer-0", message: "Stop the API review; focus on the migration script instead." })
```

Pass `async: false` only when this turn must have the result before it ends.

## Success/failure model

**herdr cannot tell you whether an agent succeeded.** You must derive it from the
agent's session jsonl:

| Signal | Meaning |
| --- | --- |
| Last turn's assistant `stopReason: "stop"` | success |
| `stopReason: "error"` (message without "aborted") | failed |
| `stopReason: "error"` + "This operation was aborted" | aborted (graceful esc) |
| Last user prompt with **no** assistant message | aborted (killed mid-turn) |
| Last assistant message is `stopReason: "toolUse"` | aborted (terminated during a tool call) |
| `stopReason: "length"` | truncated |
| No messages at all | unknown |

Rules that surprise people:

- **Only the last turn decides the outcome.** A tool error (`toolResult.isError: true`)
  in turn 1 followed by a clean turn 2 is overall **success**; tool errors are
  diagnostics, never status (they are counted in `toolErrors`).
- **"aborted" is never written as a stopReason.** Graceful interruption writes
  `error` + an "aborted" message; a hard kill writes no assistant message at all.
- **Self-reported failure is invisible to the execution layer.** An agent that replies
  "FAILED: ..." still has `stopReason: "stop"` and status `done`. Require every child
  to end with a machine-readable verdict, and treat `{"ok": false}` as rejection:
  `{"ok": true, "reason": "..."}` or `{"ok": false, "reason": "..."}`.
- **Recycle destroys the evidence.** After the agent exits, `agent get` returns
  `agent_not_found`. Always collect/derive the outcome (and snapshot it into the run
  record) **before** retiring the pane.

## Recycling (unconditional)

Closing the pane loses nothing: the session jsonl on disk is strictly more
informative than the pane (error messages, stopReason, tool errors, usage). So
recycle unconditionally once the task reaches a terminal state:

1. Task is terminal (`awaiting` / `retired` / `failed` / `aborted`).
   **Exception:** `blocked` is not terminal — the agent is alive waiting for an
   approval; keep the pane (and back any blocked decision with a timeout; the
   detection has a false-positive rate).
2. **Collect first** (derive outcome from session jsonl, persist it).
3. Graceful exit: `herdr agent send-keys <name> ctrl+d` —
   **twice if needed**, wait ~2s.
   Never `ctrl+c`; measured to leave the agent alive.
4. Still alive? `herdr pane close <pane-id>` (session file survives, resume works).
5. Batch fallback: `herdr tab close <tab-id>` empties the whole task tab atomically.
6. Mark retired; keep session files per retention policy.

Resume a retired agent in a fresh pane (context fully preserved):

```bash
herdr pane split --current --direction down --cwd "$PWD" --no-focus
herdr agent start reviewer-1 --kind pi --pane <pane-id> -- --session <session-file>
```

## Tab organisation

```text
workspace = project/repo boundary (follows cwd)
  tab     = one task
    pane  = one subagent
```

- **Tab is the isolation boundary and the batch-recycle unit.** One task per tab when
  tasks are unrelated or long-lived; split into the current tab for a single agent or
  2–4 closely related parallel agents.
- `placement: split-down | split-right | new-tab` in agent
  frontmatter picks the layout.
- Orphan audit: after recycling, compare
  `herdr pane list --workspace <ws>` panes in
  the task tab against registered children; unregistered panes mean something created
  panes outside the tree.
- `herdr tab rename <tab-id> <label>` is cheap (~20ms) —
  use it as a live status board.

## CLI quick reference (verified flags only)

```bash
herdr pane split --current --direction <right|down> [--cwd <path>] [--no-focus] [--env KEY=VALUE]
herdr pane close <pane_id>
herdr pane read <PANE_ID> [--source visible|recent|recent-unwrapped|detection] [--lines <N>]
herdr pane list [--workspace <WORKSPACE_ID>]
herdr tab create [--workspace <ID>] [--cwd <path>] [--label <text>] [--no-focus]
herdr tab close <tab_id>
herdr tab rename <TAB_ID> <LABEL>
herdr agent start <NAME> --kind <KIND> --pane <ID> [--timeout <MS>] [-- <agent args>]
herdr agent prompt <TARGET> <TEXT> [--wait] [--until <STATUS>] [--timeout <MS>]
herdr agent wait <TARGET> [--until <STATUS>] [--timeout <MS>]
herdr agent read <TARGET> [--source <SOURCE>] [--lines <N>]
herdr agent send-keys <TARGET> <KEY>...
```

Notes:

- Agent names must match `[a-z][a-z0-9_-]{0,31}`. A name is released when the agent
  exits and may be reused; while alive, reuse fails with `agent_name_taken`.
- Parallel `agent start` races with `agent_pane_busy` (2/6 failures measured with no
  delay). Retry with backoff (≈150ms + 50ms·i) eliminates it completely.
- Errors come as `{"error":{code,message}}` JSON on **stderr** with exit code 1.
- A missing agent binary does not fail loudly: `agent start` times out (~15s). Probe
  `which <binary>` before starting non-pi kinds.
- `agent read` returns rendered terminal text, not JSON. Programmatic diagnostics
  belong in the session jsonl; `pane read` is for human eyes.
- Non-pi kinds (claude, codex, …) expose no session ref: no usage, no stopReason,
  outcome can only be `unknown`. Use `pi` kind when you need reliable accounting.

## Isolation: discipline, not enforcement

**There is no enforced isolation between herdr panes.** Measured findings:

- **F23** — a child agent can `herdr pane read` ANY pane in the session, including
  yours and the user's. A rouge or prompt-injected child can exfiltrate whatever is
  on screen (verified with a planted secret).
- **F24** — `HERDR_SOCKET_PATH` cannot be overridden per-pane via `--env`; herdr
  reserves it, so children cannot even be pointed at a restricted socket.
- **F25** — the only real isolation is a named session (separate socket + server),
  which breaks the visible/steerable model this extension exists for.

Treat the whole herdr session as a **single trust domain**. This is a trusted internal
tool, not an untrusted-code sandbox:

1. **Tab boundary + orphan audit** — contain and detect, cannot prevent.
2. **Tool allowlists** — agents that do not need `bash` or `edit` must not have them
   (the built-in `reviewer` is read-only by frontmatter).
3. **Prompt discipline** — every child's system prompt explicitly forbids touching
   panes outside its own task.
4. **Never put secrets on screen** in panes a child can read while it runs.
5. **Owner tokens** — children are recorded with an owner token; recycle only panes
   the tree registered, and skip + warn on anything else.

If a task genuinely needs isolation, run it outside herdr (fresh `pi` process without
herdr env) rather than pretending panes are sandboxed.

## Known limitations

- **No isolation** (F23–F25): as above. Discipline + audit only.
- **`agent_status` has no success/failure semantics** (F26): never gate on it; read
  the session jsonl.
- **`agent get` has no error field** (F27): after exit everything is gone — collect
  before recycle.
- **Non-pi kinds degrade** (F7): no usage, no cost, no reliable outcome (only
  `unknown`); resume depends on each CLI's own support.
- **`blocked` detection is screen-heuristic** (F10/F8 family): false positives exist;
  always pair with a timeout.
- **`pane process-info` cannot classify working/idle** (measured: empty diff): use
  jsonl quiet-window + message counts instead.
- **Panes are scarce** (screen real estate): cap concurrency
  (`herdr.maxConcurrentAgents`, default 6); pool warm panes is not worth it (~0.9s
  saved vs ~3s cold start).
- **herdr version coupling**: verify `herdr --help` before relying on a flag; this
  doc only lists flags verified against the installed binary.
