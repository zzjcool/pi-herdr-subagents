---
name: herdr-subagents
description: "Delegate work to child Pi agents in Herdr panes: parallel workers, fresh-context review, resumable long tasks. Use when the user asks for parallel/delegated subagent work, or a task clearly benefits from multiple agents. Requires HERDR_ENV=1."
---

# Herdr Subagents

Delegate tasks to child Pi agents running in Herdr panes. Each child is a
supervised live process: visible in its pane, steerable mid-turn, resumable
after recycle, with success/failure derived from its session jsonl.

Verify you are inside Herdr first:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, stop and tell the user this requires running inside Herdr.

## When to delegate

Delegate when at least one holds:

- Work spans multiple independent modules/directories (one worker per module).
- An implementation deserves adversarial review by fresh-context agents.
- Several independent tasks (tests / regression / research) can run at once.
- The approach is uncertain and you want a second opinion before acting.
- A long task would block the conversation for many minutes.

Do NOT delegate: single-function edits, running tests, reading logs, answering
simple questions, or anything the user asked you to "just do directly".

## Dispatch discipline: fire, then wait

```bash
# 1. Layout: one pane per worker (parse IDs from JSON, never guess)
herdr pane split --current --direction down --cwd "$PWD" --no-focus
# → take .result.pane.pane_id from the response

# 2. Start agents (retry on agent_pane_busy — parallel starts race)
herdr agent start w1 --kind pi --pane <pane-id>
herdr agent start w2 --kind pi --pane <pane-id-2>

# 3. Dispatch ALL tasks first, WITHOUT --wait
herdr agent prompt w1 "<task A> ... When done run: herdr agent prompt orchestrator \"w1 done. report: <path>\""
herdr agent prompt w2 "<task B> ... When done run: herdr agent prompt orchestrator \"w2 done. report: <path>\""

# 4. Only then harvest
herdr agent wait w1 --timeout 900000
herdr agent wait w2 --timeout 900000
```

Never issue `agent prompt --wait` one-by-one across multiple workers: `--wait`
blocks until completion, so the dispatch phase serializes and parallelism drops to
zero. `--wait` is only for the single-agent "submit and I need the answer now" case.

Include a wakeup instruction in every task card so workers report back automatically:
`When done run: herdr agent prompt orchestrator "<one-line summary> report: <path>"`.
If a worker appears stuck at a confirmation dialog, it will refuse prompts — check
`herdr agent get <name>` and `herdr agent read <name>` first, and wrap any probe
commands in `timeout 60`.

## Task cards

Each task card must contain:

1. The concrete task (files in/out, constraints, frozen signatures if any).
2. Scope guards: which files/dirs the worker may touch; no spawning further agents.
3. Output contract: report path + format, and the wakeup instruction above.
4. A verdict requirement — the worker's last output must be machine-readable:

   ```json
   {"ok": true, "reason": "..."}
   ```

   An agent that says "FAILED: ..." in prose still looks successful to herdr
   (`done` + `stopReason: stop`), so the verdict JSON is the only reliable
   self-report. `"ok": false` counts as rejection regardless of `done`.

## Success/failure: read the session, not the status

`agent_status` cannot distinguish success, model error, or being killed — all are
`done`. Derive the outcome from the child's session jsonl (the path `agent start`
returned, F1):

- Last turn ends with `stopReason: "stop"` → success.
- `stopReason: "error"` without "aborted" in the message → failed.
- Last user prompt with no assistant reply, or last message stuck at `toolUse`
  → aborted (killed mid-turn).
- `stopReason: "length"` → truncated.
- Only the **last turn** decides; earlier tool errors are diagnostics only.
- Collect (derive + persist) the outcome BEFORE recycling — after the agent exits,
  `agent get` returns `agent_not_found` and the evidence is gone.

## Steering and resuming

- **Steer** (running, change direction): `herdr agent prompt <name> "<new direction>"`
  without waiting — the agent abandons its current task, context kept.
- **Continue** (turn finished, keep going): same command; it queues the next turn.
- **Resume** (process exited / pane gone): split a new pane and start with
  `-- --session <session-file>`; context is fully preserved from disk.
- **Retire**: collect first, then `herdr agent send-keys <name> ctrl+d` (twice if
  needed; never `ctrl+c`), wait ~2s, then `herdr pane close <pane-id>` if still
  alive, and `herdr tab close <tab-id>` as the batch fallback for a whole task.

## Tab organisation

One task, one tab: `tab` is the isolation boundary and the atomic recycle unit
(`herdr tab create --label "task:<name>" --no-focus`, create panes inside it).
Split into the current tab only for a single agent or 2–4 closely related
workers. After recycling, audit:
`herdr pane list --workspace "$HERDR_WORKSPACE_ID"` panes in
the task tab must all be registered children; anything else is an orphan and a
sign of out-of-tree creation.

## Isolation: discipline only

A child agent can `herdr pane read` ANY pane in the session, including yours and the
user's; `HERDR_SOCKET_PATH` cannot be overridden per-pane. There is no enforced
isolation — only the tab boundary, tool allowlists (deny `bash`/`edit` to agents
that do not need them), prompt discipline, and owner-token audit. Never display
secrets in panes while children run, and never treat a pane as a sandbox.

## Recycling

Pane contents are a strict subset of the session jsonl (which adds error messages,
stopReason, tool-error counts, usage) — closing a pane loses nothing once you have
collected. Recycle unconditionally at terminal states (`awaiting`/`retired`/failed/
aborted), keep the pane only while `blocked` (an approval is pending — pair with a
timeout, the detection has false positives). Keep session files for resume; they are
the only durable carrier of a child's work.
