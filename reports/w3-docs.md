# W3 — docs, skills, prompts, agents

## Delivered

| File | Content |
| --- | --- |
| `README.md` | What it is, install/requirements, quick start (single + parallel fire-then-wait), success/failure model, recycling, tab organisation, verified CLI reference, **honest limitations incl. F23–F25 no-isolation finding** (own section: "Isolation: discipline, not enforcement"), known-limitations table |
| `skills/pi-herdr-subagents/SKILL.md` | Skill for the main agent: when to delegate, fire-then-wait dispatch discipline, task-card contract + verdict JSON requirement, session-based success/failure, steer/continue/resume/retire, tab organisation, isolation discipline. Frontmatter shape copied from `/root/.pi/agent/skills/herdr/SKILL.md` (`name` + quoted `description`) |
| `prompts/implement.md` | scout → planner → worker pipeline (serial, report files per phase). Shape copied exactly from `/root/.pi/agent/prompts/ls-branch.md` (frontmatter = `description` only, then body) |
| `prompts/parallel-review.md` | 3 parallel reviewers (correctness / test-coverage / simplicity), fire-then-wait, wakeup callback, ctrl+d recycling |
| `prompts/implement-and-review.md` | implement → parallel review → fix loop with re-verification |
| `agents/{scout,planner,reviewer,worker,oracle}.md` | Builtin agent defs, frontmatter fields cross-checked against `src/shared/types.ts` `AgentConfig` |

## Frontmatter cross-check vs `src/shared/types.ts` AgentConfig

All fields used exist in `AgentConfig`: `name`, `description`, `model`,
`fallbackModels`, `thinking`, `tools`, `systemPromptMode`, `inheritProjectContext`,
`inheritSkills`, `timeoutMs`, `toolTimeoutMs`, `acceptance` (with `level`,
`role`, `criteria[]`/`id`/`must`/`evidence`/`severity` — all in
`AcceptanceConfig`/`AcceptanceCriterion`), `kind`, `placement`, `steer`,
`onBlocked`, `maxSubagentDepth`, `allowNestedSubagents`.

**Fields I wanted that do NOT exist in AgentConfig (none used):**

- `promptTemplate` / `verdictFormat` — would have liked a declarative verdict-JSON
  spec per agent; verdict text lives in the system-prompt body instead (fine).
- `memory` / `permissions` — appear in design §6.1 example but are NOT fields of
  `AgentConfig`; deliberately omitted from all agent .md files.
- `toolBudget` / `turnBudget` exist (as `ToolBudgetConfig`/`TurnBudgetConfig`) but
  with only `maxToolCalls`/`maxTurns`; I left them off the builtins rather than
  guess nested shapes.
- `fallbackModels` exists — used on `oracle.md`.
- `reviewer.md` is read-only: `tools: read, grep, find, ls` — no `edit`, `write`,
  or `bash` (verified by script: scout/planner/reviewer/oracle all read-only).

## CLI flags: verified, nothing invented

Ran `herdr agent start|prompt|wait|read|send-keys --help`,
`herdr pane split|close|read|list --help`, `herdr tab create|close|rename --help`
and cross-checked every flag in the docs:

- Used: `agent start --kind --pane --timeout [-- args]`; `agent prompt --wait
  --until --timeout`; `agent wait --until --timeout`; `agent read --source --lines`;
  `agent send-keys`; `pane split --current --direction --cwd --no-focus --env`;
  `pane close`; `pane read --source --lines`; `pane list --workspace`;
  `tab create --workspace --cwd --label --no-focus`; `tab close`; `tab rename`.
- All confirmed real. `--env` on `pane split` confirmed (relevant to F24 doc note).
- `agent get` / `agent list` also appear in the README quick-reference notes; both
  verified real (`agent list` used by the wakeup/audit flows, `agent get` by the
  blocked-inspection flow). Not in the assigned verb list, so flagged here:
  **deviation: README documents `herdr agent get` + `herdr agent list`** because
  design F14 (late adoption) and the skill's stuck-worker flow require them.
- Doc-only commands (`herdr --help`, `which <bin>` probe) are not herdr API surface.
- The extension's own subagent tool (`subagent({action,...})` from design §11) is
  referenced conceptually in the skill/README but the CLI examples use only
  verified raw `herdr` commands (the tool implementation is orchestrator-owned).

## Honest limitations documented

- **No isolation (F23–F25)**: README has a dedicated section + a limitations row +
  the skill states children can `pane read` any pane, `HERDR_SOCKET_PATH` is not
  overridable per-pane, and the only real isolation (named session) breaks the
  visibility model. Mitigations framed as discipline + audit + tool allowlists,
  explicitly "not a sandbox".
- F26/F27 (`agent_status` has no success semantics; `agent get` has no error
  field → collect-before-recycle), F29 (aborted never written as stopReason),
  F30/F31 (last-turn-only, tool errors diagnostic), F32/F33 (verdict JSON
  requirement), F19/F20 (start race + retry), F21 (stderr errors), F22 (missing
  binary = 15s timeout), F7 (non-pi kinds degrade to `unknown`), F11 (ctrl+d not
  ctrl+c), F12 (resume works), F15 (tab close atomic), F17 (name rules) — all
  covered in README + skill.

## Verification

- Frontmatter structure check: all 10 files start with `---`, close correctly;
  agents/skills have `name`+`description`, prompts have `description` (matches
  `ls-branch.md` shape exactly — prompts intentionally have no `name`).
- All fences language-tagged (`bash`/`json`/`text`); no bare opening fences.
- markdownlint: files are clean except MD041 (prose-first format, inherent — the
  reference `ls-branch.md` and `herdr/SKILL.md` fail the same rule) and MD013 on
  table rows / CLI one-liners / verdict JSON (harness auto-fixes).
- Did NOT touch `src/`, `test/`, or `docs/design.md`.

## Open questions

1. `design.md` §6.1 shows `acceptance.criteria[].evidence` as a YAML list and
   `skills`/`alias` as comma-lists; W1's parser supports both — builtin agents use
   YAML block lists for `acceptance` and comma-lists for `tools`. Confirm W1's
   `parseFrontmatterList` normalizes comma strings (spec says it does).
2. Should builtin agents get a `defaultReads` (e.g. `reports/plan.md` for worker)?
   Field exists; left unset to avoid inventing conventions.
