---
name: pi-herdr-subagents
npm: "@zzjcool/pi-herdr-subagents"
description: "Delegate work to child Pi agents running in Herdr panes: visible, steerable, resumable, with accurate success/failure accounting. Use when a task would benefit from parallel workers, fresh-context adversarial review, or long-running background subtasks that must survive the parent. Do not use for trivial single-file edits, running tests, or answering simple questions."
---

# @zzjcool/pi-herdr-subagents

A [Pi](https://github.com/badlogic/pi-mono) extension that delegates work to
**child Pi agents in [Herdr](https://herdr.dev) panes**.

A herdr subagent is a **supervised live process**, not a one-shot function call.
It stays resident across turns, can be steered mid-flight, resumed after its
pane is gone, and stays visible to you. The parent session never has to invent
`herdr pane split` / `herdr agent start` — one `subagent` tool call is the
whole launch path.

> **Name note.** The package is scoped (`@zzjcool/...`) on purpose: the
> unscoped name `pi-herdr-subagents` on npm belongs to an unrelated project.
> Installing that one will not give you this code.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [What the plugin does for you](#what-the-plugin-does-for-you)
- [Quick start](#quick-start)
- [Tool reference](#tool-reference)
- [Bundled roles](#bundled-roles)
- [Presets (kind+model+thinking)](#presets-kindmodelthinking)
- [Model profiles (cheap / medium / strong)](#model-profiles-cheap--medium--strong)
- [Settings](#settings)
- [Custom agents](#custom-agents)
- [Isolation](#isolation)
- [Success and failure](#success-and-failure)
- [Programmatic API](#programmatic-api)
- [Development](#development)
- [Known limitations](#known-limitations)

## Requirements

- **Pi** (the coding agent that loads this package as an extension)
- **Herdr**, with the parent session running **inside** a Herdr pane
  (`HERDR_ENV=1`). The plugin talks to herdr to create tabs/panes and start
  child agents; it will not launch anything from a plain terminal Pi.
- Node.js 22+ if you are developing the package itself

You do **not** need to run `test "$HERDR_ENV" = 1` or `herdr --help` yourself.
The parent model must not either — the plugin blocks that ritual and checks
herdr on every launch.

## Install

```bash
pi install npm:@zzjcool/pi-herdr-subagents
```

From git (picks up commits that are not on npm yet):

```bash
pi install git:github.com/zzjcool/pi-herdr-subagents
```

From a local checkout:

```bash
pi install /path/to/herdr-subagents
```

Then **reload the parent session** (`/reload`, or restart Pi). After install,
five roles (`scout`, `planner`, `worker`, `reviewer`, `oracle`) are available
with no extra files to copy — see [Bundled roles](#bundled-roles).

To update a git install: `pi update`. To switch from a path/git install to npm
once a release is published, remove the old package and `pi install npm:@zzjcool/pi-herdr-subagents`.

## What the plugin does for you

These used to be “please remember this in the prompt.” They are now
**scripts**. Neither the parent model nor the child has to cooperate for them
to hold.

| Concern | What happens |
| --- | --- |
| Launch | One `subagent` call creates the type tab, splits a pane, starts `pi`, and begins watching. Same agent type shares one tab (each child is a pane). |
| Status | Running children are painted **above the parent input** with model (`:thinking` when set), kind (if not `pi`), turn / in-flight tool, and worktree branch. Elapsed time keeps ticking after the tool call returns. Non-pi kinds (cursor, claude, …) fill the same slots from `agent get` labels / pane title when jsonl is absent. |
| Completion | When a turn finishes, the plugin injects `Background task completed: **name**` into the parent. If the parent is idle it wakes immediately; if it is still in a tool loop, the notice waits (`followUp`) instead of steering mid-turn. |
| Recycle | Terminal children get `ctrl+d`, then pane close (and the type tab when it is empty). You do not `retire` or close panes. `blocked` is the exception — the pane stays. |
| Child must not ping the parent | Every child Pi loads a **child-guard** extension. `herdr agent prompt/wait/send-keys/start`, pane split, tab create/close, and reading someone else’s pane are blocked. |
| Task-card boilerplate | A frozen appendix is appended to every child task: no wakeup, no nested agents, end with `{"ok": true\|false, "reason": "..."}`. |
| Read-only roles | `acceptance.role: read-only` (scout, reviewer, …) may still have `bash` for `rg` / `git log` / `ls`, but writes (`rm`, `git commit`, `echo > file`, `npm install`, `sed -i`, …) are blocked. |
| Acceptance | `{"ok": true}` is only **attested**. If a required criterion lists `evidence: [verification-output]` (the bundled `worker` does), collect then runs `npm run typecheck && npm test` in the child’s cwd and promotes the result to **verified** or rejects it. |
| Tool approval (`blocked`) | `onBlocked: forward` (default) pops a **confirm** in the parent TUI. Yes → `send-keys y` and keep watching. No → deny. No TUI → a notify is queued instead of silently waiting for the parent model to `steer`. `auto-approve` / `notify` are the other policies. |
| Late `collect` / `retire` | If watch already collected, `collect` returns the cached snapshot. If the pane is already gone, `retire` is a no-op that points at the session file. |

What is still a **judgment** (and must stay one):

- whether to spawn a child, which role, and what the task should say
- what to do with the completion (accept, `steer`, `continue`, ignore)
- whether a semantic checklist item like “no secrets in the diff” actually holds

## Quick start

Use the `subagent` tool. **Do not run herdr CLI or env checks first.** Do not
tell the child to prompt the parent.

```text
subagent({
  agent: "reviewer",
  task: "Review src/foo.ts for regressions. Write findings to /tmp/review.md."
})
```

The frozen appendix (verdict JSON, no wakeup) is added automatically. You can
still write a detailed task card; just do not include “when done, `herdr agent
prompt` the parent.” Isolation is the parent’s call:

```text
subagent({ agent: "worker", task: "<implement>", worktree: true })   // own branch, child opens MR
subagent({ agent: "worker", task: "<hotfix>", worktree: false })     // edit this checkout
```

Parallel fan-out — one tool call, then return control:

```text
subagent({ tasks: [
  { agent: "worker", task: "<task A>" },
  { agent: "worker", task: "<task B>" },
  { agent: "reviewer", task: "<task C>" },
] })
```

Steer a running agent (current task abandoned, context kept):

```text
subagent({ action: "steer", name: "reviewer-0", message: "Stop the API review; focus on the migration script instead." })
```

Pass `async: false` only when **this turn** must have the result before it
ends. The default is async: launch, return control, get a completion later.

## Tool reference

| `action` | Purpose |
| --- | --- |
| *(omitted)* / `launch` | Start one child (`agent` + `task`) or several (`tasks[]` / `chain[]`) |
| `steer` | Prompt a live child; it drops the current turn and takes the new message |
| `continue` | Prompt a live child without abandoning the current turn |
| `resume` | Relaunch from the session file if the pane is already gone |
| `status` | Show the persisted record (state, pane, session path, last execution) |
| `collect` | Wait for the current turn (or return the cache if watch already did) |
| `list` | Roles the parent can spawn, with provenance (`builtin` / `user` / `project`) |
| `retire` | Close the pane. After auto-recycle this is a documented no-op |

Useful launch fields: `model`, `preset`, `cwd`, `placement` (`split-down` / `split-right` /
`new-tab`), `worktree` (`true` = isolated branch + child opens an MR; `false` =
edit the current checkout; omit = role default), `agentScope` (`user` /
`project` / `both`), `async`.

Handles look like `reviewer-0`. Every loaded role (builtin plus
`~/.pi/agent/agents` and project `.pi/agents`) is injected into the parent
system prompt each turn — that is how the model knows to call `search` without
`action=list` first. `status` / `collect` take `name`.

## Bundled roles

Five role definitions ship inside the package and load with **zero setup**.
They are anchored to the package itself (not to `~/.pi/agent/agents`), because
Pi’s package resource conventions have no `agents/` slot — a manifest entry
alone would be silently ignored.

| Role | Purpose | Acceptance |
| --- | --- | --- |
| `scout` | Read-only reconnaissance: map code, conventions, environment. Facts only. | attested, **read-only** bash |
| `planner` | Turn a task into a parallelisable, verifiable plan; freeze interfaces. | attested |
| `worker` | Implement a frozen plan on an isolated worktree; open an MR; run tests; self-report a verdict. | **verified** via `npm run typecheck && npm test` |
| `reviewer` | Read-only adversarial review; findings with path + severity. | attested, **read-only** bash |
| `oracle` | Final arbitration on a contested plan. | attested |

Bundled roles do **not** pin a vendor model. A child uses the parent session’s
model unless you set `subagents.defaultModel`,
`subagents.agentOverrides.<name>.model`, assign a named
[preset](#presets-kindmodelthinking), pass `model` on the tool call, or
[load a model profile](#model-profiles-cheap--medium--strong).

## Presets (kind+model+thinking)

Named bundles in settings, referenced from agent frontmatter (`preset: strong`),
from `agentOverrides.<name>.preset`, or from the tool’s `preset` param (single
launch, `tasks[]`, and `chain[]` all accept it):

```json
{
  "subagents": {
    "presets": {
      "cheap":  { "kind": "pi", "model": "cb/deepseek-v4.1-flash", "thinking": "low" },
      "strong": { "kind": "pi", "model": "cb/kimi-k3", "thinking": "high" },
      "visual": { "kind": "cursor", "model": "grok-4.6" }
    }
  }
}
```

Model precedence, strongest first:

```text
per-run tool `model`            (beats the preset's MODEL, but the preset's KIND still applies)
→ preset kind / model / thinking
→ agentOverridesByProvider.<provider>.<name>
→ agentOverrides.<name>
→ agent frontmatter `model`
→ subagents.defaultModel
→ the dispatching (parent) session model
```

A preset deliberately beats `agentOverrides` — that is the point of the level:
profiles pin roles via `agentOverrides` (`loadCatalog` folds them into
`agent.model` before anything resolves), so a frontmatter-adjacent preset would
be unreachable. Two guarantees:

- **Atomic.** The preset's `kind` and the model the child is *actually launched
  with* are checked together. Whichever level supplied the model — the preset
  itself, a per-run tool `model`, `agentOverrides`, `defaultModel`, the parent
  session — a pair the kind cannot accept is refused loudly instead of being
  silently dropped at start (`kind: cursor` with a pi-shaped `provider/id` is
  the canonical case).
- **Loud.** Referencing an undefined preset is an error naming the defined
  presets — never a silent fallback to the parent model.

Agents with no `preset` resolve exactly as before.

Precedence, lowest to highest — later layers override earlier ones by name:

```text
builtin (shipped)  <  extra dirs  <  ~/.pi/agent/agents  <  <project>/.pi/agents
```

Shadow any bundled role by putting a same-name `*.md` in `~/.pi/agent/agents`
or `<repo>/.pi/agents`.

- `subagents.disableBuiltins: true` drops the bundled layer entirely.
- `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` (PATH-style) injects extra read-only
  role directories — Nix store, container, read-only mount.
- `subagent({ action: "list" })` shows every role with its provenance tag.

## Model profiles (cheap / medium / strong)

Same workflow as pi-subagents: classify a provider’s models into three
capability tiers, then bind roles to those tiers so you do not have to change
the parent session model every time.

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

That writes two profiles (`<provider>.quota` leans cheaper,
`<provider>.quality` leans stronger) under
`~/.pi/agent/profiles/pi-herdr-subagents/` and, on load, copies
`agentOverrides` into `~/.pi/agent/settings.json`. Project `.pi/settings.json`
still wins on overlapping keys.

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

## Settings

Read from `~/.pi/agent/settings.json` (user) and `<project>/.pi/settings.json`
(project). Project wins on overlap.

```json
{
  "subagents": {
    "defaultModel": "provider/id",
    "disableBuiltins": false,
    "maxSubagentSpawnsPerSession": 8,
    "agentOverrides": {
      "worker": { "model": "provider/id", "thinking": "medium" }
    },
    "agentOverridesByProvider": {
      "cb": { "worker": { "model": "cb/glm-5.3" } }
    },
    "modelScope": { "allow": ["cb/*", "openai/*"] },
    "herdr": {
      "defaultPlacement": "split-down",
      "maxConcurrentAgents": 6,
      "startRetries": 40,
      "startRetryBackoffMs": 150,
      "sessionRetentionDays": 7
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `defaultModel` | Fallback model for roles that do not pin one |
| `presets` | Named kind+model+thinking bundles, referenced via `preset:` — they beat `agentOverrides`, lose to the tool `model` |
| `agentOverrides` | Per-role field overlay (`model`, `thinking`, `preset`, `tools`, `disabled`, …) |
| `agentOverridesByProvider` | Same overlay, keyed by the **parent** provider id |
| `modelScope.allow` | Glob list of `provider/id` the parent may assign. Explicit tool `model` is an error if it misses; inherited is a warning |
| `disableBuiltins` | Do not load the five shipped roles |
| `maxSubagentSpawnsPerSession` | Hard cap on how many children this session may start |
| `herdr.maxConcurrentAgents` | Layout / density hint (default 6) |
| `herdr.startRetries` | `agent_pane_busy` retries (default 40 × 150ms+) |

Run records and child session jsonl live under `<cwd>/.pi-subagents/`. That
directory is the resume credential; do not delete it while you still want to
`resume` a child.

## Custom agents

A role is a markdown file with YAML frontmatter + a system prompt body:

```markdown
---
name: researcher
description: Read-only paper/code survey
tools: read, grep, find, ls, bash
timeoutMs: 600000
acceptance:
  level: attested
  role: read-only
kind: pi
placement: split-down
steer: true
onBlocked: forward
---

You are a read-only researcher. Facts with paths. No edits.
```

Put it in `~/.pi/agent/agents/researcher.md` (user) or
`<repo>/.pi/agents/researcher.md` (project). Required fields: `name`,
`description`. Useful optional fields: `model`, `preset`, `thinking`, `tools`, `skills`,
`timeoutMs`, `placement`, `onBlocked` (`forward` / `auto-approve` / `notify`),
`acceptance.role` (`read-only` / `writer`), `acceptance.criteria` with
`evidence: [verification-output]` (and optional `command:`) if collect should
run a check, `worktree`, `toolBudget` / `turnBudget` / `toolTimeoutMs`,
`fallbackModels`, `alias`, `completionGuard`, `allowNestedSubagents`.

If `subagent({ action: "list" })` prints `⚠ not enforced yet: …`, that key is
parsed but inert. A listed key that does nothing is worse than an unknown key
— if you see that warning, the field is decoration. The shipped roles currently
report none.

## Isolation

Herdr panes are **one trust domain**. A child can in principle `herdr pane
read` any pane in the session (measured: F23). We now **enforce** a subset of
that discipline; the rest is still on you.

**Enforced in the child process**

- `herdr agent prompt|wait|send-keys|start`
- `herdr pane split`, `herdr tab create|close`
- `herdr pane read|close` of a pane that is not this child’s
- for `acceptance.role: read-only`: filesystem writes, `git` mutations,
  package-manager installs, `sed -i`, redirects onto files
- `toolBudget.maxToolCalls` / `turnBudget.maxTurns` (further tool calls are
  blocked); `toolTimeoutMs` wraps bash with GNU `timeout`
- `worktree: true` → `git worktree add -b` under the run dir (named
  `pi-subagent/<name>-…` branch). The pane’s cwd is that tree. The **parent**
  decides per launch (`subagent({ worktree: true|false })`); omitting it uses
  the role default. Writer roles (`acceptance.role: writer`, including bundled
  `worker`) default this on so concurrent parent Pis do not share a dirty
  checkout; the child commits on the branch and opens an MR. `worktree: false`
  opts out. Retire leaves the tree on disk. Requires a git repository.
- child tabs are pinned to the **parent herdr Space**
  (`HERDR_WORKSPACE_ID` → `tab create --workspace`). A focused Space elsewhere
  cannot steal the child, and adopt will not reuse a same-label tab in another
  Space.

**Still not a sandbox**

- `HERDR_SOCKET_PATH` cannot be overridden per pane (F24)
- a true isolated session would break the visible/steerable model (F25)
- never put secrets on screen in any pane while children run
- owner tokens: recycle only panes the tree registered; skip + warn otherwise

If a task genuinely needs isolation, run it **outside** herdr (plain `pi`, no
`HERDR_ENV`), rather than pretending panes are sandboxed.

## Success and failure

**herdr `agent_status` cannot tell you whether an agent succeeded.** Success,
model error, and kill all report `done`. The plugin derives outcome from the
child’s session jsonl (`stopReason` of the last turn) and from the
machine-readable verdict.

Two orthogonal dimensions — never conflate them:

- **Lifecycle** (`launching → working → awaiting → blocked → retired/exited`):
  is the process alive?
- **Execution** (`success / failed / aborted / truncated / running`): did the
  task succeed?

`state: retired` + `execution.status: failed` is a normal combination.

| Session signal | Execution |
| --- | --- |
| Last turn `stopReason: "stop"` | success |
| `stopReason: "error"` without “aborted” | failed |
| `stopReason: "error"` + “This operation was aborted” | aborted |
| Last user prompt with **no** assistant message | aborted (killed mid-turn) |
| Last assistant `stopReason: "toolUse"` and the agent is gone | aborted |
| Last assistant `toolUse` and herdr says `blocked` | not terminal — confirm / wait |
| `stopReason: "length"` | truncated |
| No messages | unknown |

On top of that:

- **Only the last turn decides execution.** A tool error in turn 1 followed by
  a clean turn 2 is overall success. `toolErrors` is diagnostic only.
- **Self-report is attested, not verified.** `{"ok": true}` is the agent
  marking its own homework. Worker’s `verification-output` criterion is the
  exception: the plugin runs `criterion.command` (or
  `npm run typecheck && npm test`) itself, with a timeout. `completionGuard:
  true` rejects a successful turn that forgot the `{"ok":…}` verdict.
- **Recycle destroys live evidence** (`agent get` → `agent_not_found`). The
  plugin collects and snapshots `execution` into `.pi-subagents/run.json`
  **before** closing the pane. Resume uses the session file, not the pane.

## Programmatic API

Hosts that are not the Pi `subagent` tool can drive the same machinery:

```ts
import {
  createHerdrClient,
  Orchestrator,
  loadAgentsFromDir,
} from "@zzjcool/pi-herdr-subagents/api";

const client = createHerdrClient();
const [scout] = loadAgentsFromDir("/path/to/agents", "user");
const orch = new Orchestrator({
  client,
  runDir: "/tmp/run",
  cwd: process.cwd(),
});
const handle = await orch.launch({ agent: scout, task: "survey the repo" });
const result = await orch.collect(handle.name);
```

Everything re-exported from `./api` is covered by the test suite. Do not import
from `src/` directly.

## Development

```bash
git clone https://github.com/zzjcool/pi-herdr-subagents.git
cd pi-herdr-subagents
npm install
npm run typecheck
npm test                 # unit
npm run test:integration # fake herdr, no live binary
```

Live tests (`npm run test:live`) need a real herdr on `PATH` and
`HERDR_ENV=1`. They are skipped otherwise.

Container checks (host Pi config bind-mounted, package at `/plugin`) live in
`test/docker/`. Each numbered script is one feature:

```bash
bash test/docker/verify-1-child-guard.sh
bash test/docker/verify-2-task-appendix.sh
bash test/docker/verify-3-readonly.sh
bash test/docker/verify-4-acceptance.sh
bash test/docker/verify-5-blocked.sh
bash test/docker/verify-6-cache.sh
bash test/docker/verify-7-budget.sh
bash test/docker/verify-8-verify-command.sh
bash test/docker/verify-9-worktree.sh
bash test/docker/verify-10-fallback.sh
bash test/docker/verify-11-nested-alias.sh
bash test/docker/verify-12-workspace.sh
bash test/docker/verify-13-kinds.sh        # kinds + models; live CodeBuddy/Cursor when mounted
```

They expect image `pi-herdr-sandbox:latest` and copy `~/.pi/agent/{settings,models,auth}.json`
into a disposable home so the container uses your providers without writing
back. See [CONTRIBUTING.md](CONTRIBUTING.md).

The measured design (findings F1–F46, why session jsonl is the source of
truth, why recycle is unconditional) is [docs/design.md](docs/design.md).
Historical “this field is parsed but inert” notes in that file may predate
the runtime table above — trust this README and `action=list`’s
`unenforcedFields` for what is actually wired.

## Known limitations

- **Not a sandbox** (F23–F25): child-guard covers bash/herdr dispatch and
  read-only writes; it does not give you process isolation.
- **`agent_status` has no success/failure semantics** (F26).
- **Non-pi kinds degrade** (F7): same Herdr control plane (`start` → `prompt` → `wait`), but no usage and outcome is `unknown` unless the pane text includes a verdict JSON that is not just the echoed launch prompt. Cursor starts with `--trust` (and `--force` when `onBlocked: auto-approve`) so workspace-trust does not block the first prompt. Resume depends on each CLI.
- **`blocked` is screen-heuristic**: false positives exist; the confirm is
  paired with the collect timeout as a backstop.
- **Verification** runs `criterion.command` when a required criterion asks
  for `verification-output`, else `npm run typecheck && npm test`. Semantic
  `must` strings are never NLP-parsed (F32 / F44). Other evidence types stay
  a checklist.
- **Panes are scarce**: cap fan-out (`maxSubagentSpawnsPerSession` /
  `herdr.maxConcurrentAgents`). Warm-pane pooling is not worth it (~0.9s).

## License

MIT. See [LICENSE](LICENSE).
