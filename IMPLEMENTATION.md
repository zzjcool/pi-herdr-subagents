# IMPLEMENTATION SPEC — @zzjcool/pi-herdr-subagents

**Read `docs/design.md` (the measured design, findings F1–F33) before coding.**
This file assigns ownership and freezes signatures. Do not deviate without asking.

## Goal

A Pi extension that delegates work to child Pi agents running in **Herdr panes**:
visible, steerable, resumable, and with accurate success/failure accounting.

## Hard rules

1. **Only edit files you own** (see ownership table). Never touch another module's files.
2. **No runtime dependencies.** Node stdlib only (plus `typebox` for tool params).
3. **TypeScript, strict.** `noUncheckedIndexedAccess: true` — handle `T | undefined`.
4. **Import with explicit `.ts` extension** (project uses `allowImportingTsExtensions`).
5. **Every module ships unit tests.** `npm test` must pass. Run `npm run typecheck` too.
6. **Pure logic must be testable without a live herdr.** Inject `CommandRunner`.
7. Before reporting: run `npm run typecheck && npm test`, and include the exact output.
8. Write a short report to `reports/<module>.md` (what you built, tests, open questions).

## Ownership

| Module | Owner | Files |
| --- | --- | --- |
| types (FROZEN) | orchestrator | `src/shared/types.ts` |
| session parse + outcome | orchestrator | `src/shared/session.ts`, `src/shared/paths.ts` |
| herdr client | orchestrator | `src/herdr/client.ts`, `src/herdr/runner.ts`, `src/shared/name.ts`, `src/shared/nested-path.ts` |
| **agents** | **W1** | `src/agents/*.ts`, `test/unit/agents-*.test.ts` |
| **store** | **W2** | `src/runs/store.ts`, `test/unit/store.test.ts` |
| **docs/skills** | **W3** | `skills/**`, `prompts/**`, `README.md`, `docs/**` |
| **test harness** | **W4** | `test/helpers/**`, `test/unit/session.test.ts`, `test/unit/herdr-client.test.ts` |
| orchestrator (launch/collect/retire) | orchestrator | `src/runs/orchestrator.ts` |
| tool + TUI | orchestrator | `index.ts` |

## Conventions

- Tests: `node --experimental-strip-types --test test/unit/*.test.ts`, using `node:test` + `node:assert/strict`.
- Use `mkdtempSync` + `rmSync` for filesystem tests; never write outside a temp dir.
- Error type: `SubagentError` from `src/shared/types.ts` with codes from `ErrorCodes`.
- Prefer small pure functions; push I/O to the edges.

---

## W1 — `src/agents/`

### Deliverables

1. **`src/agents/frontmatter.ts`**

   ```ts
   export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string };
   export function parseFrontmatterList(raw: string | undefined): string[] | undefined;
   ```

   - YAML-ish subset: `key: value`, quoted scalars, block scalars (`|` and `>` with `-` chomping),
     nested blocks (indented), block lists (`- item`), comma lists.
   - Strip surrounding quotes. Handle CRLF.
   - Reference: pi-subagents `src/agents/frontmatter.ts` (already extracted at `/tmp/psa67/package/src/agents/frontmatter.ts`)
     — **you may study it, but write your own** and keep it dependency-free.

2. **`src/agents/agents.ts`**

   ```ts
   export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[];
   export function discoverAgents(cwd: string, scope: AgentScope, opts?: { builtinDir?: string }): AgentDiscoveryResult;
   export function findNearestProjectAgentsDir(cwd: string): string | null;
   ```

   - User dir: `~/.pi/agent/agents`. Project dir: nearest `<cwd>/.pi/agents` walking up.
   - Project overrides user on name collision when scope is `both`.
   - Skip files without `name` + `description`. Never throw on one bad file.
   - Defaults when absent: `systemPromptMode: "replace"`, `inheritProjectContext: true`,
     `inheritSkills: false`, `kind: "pi"`, `placement: "split-down"`, `steer: true`, `onBlocked: "forward"`.
   - Normalize `tools`/`skills`/`alias` from string-or-array.
   - Validate `kind` against the allowed list; reject unknown kinds with a clear message.
   - `maxSubagentDepth` default 1; `allowNestedSubagents` default false.

3. **`src/agents/settings.ts`**

   ```ts
   export function loadSubagentSettings(opts: { userSettingsPath: string; projectSettingsPath?: string }): SubagentsSettings;
   export function resolveSubagentSettings(user: SubagentsSettings, project: SubagentsSettings): SubagentsSettings;
   ```

   - Read the `subagents` key from `settings.json`. Missing file → `{}`. Malformed → throw
     `SubagentError(..., ErrorCodes.INVALID_PARAMS)` with the file path in the message.
   - Validate `herdr.maxConcurrentAgents` (positive int), `startRetries` (int ≥ 0),
     `sessionRetentionDays` (positive int), `modelScope.allow` (string[]).
   - Project settings win over user settings (shallow-merge `herdr`, `agentOverrides`; replace `modelScope`).

4. **`src/agents/model-scope.ts`**

   ```ts
   export function matchesScopePattern(model: string, pattern: string): boolean;
   export function checkModelScope(model: string | undefined, scope: ModelScopeConfig | undefined,
                                   source: "explicit" | "inherited"): ModelScopeViolation | undefined;
   export function stripThinkingSuffix(model: string): string;
   ```

   - Glob: `*` → `.*`, escape other regex specials, case-insensitive, anchored.
   - Compare full `provider/id` with the thinking suffix stripped.
   - Enforcement with no `allow` list is a no-op.
   - **Explicit source → `severity: "error"`; inherited → `"warn"`** (pi-subagents convention).

5. **`src/agents/model-resolution.ts`**

   ```ts
   export function resolveModel(input: {
     agent: AgentConfig;
     override?: string;
     dispatchModel?: string;         // parent session model, "provider/id"
     defaultModel?: string;
     settings?: SubagentsSettings;
     parentProvider?: string;
   }): { model?: string; source?: ModelSourceInfo };
   ```

   - Precedence (highest first), per design §6.2:
     per-run override → `agentOverridesByProvider.<parentProvider>.<name>.model` →
     `agentOverrides.<name>.model` → frontmatter `model` → `subagents.defaultModel` → dispatch model.
   - `model: "inherit"` resolves to `dispatchModel` with `source.type = "inherit"`.
   - `thinking` appended as `:level` **only if** the model has no existing known suffix
     (levels: off, minimal, low, medium, high, xhigh, max). See `applyThinkingSuffix` semantics.
   - Returns `source` describing where it came from.

6. **`src/agents/overrides.ts`**

   ```ts
   export function applyAgentOverrides(agents: AgentConfig[], overrides: SubagentsSettings["agentOverrides"]): AgentConfig[];
   export function applyDefaultModel(agents: AgentConfig[], defaultModel: string | undefined): AgentConfig[];
   ```

   - `disabled: true` removes the agent from the list.
   - Override fields replace frontmatter fields (deep-copy arrays).

7. **`src/profiles/` + `src/extension/slash.ts`**

   Model-tier profiles matching pi-subagents: classify a provider catalog into
   cheap / medium / strong, write `<provider>.quota` + `<provider>.quality`, load
   into `~/.pi/agent/settings.json` as `agentOverrides`.

   - Role map: scout→cheap, planner→medium, worker/reviewer/oracle→strong.
   - Files: `~/.pi/agent/profiles/pi-herdr-subagents/`.
   - Slash: `/subagents-profiles`, `/subagents-load-profile`,
     `/subagents-refresh-provider-models`, `/subagents-generate-profiles`,
     `/subagents-check-profile`.
   - Launch reads **user** `~/.pi/agent/settings.json` merged with project
     `.pi/settings.json` so a loaded profile actually applies.

### W1 acceptance

- `npm run typecheck` clean; `npm test` green.
- ≥ 25 focused unit tests covering: frontmatter edge cases (block/folded/quoted/CRLF/missing),
  discovery precedence, bad-file tolerance, kind validation, settings merge + validation,
  glob matching, the **full model precedence chain**, `inherit`, thinking suffix rules,
  overrides including `disabled`.

---

## W2 — `src/runs/store.ts`

### Deliverables

```ts
export interface StoreOptions { rootDir: string; now?: () => number }

export class RunStore {
  constructor(opts: StoreOptions);
  readonly rootDir: string;
  /** runDir = <root>/runs/<runId> */
  runDir(runId: string): string;
  sessionFileFor(runId: string, name: string): string;
  artifactDirFor(runId: string): string;

  createRun(input: { task: string; cwd: string; path?: NestedPathEntry[]; maxDepth?: number;
                     herdr?: RunRecord["herdr"] }): RunRecord;
  readRun(runId: string): RunRecord | null;
  writeRun(record: RunRecord): void;          // atomic
  updateRun(runId: string, fn: (r: RunRecord) => void): RunRecord;

  addChild(runId: string, child: ChildRecord): RunRecord;
  updateChild(runId: string, name: string, fn: (c: ChildRecord) => void): RunRecord;
  findChild(runId: string, name: string): ChildRecord | null;

  listRuns(): RunRecord[];
  /** Delete session files older than retentionDays, then prune stale run dirs. */
  prune(opts: { retentionDays: number; maxBytesPerRun?: number }): { removedSessions: string[]; removedRuns: string[] };
}
```

Requirements:

- **Atomic writes**: write to `<file>.tmp` then `renameSync`. Never leave a partial `run.json`.
- **Session pre-creation** (design F4): `sessionFileFor` must **create the empty file** (mode 0600)
  and return the path — this closes the "no turn ⇒ no file" data-loss window.
- `createRun` generates `runId` (`r-` + 8 hex) and a 16-hex `ownerToken` per child (via `randomUUID`/`randomBytes`).
- `prune` must never delete `run.json` for runs newer than retention; only sessions.
- Corrupt `run.json` → return `null` from `readRun` (do not throw), and rename it to `run.json.corrupt`.
- Idempotent `updateRun` (read-modify-write with a simple in-process mutex per runId).
- Session file paths must be **relative-safe**: sanitize `name` for filesystem use.

### W2 acceptance

- ≥ 20 unit tests: create/read/update round-trip, atomic write leaves no `.tmp`,
  session pre-creation (file exists, size 0, mode 0600), corrupt-run recovery,
  prune by age and by size, concurrent-ish updates, sanitization of hostile names
  (`../../etc/passwd`, spaces, unicode).

---

## W3 — docs, skills, prompts

### Deliverables

1. `README.md` — what it is, install, quick start, config reference, the
   success/failure model, limitations (be honest about the no-isolation finding F23–F25).
2. `docs/design.md` — the measured design (findings F1–F46), kept in-repo.
3. `skills/pi-herdr-subagents/SKILL.md` — when/how the main agent should delegate.
   Frontmatter: `name`, `description` (follow the existing skill format used by other skills
   in `/root/.pi/agent/skills/`; read one for the exact shape).
4. `prompts/*.md` — at least: `implement.md` (scout→planner→worker),
   `parallel-review.md` (3 reviewers, distinct angles), `implement-and-review.md`.
   Each must be usable as a Pi prompt template (see `/root/.pi/agent/prompts/ls-branch.md`).
5. `agents/*.md` — builtin agent definitions: `scout`, `planner`, `reviewer`, `worker`,
   `oracle`. Use the frontmatter field set from design §6.1. Keep `reviewer` read-only.

### W3 acceptance

- Every markdown file parses as frontmatter+body (W1's parser is the authority; if unavailable,
  validate manually that `---` fences are correct and `name`/`description` exist).
- No invented CLI flags: only document `herdr agent start/prompt/wait/read/send-keys`,
  `pane split/close/read/list`, `tab create/close/rename`. Verify against `herdr --help`.

---

## W4 — test harness

### Deliverables

1. `test/helpers/fake-herdr.ts` — an in-memory `HerdrClient` + `CommandRunner`:
   - Simulates panes, tabs, agents, `agent_status` transitions.
   - **Reproduces the measured races**: `agent_pane_busy` for the first N ms after a split
     (F19), `agent_pane_busy` then success, `agent_name_taken` (F16).
   - Emits errors on **stderr** with `{error:{code,message}}` (F21).
   - Lets a test script a session-jsonl transcript per agent.
2. `test/helpers/fixtures.ts` — builders for session jsonl lines:
   `sessionHeader()`, `modelChange()`, `userMsg(text)`, `assistantMsg({stopReason, text, tools, errorMessage})`,
   `toolResult({isError})`, `tornLine()`.
3. `test/helpers/tmp.ts` — `withTempDir(fn)` helper.
4. `test/unit/session.test.ts` — **written from the spec below, not from the implementation.**
5. `test/unit/herdr-client.test.ts` — from the spec below.

### Frozen signatures you must test against

```ts
// src/shared/session.ts
export function parseSessionText(text: string): ParsedSession;
export function parseSessionFile(path: string): ParsedSession;   // missing file => empty ParsedSession
export function deriveOutcome(parsed: ParsedSession): Execution;
export function extractVerdict(text: string): { ok: boolean; reason?: string } | null;

// src/herdr/client.ts
export function createHerdrClient(runner?: CommandRunner): HerdrClient;
export function createCommandRunner(): CommandRunner;
export function parseHerdrResponse(stdout: string, stderr: string, code: number):
  { ok: true; value: unknown } | { ok: false; error: HerdrError };

// src/shared/name.ts
export function makeName(agent: string, index: number): string;   // matches [a-z][a-z0-9_-]{0,31}
export function isValidAgentName(name: string): boolean;

// src/shared/nested-path.ts
export function isSafeNestedPathId(v: unknown): v is string;
export function sanitizeNestedPath(v: unknown): NestedPathEntry[];
```

### Required test cases (session)

| Case | Expected |
| --- | --- |
| success turn | `deriveOutcome().status === "success"` |
| `stopReason: "error"` + message | `"failed"`, errorMessage preserved |
| `stopReason: "error"` + message containing `aborted` | `"aborted"` (F29) |
| `stopReason: "length"` | `"truncated"` |
| `stopReason: "toolUse"` as last assistant | `"aborted"` (killed mid-tool) |
| user msg with **no** assistant reply | `"aborted"`, `lastTurnMissing === true` (F29) |
| no messages at all | `"unknown"` |
| turn1 tool error (`isError:true`), turn2 clean `stop` | `"success"`, `toolErrors === 1` (F30/F31) |
| torn/truncated JSON line | counted in `tornLines`, does not throw (F12) |
| usage accumulation across 3 assistant msgs | summed input/output/cacheRead/cacheWrite/cost |
| unknown `stopReason` value | `"failed"` with a reason |
| `extractVerdict('{"ok":false,"reason":"x"}')` | `{ok:false, reason:"x"}` |
| `extractVerdict("plain text")` | `null` |
| `extractVerdict` on fenced ```json block | parses the JSON inside |

### Required test cases (client)

| Case | Expected |
| --- | --- |
| success JSON on stdout | parsed value |
| error JSON on **stderr**, empty stdout, code 1 | `ok:false` with the code from stderr (F21) |
| non-JSON garbage | `ok:false`, code `VALIDATION_ERROR` or `PARSE_ERROR` |
| `agent_pane_busy` error | mapped to `ErrorCodes.PANE_BUSY` |
| `agent_name_taken` | mapped to `ErrorCodes.NAME_TAKEN` |
| herdr binary missing (ENOENT) | `HERDR_UNAVAILABLE` |
| `makeName("Review Agent", 1)` | `review-agent-1` |
| `makeName("9bad", 0)` | starts with a letter, ≤32 chars |
| `makeName("x".repeat(50), 3)` | ≤32 chars |
| `isSafeNestedPathId("../../etc")` | `false` |
| `sanitizeNestedPath` with >4 entries | truncated to 4 |
| `sanitizeNestedPath` with junk entries | junk dropped |

### W4 acceptance

- All of the above pass once the orchestrator's modules land.
- The fake client must be reusable by the orchestrator's integration tests.

---

## Reporting

Write `reports/<module>.md`:

```text
# <module>
## Delivered
## Tests (count + what they cover)
## Verification output   <- paste `npm run typecheck && npm test` tail
## Open questions / deviations
```

The parent session is woken by the extension's completion message (`followUp`,
so an in-flight parent turn is not steered); do not have workers
`herdr agent prompt` the parent pane.
