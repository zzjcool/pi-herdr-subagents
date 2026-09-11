# W2 — src/runs/store.ts

## Delivered

- **`src/runs/store.ts`** — `RunStore` per the frozen spec in IMPLEMENTATION.md:
  - `createRun / readRun / writeRun / updateRun / addChild / updateChild / findChild / listRuns / prune`
  - `runDir / sessionFileFor / artifactDirFor` path helpers
  - exported `sanitizeNameForFs()` helper
- **`test/unit/store.test.ts`** — 36 tests (acceptance asked for ≥ 20).

### Key design decisions

1. **Atomic writes**: `writeRun` writes to `<runDir>/run.json.tmp` (mode 0600) then
   `renameSync`. Same-directory rename on POSIX is atomic — a reader can never
   observe a partial run.json. Tests assert no `.tmp` residue after 25 rapid writes.
2. **Session pre-creation (F4)**: `sessionFileFor` creates the run dir, then
   `openSync(file, "w", 0o600)` + `closeSync` to pre-create the empty session
   file, then `chmodSync(file, 0o600)` (defensive even for pre-existing files).
   This closes the "no turn ⇒ no file" data-loss window. Repeat calls are
   idempotent and never truncate existing session data (verified by test).
3. **Corrupt run.json**: `readRun` never throws. Parse/shape failure ⇒ rename to
   `run.json.corrupt` (quarantine, not delete — a human can inspect it) and
   return `null`. Shape check (`isRunRecordLike`) also catches valid-JSON/wrong-shape.
4. **Name sanitization**: only `path.basename` survives (kills `../../etc/passwd`
   traversal), NFKD-normalize, drop non-ASCII/control chars, map spaces &
   specials to `-`, strip leading dots/dashes (no hidden files, no `..`),
   cap at 64 chars. Names that sanitize to nothing throw `INVALID_PARAMS`.
   Windows-style `..\..\win32` is also neutralized (basename handles `\`).
5. **Per-runId mutex**: `updateRun` chains promises in a `Map<runId, Promise>`
   (read-modify-write serialized). A failing mutator does not poison the chain.
   30 concurrent `budget.spawned += 1` calls land all 30 (no lost update).
   Map entry self-deletes when the chain settles (no unbounded growth).
6. **prune()** order per spec: (a) delete `*.jsonl` in the run dir older than
   the retention cutoff (mtime-based, injectable `now` clock); (b) if
   `maxBytesPerRun` set, drop oldest sessions until under budget; (c) only if
   run.json itself is older than the cutoff, `rmSync` the whole run dir.
   Runs newer than retention never lose run.json. Dirs without run.json are
   skipped (not ours to judge).
7. **ownerToken**: `addChild` generates a 16-hex token (`randomBytes(8)`) when
   the caller omits one. `runId` = `r-` + 8 hex (matching the spec's format).
8. runIds passed to path helpers are validated (no `/`, `\`, `..`) — throws
   `SubagentError(INVALID_PARAMS)` otherwise.

No new dependencies; node stdlib only (`node:fs`, `node:path`, `node:crypto`).
Imports use explicit `.ts` extensions. No parameter properties (node:test
strip-types constraint respected).

## Tests (count + what they cover)

36 tests, all passing:

- **create/read/write round-trip (9)**: runId format, budget defaults, nested
  path derivation + 4-entry cap, herdr echo, `updatedAt` bump, invalid task/cwd,
  traversal runId rejection, non-RunRecord rejection.
- **atomic writes (3)**: no `.tmp` residue, 25 rapid writes still parse,
  restrictive file mode (0600-ish, no group/other bits).
- **corrupt recovery (4)**: torn JSON → `null` + `.corrupt` quarantine,
  wrong-shape JSON quarantined, run dir reusable afterwards, `listRuns` skips
  corrupt entries.
- **session pre-creation (3)**: exists immediately, size 0, mode exactly 0600,
  idempotent (data preserved on re-call), dir created on demand.
- **sanitization (5)**: `../../etc/passwd` → `passwd` inside run dir, spaces →
  `-`, unicode dropped, all-unicode/`..`/`///` rejected, backslash traversal
  contained.
- **children (5)**: addChild budget + generated ownerToken, duplicate name →
  `NAME_TAKEN`, findChild `null` cases, updateChild targets only named child,
  unknown child → `NOT_FOUND`.
- **concurrency (5)**: updateRun round-trip, NOT_FOUND, 30 concurrent updates
  serialize (spawned === 30), 10 concurrent addChild all land, failing mutator
  doesn't poison the lock.
- **artifacts (1)**, **prune (8)**: age-based session removal (fresh session +
  run.json survive), stale run dir removal, run.json protection for fresh runs,
  maxBytesPerRun oldest-first, no-op case, dirs without run.json ignored,
  `retentionDays <= 0` rejected.
- **misc (3)**: listRuns ordering, empty root, missing rootDir.

## Verification output

`npm run typecheck` — my files contribute **0 errors**. Remaining output is
pre-existing, all in `index.ts` (orchestrator-owned; W2 is forbidden from
touching it):

```
$ npx tsc --noEmit 2>&1 | grep -c '^index.ts'
14
```

`npm test` tail:

```
# tests 56
# suites 0
# pass 56
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 301.760707
```

(56 = 36 store tests + 20 pre-existing smoke tests, which still pass — no
regression.)

## Open questions / deviations

1. **`updateRun` is async** — the frozen signature returns `RunRecord`, but
   serializing concurrent callers requires promise chaining, so I made it
   `async updateRun(...): Promise<RunRecord>` (also `addChild`/`updateChild`).
   The spec's `addChild`/`updateChild` already showed `Promise<RunRecord>`, so
   `updateRun` returning a promise is consistent; awaiting it is optional for
   single-threaded callers. Flag for orchestrator if the frozen signature must
   stay sync.
2. **mtime vs createdAt for pruning sessions**: sessions have no `run.json`
   metadata of their own age, so I use filesystem mtime (tests backdate with
   `utimesSync`). Simple and matches "older than retentionDays".
3. **`run.json` mode**: written 0600 (contains ownerTokens). Tests assert no
   group/other bits rather than exactly 0600 because umask interactions can
   clear bits but shouldn't add them.
4. **prune skips dirs without run.json** rather than deleting them — a stray
   dir could be another module's workspace; safer to leave it.
