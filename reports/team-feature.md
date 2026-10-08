# Team feature implementation report

## 做了什么

- Added `TeamMember`, `TeamConfig`, `AgentOverride`, and optional `subagents.teams` / `subagents.team` settings types.
- Added strict team-settings parsing and user/project merge semantics, including reserved `default` rejection and file/field-aware errors.
- Added `src/agents/teams.ts` with active-team precedence, team expansion, wildcard handling, member overrides, disabled-role removal, warnings, and team listing.
- Wired catalog loading in the frozen order and exposed `team`, `teamWarnings`, and `allAgents`; launch lookups use the filtered catalog while control actions use the full catalog.
- Added team-aware roster/list output and the team-specific unknown-agent refusal.
- Propagated non-default teams to child panes/tabs through `PI_SUBAGENTS_TEAM`, with split/new-tab/default integration coverage.
- Added `/subagents-team` parsing, status/list/use/create handlers, safe settings-file updates, and public API exports.
- Updated README and design settings documentation.
- Added unit coverage in `test/unit/teams.test.ts` and integration regression coverage in `test/integration/regressions.test.ts`.

## 改动文件清单

- `README.md`
- `docs/design.md`
- `index.ts`
- `src/agents/overrides.ts`
- `src/agents/settings.ts`
- `src/agents/teams.ts` (new)
- `src/api.ts`
- `src/extension/slash.ts`
- `src/profiles/profiles.ts`
- `src/runs/orchestrator.ts`
- `src/shared/types.ts`
- `test/unit/teams.test.ts` (new)
- `test/integration/regressions.test.ts`
- `test/unit/profiles.test.ts`
- `reports/team-feature.md` (this report)

## 与设计的偏差及理由

- No semantic deviations from the frozen team design are known.
- The initial implementation was left uncommitted; this review round is being delivered on the isolated worker branch. See the review-fix section below for the final MR/PR link.

## 测试覆盖

- Active-team precedence and whitespace-only environment handling.
- Default reference identity, explicit members, wildcard expansion/deduplication, later object overrides, disabled members, missing members, and missing-team fallback warnings.
- Settings parsing, reserved-name and malformed-structure rejection, and user/project team merge behavior.
- Slash argument parsing and actual `use`/`create` settings writes while preserving unrelated keys.
- Team-specific unknown-agent wording and control lookup after role filtering.
- Integration assertions for split and tab argv environment propagation and default omission.

## 验证命令输出（原样）

The following is the complete output of the required command sequence:

$ npm run typecheck && npm test && npm run test:integration
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 typecheck
npm notice run tsc --noEmit
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 test
npm notice run node --experimental-strip-types --test test/unit/*.test.ts
TAP version 13
# Subtest: needsVerification is true only for required verification-output criteria
ok 1 - needsVerification is true only for required verification-output criteria
  ---
  duration_ms: 0.567541
  type: 'test'
  ...
# Subtest: applyVerification skips when there is nothing to run
ok 2 - applyVerification skips when there is nothing to run
  ---
  duration_ms: 0.1135
  type: 'test'
  ...
# Subtest: applyVerification promotes attested to verified when the command passes
ok 3 - applyVerification promotes attested to verified when the command passes
  ---
  duration_ms: 0.206291
  type: 'test'
  ...
# Subtest: applyVerification rejects when the command fails
ok 4 - applyVerification rejects when the command fails
  ---
  duration_ms: 0.116084
  type: 'test'
  ...
# Subtest: applyVerification does not run on an already-rejected turn
ok 5 - applyVerification does not run on an already-rejected turn
  ---
  duration_ms: 0.072958
  type: 'test'
  ...
# Subtest: verifyCommandOf prefers a criterion command over the default
ok 6 - verifyCommandOf prefers a criterion command over the default
  ---
  duration_ms: 0.063334
  type: 'test'
  ...
# Subtest: applyVerification runs the criterion command
ok 7 - applyVerification runs the criterion command
  ---
  duration_ms: 0.084833
  type: 'test'
  ...
# Subtest: defaultVerifyRunner times out a hung command
ok 8 - defaultVerifyRunner times out a hung command
  ---
  duration_ms: 103.831125
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: empty → default (undefined)
ok 9 - parseAgentsScopeArg: empty → default (undefined)
  ---
  duration_ms: 1.140458
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: accepts the three scopes
ok 10 - parseAgentsScopeArg: accepts the three scopes
  ---
  duration_ms: 0.087167
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: rejects junk and extra tokens
ok 11 - parseAgentsScopeArg: rejects junk and extra tokens
  ---
  duration_ms: 0.121708
  type: 'test'
  ...
# Subtest: renderAgentsListing: groups by source with counts
ok 12 - renderAgentsListing: groups by source with counts
  ---
  duration_ms: 0.545625
  type: 'test'
  ...
# Subtest: renderAgentsListing: user dir shows the resolved path and scope skips it
ok 13 - renderAgentsListing: user dir shows the resolved path and scope skips it
  ---
  duration_ms: 0.119792
  type: 'test'
  ...
# Subtest: renderAgentsListing: empty listing explains where to add agents
ok 14 - renderAgentsListing: empty listing explains where to add agents
  ---
  duration_ms: 0.153625
  type: 'test'
  ...
# Subtest: renderAgentsListing: flags disableBuiltins
ok 15 - renderAgentsListing: flags disableBuiltins
  ---
  duration_ms: 0.128875
  type: 'test'
  ...
# Subtest: renderAgentsListing: model line reports the resolved model + provenance
ok 16 - renderAgentsListing: model line reports the resolved model + provenance
  ---
  duration_ms: 0.133458
  type: 'test'
  ...
# Subtest: renderAgentsListing: no model anywhere → agent CLI default
ok 17 - renderAgentsListing: no model anywhere → agent CLI default
  ---
  duration_ms: 0.32275
  type: 'test'
  ...
# Subtest: renderAgentsListing: parent model fall-through is labelled parent session model, never per-run override
ok 18 - renderAgentsListing: parent model fall-through is labelled parent session model, never per-run override
  ---
  duration_ms: 0.46025
  type: 'test'
  ...
# Subtest: renderAgentsListing: modelScope violation — explicit model is a launch refusal
ok 19 - renderAgentsListing: modelScope violation — explicit model is a launch refusal
  ---
  duration_ms: 0.197041
  type: 'test'
  ...
# Subtest: renderAgentsListing: modelScope violation — inherited model is a warning
ok 20 - renderAgentsListing: modelScope violation — inherited model is a warning
  ---
  duration_ms: 0.072625
  type: 'test'
  ...
# Subtest: renderAgentsListing: explicit pi-shaped model on a cursor role is a launch refusal
ok 21 - renderAgentsListing: explicit pi-shaped model on a cursor role is a launch refusal
  ---
  duration_ms: 0.161542
  type: 'test'
  ...
# Subtest: renderAgentsListing: inherited pi-shaped model on a cursor role is a documented drop
ok 22 - renderAgentsListing: inherited pi-shaped model on a cursor role is a documented drop
  ---
  duration_ms: 0.089084
  type: 'test'
  ...
# Subtest: renderAgentsListing: unresolvable configuration is reported, not guessed
ok 23 - renderAgentsListing: unresolvable configuration is reported, not guessed
  ---
  duration_ms: 0.0975
  type: 'test'
  ...
# Subtest: renderAgentsListing: alias and unenforced fields are surfaced
ok 24 - renderAgentsListing: alias and unenforced fields are surfaced
  ---
  duration_ms: 0.056542
  type: 'test'
  ...
# Subtest: command: registered with a description and scope completions
ok 25 - command: registered with a description and scope completions
  ---
  duration_ms: 11.818875
  type: 'test'
  ...
# Subtest: command: lists sandboxed + builtin roles, grouped, with file paths
ok 26 - command: lists sandboxed + builtin roles, grouped, with file paths
  ---
  duration_ms: 5.749459
  type: 'test'
  ...
# Subtest: command: scope=project skips user layers but keeps builtin roles
ok 27 - command: scope=project skips user layers but keeps builtin roles
  ---
  duration_ms: 7.532792
  type: 'test'
  ...
# Subtest: command: invalid scope notifies an error and sends nothing
ok 28 - command: invalid scope notifies an error and sends nothing
  ---
  duration_ms: 1.627125
  type: 'test'
  ...
# Subtest: command: settings flow through — override model + disableBuiltins
ok 29 - command: settings flow through — override model + disableBuiltins
  ---
  duration_ms: 1.954417
  type: 'test'
  ...
# Subtest: command: no roles at all → helpful empty state
ok 30 - command: no roles at all → helpful empty state
  ---
  duration_ms: 1.565083
  type: 'test'
  ...
# Subtest: command: a loadCatalog failure surfaces as ui.notify error, nothing sent
ok 31 - command: a loadCatalog failure surfaces as ui.notify error, nothing sent
  ---
  duration_ms: 0.188834
  type: 'test'
  ...
# Subtest: AgentsCommandDeps: loadCatalog receives the parsed scope untouched
ok 32 - AgentsCommandDeps: loadCatalog receives the parsed scope untouched
  ---
  duration_ms: 0.156834
  type: 'test'
  ...
# Subtest: scope: thinking suffix is stripped only for known levels
ok 33 - scope: thinking suffix is stripped only for known levels
  ---
  duration_ms: 7.191625
  type: 'test'
  ...
# Subtest: scope: glob matching is case-insensitive and anchored
ok 34 - scope: glob matching is case-insensitive and anchored
  ---
  duration_ms: 0.170042
  type: 'test'
  ...
# Subtest: scope: explicit violation is an error, inherited is a warning
ok 35 - scope: explicit violation is an error, inherited is a warning
  ---
  duration_ms: 0.11025
  type: 'test'
  ...
# Subtest: scope: in-scope model yields no violation
ok 36 - scope: in-scope model yields no violation
  ---
  duration_ms: 0.153583
  type: 'test'
  ...
# Subtest: scope: enforcement without allow list is a no-op
ok 37 - scope: enforcement without allow list is a no-op
  ---
  duration_ms: 0.062042
  type: 'test'
  ...
# Subtest: scope: disabled enforcement never violates
ok 38 - scope: disabled enforcement never violates
  ---
  duration_ms: 0.047125
  type: 'test'
  ...
# Subtest: scope: parse rejects malformed config
ok 39 - scope: parse rejects malformed config
  ---
  duration_ms: 0.245417
  type: 'test'
  ...
# Subtest: scope: parse accepts a valid config
ok 40 - scope: parse accepts a valid config
  ---
  duration_ms: 0.079292
  type: 'test'
  ...
# Subtest: resolve: per-run override wins over everything
ok 41 - resolve: per-run override wins over everything
  ---
  duration_ms: 0.384792
  type: 'test'
  ...
# Subtest: resolve: preset model beats agentOverrides (level 2)
ok 42 - resolve: preset model beats agentOverrides (level 2)
  ---
  duration_ms: 0.332875
  type: 'test'
  ...
# Subtest: resolve: preset model beats the provider-scoped override too
ok 43 - resolve: preset model beats the provider-scoped override too
  ---
  duration_ms: 0.121417
  type: 'test'
  ...
# Subtest: resolve: no preset means the old chain is bit-for-bit unchanged
ok 44 - resolve: no preset means the old chain is bit-for-bit unchanged
  ---
  duration_ms: 0.055375
  type: 'test'
  ...
# Subtest: resolve: provider-scoped override beats plain override
ok 45 - resolve: provider-scoped override beats plain override
  ---
  duration_ms: 0.046333
  type: 'test'
  ...
# Subtest: resolve: plain override beats frontmatter
ok 46 - resolve: plain override beats frontmatter
  ---
  duration_ms: 0.045791
  type: 'test'
  ...
# Subtest: resolve: frontmatter beats defaultModel
ok 47 - resolve: frontmatter beats defaultModel
  ---
  duration_ms: 0.048084
  type: 'test'
  ...
# Subtest: resolve: defaultModel used when frontmatter is absent
ok 48 - resolve: defaultModel used when frontmatter is absent
  ---
  duration_ms: 0.042792
  type: 'test'
  ...
# Subtest: resolve: falls back to the dispatch model
ok 49 - resolve: falls back to the dispatch model
  ---
  duration_ms: 0.088667
  type: 'test'
  ...
# Subtest: resolve: 'inherit' selects the dispatch model explicitly
ok 50 - resolve: 'inherit' selects the dispatch model explicitly
  ---
  duration_ms: 0.041583
  type: 'test'
  ...
# Subtest: resolve: no candidates yields no model
ok 51 - resolve: no candidates yields no model
  ---
  duration_ms: 0.040125
  type: 'test'
  ...
# Subtest: resolve: providerOf extracts the provider half
ok 52 - resolve: providerOf extracts the provider half
  ---
  duration_ms: 0.049833
  type: 'test'
  ...
# Subtest: overrides: scalar fields replace frontmatter values
ok 53 - overrides: scalar fields replace frontmatter values
  ---
  duration_ms: 0.072417
  type: 'test'
  ...
# Subtest: overrides: arrays are copied, not aliased
ok 54 - overrides: arrays are copied, not aliased
  ---
  duration_ms: 0.05425
  type: 'test'
  ...
# Subtest: overrides: disabled removes the agent
ok 55 - overrides: disabled removes the agent
  ---
  duration_ms: 0.405625
  type: 'test'
  ...
# Subtest: overrides: unknown agent names are ignored
ok 56 - overrides: unknown agent names are ignored
  ---
  duration_ms: 0.155792
  type: 'test'
  ...
# Subtest: overrides: absent overrides returns the same list
ok 57 - overrides: absent overrides returns the same list
  ---
  duration_ms: 0.10225
  type: 'test'
  ...
# Subtest: overrides: applyOverride honours a preset reference
ok 58 - overrides: applyOverride honours a preset reference
  ---
  duration_ms: 0.152042
  type: 'test'
  ...
# Subtest: overrides: applyDefaultModel only fills agents without a model
ok 59 - overrides: applyDefaultModel only fills agents without a model
  ---
  duration_ms: 0.176708
  type: 'test'
  ...
# Subtest: overrides: applyDefaultModel is a no-op without a default
ok 60 - overrides: applyDefaultModel is a no-op without a default
  ---
  duration_ms: 0.046375
  type: 'test'
  ...
# Subtest: overrides: applyDefaultOnBlocked fills unset agents, keeps explicit choices
ok 61 - overrides: applyDefaultOnBlocked fills unset agents, keeps explicit choices
  ---
  duration_ms: 0.088875
  type: 'test'
  ...
# Subtest: settings: absent subagents key yields empty settings
ok 62 - settings: absent subagents key yields empty settings
  ---
  duration_ms: 0.087833
  type: 'test'
  ...
# Subtest: settings: rejects a non-object subagents value
ok 63 - settings: rejects a non-object subagents value
  ---
  duration_ms: 0.068083
  type: 'test'
  ...
# Subtest: settings: rejects an empty defaultModel
ok 64 - settings: rejects an empty defaultModel
  ---
  duration_ms: 0.05925
  type: 'test'
  ...
# Subtest: settings: defaultOnBlocked validates and merges
ok 65 - settings: defaultOnBlocked validates and merges
  ---
  duration_ms: 0.284125
  type: 'test'
  ...
# Subtest: settings: validates herdr numeric fields
ok 66 - settings: validates herdr numeric fields
  ---
  duration_ms: 0.207708
  type: 'test'
  ...
# Subtest: settings: rejects an invalid placement
ok 67 - settings: rejects an invalid placement
  ---
  duration_ms: 0.049834
  type: 'test'
  ...
# Subtest: settings: project settings win over user settings
ok 68 - settings: project settings win over user settings
  ---
  duration_ms: 0.047208
  type: 'test'
  ...
# Subtest: settings: agentOverrides shallow-merge across scopes
ok 69 - settings: agentOverrides shallow-merge across scopes
  ---
  duration_ms: 0.110583
  type: 'test'
  ...
# Subtest: settings: presets survive parseSubagentSettings (the whitelist)
ok 70 - settings: presets survive parseSubagentSettings (the whitelist)
  ---
  duration_ms: 0.08975
  type: 'test'
  ...
# Subtest: settings: unknown subagents keys ARE silently dropped (whitelist)
ok 71 - settings: unknown subagents keys ARE silently dropped (whitelist)
  ---
  duration_ms: 0.039709
  type: 'test'
  ...
# Subtest: settings: presets shallow-merge across user/project
ok 72 - settings: presets shallow-merge across user/project
  ---
  duration_ms: 0.043792
  type: 'test'
  ...
# Subtest: settings: project without presets keeps the user's presets
ok 73 - settings: project without presets keeps the user's presets
  ---
  duration_ms: 0.0395
  type: 'test'
  ...
# Subtest: settings: loadSubagentSettings tolerates a missing file
ok 74 - settings: loadSubagentSettings tolerates a missing file
  ---
  duration_ms: 0.127542
  type: 'test'
  ...
# Subtest: settings: loadSubagentSettings reports malformed JSON with the path
ok 75 - settings: loadSubagentSettings reports malformed JSON with the path
  ---
  duration_ms: 1.114
  type: 'test'
  ...
# Subtest: settings: a project file overlays a user profile's agentOverrides
ok 76 - settings: a project file overlays a user profile's agentOverrides
  ---
  duration_ms: 0.838417
  type: 'test'
  ...
# Subtest: glob matching is linear, not exponential, on adversarial patterns
ok 77 - glob matching is linear, not exponential, on adversarial patterns
  ---
  duration_ms: 0.212916
  type: 'test'
  ...
# Subtest: glob semantics: full match, case-insensitive, star spans slashes
ok 78 - glob semantics: full match, case-insensitive, star spans slashes
  ---
  duration_ms: 0.076208
  type: 'test'
  ...
# Subtest: agentOverrides: a non-object value is rejected, not silently ignored
ok 79 - agentOverrides: a non-object value is rejected, not silently ignored
  ---
  duration_ms: 0.136834
  type: 'test'
  ...
# Subtest: agentOverrides: valid object values are accepted
ok 80 - agentOverrides: valid object values are accepted
  ---
  duration_ms: 0.054041
  type: 'test'
  ...
# Subtest: modelCandidates is unique and keeps an empty primary as one attempt
ok 81 - modelCandidates is unique and keeps an empty primary as one attempt
  ---
  duration_ms: 0.088708
  type: 'test'
  ...
# Subtest: settings: joinMode accepts each/smart, rejects anything else
ok 82 - settings: joinMode accepts each/smart, rejects anything else
  ---
  duration_ms: 0.139541
  type: 'test'
  ...
# Subtest: settings: joinFlushMs must be a positive integer
ok 83 - settings: joinFlushMs must be a positive integer
  ---
  duration_ms: 0.08825
  type: 'test'
  ...
# Subtest: settings: join keys default to absent and project overrides user
ok 84 - settings: join keys default to absent and project overrides user
  ---
  duration_ms: 0.055167
  type: 'test'
  ...
# Subtest: frontmatter: no fence yields empty frontmatter
ok 85 - frontmatter: no fence yields empty frontmatter
  ---
  duration_ms: 6.591333
  type: 'test'
  ...
# Subtest: frontmatter: unterminated fence is treated as body
ok 86 - frontmatter: unterminated fence is treated as body
  ---
  duration_ms: 0.099833
  type: 'test'
  ...
# Subtest: frontmatter: simple key/value + body
ok 87 - frontmatter: simple key/value + body
  ---
  duration_ms: 0.2665
  type: 'test'
  ...
# Subtest: frontmatter: quoted values are unquoted
ok 88 - frontmatter: quoted values are unquoted
  ---
  duration_ms: 0.067084
  type: 'test'
  ...
# Subtest: frontmatter: CRLF is normalized
ok 89 - frontmatter: CRLF is normalized
  ---
  duration_ms: 0.067917
  type: 'test'
  ...
# Subtest: frontmatter: literal block scalar preserves newlines
ok 90 - frontmatter: literal block scalar preserves newlines
  ---
  duration_ms: 0.169334
  type: 'test'
  ...
# Subtest: frontmatter: folded block scalar joins lines with spaces
ok 91 - frontmatter: folded block scalar joins lines with spaces
  ---
  duration_ms: 0.125834
  type: 'test'
  ...
# Subtest: frontmatter: block list is preserved for list parsing
ok 92 - frontmatter: block list is preserved for list parsing
  ---
  duration_ms: 0.169042
  type: 'test'
  ...
# Subtest: frontmatter: comments and blank lines are ignored
ok 93 - frontmatter: comments and blank lines are ignored
  ---
  duration_ms: 0.280959
  type: 'test'
  ...
# Subtest: parseFrontmatterList: comma separated
ok 94 - parseFrontmatterList: comma separated
  ---
  duration_ms: 0.344833
  type: 'test'
  ...
# Subtest: parseFrontmatterList: hyphenated values survive
ok 95 - parseFrontmatterList: hyphenated values survive
  ---
  duration_ms: 0.435542
  type: 'test'
  ...
# Subtest: parseFrontmatterList: undefined yields undefined
ok 96 - parseFrontmatterList: undefined yields undefined
  ---
  duration_ms: 0.096417
  type: 'test'
  ...
# Subtest: agent: requires name and description
ok 97 - agent: requires name and description
  ---
  duration_ms: 0.377583
  type: 'test'
  ...
# Subtest: agent: defaults match the documented conventions
ok 98 - agent: defaults match the documented conventions
  ---
  duration_ms: 0.059417
  type: 'test'
  ...
# Subtest: agent: invalid kind degrades to pi instead of failing
ok 99 - agent: invalid kind degrades to pi instead of failing
  ---
  duration_ms: 0.051041
  type: 'test'
  ...
# Subtest: agent: valid non-pi kind is honored
ok 100 - agent: valid non-pi kind is honored
  ---
  duration_ms: 0.042125
  type: 'test'
  ...
# Subtest: agent: herdr grok kind is honored rather than coerced to pi
ok 101 - agent: herdr grok kind is honored rather than coerced to pi
  ---
  duration_ms: 0.038916
  type: 'test'
  ...
# Subtest: agent: tools parse from comma string and array spellings
ok 102 - agent: tools parse from comma string and array spellings
  ---
  duration_ms: 0.142209
  type: 'test'
  ...
# Subtest: agent: skills false is distinct from absent
ok 103 - agent: skills false is distinct from absent
  ---
  duration_ms: 0.157875
  type: 'test'
  ...
# Subtest: agent: numeric and boolean fields are coerced
ok 104 - agent: numeric and boolean fields are coerced
  ---
  duration_ms: 0.114792
  type: 'test'
  ...
# Subtest: agent: acceptance JSON is parsed
ok 105 - agent: acceptance JSON is parsed
  ---
  duration_ms: 0.088958
  type: 'test'
  ...
# Subtest: agent: malformed acceptance JSON is ignored, not fatal
ok 106 - agent: malformed acceptance JSON is ignored, not fatal
  ---
  duration_ms: 0.1095
  type: 'test'
  ...
# Subtest: agent: frontmatterFields records provenance
ok 107 - agent: frontmatterFields records provenance
  ---
  duration_ms: 0.056875
  type: 'test'
  ...
# Subtest: agent: frontmatter preset is parsed onto the config
ok 108 - agent: frontmatter preset is parsed onto the config
  ---
  duration_ms: 0.081666
  type: 'test'
  ...
# Subtest: discovery: loadAgentsFromDir skips bad files without throwing
ok 109 - discovery: loadAgentsFromDir skips bad files without throwing
  ---
  duration_ms: 1.717666
  type: 'test'
  ...
# Subtest: discovery: missing directory yields empty list
ok 110 - discovery: missing directory yields empty list
  ---
  duration_ms: 0.080875
  type: 'test'
  ...
# Subtest: discovery: findNearestProjectAgentsDir walks up
ok 111 - discovery: findNearestProjectAgentsDir walks up
  ---
  duration_ms: 1.229875
  type: 'test'
  ...
# Subtest: discovery: returns null when no project dir exists
ok 112 - discovery: returns null when no project dir exists
  ---
  duration_ms: 0.339208
  type: 'test'
  ...
# Subtest: discovery: project overrides user on name collision in 'both'
ok 113 - discovery: project overrides user on name collision in 'both'
  ---
  duration_ms: 1.883
  type: 'test'
  ...
# Subtest: discovery: scope 'user' excludes project agents
ok 114 - discovery: scope 'user' excludes project agents
  ---
  duration_ms: 7.371834
  type: 'test'
  ...
# Subtest: discovery: scope 'project' excludes user agents
ok 115 - discovery: scope 'project' excludes user agents
  ---
  duration_ms: 3.584875
  type: 'test'
  ...
# Subtest: discovery: bundled roles are present by default
ok 116 - discovery: bundled roles are present by default
  ---
  duration_ms: 5.008708
  type: 'test'
  ...
# Subtest: discovery: includeBuiltin false drops the bundled roles
ok 117 - discovery: includeBuiltin false drops the bundled roles
  ---
  duration_ms: 0.539792
  type: 'test'
  ...
# Subtest: discovery: a user definition overrides a bundled role of the same name
ok 118 - discovery: a user definition overrides a bundled role of the same name
  ---
  duration_ms: 1.908667
  type: 'test'
  ...
# Subtest: discovery: a project definition overrides a bundled role in 'both'
ok 119 - discovery: a project definition overrides a bundled role in 'both'
  ---
  duration_ms: 2.329166
  type: 'test'
  ...
# Subtest: discovery: extra agent dirs load below the user dir in precedence
ok 120 - discovery: extra agent dirs load below the user dir in precedence
  ---
  duration_ms: 1.938208
  type: 'test'
  ...
# Subtest: formerly unenforced fields are now honoured
ok 121 - formerly unenforced fields are now honoured
  ---
  duration_ms: 0.169416
  type: 'test'
  ...
# Subtest: enforced fields are NOT reported as unenforced
ok 122 - enforced fields are NOT reported as unenforced
  ---
  duration_ms: 0.075083
  type: 'test'
  ...
# Subtest: acceptance.criteria is no longer reported unenforced (it is surfaced instead)
ok 123 - acceptance.criteria is no longer reported unenforced (it is surfaced instead)
  ---
  duration_ms: 0.083958
  type: 'test'
  ...
# Subtest: the reviewer role is read-only
ok 124 - the reviewer role is read-only
  ---
  duration_ms: 1.323667
  type: 'test'
  ...
# Subtest: bundled roles do not pin a vendor model
ok 125 - bundled roles do not pin a vendor model
  ---
  duration_ms: 0.562416
  type: 'test'
  ...
# Subtest: every bundled role thinks at max
ok 126 - every bundled role thinks at max
  ---
  duration_ms: 0.557416
  type: 'test'
  ...
# Subtest: formatAgentRoster lists user roles so the parent can pick search without list
ok 127 - formatAgentRoster lists user roles so the parent can pick search without list
  ---
  duration_ms: 0.180666
  type: 'test'
  ...
# Subtest: every bundled role ships a non-empty system prompt
ok 128 - every bundled role ships a non-empty system prompt
  ---
  duration_ms: 0.534208
  type: 'test'
  ...
# Subtest: a bundled role reports no unenforced fields
ok 129 - a bundled role reports no unenforced fields
  ---
  duration_ms: 18.999792
  type: 'test'
  ...
# Subtest: timeoutMs is parsed and is NOT reported as unenforced
ok 130 - timeoutMs is parsed and is NOT reported as unenforced
  ---
  duration_ms: 0.124916
  type: 'test'
  ...
# Subtest: toolTimeoutMs is parsed and is NOT reported as unenforced
ok 131 - toolTimeoutMs is parsed and is NOT reported as unenforced
  ---
  duration_ms: 0.05975
  type: 'test'
  ...
# Subtest: every bundled role declares a timeout budget the runtime honours
ok 132 - every bundled role declares a timeout budget the runtime honours
  ---
  duration_ms: 0.600834
  type: 'test'
  ...
# Subtest: acceptance: a nested YAML block is parsed, not just a JSON string
ok 133 - acceptance: a nested YAML block is parsed, not just a JSON string
  ---
  duration_ms: 0.14975
  type: 'test'
  ...
# Subtest: acceptance: the JSON-string spelling still works
ok 134 - acceptance: the JSON-string spelling still works
  ---
  duration_ms: 0.063334
  type: 'test'
  ...
# Subtest: acceptance: an invalid level is rejected rather than guessed
ok 135 - acceptance: an invalid level is rejected rather than guessed
  ---
  duration_ms: 0.056125
  type: 'test'
  ...
# Subtest: acceptance: criteria missing id or must are dropped
ok 136 - acceptance: criteria missing id or must are dropped
  ---
  duration_ms: 0.079958
  type: 'test'
  ...
# Subtest: acceptance: every bundled role parses its acceptance block
ok 137 - acceptance: every bundled role parses its acceptance block
  ---
  duration_ms: 7.254417
  type: 'test'
  ...
# Subtest: writer roles default to an isolated worktree
ok 138 - writer roles default to an isolated worktree
  ---
  duration_ms: 0.657
  type: 'test'
  ...
# Subtest: findAgent matches canonical name and alias
ok 139 - findAgent matches canonical name and alias
  ---
  duration_ms: 0.142834
  type: 'test'
  ...
# Subtest: buildPiArgs injects the child-guard extension
ok 140 - buildPiArgs injects the child-guard extension
  ---
  duration_ms: 10.371208
  type: 'test'
  ...
# Subtest: buildPiArgs writes the frozen task appendix
ok 141 - buildPiArgs writes the frozen task appendix
  ---
  duration_ms: 0.857209
  type: 'test'
  ...
# Subtest: buildPiArgs allowNested omits the no-nested-agents constraint
ok 142 - buildPiArgs allowNested omits the no-nested-agents constraint
  ---
  duration_ms: 0.737459
  type: 'test'
  ...
# Subtest: buildPiArgs worktreeBranch lands in the task file
ok 143 - buildPiArgs worktreeBranch lands in the task file
  ---
  duration_ms: 2.692416
  type: 'test'
  ...
# Subtest: formatBlockedPrompt names the child and the reason
ok 144 - formatBlockedPrompt names the child and the reason
  ---
  duration_ms: 0.518458
  type: 'test'
  ...
# Subtest: followUpFor: a decision resumes the watch; notify holds the pane
ok 145 - followUpFor: a decision resumes the watch; notify holds the pane
  ---
  duration_ms: 0.085834
  type: 'test'
  ...
# Subtest: forward: parent confirm yes approves the child
ok 146 - forward: parent confirm yes approves the child
  ---
  duration_ms: 0.422834
  type: 'test'
  ...
# Subtest: forward: parent confirm no rejects the child
ok 147 - forward: parent confirm no rejects the child
  ---
  duration_ms: 0.08875
  type: 'test'
  ...
# Subtest: forward without a TUI falls back to notify
ok 148 - forward without a TUI falls back to notify
  ---
  duration_ms: 0.144291
  type: 'test'
  ...
# Subtest: auto-approve skips the parent confirm
ok 149 - auto-approve skips the parent confirm
  ---
  duration_ms: 0.07025
  type: 'test'
  ...
# Subtest: notify only tells the parent; the child stays blocked
ok 150 - notify only tells the parent; the child stays blocked
  ---
  duration_ms: 0.124
  type: 'test'
  ...
# Subtest: parseBudgetInt accepts 0 and positive integers
ok 151 - parseBudgetInt accepts 0 and positive integers
  ---
  duration_ms: 0.533375
  type: 'test'
  ...
# Subtest: wrapBashWithTimeout prefixes GNU timeout and does not double-wrap
ok 152 - wrapBashWithTimeout prefixes GNU timeout and does not double-wrap
  ---
  duration_ms: 0.201167
  type: 'test'
  ...
# Subtest: budgetExceededReason names the limit
ok 153 - budgetExceededReason names the limit
  ---
  duration_ms: 0.073834
  type: 'test'
  ...
# Subtest: child: herdr agent prompt/wait/send-keys/start are blocked
ok 154 - child: herdr agent prompt/wait/send-keys/start are blocked
  ---
  duration_ms: 0.985625
  type: 'test'
  ...
# Subtest: child: may read its own pane but not another
ok 155 - child: may read its own pane but not another
  ---
  duration_ms: 0.112042
  type: 'test'
  ...
# Subtest: child: pane split / tab create stay blocked
ok 156 - child: pane split / tab create stay blocked
  ---
  duration_ms: 0.111542
  type: 'test'
  ...
# Subtest: child: unknown own pane blocks every pane read
ok 157 - child: unknown own pane blocks every pane read
  ---
  duration_ms: 0.060167
  type: 'test'
  ...
# Subtest: child: herdr --help is blocked without the parent launch playbook
ok 158 - child: herdr --help is blocked without the parent launch playbook
  ---
  duration_ms: 0.175709
  type: 'test'
  ...
# Subtest: child block reasons do not tell the child to call subagent
ok 159 - child block reasons do not tell the child to call subagent
  ---
  duration_ms: 0.060166
  type: 'test'
  ...
# Subtest: formatChildTask appends the frozen constraints
ok 160 - formatChildTask appends the frozen constraints
  ---
  duration_ms: 0.186416
  type: 'test'
  ...
# Subtest: formatChildTask allowNested changes the nested-agents bullet
ok 161 - formatChildTask allowNested changes the nested-agents bullet
  ---
  duration_ms: 0.074167
  type: 'test'
  ...
# Subtest: formatChildTask worktreeBranch tells the child to ship via MR
ok 162 - formatChildTask worktreeBranch tells the child to ship via MR
  ---
  duration_ms: 0.309625
  type: 'test'
  ...
# Subtest: read-only role: writes and herdr prompts are blocked, recon commands pass
ok 163 - read-only role: writes and herdr prompts are blocked, recon commands pass
  ---
  duration_ms: 0.681167
  type: 'test'
  ...
# Subtest: writer role may run npm test
ok 164 - writer role may run npm test
  ---
  duration_ms: 0.11375
  type: 'test'
  ...
# Subtest: child-guard counts every tool call against toolBudget
ok 165 - child-guard counts every tool call against toolBudget
  ---
  duration_ms: 0.203042
  type: 'test'
  ...
# Subtest: child-guard wraps bash with timeout after classifying
ok 166 - child-guard wraps bash with timeout after classifying
  ---
  duration_ms: 0.131625
  type: 'test'
  ...
# Subtest: child-guard turn budget blocks tools after too many turns
ok 167 - child-guard turn budget blocks tools after too many turns
  ---
  duration_ms: 0.058458
  type: 'test'
  ...
# Subtest: read-only role: comparison/arrow operators are not redirects
ok 168 - read-only role: comparison/arrow operators are not redirects
  ---
  duration_ms: 0.092458
  type: 'test'
  ...
# Subtest: read-only role: real redirects are still blocked, including &>file
ok 169 - read-only role: real redirects are still blocked, including &>file
  ---
  duration_ms: 0.03825
  type: 'test'
  ...
# Subtest: child process does not register the subagent tool
ok 170 - child process does not register the subagent tool
  ---
  duration_ms: 0.67
  type: 'test'
  ...
# Subtest: child bash interceptor blocks herdr agent prompt
ok 171 - child bash interceptor blocks herdr agent prompt
  ---
  duration_ms: 0.464458
  type: 'test'
  ...
# Subtest: nested-allowed child still registers the subagent tool
ok 172 - nested-allowed child still registers the subagent tool
  ---
  duration_ms: 0.694083
  type: 'test'
  ...
# (node:62473) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: findCursorChatDir locates by id and prefers a matching cwd
ok 173 - findCursorChatDir locates by id and prefers a matching cwd
  ---
  duration_ms: 4.155
  type: 'test'
  ...
# Subtest: parseCursorChat skips injected rows and derives turns atomically
ok 174 - parseCursorChat skips injected rows and derives turns atomically
  ---
  duration_ms: 6.313458
  type: 'test'
  ...
# Subtest: parseCursorChat reports an unanswered turn as unsettled
ok 175 - parseCursorChat reports an unanswered turn as unsettled
  ---
  duration_ms: 2.62725
  type: 'test'
  ...
# Subtest: parseCursorChat refuses a future schemaVersion
ok 176 - parseCursorChat refuses a future schemaVersion
  ---
  duration_ms: 2.554375
  type: 'test'
  ...
# Subtest: parseCursorChat on a missing store is an empty session
ok 177 - parseCursorChat on a missing store is an empty session
  ---
  duration_ms: 0.462166
  type: 'test'
  ...
# Subtest: parseCursorChat on an unopenable store is an empty session
ok 178 - parseCursorChat on an unopenable store is an empty session
  ---
  duration_ms: 0.988959
  type: 'test'
  ...
# Subtest: parseCursorChat on a zero-byte store is an empty session
ok 179 - parseCursorChat on a zero-byte store is an empty session
  ---
  duration_ms: 0.791084
  type: 'test'
  ...
# Subtest: regression: no source file may statically import node:sqlite or bun:sqlite
ok 180 - regression: no source file may statically import node:sqlite or bun:sqlite
  ---
  duration_ms: 4.422875
  type: 'test'
  ...
# (node:62478) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: success JSON on stdout → parsed value
ok 181 - success JSON on stdout → parsed value
  ---
  duration_ms: 1.6595
  type: 'test'
  ...
# Subtest: error JSON on stderr with empty stdout and code 1 → ok:false with the stderr code (F21)
ok 182 - error JSON on stderr with empty stdout and code 1 → ok:false with the stderr code (F21)
  ---
  duration_ms: 0.141917
  type: 'test'
  ...
# Subtest: non-JSON garbage → ok:false with PARSE_ERROR (code 0) or HERDR_ERROR (non-zero)
ok 183 - non-JSON garbage → ok:false with PARSE_ERROR (code 0) or HERDR_ERROR (non-zero)
  ---
  duration_ms: 0.1575
  type: 'test'
  ...
# Subtest: agent_pane_busy error → mapped to PANE_BUSY (F19)
ok 184 - agent_pane_busy error → mapped to PANE_BUSY (F19)
  ---
  duration_ms: 0.059042
  type: 'test'
  ...
# Subtest: agent_name_taken error → mapped to NAME_TAKEN (F16)
ok 185 - agent_name_taken error → mapped to NAME_TAKEN (F16)
  ---
  duration_ms: 0.066709
  type: 'test'
  ...
# Subtest: missing herdr binary (ENOENT) → HERDR_UNAVAILABLE (F22)
ok 186 - missing herdr binary (ENOENT) → HERDR_UNAVAILABLE (F22)
  ---
  duration_ms: 0.059042
  type: 'test'
  ...
# Subtest: makeName lowercases, replaces spaces, appends the index (F17)
ok 187 - makeName lowercases, replaces spaces, appends the index (F17)
  ---
  duration_ms: 0.956625
  type: 'test'
  ...
# Subtest: makeName('9bad', 0) → starts with a letter, ≤32 chars
ok 188 - makeName('9bad', 0) → starts with a letter, ≤32 chars
  ---
  duration_ms: 0.165417
  type: 'test'
  ...
# Subtest: makeName with a 50-char input → ≤32 chars and still valid
ok 189 - makeName with a 50-char input → ≤32 chars and still valid
  ---
  duration_ms: 0.330042
  type: 'test'
  ...
# Subtest: isSafeNestedPathId rejects traversal and absolute paths
ok 190 - isSafeNestedPathId rejects traversal and absolute paths
  ---
  duration_ms: 13.031792
  type: 'test'
  ...
# Subtest: sanitizeNestedPath truncates to 4 entries
ok 191 - sanitizeNestedPath truncates to 4 entries
  ---
  duration_ms: 0.389958
  type: 'test'
  ...
# Subtest: sanitizeNestedPath drops junk entries, keeps good ones
ok 192 - sanitizeNestedPath drops junk entries, keeps good ones
  ---
  duration_ms: 0.111917
  type: 'test'
  ...
# Subtest: agentStart returns the session path for pi kind (F1)
ok 193 - agentStart returns the session path for pi kind (F1)
  ---
  duration_ms: 1.0645
  type: 'test'
  ...
# Subtest: agentStart reports NO session path for non-pi kinds (F7)
ok 194 - agentStart reports NO session path for non-pi kinds (F7)
  ---
  duration_ms: 5.979375
  type: 'test'
  ...
# Subtest: agentStart reports NO agent_session for other non-pi kinds (F7)
ok 195 - agentStart reports NO agent_session for other non-pi kinds (F7)
  ---
  duration_ms: 0.295792
  type: 'test'
  ...
# Subtest: agent_pane_busy race after split, retry succeeds (F19/F20)
ok 196 - agent_pane_busy race after split, retry succeeds (F19/F20)
  ---
  duration_ms: 0.424208
  type: 'test'
  ...
# Subtest: reusing a live name → agent_name_taken; freed after exit (F16)
ok 197 - reusing a live name → agent_name_taken; freed after exit (F16)
  ---
  duration_ms: 0.783875
  type: 'test'
  ...
# Subtest: ctrl+d exits the agent but ctrl+c does NOT (F11)
ok 198 - ctrl+d exits the agent but ctrl+c does NOT (F11)
  ---
  duration_ms: 0.289625
  type: 'test'
  ...
# Subtest: missing herdr binary surfaces as a start timeout, not a clear error (F22)
ok 199 - missing herdr binary surfaces as a start timeout, not a clear error (F22)
  ---
  duration_ms: 0.114167
  type: 'test'
  ...
# Subtest: start timeout maps to START_TIMEOUT (F22 family)
ok 200 - start timeout maps to START_TIMEOUT (F22 family)
  ---
  duration_ms: 0.049708
  type: 'test'
  ...
# Subtest: agentGet → session info; agentList → arrays
ok 201 - agentGet → session info; agentList → arrays
  ---
  duration_ms: 0.622084
  type: 'test'
  ...
# Subtest: agentGet on an unknown agent → NOT_FOUND (F21 shape: stderr, empty stdout)
ok 202 - agentGet on an unknown agent → NOT_FOUND (F21 shape: stderr, empty stdout)
  ---
  duration_ms: 0.356791
  type: 'test'
  ...
# Subtest: paneRead returns plain text, not JSON (F6)
ok 203 - paneRead returns plain text, not JSON (F6)
  ---
  duration_ms: 0.210584
  type: 'test'
  ...
# Subtest: tabCreate / tabList / tabClose round trip; tab close kills agents atomically (F15)
ok 204 - tabCreate / tabList / tabClose round trip; tab close kills agents atomically (F15)
  ---
  duration_ms: 0.386833
  type: 'test'
  ...
# Subtest: agentStart forwards extra args and timeout
ok 205 - agentStart forwards extra args and timeout
  ---
  duration_ms: 0.170542
  type: 'test'
  ...
# Subtest: client.available() is true against the fake, false for a missing binary
ok 206 - client.available() is true against the fake, false for a missing binary
  ---
  duration_ms: 0.133541
  type: 'test'
  ...
# Subtest: createCommandRunner: resolveHerdrBin honours HERDR_BIN env
ok 207 - createCommandRunner: resolveHerdrBin honours HERDR_BIN env
  ---
  duration_ms: 0.097625
  type: 'test'
  ...
# Subtest: tabCreate with workspaceId records --workspace then that Space id in argv
ok 208 - tabCreate with workspaceId records --workspace then that Space id in argv
  ---
  duration_ms: 0.168792
  type: 'test'
  ...
# Subtest: tabCreate without workspaceId does not add --workspace
ok 209 - tabCreate without workspaceId does not add --workspace
  ---
  duration_ms: 0.126959
  type: 'test'
  ...
# Subtest: tabCreate with workspaceId yields tab and root pane in that workspace
ok 210 - tabCreate with workspaceId yields tab and root pane in that workspace
  ---
  duration_ms: 0.11975
  type: 'test'
  ...
# Subtest: fake tab create without --workspace uses focusedWorkspaceId
ok 211 - fake tab create without --workspace uses focusedWorkspaceId
  ---
  duration_ms: 0.115542
  type: 'test'
  ...
# Subtest: fake tab create --workspace pins the tab to that Space not the focused one
ok 212 - fake tab create --workspace pins the tab to that Space not the focused one
  ---
  duration_ms: 0.112375
  type: 'test'
  ...
# Subtest: tabList(workspaceId) does not return a tab from another Space
ok 213 - tabList(workspaceId) does not return a tab from another Space
  ---
  duration_ms: 0.326375
  type: 'test'
  ...
# Subtest: join: default config is smart with a 10s window (constructor-only)
ok 214 - join: default config is smart with a 10s window (constructor-only)
  ---
  duration_ms: 0.755209
  type: 'test'
  ...
# Subtest: join: each mode delivers immediately, one notice per child
ok 215 - join: each mode delivers immediately, one notice per child
  ---
  duration_ms: 0.11825
  type: 'test'
  ...
# Subtest: join: all members terminal → one immediate grouped flush
ok 216 - join: all members terminal → one immediate grouped flush
  ---
  duration_ms: 0.417208
  type: 'test'
  ...
# Subtest: join: window expiry with stragglers flushes only the finished ones
ok 217 - join: window expiry with stragglers flushes only the finished ones
  ---
  duration_ms: 0.151958
  type: 'test'
  ...
# Subtest: join: a busy parent extends the window at most MAX_BUSY_EXTENSIONS times
ok 218 - join: a busy parent extends the window at most MAX_BUSY_EXTENSIONS times
  ---
  duration_ms: 0.182208
  type: 'test'
  ...
# Subtest: join: an idle parent flushes at the first window expiry
ok 219 - join: an idle parent flushes at the first window expiry
  ---
  duration_ms: 0.075875
  type: 'test'
  ...
# Subtest: join: remove() drops a member so the group can settle without it
ok 220 - join: remove() drops a member so the group can settle without it
  ---
  duration_ms: 0.991917
  type: 'test'
  ...
# Subtest: join: failed entries keep their failed status in the batch
ok 221 - join: failed entries keep their failed status in the batch
  ---
  duration_ms: 0.103125
  type: 'test'
  ...
# Subtest: join: onTerminal without tracking delivers directly instead of dropping
ok 222 - join: onTerminal without tracking delivers directly instead of dropping
  ---
  duration_ms: 0.3205
  type: 'test'
  ...
# Subtest: join: dispose cancels timers and swallows nothing
ok 223 - join: dispose cancels timers and swallows nothing
  ---
  duration_ms: 0.372583
  type: 'test'
  ...
# Subtest: join: two runs batch independently
ok 224 - join: two runs batch independently
  ---
  duration_ms: 0.133375
  type: 'test'
  ...
# Subtest: U4: onTerminal fails loud on a running entry instead of buffering a lie
ok 225 - U4: onTerminal fails loud on a running entry instead of buffering a lie
  ---
  duration_ms: 0.21125
  type: 'test'
  ...
# Subtest: U4: a running entry mixed into a batch is refused, not merged
ok 226 - U4: a running entry mixed into a batch is refused, not merged
  ---
  duration_ms: 0.05925
  type: 'test'
  ...
# Subtest: cursorModel keeps legacy Auto distinct from Auto Balance
ok 227 - cursorModel keeps legacy Auto distinct from Auto Balance
  ---
  duration_ms: 8.50725
  type: 'test'
  ...
# Subtest: cursorModel maps grok-4.6 plus thinking onto the CLI slug
ok 228 - cursorModel maps grok-4.6 plus thinking onto the CLI slug
  ---
  duration_ms: 0.285416
  type: 'test'
  ...
# Subtest: cursorModel maps bare grok onto version-correct CLI slugs
ok 229 - cursorModel maps bare grok onto version-correct CLI slugs
  ---
  duration_ms: 0.069
  type: 'test'
  ...
# Subtest: cursorModel repairs a wrongly-prefixed grok-4.7 slug
ok 230 - cursorModel repairs a wrongly-prefixed grok-4.7 slug
  ---
  duration_ms: 0.206375
  type: 'test'
  ...
# Subtest: cursorModel expands pi-cursor-sdk context aliases to the bracket form
ok 231 - cursorModel expands pi-cursor-sdk context aliases to the bracket form
  ---
  duration_ms: 0.154042
  type: 'test'
  ...
# Subtest: cursorModel maps thinking=false to the lowest effort in every branch
ok 232 - cursorModel maps thinking=false to the lowest effort in every branch
  ---
  duration_ms: 0.06475
  type: 'test'
  ...
# Subtest: cursorModel passes an unknown :level-suffixed slug through unchanged
ok 233 - cursorModel passes an unknown :level-suffixed slug through unchanged
  ---
  duration_ms: 0.098792
  type: 'test'
  ...
# Subtest: cursorModel leaves explicit bracket forms untouched
ok 234 - cursorModel leaves explicit bracket forms untouched
  ---
  duration_ms: 0.0495
  type: 'test'
  ...
# Subtest: nativeModelFor drops inherited pi ids for non-pi kinds
ok 235 - nativeModelFor drops inherited pi ids for non-pi kinds
  ---
  duration_ms: 0.297125
  type: 'test'
  ...
# Subtest: isPiShapedModel accepts provider/id(:level) and rejects CLIs' bare slugs
ok 236 - isPiShapedModel accepts provider/id(:level) and rejects CLIs' bare slugs
  ---
  duration_ms: 0.318458
  type: 'test'
  ...
# Subtest: applyThinkingSuffix appends :level for pi and drops it for false
ok 237 - applyThinkingSuffix appends :level for pi and drops it for false
  ---
  duration_ms: 0.105333
  type: 'test'
  ...
# Subtest: kind/model coherence guard: cursor + pi-shaped model throws, pi accepts
ok 238 - kind/model coherence guard: cursor + pi-shaped model throws, pi accepts
  ---
  duration_ms: 0.265542
  type: 'test'
  ...
# Subtest: planKindStart: every kind omits the task from start argv
ok 239 - planKindStart: every kind omits the task from start argv
  ---
  duration_ms: 1.32925
  type: 'test'
  ...
# Subtest: planKindStart: cursor starts --force unless the agent opts into a human gate
ok 240 - planKindStart: cursor starts --force unless the agent opts into a human gate
  ---
  duration_ms: 0.76875
  type: 'test'
  ...
# Subtest: typeTabLabel is parent-scoped so two Pis in one Space do not share a tab
ok 241 - typeTabLabel is parent-scoped so two Pis in one Space do not share a tab
  ---
  duration_ms: 4.346041
  type: 'test'
  ...
# Subtest: tileSplit is a 3-column grid: fill a row, then wrap down
ok 242 - tileSplit is a 3-column grid: fill a row, then wrap down
  ---
  duration_ms: 6.777333
  type: 'test'
  ...
# Subtest: claimName reserves names so two callers cannot both take scout-0
ok 243 - claimName reserves names so two callers cannot both take scout-0
  ---
  duration_ms: 0.320417
  type: 'test'
  ...
# Subtest: liveNames unions claimed names with the fetched list
ok 244 - liveNames unions claimed names with the fetched list
  ---
  duration_ms: 0.154208
  type: 'test'
  ...
# Subtest: liveNames coalesces concurrent fetches
ok 245 - liveNames coalesces concurrent fetches
  ---
  duration_ms: 0.194917
  type: 'test'
  ...
# Subtest: acquireTypeTab serializes creators of the same type
ok 246 - acquireTypeTab serializes creators of the same type
  ---
  duration_ms: 0.23375
  type: 'test'
  ...
# Subtest: acquireTypeTab retries after the first creator fails
ok 247 - acquireTypeTab retries after the first creator fails
  ---
  duration_ms: 0.329708
  type: 'test'
  ...
# Subtest: assignPane serializes two racing splits of the same type
ok 248 - assignPane serializes two racing splits of the same type
  ---
  duration_ms: 0.125292
  type: 'test'
  ...
# Subtest: releasePane drops the type tab when the last pane is gone
ok 249 - releasePane drops the type tab when the last pane is gone
  ---
  duration_ms: 0.343333
  type: 'test'
  ...
# Subtest: renderer: collapsed success is one compact row
ok 250 - renderer: collapsed success is one compact row
  ---
  duration_ms: 16.610708
  type: 'test'
  ...
# Subtest: renderer: collapsed success stays one row at hostile widths
ok 251 - renderer: collapsed success stays one row at hostile widths
  ---
  duration_ms: 0.713709
  type: 'test'
  ...
# Subtest: renderer: hostile names render as one row without escapes
ok 252 - renderer: hostile names render as one row without escapes
  ---
  duration_ms: 0.236292
  type: 'test'
  ...
# Subtest: renderer: expanded success falls back to the default Markdown block
ok 253 - renderer: expanded success falls back to the default Markdown block
  ---
  duration_ms: 0.060209
  type: 'test'
  ...
# Subtest: renderer: failures and stops always use the full default block
ok 254 - renderer: failures and stops always use the full default block
  ---
  duration_ms: 0.151958
  type: 'test'
  ...
# Subtest: renderer: notices without details (old sessions) fall back
ok 255 - renderer: notices without details (old sessions) fall back
  ---
  duration_ms: 0.053791
  type: 'test'
  ...
# Subtest: renderer: details round-trips through JSON and still collapses
ok 256 - renderer: details round-trips through JSON and still collapses
  ---
  duration_ms: 0.202042
  type: 'test'
  ...
# Subtest: completionStatusOf: success is completed, abort is stopped, else failed
ok 257 - completionStatusOf: success is completed, abort is stopped, else failed
  ---
  duration_ms: 0.682958
  type: 'test'
  ...
# Subtest: formatCompletionNotice: success is displayed and carries renderer details
ok 258 - formatCompletionNotice: success is displayed and carries renderer details
  ---
  duration_ms: 0.21625
  type: 'test'
  ...
# Subtest: formatCompletionNotice: failure is displayed
ok 259 - formatCompletionNotice: failure is displayed
  ---
  duration_ms: 0.08325
  type: 'test'
  ...
# Subtest: formatCompletionNotice: aborted maps to stopped and is displayed
ok 260 - formatCompletionNotice: aborted maps to stopped and is displayed
  ---
  duration_ms: 0.062708
  type: 'test'
  ...
# Subtest: formatNoticeHeadline: one line with glyph, verdict and size
ok 261 - formatNoticeHeadline: one line with glyph, verdict and size
  ---
  duration_ms: 0.225625
  type: 'test'
  ...
# Subtest: formatNoticeHeadline: hostile fields cannot break the one-line contract
ok 262 - formatNoticeHeadline: hostile fields cannot break the one-line contract
  ---
  duration_ms: 0.090333
  type: 'test'
  ...
# Subtest: sanitizeNoticeField strips control characters only
ok 263 - sanitizeNoticeField strips control characters only
  ---
  duration_ms: 0.129833
  type: 'test'
  ...
# Subtest: formatCompletionNotice: details survive a JSON round-trip (session reload)
ok 264 - formatCompletionNotice: details survive a JSON round-trip (session reload)
  ---
  duration_ms: 0.090792
  type: 'test'
  ...
# Subtest: formatCollectFailure wraps an exception as a failed notice
ok 265 - formatCollectFailure wraps an exception as a failed notice
  ---
  duration_ms: 0.316
  type: 'test'
  ...
# Subtest: completionDeliveryOptions follows up instead of steering
ok 266 - completionDeliveryOptions follows up instead of steering
  ---
  duration_ms: 0.625458
  type: 'test'
  ...
# Subtest: previewOutput truncates long text
ok 267 - previewOutput truncates long text
  ---
  duration_ms: 0.134083
  type: 'test'
  ...
# Subtest: deliverCompletion sends subagent-notify with followUp wakeup
ok 268 - deliverCompletion sends subagent-notify with followUp wakeup
  ---
  duration_ms: 0.090375
  type: 'test'
  ...
# Subtest: deliverCompletion returns false when sendMessage throws
ok 269 - deliverCompletion returns false when sendMessage throws
  ---
  duration_ms: 0.060417
  type: 'test'
  ...
# Subtest: U3: completionStatusOf reports `running` as itself (never folded into failed)
ok 270 - U3: completionStatusOf reports `running` as itself (never folded into failed)
  ---
  duration_ms: 0.032709
  type: 'test'
  ...
# Subtest: U3: formatCompletionNotice fails loud on a running snapshot (B)
ok 271 - U3: formatCompletionNotice fails loud on a running snapshot (B)
  ---
  duration_ms: 0.173083
  type: 'test'
  ...
# Subtest: U3: a running snapshot never surfaces as a failed notice by accident (B regression)
ok 272 - U3: a running snapshot never surfaces as a failed notice by accident (B regression)
  ---
  duration_ms: 0.068958
  type: 'test'
  ...
# Subtest: completionStatusOf: unknown with a parsed verdict is completed, not failed
ok 273 - completionStatusOf: unknown with a parsed verdict is completed, not failed
  ---
  duration_ms: 0.034375
  type: 'test'
  ...
# Subtest: formatCompletionNotice: settled cursor answer reports completed with its verdict
ok 274 - formatCompletionNotice: settled cursor answer reports completed with its verdict
  ---
  duration_ms: 0.053709
  type: 'test'
  ...
# Subtest: formatGroupedNotice: multiple entries merge into one notice with a header
ok 275 - formatGroupedNotice: multiple entries merge into one notice with a header
  ---
  duration_ms: 0.149125
  type: 'test'
  ...
# Subtest: formatGroupedNotice: recycle markers are per-entry, not a blanket footer
ok 276 - formatGroupedNotice: recycle markers are per-entry, not a blanket footer
  ---
  duration_ms: 0.091625
  type: 'test'
  ...
# Subtest: formatGroupedNotice: any failed → failed aggregate and display
ok 277 - formatGroupedNotice: any failed → failed aggregate and display
  ---
  duration_ms: 0.0555
  type: 'test'
  ...
# Subtest: formatGroupedNotice: no runId omits the run header; stillRunning line appended
ok 278 - formatGroupedNotice: no runId omits the run header; stillRunning line appended
  ---
  duration_ms: 0.066584
  type: 'test'
  ...
# Subtest: formatGroupedNotice: a single entry still uses the grouped shape
ok 279 - formatGroupedNotice: a single entry still uses the grouped shape
  ---
  duration_ms: 0.120416
  type: 'test'
  ...
# Subtest: formatGroupedNotice: per-entry previews are capped so the batch stays bounded
ok 280 - formatGroupedNotice: per-entry previews are capped so the batch stays bounded
  ---
  duration_ms: 0.080209
  type: 'test'
  ...
# Subtest: parent-label: no pane id means no-op
ok 281 - parent-label: no pane id means no-op
  ---
  duration_ms: 0.633708
  type: 'test'
  ...
# Subtest: parent-label: reports idle state-label with TTL and source
ok 282 - parent-label: reports idle state-label with TTL and source
  ---
  duration_ms: 2.481459
  type: 'test'
  ...
# Subtest: parent-label: skips an unchanged label inside the dedupe window
ok 283 - parent-label: skips an unchanged label inside the dedupe window
  ---
  duration_ms: 9.475333
  type: 'test'
  ...
# Subtest: parent-label: a changed label reports immediately
ok 284 - parent-label: a changed label reports immediately
  ---
  duration_ms: 8.6125
  type: 'test'
  ...
# Subtest: parent-label: clear sends clear-state-labels and resets dedupe
ok 285 - parent-label: clear sends clear-state-labels and resets dedupe
  ---
  duration_ms: 2.972875
  type: 'test'
  ...
# Subtest: parent-label: report(undefined) clears via the busy hook path
ok 286 - parent-label: report(undefined) clears via the busy hook path
  ---
  duration_ms: 9.744917
  type: 'test'
  ...
# Subtest: parent-label: a failed report is retried on the next tick
ok 287 - parent-label: a failed report is retried on the next tick
  ---
  duration_ms: 7.259292
  type: 'test'
  ...
# Subtest: parent-label: concurrent reports coalesce (in-flight guard)
ok 288 - parent-label: concurrent reports coalesce (in-flight guard)
  ---
  duration_ms: 12.60025
  type: 'test'
  ...
# Subtest: plan: exactly one request shape must be provided
ok 289 - plan: exactly one request shape must be provided
  ---
  duration_ms: 0.980125
  type: 'test'
  ...
# Subtest: plan: a single agent+task is accepted
ok 290 - plan: a single agent+task is accepted
  ---
  duration_ms: 0.559667
  type: 'test'
  ...
# Subtest: plan: a single request with a blank task is refused
ok 291 - plan: a single request with a blank task is refused
  ---
  duration_ms: 0.108334
  type: 'test'
  ...
# Subtest: plan: tasks[] entries are validated
ok 292 - plan: tasks[] entries are validated
  ---
  duration_ms: 0.139167
  type: 'test'
  ...
# Subtest: plan: tasks[] preserves a per-child worktree flag
ok 293 - plan: tasks[] preserves a per-child worktree flag
  ---
  duration_ms: 0.168583
  type: 'test'
  ...
# Subtest: plan: chain[] entries are validated
ok 294 - plan: chain[] entries are validated
  ---
  duration_ms: 0.131792
  type: 'test'
  ...
# Subtest: plan: chain substitutes {previous} in every step after the first
ok 295 - plan: chain substitutes {previous} in every step after the first
  ---
  duration_ms: 0.224458
  type: 'test'
  ...
# Subtest: plan: the unknown-agent refusal is a single, complete line
ok 296 - plan: the unknown-agent refusal is a single, complete line
  ---
  duration_ms: 0.114
  type: 'test'
  ...
# Subtest: plan: the unknown-agent refusal says "none" when no agent is known
ok 297 - plan: the unknown-agent refusal says "none" when no agent is known
  ---
  duration_ms: 1.324666
  type: 'test'
  ...
# Subtest: playbook text is the frozen launch recipe
ok 298 - playbook text is the frozen launch recipe
  ---
  duration_ms: 0.687833
  type: 'test'
  ...
# Subtest: shellChunks splits compound commands
ok 299 - shellChunks splits compound commands
  ---
  duration_ms: 0.532792
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: the herdr skill discovery ritual
ok 300 - forbiddenDispatchReason: the herdr skill discovery ritual
  ---
  duration_ms: 0.387959
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: the old dispatch ritual
ok 301 - forbiddenDispatchReason: the old dispatch ritual
  ---
  duration_ms: 0.170875
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: HERDR_ENV prelude
ok 302 - forbiddenDispatchReason: HERDR_ENV prelude
  ---
  duration_ms: 0.130709
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: inspection commands stay allowed
ok 303 - forbiddenDispatchReason: inspection commands stay allowed
  ---
  duration_ms: 0.133084
  type: 'test'
  ...
# Subtest: playbook explains merged completion notices and the wait action
ok 304 - playbook explains merged completion notices and the wait action
  ---
  duration_ms: 0.15475
  type: 'test'
  ...
# Subtest: U8: playbook explains that a collect timeout notice is a progress signal
ok 305 - U8: playbook explains that a collect timeout notice is a progress signal
  ---
  duration_ms: 0.063917
  type: 'test'
  ...
# Subtest: BUG P1: an undefined preset must not abort the whole tasks[] batch
ok 306 - BUG P1: an undefined preset must not abort the whole tasks[] batch
  ---
  duration_ms: 5445.556209
  type: 'test'
  ...
# Subtest: BUG P1: the healthy sibling actually LAUNCHES despite the bad preset
ok 307 - BUG P1: the healthy sibling actually LAUNCHES despite the bad preset
  ---
  duration_ms: 5178.407833
  type: 'test'
  ...
# Subtest: BUG P1: the refusal names the presets that ARE defined
ok 308 - BUG P1: the refusal names the presets that ARE defined
  ---
  duration_ms: 258.259667
  type: 'test'
  ...
# Subtest: launch: a defined preset's model reaches the herdr argv
ok 309 - launch: a defined preset's model reaches the herdr argv
  ---
  duration_ms: 5154.810667
  type: 'test'
  ...
# Subtest: launch: a preset beats a folded agentOverrides model, end to end
ok 310 - launch: a preset beats a folded agentOverrides model, end to end
  ---
  duration_ms: 5200.557333
  type: 'test'
  ...
# Subtest: launch: the tool `preset` param selects a different preset
ok 311 - launch: the tool `preset` param selects a different preset
  ---
  duration_ms: 5222.504
  type: 'test'
  ...
# Subtest: e2e: an inherited parent model is dropped and reported, not refused
ok 312 - e2e: an inherited parent model is dropped and reported, not refused
  ---
  duration_ms: 2823.424541
  type: 'test'
  ...
# Subtest: e2e: an explicit model the kind cannot express is refused, launching nothing
ok 313 - e2e: an explicit model the kind cannot express is refused, launching nothing
  ---
  duration_ms: 264.016667
  type: 'test'
  ...
# Subtest: presets: absent key yields undefined, not an error
ok 314 - presets: absent key yields undefined, not an error
  ---
  duration_ms: 0.809
  type: 'test'
  ...
# Subtest: presets: rejects a non-object presets value
ok 315 - presets: rejects a non-object presets value
  ---
  duration_ms: 0.260291
  type: 'test'
  ...
# Subtest: presets: rejects a non-object preset entry
ok 316 - presets: rejects a non-object preset entry
  ---
  duration_ms: 0.108625
  type: 'test'
  ...
# Subtest: presets: rejects an unknown kind
ok 317 - presets: rejects an unknown kind
  ---
  duration_ms: 0.075291
  type: 'test'
  ...
# Subtest: presets: rejects an empty model and a non-string thinking
ok 318 - presets: rejects an empty model and a non-string thinking
  ---
  duration_ms: 0.168292
  type: 'test'
  ...
# Subtest: presets: accepts a full and a partial preset; thinking: false is kept
ok 319 - presets: accepts a full and a partial preset; thinking: false is kept
  ---
  duration_ms: 0.4095
  type: 'test'
  ...
# Subtest: presets: tool param wins over the agent's own preset
ok 320 - presets: tool param wins over the agent's own preset
  ---
  duration_ms: 0.184292
  type: 'test'
  ...
# Subtest: presets: falls back to the agent's preset; absent means undefined
ok 321 - presets: falls back to the agent's preset; absent means undefined
  ---
  duration_ms: 0.059375
  type: 'test'
  ...
# Subtest: presets: a blank tool param is ignored, not treated as a name
ok 322 - presets: a blank tool param is ignored, not treated as a name
  ---
  duration_ms: 0.279917
  type: 'test'
  ...
# Subtest: presets: requirePreset returns the entry when defined
ok 323 - presets: requirePreset returns the entry when defined
  ---
  duration_ms: 0.342417
  type: 'test'
  ...
# Subtest: presets: requirePreset error names the defined presets
ok 324 - presets: requirePreset error names the defined presets
  ---
  duration_ms: 0.150667
  type: 'test'
  ...
# Subtest: presets: requirePreset says 'None are defined' for an empty/absent map
ok 325 - presets: requirePreset says 'None are defined' for an empty/absent map
  ---
  duration_ms: 0.077875
  type: 'test'
  ...
# Subtest: presets: coherence guard rejects a pi-shaped model on cursor
ok 326 - presets: coherence guard rejects a pi-shaped model on cursor
  ---
  duration_ms: 0.215125
  type: 'test'
  ...
# Subtest: presets: coherence guard accepts a pi-shaped model on pi
ok 327 - presets: coherence guard accepts a pi-shaped model on pi
  ---
  duration_ms: 0.081917
  type: 'test'
  ...
# Subtest: presets: coherence guard accepts a cursor slug on cursor and no model
ok 328 - presets: coherence guard accepts a cursor slug on cursor and no model
  ---
  duration_ms: 0.16225
  type: 'test'
  ...
# Subtest: presets: the guard reports where the model came from
ok 329 - presets: the guard reports where the model came from
  ---
  duration_ms: 0.071417
  type: 'test'
  ...
# Subtest: presets: applyPreset replaces kind/model/thinking atomically
ok 330 - presets: applyPreset replaces kind/model/thinking atomically
  ---
  duration_ms: 0.06825
  type: 'test'
  ...
# Subtest: presets: applyPreset records provenance and copies the agent
ok 331 - presets: applyPreset records provenance and copies the agent
  ---
  duration_ms: 0.049958
  type: 'test'
  ...
# Subtest: presets: applyPreset keeps untouched fields; thinking: false disables
ok 332 - presets: applyPreset keeps untouched fields; thinking: false disables
  ---
  duration_ms: 0.042125
  type: 'test'
  ...
# Subtest: every bundled role is assigned a cheap/medium/strong tier
ok 333 - every bundled role is assigned a cheap/medium/strong tier
  ---
  duration_ms: 1.149
  type: 'test'
  ...
# Subtest: name heuristics: flash/haiku/sonnet/opus bands
ok 334 - name heuristics: flash/haiku/sonnet/opus bands
  ---
  duration_ms: 0.254917
  type: 'test'
  ...
# Subtest: classify: flash is cheap, opus is strong
ok 335 - classify: flash is cheap, opus is strong
  ---
  duration_ms: 0.426166
  type: 'test'
  ...
# Subtest: classify: official cost metadata is recorded as a source
ok 336 - classify: official cost metadata is recorded as a source
  ---
  duration_ms: 0.119042
  type: 'test'
  ...
# Subtest: pickTierModels: quota sits lower than quality
ok 337 - pickTierModels: quota sits lower than quality
  ---
  duration_ms: 0.221667
  type: 'test'
  ...
# Subtest: pickTierModels: a single model fills every tier
ok 338 - pickTierModels: a single model fills every tier
  ---
  duration_ms: 0.0695
  type: 'test'
  ...
# Subtest: filterDominatedModels: cheaper equal-or-better model wins
ok 339 - filterDominatedModels: cheaper equal-or-better model wins
  ---
  duration_ms: 0.201667
  type: 'test'
  ...
# Subtest: buildProfileFile maps our five roles onto the three tiers
ok 340 - buildProfileFile maps our five roles onto the three tiers
  ---
  duration_ms: 0.105958
  type: 'test'
  ...
# Subtest: normalizePathToken rejects traversal and empty names
ok 341 - normalizePathToken rejects traversal and empty names
  ---
  duration_ms: 0.457375
  type: 'test'
  ...
# Subtest: applySubagentProfile writes agentOverrides and keeps other settings
ok 342 - applySubagentProfile writes agentOverrides and keeps other settings
  ---
  duration_ms: 2.583708
  type: 'test'
  ...
# Subtest: list/read profiles ignore the providers subdirectory
ok 343 - list/read profiles ignore the providers subdirectory
  ---
  duration_ms: 1.765458
  type: 'test'
  ...
# Subtest: validateSubagentProfile rejects a missing agentOverrides object
ok 344 - validateSubagentProfile rejects a missing agentOverrides object
  ---
  duration_ms: 0.225417
  type: 'test'
  ...
# Subtest: generateProfilesForProvider writes quota and quality files
ok 345 - generateProfilesForProvider writes quota and quality files
  ---
  duration_ms: 16.5795
  type: 'test'
  ...
# Subtest: refresh reuses a fresh catalog and refreshes a stale one
ok 346 - refresh reuses a fresh catalog and refreshes a stale one
  ---
  duration_ms: 1.811292
  type: 'test'
  ...
# Subtest: checkSubagentProfile reports registry hits without probing
ok 347 - checkSubagentProfile reports registry hits without probing
  ---
  duration_ms: 2.039458
  type: 'test'
  ...
# Subtest: refresh reports unknown providers clearly
ok 348 - refresh reports unknown providers clearly
  ---
  duration_ms: 0.934541
  type: 'test'
  ...
# Subtest: slash arg parsing: required name, force, no-probe
ok 349 - slash arg parsing: required name, force, no-probe
  ---
  duration_ms: 0.442459
  type: 'test'
  ...
# Subtest: getAgentDir honours PI_CODING_AGENT_DIR
ok 350 - getAgentDir honours PI_CODING_AGENT_DIR
  ---
  duration_ms: 0.084708
  type: 'test'
  ...
# Subtest: progressFromSession: model_change is enough before any assistant message
ok 351 - progressFromSession: model_change is enough before any assistant message
  ---
  duration_ms: 0.922667
  type: 'test'
  ...
# Subtest: progressFromSession: turns and in-flight tools come from the last assistant
ok 352 - progressFromSession: turns and in-flight tools come from the last assistant
  ---
  duration_ms: 0.345
  type: 'test'
  ...
# Subtest: progressFromSession: a finished text turn does not keep stale tools
ok 353 - progressFromSession: a finished text turn does not keep stale tools
  ---
  duration_ms: 0.184333
  type: 'test'
  ...
# Subtest: progressFromAgentInfo: aligns cursor-like labels/tokens onto the pi fields
ok 354 - progressFromAgentInfo: aligns cursor-like labels/tokens onto the pi fields
  ---
  duration_ms: 0.229375
  type: 'test'
  ...
# Subtest: progressFromAgentInfo: ignores usage-shaped tokens and finds a model-like label
ok 355 - progressFromAgentInfo: ignores usage-shaped tokens and finds a model-like label
  ---
  duration_ms: 0.317875
  type: 'test'
  ...
# Subtest: progressFromPaneInfo: pulls a provider/id out of the terminal title
ok 356 - progressFromPaneInfo: pulls a provider/id out of the terminal title
  ---
  duration_ms: 0.630417
  type: 'test'
  ...
# Subtest: mergeProgress: later sources win, empty parts do not clobber
ok 357 - mergeProgress: later sources win, empty parts do not clobber
  ---
  duration_ms: 0.694167
  type: 'test'
  ...
# Subtest: formatAlreadyRecycled is a no-op explanation, not a new close
ok 358 - formatAlreadyRecycled is a no-op explanation, not a new close
  ---
  duration_ms: 4.026042
  type: 'test'
  ...
# Subtest: canUseCachedCollect is true after collect, not while the child is working
ok 359 - canUseCachedCollect is true after collect, not while the child is working
  ---
  duration_ms: 0.12525
  type: 'test'
  ...
# Subtest: runtime: async watch notifies the parent once and drops the widget entry
ok 360 - runtime: async watch notifies the parent once and drops the widget entry
  ---
  duration_ms: 20.218667
  type: 'test'
  ...
# Subtest: runtime: watch recycles the pane after a terminal collect
ok 361 - runtime: watch recycles the pane after a terminal collect
  ---
  duration_ms: 7.130792
  type: 'test'
  ...
# Subtest: runtime: a blocked child is not recycled
ok 362 - runtime: a blocked child is not recycled
  ---
  duration_ms: 6.43
  type: 'test'
  ...
# Subtest: runtime: an explicit collect suppresses the completion message
ok 363 - runtime: an explicit collect suppresses the completion message
  ---
  duration_ms: 6.481292
  type: 'test'
  ...
# Subtest: runtime: collect failure still wakes the parent
ok 364 - runtime: collect failure still wakes the parent
  ---
  duration_ms: 7.037375
  type: 'test'
  ...
# Subtest: runtime: dispose clears jobs and busy overlay
ok 365 - runtime: dispose clears jobs and busy overlay
  ---
  duration_ms: 0.418
  type: 'test'
  ...
# Subtest: runtime: collect after watch finished returns the cached snapshot
ok 366 - runtime: collect after watch finished returns the cached snapshot
  ---
  duration_ms: 14.633375
  type: 'test'
  ...
# Subtest: runtime: a blocked child asks the parent and does not recycle
ok 367 - runtime: a blocked child asks the parent and does not recycle
  ---
  duration_ms: 7.265291
  type: 'test'
  ...
# Subtest: runtime: approving a blocked child rewatches instead of releasing
ok 368 - runtime: approving a blocked child rewatches instead of releasing
  ---
  duration_ms: 8.134583
  type: 'test'
  ...
# Subtest: runtime: session jsonl fills model, turns, and in-flight tools
ok 369 - runtime: session jsonl fills model, turns, and in-flight tools
  ---
  duration_ms: 2.736042
  type: 'test'
  ...
# Subtest: runtime: non-pi probe fills the same live fields
ok 370 - runtime: non-pi probe fills the same live fields
  ---
  duration_ms: 10.812625
  type: 'test'
  ...
# Subtest: shouldRecycleAfterCollect keeps running/blocked panes, recycles unknown
ok 371 - shouldRecycleAfterCollect keeps running/blocked panes, recycles unknown
  ---
  duration_ms: 0.12
  type: 'test'
  ...
# Subtest: runtime: same-run children batch into exactly one grouped notice
ok 372 - runtime: same-run children batch into exactly one grouped notice
  ---
  duration_ms: 34.064833
  type: 'test'
  ...
# Subtest: runtime: flush window expiry delivers a partial batch; the straggler flushes alone
ok 373 - runtime: flush window expiry delivers a partial batch; the straggler flushes alone
  ---
  duration_ms: 68.682
  type: 'test'
  ...
# Subtest: runtime: joinMode each sends one notice per child
ok 374 - runtime: joinMode each sends one notice per child
  ---
  duration_ms: 5.583458
  type: 'test'
  ...
# Subtest: runtime: a blocked sibling does not block the group's flush; resume rejoins it
ok 375 - runtime: a blocked sibling does not block the group's flush; resume rejoins it
  ---
  duration_ms: 61.97925
  type: 'test'
  ...
# Subtest: runtime: retire runs during the batch window, not after the flush
ok 376 - runtime: retire runs during the batch window, not after the flush
  ---
  duration_ms: 12.284792
  type: 'test'
  ...
# Subtest: runtime.wait: aggregates both children, recycles panes, suppresses notify
ok 377 - runtime.wait: aggregates both children, recycles panes, suppresses notify
  ---
  duration_ms: 28.149667
  type: 'test'
  ...
# Subtest: runtime.wait: the hit path itself releases the job (no watch finally to hide it)
ok 378 - runtime.wait: the hit path itself releases the job (no watch finally to hide it)
  ---
  duration_ms: 0.31775
  type: 'test'
  ...
# Subtest: runtime.wait: timeout yields stillRunning, resets consumedByTool, auto-notify lands
ok 379 - runtime.wait: timeout yields stillRunning, resets consumedByTool, auto-notify lands
  ---
  duration_ms: 56.755959
  type: 'test'
  ...
# Subtest: runtime.wait: finished-cache hits return instantly; unknown names are missing
ok 380 - runtime.wait: finished-cache hits return instantly; unknown names are missing
  ---
  duration_ms: 5.0405
  type: 'test'
  ...
# Subtest: runtime.wait: a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch
ok 381 - runtime.wait: a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch
  ---
  duration_ms: 12.377333
  type: 'test'
  ...
# Subtest: runtime.wait: a non-terminal (running) snapshot keeps the job active and unretired
ok 382 - runtime.wait: a non-terminal (running) snapshot keeps the job active and unretired
  ---
  duration_ms: 0.34275
  type: 'test'
  ...
# Subtest: U1: watch re-arms instead of notifying when collect times out on a live child
ok 383 - U1: watch re-arms instead of notifying when collect times out on a live child
  ---
  duration_ms: 32.380667
  type: 'test'
  ...
# Subtest: U2: the re-armed watch never treats the same running snapshot as terminal
ok 384 - U2: the re-armed watch never treats the same running snapshot as terminal
  ---
  duration_ms: 27.238709
  type: 'test'
  ...
# Subtest: U2: a re-arming watch joins no group until it really finishes
ok 385 - U2: a re-arming watch joins no group until it really finishes
  ---
  duration_ms: 55.667416
  type: 'test'
  ...
# Subtest: U5: a running snapshot is not cached as a finished result
ok 386 - U5: a running snapshot is not cached as a finished result
  ---
  duration_ms: 0.332792
  type: 'test'
  ...
# Subtest: U5: a terminal snapshot is still cached (the exclusion is running-only)
ok 387 - U5: a terminal snapshot is still cached (the exclusion is running-only)
  ---
  duration_ms: 0.130125
  type: 'test'
  ...
# Subtest: success turn → status success
ok 388 - success turn → status success
  ---
  duration_ms: 1.258458
  type: 'test'
  ...
# Subtest: stopReason error + message → failed, errorMessage preserved
ok 389 - stopReason error + message → failed, errorMessage preserved
  ---
  duration_ms: 0.178041
  type: 'test'
  ...
# Subtest: stopReason error + message containing aborted → aborted (F29)
ok 390 - stopReason error + message containing aborted → aborted (F29)
  ---
  duration_ms: 0.112125
  type: 'test'
  ...
# Subtest: stopReason length → truncated
ok 391 - stopReason length → truncated
  ---
  duration_ms: 0.091541
  type: 'test'
  ...
# Subtest: stopReason toolUse as last assistant → aborted (killed mid-tool)
ok 392 - stopReason toolUse as last assistant → aborted (killed mid-tool)
  ---
  duration_ms: 0.106417
  type: 'test'
  ...
# Subtest: user msg with no assistant reply → aborted, lastTurnMissing true (F29)
ok 393 - user msg with no assistant reply → aborted, lastTurnMissing true (F29)
  ---
  duration_ms: 0.070625
  type: 'test'
  ...
# Subtest: no messages at all → unknown
ok 394 - no messages at all → unknown
  ---
  duration_ms: 0.057
  type: 'test'
  ...
# Subtest: turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)
ok 395 - turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)
  ---
  duration_ms: 0.213959
  type: 'test'
  ...
# Subtest: torn/truncated JSON line → counted in tornLines, does not throw (F12)
ok 396 - torn/truncated JSON line → counted in tornLines, does not throw (F12)
  ---
  duration_ms: 0.473417
  type: 'test'
  ...
# Subtest: usage accumulation across 3 assistant messages
ok 397 - usage accumulation across 3 assistant messages
  ---
  duration_ms: 0.767
  type: 'test'
  ...
# Subtest: unknown stopReason value → failed with a reason
ok 398 - unknown stopReason value → failed with a reason
  ---
  duration_ms: 0.583083
  type: 'test'
  ...
# Subtest: extractVerdict('{"ok":false,"reason":"x"}') → {ok:false, reason:"x"} (F33)
ok 399 - extractVerdict('{"ok":false,"reason":"x"}') → {ok:false, reason:"x"} (F33)
  ---
  duration_ms: 0.249584
  type: 'test'
  ...
# Subtest: extractVerdict("plain text") → null
ok 400 - extractVerdict("plain text") → null
  ---
  duration_ms: 0.166459
  type: 'test'
  ...
# Subtest: extractVerdict on fenced ```json block parses the JSON inside
ok 401 - extractVerdict on fenced ```json block parses the JSON inside
  ---
  duration_ms: 0.136125
  type: 'test'
  ...
# Subtest: model_change header populates parsed.model before any assistant message
ok 402 - model_change header populates parsed.model before any assistant message
  ---
  duration_ms: 0.075334
  type: 'test'
  ...
# Subtest: assistant model overrides an earlier model_change
ok 403 - assistant model overrides an earlier model_change
  ---
  duration_ms: 0.076875
  type: 'test'
  ...
# Subtest: parseSessionFile: missing file → empty ParsedSession (no throw)
ok 404 - parseSessionFile: missing file → empty ParsedSession (no throw)
  ---
  duration_ms: 0.107917
  type: 'test'
  ...
# Subtest: parseSessionFile: real file round-trips like text
ok 405 - parseSessionFile: real file round-trips like text
  ---
  duration_ms: 1.381209
  type: 'test'
  ...
# Subtest: F32: agent self-reporting failure still has stopReason stop → mechanically success
ok 406 - F32: agent self-reporting failure still has stopReason stop → mechanically success
  ---
  duration_ms: 0.146709
  type: 'test'
  ...
# Subtest: extractVerdict ignores non-verdict JSON objects
ok 407 - extractVerdict ignores non-verdict JSON objects
  ---
  duration_ms: 0.182125
  type: 'test'
  ...
# Subtest: stripPromptEcho drops the launch prompt once but keeps a later verdict
ok 408 - stripPromptEcho drops the launch prompt once but keeps a later verdict
  ---
  duration_ms: 0.239167
  type: 'test'
  ...
# Subtest: paneLooksStuck detects Cursor trust and paste-preview chrome
ok 409 - paneLooksStuck detects Cursor trust and paste-preview chrome
  ---
  duration_ms: 1.8395
  type: 'test'
  ...
# Subtest: paneLooksStuck ignores leftover paste chrome once a live reply exists
ok 410 - paneLooksStuck ignores leftover paste chrome once a live reply exists
  ---
  duration_ms: 0.087541
  type: 'test'
  ...
# Subtest: paneHasLiveReply reads every rotating cursor banner variant as not-yet-replied
ok 411 - paneHasLiveReply reads every rotating cursor banner variant as not-yet-replied
  ---
  duration_ms: 8.467333
  type: 'test'
  ...
# Subtest: paneHasLiveReply still sees a real reply under the banner
ok 412 - paneHasLiveReply still sees a real reply under the banner
  ---
  duration_ms: 0.129
  type: 'test'
  ...
# Subtest: turn boundaries are split by user messages; per-turn stats are independent
ok 413 - turn boundaries are split by user messages; per-turn stats are independent
  ---
  duration_ms: 0.201375
  type: 'test'
  ...
# Subtest: hard kill mid-turn: user msg then only toolResult, no assistant → aborted
ok 414 - hard kill mid-turn: user msg then only toolResult, no assistant → aborted
  ---
  duration_ms: 0.074542
  type: 'test'
  ...
# Subtest: toolResult before any user message does not crash
ok 415 - toolResult before any user message does not crash
  ---
  duration_ms: 0.074667
  type: 'test'
  ...
# Subtest: scalar JSON lines are treated as damaged, never crash the parse
ok 416 - scalar JSON lines are treated as damaged, never crash the parse
  ---
  duration_ms: 0.066583
  type: 'test'
  ...
# Subtest: a null line does not prevent the valid lines around it from parsing
ok 417 - a null line does not prevent the valid lines around it from parsing
  ---
  duration_ms: 0.070708
  type: 'test'
  ...
# Subtest: parseSessionText never throws on hostile input
ok 418 - parseSessionText never throws on hostile input
  ---
  duration_ms: 0.21975
  type: 'test'
  ...
# Subtest: success
ok 419 - success
  ---
  duration_ms: 4.49525
  type: 'test'
  ...
# Subtest: error
ok 420 - error
  ---
  duration_ms: 0.183375
  type: 'test'
  ...
# Subtest: aborted via missing reply
ok 421 - aborted via missing reply
  ---
  duration_ms: 0.084292
  type: 'test'
  ...
# Subtest: toolUse as final => aborted
ok 422 - toolUse as final => aborted
  ---
  duration_ms: 0.08175
  type: 'test'
  ...
# Subtest: tool error then clean stop => success with toolErrors
ok 423 - tool error then clean stop => success with toolErrors
  ---
  duration_ms: 0.210875
  type: 'test'
  ...
# Subtest: torn line tolerated
ok 424 - torn line tolerated
  ---
  duration_ms: 0.234042
  type: 'test'
  ...
# Subtest: verdict
ok 425 - verdict
  ---
  duration_ms: 0.677292
  type: 'test'
  ...
# Subtest: names
ok 426 - names
  ---
  duration_ms: 0.226209
  type: 'test'
  ...
# Subtest: names: a non-finite index still yields a valid name
ok 427 - names: a non-finite index still yields a valid name
  ---
  duration_ms: 0.40575
  type: 'test'
  ...
# Subtest: names: every generated name is valid, across hostile inputs
ok 428 - names: every generated name is valid, across hostile inputs
  ---
  duration_ms: 2.284709
  type: 'test'
  ...
# Subtest: names: distinct indexes yield distinct names
ok 429 - names: distinct indexes yield distinct names
  ---
  duration_ms: 0.188
  type: 'test'
  ...
# Subtest: nested path safety
ok 430 - nested path safety
  ---
  duration_ms: 0.141708
  type: 'test'
  ...
# Subtest: herdr error on stderr
ok 431 - herdr error on stderr
  ---
  duration_ms: 0.136959
  type: 'test'
  ...
# Subtest: herdr success on stdout
ok 432 - herdr success on stdout
  ---
  duration_ms: 0.042209
  type: 'test'
  ...
# Subtest: buildPiArgs: a multi-line task goes through a file, not argv
ok 433 - buildPiArgs: a multi-line task goes through a file, not argv
  ---
  duration_ms: 1.281291
  type: 'test'
  ...
# Subtest: buildPiArgs: a short single-line task also uses the file (no context switch)
ok 434 - buildPiArgs: a short single-line task also uses the file (no context switch)
  ---
  duration_ms: 0.505167
  type: 'test'
  ...
# Subtest: formatElapsed rounds to seconds
ok 435 - formatElapsed rounds to seconds
  ---
  duration_ms: 0.871125
  type: 'test'
  ...
# Subtest: formatFooterStatus is empty when nothing is running
ok 436 - formatFooterStatus is empty when nothing is running
  ---
  duration_ms: 0.102625
  type: 'test'
  ...
# Subtest: formatBusyLabel matches the herdr overlay copy
ok 437 - formatBusyLabel matches the herdr overlay copy
  ---
  duration_ms: 0.097208
  type: 'test'
  ...
# Subtest: formatWidgetLines keeps the compact roster when no extra fields are set
ok 438 - formatWidgetLines keeps the compact roster when no extra fields are set
  ---
  duration_ms: 0.607125
  type: 'test'
  ...
# Subtest: formatWidgetLines adds model, thinking, kind, tools, and worktree
ok 439 - formatWidgetLines adds model, thinking, kind, tools, and worktree
  ---
  duration_ms: 0.251459
  type: 'test'
  ...
# Subtest: applyStatus paints above the editor and in the footer
ok 440 - applyStatus paints above the editor and in the footer
  ---
  duration_ms: 0.330458
  type: 'test'
  ...
# Subtest: applyStatus is a no-op without UI
ok 441 - applyStatus is a no-op without UI
  ---
  duration_ms: 0.073583
  type: 'test'
  ...
# Subtest: status board registers a persistent factory and then requestRender
ok 442 - status board registers a persistent factory and then requestRender
  ---
  duration_ms: 0.37375
  type: 'test'
  ...
# Subtest: formatWidgetLines crash replica exceeds a 66-column terminal before truncation
ok 443 - formatWidgetLines crash replica exceeds a 66-column terminal before truncation
  ---
  duration_ms: 1.730084
  type: 'test'
  ...
# Subtest: status board render truncates crash-replica titles to terminal width
ok 444 - status board render truncates crash-replica titles to terminal width
  ---
  duration_ms: 11.796042
  type: 'test'
  ...
# Subtest: status board render truncates multi-child tree prefixes and ANSI colors
ok 445 - status board render truncates multi-child tree prefixes and ANSI colors
  ---
  duration_ms: 12.562834
  type: 'test'
  ...
# Subtest: status board keeps short titles intact on a wide terminal
ok 446 - status board keeps short titles intact on a wide terminal
  ---
  duration_ms: 0.296375
  type: 'test'
  ...
# Subtest: step-model: preset beats agentOverrides AFTER loadCatalog folds them in
ok 447 - step-model: preset beats agentOverrides AFTER loadCatalog folds them in
  ---
  duration_ms: 1.139
  type: 'test'
  ...
# Subtest: step-model: a per-run tool `model` still beats the preset
ok 448 - step-model: a per-run tool `model` still beats the preset
  ---
  duration_ms: 0.117417
  type: 'test'
  ...
# Subtest: step-model: tool `preset` beats the agent's own frontmatter preset
ok 449 - step-model: tool `preset` beats the agent's own frontmatter preset
  ---
  duration_ms: 0.084
  type: 'test'
  ...
# Subtest: step-model: the preset's kind and thinking reach the launched agent
ok 450 - step-model: the preset's kind and thinking reach the launched agent
  ---
  duration_ms: 0.298708
  type: 'test'
  ...
# Subtest: step-model: an agentOverrides-supplied preset reference is honoured
ok 451 - step-model: an agentOverrides-supplied preset reference is honoured
  ---
  duration_ms: 0.202708
  type: 'test'
  ...
# Subtest: step-model: an agent with no preset is untouched
ok 452 - step-model: an agent with no preset is untouched
  ---
  duration_ms: 0.137875
  type: 'test'
  ...
# Subtest: step-model: no preset + no overrides falls through to defaultModel
ok 453 - step-model: no preset + no overrides falls through to defaultModel
  ---
  duration_ms: 0.0765
  type: 'test'
  ...
# Subtest: BUG A1: preset kind + tool `model` override must not ship incoherently
ok 454 - BUG A1: preset kind + tool `model` override must not ship incoherently
  ---
  duration_ms: 0.356542
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset + defaultModel must not ship incoherently
ok 455 - BUG A1: a kind-only preset + defaultModel must not ship incoherently
  ---
  duration_ms: 0.350583
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset + the dispatch model must not ship incoherently
ok 456 - BUG A1: a kind-only preset + the dispatch model must not ship incoherently
  ---
  duration_ms: 0.402792
  type: 'test'
  ...
# Subtest: BUG A1: the refusal names the real model source, not the preset
ok 457 - BUG A1: the refusal names the real model source, not the preset
  ---
  duration_ms: 0.15625
  type: 'test'
  ...
# Subtest: BUG A1: a tool `model` override and the parent model are blamed apart
ok 458 - BUG A1: a tool `model` override and the parent model are blamed apart
  ---
  duration_ms: 0.237541
  type: 'test'
  ...
# Subtest: BUG A1: a coherent preset still launches (guard is not over-eager)
ok 459 - BUG A1: a coherent preset still launches (guard is not over-eager)
  ---
  duration_ms: 0.135375
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset with a COMPATIBLE model is allowed
ok 460 - BUG A1: a kind-only preset with a COMPATIBLE model is allowed
  ---
  duration_ms: 0.113917
  type: 'test'
  ...
# Subtest: step-model: an undefined preset throws (never a silent fallback)
ok 461 - step-model: an undefined preset throws (never a silent fallback)
  ---
  duration_ms: 0.064625
  type: 'test'
  ...
# Subtest: origin: frontmatter, agentOverrides and preset are explicit choices
ok 462 - origin: frontmatter, agentOverrides and preset are explicit choices
  ---
  duration_ms: 0.0705
  type: 'test'
  ...
# Subtest: origin: defaultModel and the parent session model are inherited
ok 463 - origin: defaultModel and the parent session model are inherited
  ---
  duration_ms: 0.05075
  type: 'test'
  ...
# Subtest: origin: a per-run model param is an explicit choice
ok 464 - origin: a per-run model param is an explicit choice
  ---
  duration_ms: 0.043625
  type: 'test'
  ...
# Subtest: origin: no model anywhere is inherited (nothing was chosen)
ok 465 - origin: no model anywhere is inherited (nothing was chosen)
  ---
  duration_ms: 0.036542
  type: 'test'
  ...
# Subtest: createRun generates r- prefixed runId and persists run.json
ok 466 - createRun generates r- prefixed runId and persists run.json
  ---
  duration_ms: 5.252167
  type: 'test'
  ...
# Subtest: createRun rejects empty task / cwd
ok 467 - createRun rejects empty task / cwd
  ---
  duration_ms: 0.66875
  type: 'test'
  ...
# Subtest: createRun accepts nested path and derives depth
ok 468 - createRun accepts nested path and derives depth
  ---
  duration_ms: 1.574542
  type: 'test'
  ...
# Subtest: createRun truncates nested path to 4 entries
ok 469 - createRun truncates nested path to 4 entries
  ---
  duration_ms: 2.493
  type: 'test'
  ...
# Subtest: create/read round-trip preserves all fields
ok 470 - create/read round-trip preserves all fields
  ---
  duration_ms: 1.434334
  type: 'test'
  ...
# Subtest: readRun returns null for a missing run
ok 471 - readRun returns null for a missing run
  ---
  duration_ms: 0.287791
  type: 'test'
  ...
# Subtest: readRun throws for traversal runIds
ok 472 - readRun throws for traversal runIds
  ---
  duration_ms: 0.28175
  type: 'test'
  ...
# Subtest: writeRun updates updatedAt and round-trips
ok 473 - writeRun updates updatedAt and round-trips
  ---
  duration_ms: 1.794666
  type: 'test'
  ...
# Subtest: writeRun rejects a non-RunRecord shape
ok 474 - writeRun rejects a non-RunRecord shape
  ---
  duration_ms: 2.546625
  type: 'test'
  ...
# Subtest: atomic write leaves no .tmp behind
ok 475 - atomic write leaves no .tmp behind
  ---
  duration_ms: 2.240917
  type: 'test'
  ...
# Subtest: run.json still parses after many rapid writes (no partial state)
ok 476 - run.json still parses after many rapid writes (no partial state)
  ---
  duration_ms: 8.340125
  type: 'test'
  ...
# Subtest: run.json is created with restrictive file mode
ok 477 - run.json is created with restrictive file mode
  ---
  duration_ms: 4.823625
  type: 'test'
  ...
# Subtest: corrupt run.json: readRun returns null and quarantines as .corrupt
ok 478 - corrupt run.json: readRun returns null and quarantines as .corrupt
  ---
  duration_ms: 1.826792
  type: 'test'
  ...
# Subtest: corrupt run.json with valid JSON but wrong shape is quarantined
ok 479 - corrupt run.json with valid JSON but wrong shape is quarantined
  ---
  duration_ms: 1.269375
  type: 'test'
  ...
# Subtest: after corruption the run can be recreated cleanly
ok 480 - after corruption the run can be recreated cleanly
  ---
  duration_ms: 1.878834
  type: 'test'
  ...
# Subtest: listRuns skips corrupt runs without throwing
ok 481 - listRuns skips corrupt runs without throwing
  ---
  duration_ms: 1.847042
  type: 'test'
  ...
# Subtest: sessionFileFor pre-creates an empty file at mode 0600 and returns the path
ok 482 - sessionFileFor pre-creates an empty file at mode 0600 and returns the path
  ---
  duration_ms: 1.445166
  type: 'test'
  ...
# Subtest: sessionFileFor is idempotent — no data loss on repeat calls
ok 483 - sessionFileFor is idempotent — no data loss on repeat calls
  ---
  duration_ms: 1.366
  type: 'test'
  ...
# Subtest: sessionFileFor creates the run dir on demand
ok 484 - sessionFileFor creates the run dir on demand
  ---
  duration_ms: 0.816166
  type: 'test'
  ...
# Subtest: sanitizeNameForFs neutralizes path traversal
ok 485 - sanitizeNameForFs neutralizes path traversal
  ---
  duration_ms: 1.168834
  type: 'test'
  ...
# Subtest: sanitizeNameForFs: ../../etc/passwd becomes passwd
ok 486 - sanitizeNameForFs: ../../etc/passwd becomes passwd
  ---
  duration_ms: 0.25125
  type: 'test'
  ...
# Subtest: sanitizeNameForFs replaces spaces and unicode
ok 487 - sanitizeNameForFs replaces spaces and unicode
  ---
  duration_ms: 0.282458
  type: 'test'
  ...
# Subtest: sanitizeNameForFs rejects names that sanitize to nothing
ok 488 - sanitizeNameForFs rejects names that sanitize to nothing
  ---
  duration_ms: 0.259042
  type: 'test'
  ...
# Subtest: sessionFileFor with a hostile name still creates a file inside the run dir
ok 489 - sessionFileFor with a hostile name still creates a file inside the run dir
  ---
  duration_ms: 1.294916
  type: 'test'
  ...
# Subtest: addChild appends, bumps budget, and generates ownerToken when missing
ok 490 - addChild appends, bumps budget, and generates ownerToken when missing
  ---
  duration_ms: 3.408792
  type: 'test'
  ...
# Subtest: addChild rejects duplicate child names
ok 491 - addChild rejects duplicate child names
  ---
  duration_ms: 4.45825
  type: 'test'
  ...
# Subtest: findChild returns null for unknown child
ok 492 - findChild returns null for unknown child
  ---
  duration_ms: 1.675834
  type: 'test'
  ...
# Subtest: updateChild mutates only the named child and persists
ok 493 - updateChild mutates only the named child and persists
  ---
  duration_ms: 4.728708
  type: 'test'
  ...
# Subtest: updateChild throws NOT_FOUND for unknown child
ok 494 - updateChild throws NOT_FOUND for unknown child
  ---
  duration_ms: 3.137667
  type: 'test'
  ...
# Subtest: updateRun read-modify-write round trip
ok 495 - updateRun read-modify-write round trip
  ---
  duration_ms: 2.067125
  type: 'test'
  ...
# Subtest: updateRun throws NOT_FOUND for a missing run
ok 496 - updateRun throws NOT_FOUND for a missing run
  ---
  duration_ms: 0.340959
  type: 'test'
  ...
# Subtest: concurrent updateRun calls on the same run serialize (no lost update)
ok 497 - concurrent updateRun calls on the same run serialize (no lost update)
  ---
  duration_ms: 37.314666
  type: 'test'
  ...
# Subtest: concurrent addChild calls all land (mutex under contention)
ok 498 - concurrent addChild calls all land (mutex under contention)
  ---
  duration_ms: 4.649708
  type: 'test'
  ...
# Subtest: a failing mutator does not poison the lock for later callers
ok 499 - a failing mutator does not poison the lock for later callers
  ---
  duration_ms: 4.666791
  type: 'test'
  ...
# Subtest: artifactDirFor creates <runDir>/out
ok 500 - artifactDirFor creates <runDir>/out
  ---
  duration_ms: 8.485875
  type: 'test'
  ...
# Subtest: prune deletes only sessions older than retentionDays
ok 501 - prune deletes only sessions older than retentionDays
  ---
  duration_ms: 1.994917
  type: 'test'
  ...
# Subtest: prune removes whole run dirs whose run.json is older than retention
ok 502 - prune removes whole run dirs whose run.json is older than retention
  ---
  duration_ms: 3.826542
  type: 'test'
  ...
# Subtest: prune never deletes run.json of a run newer than retention
ok 503 - prune never deletes run.json of a run newer than retention
  ---
  duration_ms: 1.921458
  type: 'test'
  ...
# Subtest: prune enforces maxBytesPerRun by dropping oldest sessions first
ok 504 - prune enforces maxBytesPerRun by dropping oldest sessions first
  ---
  duration_ms: 2.3075
  type: 'test'
  ...
# Subtest: prune is a no-op when there is nothing to do
ok 505 - prune is a no-op when there is nothing to do
  ---
  duration_ms: 1.230709
  type: 'test'
  ...
# Subtest: prune ignores dirs without run.json
ok 506 - prune ignores dirs without run.json
  ---
  duration_ms: 3.554584
  type: 'test'
  ...
# Subtest: prune rejects non-positive retentionDays
ok 507 - prune rejects non-positive retentionDays
  ---
  duration_ms: 0.426375
  type: 'test'
  ...
# Subtest: listRuns returns runs ordered oldest-first
ok 508 - listRuns returns runs ordered oldest-first
  ---
  duration_ms: 18.271834
  type: 'test'
  ...
# Subtest: store works without a runs dir present
ok 509 - store works without a runs dir present
  ---
  duration_ms: 1.304209
  type: 'test'
  ...
# Subtest: RunStore requires rootDir
ok 510 - RunStore requires rootDir
  ---
  duration_ms: 0.24075
  type: 'test'
  ...
# Subtest: sessionFileFor does not leak file descriptors across repeated calls
ok 511 - sessionFileFor does not leak file descriptors across repeated calls
  ---
  duration_ms: 21.47
  type: 'test'
  ...
# Subtest: sessionFileFor keeps the pre-creation contract
ok 512 - sessionFileFor keeps the pre-creation contract
  ---
  duration_ms: 1.839583
  type: 'test'
  ...
# Subtest: pickChildByName does not return another parent's child of the same name
ok 513 - pickChildByName does not return another parent's child of the same name
  ---
  duration_ms: 3.081791
  type: 'test'
  ...
# Subtest: pickChildByName prefers a live child over an older retired one
ok 514 - pickChildByName prefers a live child over an older retired one
  ---
  duration_ms: 2.895833
  type: 'test'
  ...
# Subtest: formatters follow the compact summary conventions
ok 515 - formatters follow the compact summary conventions
  ---
  duration_ms: 0.81525
  type: 'test'
  ...
# Subtest: summaryRole prefers agent verbatim and strips the counter only from name
ok 516 - summaryRole prefers agent verbatim and strips the counter only from name
  ---
  duration_ms: 0.18425
  type: 'test'
  ...
# Subtest: aggregateSubagentRuns groups by agent, prefers execution snapshots, and falls back to jsonl
ok 517 - aggregateSubagentRuns groups by agent, prefers execution snapshots, and falls back to jsonl
  ---
  duration_ms: 24.930959
  type: 'test'
  ...
# Subtest: non-pi zero session usage is unavailable, and awaiting execution counts as both outcome and running
ok 518 - non-pi zero session usage is unavailable, and awaiting execution counts as both outcome and running
  ---
  duration_ms: 11.572625
  type: 'test'
  ...
# Subtest: a missing or empty session file yields no usage, not parser-shaped zeros
ok 519 - a missing or empty session file yields no usage, not parser-shaped zeros
  ---
  duration_ms: 12.997833
  type: 'test'
  ...
# Subtest: a running non-pi child does not display stale session usage
ok 520 - a running non-pi child does not display stale session usage
  ---
  duration_ms: 2.228542
  type: 'test'
  ...
# Subtest: formatSubagentSummary renders the fixed seven-column table and empty state
ok 521 - formatSubagentSummary renders the fixed seven-column table and empty state
  ---
  duration_ms: 0.230583
  type: 'test'
  ...
# Subtest: formatSubagentDetail includes available fields and omits missing pane/tab/worktree data
ok 522 - formatSubagentDetail includes available fields and omits missing pane/tab/worktree data
  ---
  duration_ms: 4.478709
  type: 'test'
  ...
# Subtest: registerSummaryCommand registers completion and emits slash text
ok 523 - registerSummaryCommand registers completion and emits slash text
  ---
  duration_ms: 9.693875
  type: 'test'
  ...
# Subtest: teams: environment wins over settings, then default
ok 524 - teams: environment wins over settings, then default
  ---
  duration_ms: 1.087708
  type: 'test'
  ...
# Subtest: teams: default returns the exact input array
ok 525 - teams: default returns the exact input array
  ---
  duration_ms: 0.191625
  type: 'test'
  ...
# Subtest: teams: explicit members preserve order and warn on missing roles
ok 526 - teams: explicit members preserve order and warn on missing roles
  ---
  duration_ms: 0.255958
  type: 'test'
  ...
# Subtest: teams: star expands all roles once and later object overrides win
ok 527 - teams: star expands all roles once and later object overrides win
  ---
  duration_ms: 0.166375
  type: 'test'
  ...
# Subtest: teams: disabled member removes a role even after star expansion
ok 528 - teams: disabled member removes a role even after star expansion
  ---
  duration_ms: 0.143041
  type: 'test'
  ...
# Subtest: teams: missing active team falls back to all roles with available-name warning
ok 529 - teams: missing active team falls back to all roles with available-name warning
  ---
  duration_ms: 0.08775
  type: 'test'
  ...
# Subtest: teams: list puts default first
ok 530 - teams: list puts default first
  ---
  duration_ms: 0.1185
  type: 'test'
  ...
# Subtest: settings: teams parse, merge by name, and project team selection wins
ok 531 - settings: teams parse, merge by name, and project team selection wins
  ---
  duration_ms: 0.545459
  type: 'test'
  ...
# Subtest: settings: default team name and malformed team structures are rejected
ok 532 - settings: default team name and malformed team structures are rejected
  ---
  duration_ms: 0.522125
  type: 'test'
  ...
# Subtest: slash: team arguments parse as a pure function
ok 533 - slash: team arguments parse as a pure function
  ---
  duration_ms: 0.488041
  type: 'test'
  ...
# Subtest: slash: settings writer preserves unrelated keys for use/create updates
ok 534 - slash: settings writer preserves unrelated keys for use/create updates
  ---
  duration_ms: 1.606792
  type: 'test'
  ...
# Subtest: slash: use/create handlers write project settings and preserve unrelated keys
ok 535 - slash: use/create handlers write project settings and preserve unrelated keys
  ---
  duration_ms: 1.559125
  type: 'test'
  ...
# Subtest: control lookup: a role removed by team filtering remains available for child controls
ok 536 - control lookup: a role removed by team filtering remains available for child controls
  ---
  duration_ms: 0.070292
  type: 'test'
  ...
# Subtest: unknown agent: team-specific refusal names the available team roles
ok 537 - unknown agent: team-specific refusal names the available team roles
  ---
  duration_ms: 0.061459
  type: 'test'
  ...
# Subtest: slash: registering team command exposes the command
ok 538 - slash: registering team command exposes the command
  ---
  duration_ms: 0.055917
  type: 'test'
  ...
# Subtest: waitAction: a finished child is waitable via the finished-cache probe
ok 539 - waitAction: a finished child is waitable via the finished-cache probe
  ---
  duration_ms: 7.733542
  type: 'test'
  ...
# Subtest: waitAction: an untracked name with no cache is a loud unknown child
ok 540 - waitAction: an untracked name with no cache is a loud unknown child
  ---
  duration_ms: 0.48925
  type: 'test'
  ...
# Subtest: waitAction: default timeout is the strictest (smallest) role timeout
ok 541 - waitAction: default timeout is the strictest (smallest) role timeout
  ---
  duration_ms: 0.470708
  type: 'test'
  ...
# Subtest: waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs
ok 542 - waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs
  ---
  duration_ms: 0.23825
  type: 'test'
  ...
# Subtest: renderWait: summary line counts done and still-running
ok 543 - renderWait: summary line counts done and still-running
  ---
  duration_ms: 0.137583
  type: 'test'
  ...
# Subtest: resolveWaitTargets: all picks working and blocked children
ok 544 - resolveWaitTargets: all picks working and blocked children
  ---
  duration_ms: 0.769875
  type: 'test'
  ...
# Subtest: resolveWaitTargets: all with nothing running is a loud miss
ok 545 - resolveWaitTargets: all with nothing running is a loud miss
  ---
  duration_ms: 0.10825
  type: 'test'
  ...
# Subtest: resolveWaitTargets: a tracked name resolves alone
ok 546 - resolveWaitTargets: a tracked name resolves alone
  ---
  duration_ms: 0.065667
  type: 'test'
  ...
# Subtest: resolveWaitTargets: an untracked name fails with the unknown-child wording
ok 547 - resolveWaitTargets: an untracked name fails with the unknown-child wording
  ---
  duration_ms: 0.057583
  type: 'test'
  ...
# Subtest: resolveWaitTargets: neither name nor all is rejected
ok 548 - resolveWaitTargets: neither name nor all is rejected
  ---
  duration_ms: 0.056958
  type: 'test'
  ...
# Subtest: worktreePathFor nests under the run dir
ok 549 - worktreePathFor nests under the run dir
  ---
  duration_ms: 0.715583
  type: 'test'
  ...
# Subtest: resolveLaunchWorktree lets the parent override the role default
ok 550 - resolveLaunchWorktree lets the parent override the role default
  ---
  duration_ms: 0.090792
  type: 'test'
  ...
# Subtest: createChildWorktree refuses a non-git cwd
ok 551 - createChildWorktree refuses a non-git cwd
  ---
  duration_ms: 32.1115
  type: 'test'
  ...
# Subtest: createChildWorktree adds a named branch checkout and remove rolls it back
ok 552 - createChildWorktree adds a named branch checkout and remove rolls it back
  ---
  duration_ms: 172.40525
  type: 'test'
  ...
# Subtest: worktreeBranchFor is unique per nonce
ok 553 - worktreeBranchFor is unique per nonce
  ---
  duration_ms: 0.197834
  type: 'test'
  ...
1..553
# tests 553
# suites 0
# pass 553
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 30350.231625
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 test:integration
npm notice run node --experimental-strip-types --test test/integration/*.test.ts
TAP version 13
# (node:66375) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: preCreateSessionFile creates an empty 0600 file and is idempotent
ok 1 - preCreateSessionFile creates an empty 0600 file and is idempotent
  ---
  duration_ms: 1.865458
  type: 'test'
  ...
# Subtest: launch pre-creates the session file before starting the agent (F4)
ok 2 - launch pre-creates the session file before starting the agent (F4)
  ---
  duration_ms: 4.529459
  type: 'test'
  ...
# Subtest: launch records the child with provenance
ok 3 - launch records the child with provenance
  ---
  duration_ms: 1.8135
  type: 'test'
  ...
# Subtest: launch retries agent_pane_busy until the pane is ready (F19)
ok 4 - launch retries agent_pane_busy until the pane is ready (F19)
  ---
  duration_ms: 1.413709
  type: 'test'
  ...
# Subtest: a failed launch rolls back its pane instead of leaking it
ok 5 - a failed launch rolls back its pane instead of leaking it
  ---
  duration_ms: 2.833042
  type: 'test'
  ...
# Subtest: collect derives success from the session, not agent_status (F26)
ok 6 - collect derives success from the session, not agent_status (F26)
  ---
  duration_ms: 3.178833
  type: 'test'
  ...
# Subtest: collect reports failure for an LLM error even though herdr says done (F26)
ok 7 - collect reports failure for an LLM error even though herdr says done (F26)
  ---
  duration_ms: 1.953
  type: 'test'
  ...
# Subtest: collect reports abort when the agent is GONE and the last prompt has no reply (F29)
ok 8 - collect reports abort when the agent is GONE and the last prompt has no reply (F29)
  ---
  duration_ms: 1.78775
  type: 'test'
  ...
# Subtest: collect reports `running` (not aborted) when the agent is still alive
ok 9 - collect reports `running` (not aborted) when the agent is still alive
  ---
  duration_ms: 2.251417
  type: 'test'
  ...
# Subtest: collect turns a self-reported verdict into acceptance (F33)
ok 10 - collect turns a self-reported verdict into acceptance (F33)
  ---
  duration_ms: 2.560292
  type: 'test'
  ...
# Subtest: collect on an unknown child throws
ok 11 - collect on an unknown child throws
  ---
  duration_ms: 0.412
  type: 'test'
  ...
# Subtest: retire snapshots the outcome before the agent disappears (F27)
ok 12 - retire snapshots the outcome before the agent disappears (F27)
  ---
  duration_ms: 1.827875
  type: 'test'
  ...
# Subtest: retire leaves the session file on disk so resume stays possible (F12)
ok 13 - retire leaves the session file on disk so resume stays possible (F12)
  ---
  duration_ms: 1.31
  type: 'test'
  ...
# Subtest: retire exits the agent and closes its pane
ok 14 - retire exits the agent and closes its pane
  ---
  duration_ms: 1.159375
  type: 'test'
  ...
# Subtest: retire is idempotent
ok 15 - retire is idempotent
  ---
  duration_ms: 1.670791
  type: 'test'
  ...
# Subtest: retireAll reaps every child (F15)
ok 16 - retireAll reaps every child (F15)
  ---
  duration_ms: 1.864833
  type: 'test'
  ...
# Subtest: allocateName produces valid, non-colliding names
ok 17 - allocateName produces valid, non-colliding names
  ---
  duration_ms: 0.315417
  type: 'test'
  ...
# Subtest: steer forwards a prompt to a live child (F10)
ok 18 - steer forwards a prompt to a live child (F10)
  ---
  duration_ms: 1.017167
  type: 'test'
  ...
# Subtest: steer on a missing child throws
ok 19 - steer on a missing child throws
  ---
  duration_ms: 0.261333
  type: 'test'
  ...
# Subtest: auditOrphans reports panes in the tab that the tree does not know about
ok 20 - auditOrphans reports panes in the tab that the tree does not know about
  ---
  duration_ms: 1.017208
  type: 'test'
  ...
# Subtest: restore rehydrates children from a persisted record
ok 21 - restore rehydrates children from a persisted record
  ---
  duration_ms: 0.989417
  type: 'test'
  ...
# Subtest: collect runs verification-output criteria and promotes attested to verified
ok 22 - collect runs verification-output criteria and promotes attested to verified
  ---
  duration_ms: 1.557375
  type: 'test'
  ...
# Subtest: collect reports blocked without waiting out the timeout
ok 23 - collect reports blocked without waiting out the timeout
  ---
  duration_ms: 1.171666
  type: 'test'
  ...
# Subtest: cachedCollect returns the snapshot after retire so a later collect is a no-wait
ok 24 - cachedCollect returns the snapshot after retire so a later collect is a no-wait
  ---
  duration_ms: 1.601458
  type: 'test'
  ...
# Subtest: approveBlocked sends y and lets collect run again
ok 25 - approveBlocked sends y and lets collect run again
  ---
  duration_ms: 1.24325
  type: 'test'
  ...
# Subtest: launch worktree:true is refused outside a git repo
ok 26 - launch worktree:true is refused outside a git repo
  ---
  duration_ms: 20.682459
  type: 'test'
  ...
# Subtest: launch worktree:true sets pane cwd and retire leaves the tree
ok 27 - launch worktree:true sets pane cwd and retire leaves the tree
  ---
  duration_ms: 123.144875
  type: 'test'
  ...
# Subtest: launch worktree: false opts out of the role default
ok 28 - launch worktree: false opts out of the role default
  ---
  duration_ms: 64.66775
  type: 'test'
  ...
# Subtest: launch worktree: true isolates even when the role did not default it
ok 29 - launch worktree: true isolates even when the role did not default it
  ---
  duration_ms: 103.46725
  type: 'test'
  ...
# Subtest: launch retries fallbackModels after a start failure
ok 30 - launch retries fallbackModels after a start failure
  ---
  duration_ms: 1.214334
  type: 'test'
  ...
# Subtest: completionGuard rejects a successful turn with no verdict JSON
ok 31 - completionGuard rejects a successful turn with no verdict JSON
  ---
  duration_ms: 1.36425
  type: 'test'
  ...
# Subtest: launch injects budget and nested-allow env into the pane
ok 32 - launch injects budget and nested-allow env into the pane
  ---
  duration_ms: 0.9575
  type: 'test'
  ...
# Subtest: probeProgress maps non-pi herdr labels onto the same live fields as jsonl
ok 33 - probeProgress maps non-pi herdr labels onto the same live fields as jsonl
  ---
  duration_ms: 2.755125
  type: 'test'
  ...
# Subtest: every kind starts via herdr then gets the task as agent prompt
ok 34 - every kind starts via herdr then gets the task as agent prompt
  ---
  duration_ms: 3.953208
  type: 'test'
  ...
# Subtest: cursor launch auto-installs a missing integration hook
ok 35 - cursor launch auto-installs a missing integration hook
  ---
  duration_ms: 1.518917
  type: 'test'
  ...
# Subtest: cursor launch probes the integration once per kind, not per launch
ok 36 - cursor launch probes the integration once per kind, not per launch
  ---
  duration_ms: 2.344625
  type: 'test'
  ...
# Subtest: cursor launch refuses cleanly when the hook cannot be installed
ok 37 - cursor launch refuses cleanly when the hook cannot be installed
  ---
  duration_ms: 0.295166
  type: 'test'
  ...
# Subtest: an older herdr without integration commands must not brick launches
ok 38 - an older herdr without integration commands must not brick launches
  ---
  duration_ms: 1.244542
  type: 'test'
  ...
# Subtest: pi launches never probe integrations
ok 39 - pi launches never probe integrations
  ---
  duration_ms: 0.759
  type: 'test'
  ...
# Subtest: a hook that reports not-installed even after a successful install refuses the launch
ok 40 - a hook that reports not-installed even after a successful install refuses the launch
  ---
  duration_ms: 0.295834
  type: 'test'
  ...
# Subtest: pane collect does not attest a system-prompt template verdict
ok 41 - pane collect does not attest a system-prompt template verdict
  ---
  duration_ms: 3.821125
  type: 'test'
  ...
# Subtest: cursor collect sends enter when the pane is still a paste preview
ok 42 - cursor collect sends enter when the pane is still a paste preview
  ---
  duration_ms: 3.158541
  type: 'test'
  ...
# Subtest: cursor collect does not settle on an idle Working spinner (debugger 7s retire)
ok 43 - cursor collect does not settle on an idle Working spinner (debugger 7s retire)
  ---
  duration_ms: 3.876542
  type: 'test'
  ...
# Subtest: launch: an explicit model the kind cannot accept is refused, leaking no pane
ok 44 - launch: an explicit model the kind cannot accept is refused, leaking no pane
  ---
  duration_ms: 0.43725
  type: 'test'
  ...
# Subtest: launch: an INHERITED model the kind cannot accept is dropped, not refused
ok 45 - launch: an INHERITED model the kind cannot accept is dropped, not refused
  ---
  duration_ms: 1.667167
  type: 'test'
  ...
# Subtest: launch: a compatible model still launches for a non-pi kind
ok 46 - launch: a compatible model still launches for a non-pi kind
  ---
  duration_ms: 1.788125
  type: 'test'
  ...
# Subtest: launch: an incompatible candidate is skipped in favour of a usable fallback
ok 47 - launch: an incompatible candidate is skipped in favour of a usable fallback
  ---
  duration_ms: 2.209791
  type: 'test'
  ...
# Subtest: launch: the default origin treats an explicit `model` param as a choice
ok 48 - launch: the default origin treats an explicit `model` param as a choice
  ---
  duration_ms: 0.485292
  type: 'test'
  ...
# Subtest: launch: an agent with no model at all still launches
ok 49 - launch: an agent with no model at all still launches
  ---
  duration_ms: 1.157041
  type: 'test'
  ...
# Subtest: cursor collect nudges Enter when the pane shows the real launch banner
ok 50 - cursor collect nudges Enter when the pane shows the real launch banner
  ---
  duration_ms: 3.890125
  type: 'test'
  ...
# Subtest: every observed Tip wording reaches the nudge (wording must not matter)
ok 51 - every observed Tip wording reaches the nudge (wording must not matter)
  ---
  duration_ms: 9.2805
  type: 'test'
  ...
# Subtest: cursor collect reads the verdict from the chat store, not the pane
ok 52 - cursor collect reads the verdict from the chat store, not the pane
  ---
  duration_ms: 3.040291
  type: 'test'
  ...
# Subtest: cursor collect keeps waiting while the store has no answer yet
ok 53 - cursor collect keeps waiting while the store has no answer yet
  ---
  duration_ms: 2.884709
  type: 'test'
  ...
# Subtest: U6: a timed-out (running) collect leaves the child in `working`, not `awaiting`
ok 54 - U6: a timed-out (running) collect leaves the child in `working`, not `awaiting`
  ---
  duration_ms: 2.208333
  type: 'test'
  ...
# Subtest: U6: a terminal collect still marks the child `awaiting` (the change is running-only)
ok 55 - U6: a terminal collect still marks the child `awaiting` (the change is running-only)
  ---
  duration_ms: 1.04
  type: 'test'
  ...
# Subtest: U7: a still-growing session file extends the collect deadline instead of reporting `running`
ok 56 - U7: a still-growing session file extends the collect deadline instead of reporting `running`
  ---
  duration_ms: 2.754125
  type: 'test'
  ...
# Subtest: U7: a quiet artifact still times out as `running` (no extension, no hang)
ok 57 - U7: a quiet artifact still times out as `running` (no extension, no hang)
  ---
  duration_ms: 1.481541
  type: 'test'
  ...
# (node:66376) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: regression: stopReason 'aborted' maps to aborted, not failed
ok 58 - regression: stopReason 'aborted' maps to aborted, not failed
  ---
  duration_ms: 1.084542
  type: 'test'
  ...
# Subtest: regression: absent stopReason is treated as a truncated stream (aborted)
ok 59 - regression: absent stopReason is treated as a truncated stream (aborted)
  ---
  duration_ms: 0.105958
  type: 'test'
  ...
# Subtest: regression: an UNRECOGNIZED stopReason is still reported as failed
ok 60 - regression: an UNRECOGNIZED stopReason is still reported as failed
  ---
  duration_ms: 0.09475
  type: 'test'
  ...
# Subtest: regression: collect() returns immediately when the turn already finished
ok 61 - regression: collect() returns immediately when the turn already finished
  ---
  duration_ms: 5.549292
  type: 'test'
  ...
# Subtest: isLastTurnComplete distinguishes settled, mid-tool, and unanswered turns
ok 62 - isLastTurnComplete distinguishes settled, mid-tool, and unanswered turns
  ---
  duration_ms: 0.22175
  type: 'test'
  ...
# Subtest: regression: collect aborts immediately after tab close mid-toolUse (F15)
ok 63 - regression: collect aborts immediately after tab close mid-toolUse (F15)
  ---
  duration_ms: 2.667584
  type: 'test'
  ...
# Subtest: regression: collect aborts immediately when tab close happens before any reply (F15)
ok 64 - regression: collect aborts immediately when tab close happens before any reply (F15)
  ---
  duration_ms: 1.930417
  type: 'test'
  ...
# Subtest: regression: the persisted child carries a real, unique ownerToken
ok 65 - regression: the persisted child carries a real, unique ownerToken
  ---
  duration_ms: 4.131834
  type: 'test'
  ...
# Subtest: regression: concurrent launches all succeed against a busy-pane window (F19/F20)
ok 66 - regression: concurrent launches all succeed against a busy-pane window (F19/F20)
  ---
  duration_ms: 4.470417
  type: 'test'
  ...
# Subtest: regression: launch() falls back to the agent's configured model
ok 67 - regression: launch() falls back to the agent's configured model
  ---
  duration_ms: 1.627416
  type: 'test'
  ...
# Subtest: regression: launch propagates lineage and depth to the child pane
ok 68 - regression: launch propagates lineage and depth to the child pane
  ---
  duration_ms: 1.665833
  type: 'test'
  ...
# Subtest: regression: lineage also survives the new-tab fallback
ok 69 - regression: lineage also survives the new-tab fallback
  ---
  duration_ms: 1.386375
  type: 'test'
  ...
# Subtest: regression: active team env reaches split and tab children, but default omits it
ok 70 - regression: active team env reaches split and tab children, but default omits it
  ---
  duration_ms: 3.866041
  type: 'test'
  ...
# Subtest: regression: nesting beyond maxDepth is refused
ok 71 - regression: nesting beyond maxDepth is refused
  ---
  duration_ms: 1.276292
  type: 'test'
  ...
# Subtest: regression: childPath appends this run to the inherited lineage
ok 72 - regression: childPath appends this run to the inherited lineage
  ---
  duration_ms: 0.173334
  type: 'test'
  ...
# Subtest: regression: the spawn budget is enforced and reports remaining
ok 73 - regression: the spawn budget is enforced and reports remaining
  ---
  duration_ms: 2.418083
  type: 'test'
  ...
# Subtest: regression: an unlimited budget reports null remaining
ok 74 - regression: an unlimited budget reports null remaining
  ---
  duration_ms: 0.16575
  type: 'test'
  ...
# Subtest: regression: a name held by an unrelated live agent is avoided up front
ok 75 - regression: a name held by an unrelated live agent is avoided up front
  ---
  duration_ms: 1.0165
  type: 'test'
  ...
# Subtest: regression: a name claimed between check and start is retried, not fatal
ok 76 - regression: a name claimed between check and start is retried, not fatal
  ---
  duration_ms: 1.244209
  type: 'test'
  ...
# Subtest: regression: the session file follows a mid-launch rename
ok 77 - regression: the session file follows a mid-launch rename
  ---
  duration_ms: 1.109333
  type: 'test'
  ...
# Subtest: regression: split placement falls back to a new tab without HERDR_PANE_ID
ok 78 - regression: split placement falls back to a new tab without HERDR_PANE_ID
  ---
  duration_ms: 1.170833
  type: 'test'
  ...
# Subtest: regression: split placement is honoured when HERDR_PANE_ID is present
ok 79 - regression: split placement is honoured when HERDR_PANE_ID is present
  ---
  duration_ms: 1.530708
  type: 'test'
  ...
# Subtest: regression: same-type panes tile as a 3-column grid, not a vertical stack
ok 80 - regression: same-type panes tile as a 3-column grid, not a vertical stack
  ---
  duration_ms: 2.865083
  type: 'test'
  ...
# Subtest: regression: retiring the last child of a type closes the type tab
ok 81 - regression: retiring the last child of a type closes the type tab
  ---
  duration_ms: 2.015791
  type: 'test'
  ...
# Subtest: regression: an explicit new-tab placement never splits
ok 82 - regression: an explicit new-tab placement never splits
  ---
  duration_ms: 0.980625
  type: 'test'
  ...
# Subtest: regression: an unwritable run root fails with an actionable error
ok 83 - regression: an unwritable run root fails with an actionable error
  ---
  duration_ms: 0.6705
  type: 'test'
  ...
# Subtest: regression: a writable run root is unaffected
ok 84 - regression: a writable run root is unaffected
  ---
  duration_ms: 1.035667
  type: 'test'
  ...
# Subtest: regression: declared acceptance criteria reach the caller as a checklist
ok 85 - regression: declared acceptance criteria reach the caller as a checklist
  ---
  duration_ms: 1.487208
  type: 'test'
  ...
# Subtest: regression: an agent without criteria reports none
ok 86 - regression: an agent without criteria reports none
  ---
  duration_ms: 1.256625
  type: 'test'
  ...
# Subtest: regression: a multi-line task never lands in start argv (F38)
ok 87 - regression: a multi-line task never lands in start argv (F38)
  ---
  duration_ms: 0.987916
  type: 'test'
  ...
# Subtest: regression: same-type children share one tab as panes
ok 88 - regression: same-type children share one tab as panes
  ---
  duration_ms: 1.344833
  type: 'test'
  ...
# Subtest: regression: different agent types get different tabs
ok 89 - regression: different agent types get different tabs
  ---
  duration_ms: 1.383333
  type: 'test'
  ...
# Subtest: regression: a run tab is created even outside a herdr pane (headless)
ok 90 - regression: a run tab is created even outside a herdr pane (headless)
  ---
  duration_ms: 0.865667
  type: 'test'
  ...
# Subtest: regression: a later launch of the same type joins the existing type tab
ok 91 - regression: a later launch of the same type joins the existing type tab
  ---
  duration_ms: 1.757042
  type: 'test'
  ...
# Subtest: regression: a recycled type tab is replaced, not reused
ok 92 - regression: a recycled type tab is replaced, not reused
  ---
  duration_ms: 2.717916
  type: 'test'
  ...
# Subtest: regression: parallel same-type launches share one tab (two tool calls)
ok 93 - regression: parallel same-type launches share one tab (two tool calls)
  ---
  duration_ms: 2.679416
  type: 'test'
  ...
# Subtest: regression: an aborted turn must not inherit the previous turn's verdict (F39)
ok 94 - regression: an aborted turn must not inherit the previous turn's verdict (F39)
  ---
  duration_ms: 1.621333
  type: 'test'
  ...
# Subtest: regression: a hard-killed turn must not inherit the previous verdict either (F39)
ok 95 - regression: a hard-killed turn must not inherit the previous verdict either (F39)
  ---
  duration_ms: 1.546333
  type: 'test'
  ...
# Subtest: regression: a LATER turn's rejection must override an earlier acceptance (F39)
ok 96 - regression: a LATER turn's rejection must override an earlier acceptance (F39)
  ---
  duration_ms: 1.566583
  type: 'test'
  ...
# Subtest: regression: child tab lands in parent Space, not the focused Space
ok 97 - regression: child tab lands in parent Space, not the focused Space
  ---
  duration_ms: 1.914834
  type: 'test'
  ...
# Subtest: regression: new-tab placement pins to parent workspaceId under a focused Space
ok 98 - regression: new-tab placement pins to parent workspaceId under a focused Space
  ---
  duration_ms: 1.093792
  type: 'test'
  ...
# Subtest: regression: adopt does not steal a same-label tab from another Space
ok 99 - regression: adopt does not steal a same-label tab from another Space
  ---
  duration_ms: 1.021125
  type: 'test'
  ...
# Subtest: regression: HERDR_WORKSPACE_ID env pins when workspaceId is omitted
ok 100 - regression: HERDR_WORKSPACE_ID env pins when workspaceId is omitted
  ---
  duration_ms: 1.0355
  type: 'test'
  ...
# Subtest: regression: two parent panes in one Space get separate type tabs
ok 101 - regression: two parent panes in one Space get separate type tabs
  ---
  duration_ms: 1.68125
  type: 'test'
  ...
# Subtest: regression: retiring one parent does not tab-close another parent's pane
ok 102 - regression: retiring one parent does not tab-close another parent's pane
  ---
  duration_ms: 1.661
  type: 'test'
  ...
1..102
# tests 102
# suites 0
# pass 102
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 578.00725

## 遗留问题

- None known in the implementation or test suite.
- The only intentionally unavailable artifact is an MR/PR, because creating one would violate the explicit no-commit/no-push task constraint.


## Review round 1 fixes

### A. 必修

1. **控制面角色解析 — completed.** `collectChild`、`reviveChild`、`followChild` 与 `waitAction` now resolve roles in the filtered/team-overridden `agents` first, then fall back to `allAgents`. The resolver is private (not an exported wrapper). Index-path regressions exercise filtered-child resume and collect; tests also pin filtered-role fallback and selected-team `kind`/`timeoutMs` overrides.
2. **default 输出兼容 — completed.** Tool `list`, `/subagents-agents`, and roster text omit all team headers when the active team is `default` with no warning. Unit tests compare the old list, slash listing, and roster strings exactly, including empty results. Non-default and warning output is separately asserted.
3. **子进程 env 注入 — completed.** `Orchestrator.lineageEnv` now injects for `name !== default || source === env`; `launchFamily` and `controlAction` use the same small `teamForChildren` helper. Mainline and integration tests cover split, tab, omitted default, and env-selected `default` despite settings selecting another team.
4. **原型键安全 — completed.** All team-map lookups use own-property checks; `parseTeams` creates a null-prototype result and rejects `__proto__` with path/field context. `PI_SUBAGENTS_TEAM=constructor` returns the full catalog with an exact “not defined” warning; configured own `constructor` remains usable.
5. **成员覆盖校验 — completed.** Team object members run the same supported-field validator as normal agent overrides. Invalid `model`, `disabled`, and `tools` types fail during parsing. Existing global `agentOverrides` structural validation is unchanged.
6. **创建文案 / JSON 路径 — completed.** `create` emits `Created subagent team X. Select it with /subagents-team use X`; malformed profile/settings JSON errors include the file path. The profile JSON path has a direct unit test.

### B. 简化与清理

7. **`applyTeam` 单 Map — completed.** One insertion-ordered `Map` holds selected roles; wildcard and later explicit mentions can restore a role deleted by `disabled`. That later-member-wins behavior and `{ agent: "*" }` (literal missing role with warning, not wildcard) are tested. Removed duplicate order/disabled state, redundant name filter, and unused team-type re-export.
8. **`parseTeams` — completed.** The parser uses one local `bad()` error constructor, a null-prototype output, and shared record/member/override helpers; its body is under the requested ~45-line target.
9. **Slash command — completed.** `TeamCommandDeps` has required catalog/team fields; use/create checks are own-key safe and consolidated; settings-path selection is local; the unused status `settings` parameter and unreachable member-count check are gone. `create` remains supported.
10. **无关 diff — completed.** Restored the original `launchFamily` destructuring layout and original README whitespace; retained the `OVERRIDE_FIELDS` export because the team-member validator consumes it. `profiles.ts` has no extra unrelated `SAFETY` comments; the pre-existing orchestrator blank line is preserved. The final diff was reviewed to keep changes scoped to the team feature and requested regression tests; `unknownAgentLine` team wording and active-team `source` remain.

### C. 测试补强

11. **环境隔离 — completed.** Team unit tests clear and restore `PI_SUBAGENTS_TEAM`; pure resolver/apply calls pass explicit environments. `--global` tests use a temporary `PI_CODING_AGENT_DIR`, restore it, and assert the project settings file is not created.
12. **回归覆盖 — completed.** Added exact warning/message assertions, parser boundary cases, settings merge/shape/security validation, catalog filtering/overrides/fallback behavior, legacy text snapshots, unknown-agent wording, real index-path launch/revive/collect checks, and split/tab/default/env=`default` propagation tests. Replaced the command-registration-only check with handler behavior assertions. Also verified global user-settings writes are isolated from project settings.
13. **自我变异检查 — completed.** Three mutations were made only in temporary copies and each made the relevant test fail: (a) removing the `allAgents` fallback breaks filtered-child resume; (b) dropping the env=`default` exception breaks child env injection; (c) always showing the default-team header breaks byte-for-byte legacy output. SHA-256 of the worktree diff before/after the temp-copy check matched; no mutation was left in the worktree.

### 最终验证命令输出（原样）

```text
$ npm run typecheck && npm test && npm run test:integration
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 typecheck
npm notice run tsc --noEmit
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 test
npm notice run node --experimental-strip-types --test test/unit/*.test.ts
TAP version 13
# Subtest: needsVerification is true only for required verification-output criteria
ok 1 - needsVerification is true only for required verification-output criteria
  ---
  duration_ms: 5.148833
  type: 'test'
  ...
# Subtest: applyVerification skips when there is nothing to run
ok 2 - applyVerification skips when there is nothing to run
  ---
  duration_ms: 0.121584
  type: 'test'
  ...
# Subtest: applyVerification promotes attested to verified when the command passes
ok 3 - applyVerification promotes attested to verified when the command passes
  ---
  duration_ms: 0.204292
  type: 'test'
  ...
# Subtest: applyVerification rejects when the command fails
ok 4 - applyVerification rejects when the command fails
  ---
  duration_ms: 0.105291
  type: 'test'
  ...
# Subtest: applyVerification does not run on an already-rejected turn
ok 5 - applyVerification does not run on an already-rejected turn
  ---
  duration_ms: 0.073833
  type: 'test'
  ...
# Subtest: verifyCommandOf prefers a criterion command over the default
ok 6 - verifyCommandOf prefers a criterion command over the default
  ---
  duration_ms: 0.061166
  type: 'test'
  ...
# Subtest: applyVerification runs the criterion command
ok 7 - applyVerification runs the criterion command
  ---
  duration_ms: 0.077125
  type: 'test'
  ...
# Subtest: defaultVerifyRunner times out a hung command
ok 8 - defaultVerifyRunner times out a hung command
  ---
  duration_ms: 115.4065
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: empty → default (undefined)
ok 9 - parseAgentsScopeArg: empty → default (undefined)
  ---
  duration_ms: 1.02725
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: accepts the three scopes
ok 10 - parseAgentsScopeArg: accepts the three scopes
  ---
  duration_ms: 0.079417
  type: 'test'
  ...
# Subtest: parseAgentsScopeArg: rejects junk and extra tokens
ok 11 - parseAgentsScopeArg: rejects junk and extra tokens
  ---
  duration_ms: 0.116167
  type: 'test'
  ...
# Subtest: renderAgentsListing: groups by source with counts
ok 12 - renderAgentsListing: groups by source with counts
  ---
  duration_ms: 0.5305
  type: 'test'
  ...
# Subtest: renderAgentsListing: user dir shows the resolved path and scope skips it
ok 13 - renderAgentsListing: user dir shows the resolved path and scope skips it
  ---
  duration_ms: 0.120125
  type: 'test'
  ...
# Subtest: renderAgentsListing: empty listing explains where to add agents
ok 14 - renderAgentsListing: empty listing explains where to add agents
  ---
  duration_ms: 0.156166
  type: 'test'
  ...
# Subtest: renderAgentsListing: flags disableBuiltins
ok 15 - renderAgentsListing: flags disableBuiltins
  ---
  duration_ms: 0.127208
  type: 'test'
  ...
# Subtest: renderAgentsListing: model line reports the resolved model + provenance
ok 16 - renderAgentsListing: model line reports the resolved model + provenance
  ---
  duration_ms: 0.120417
  type: 'test'
  ...
# Subtest: renderAgentsListing: no model anywhere → agent CLI default
ok 17 - renderAgentsListing: no model anywhere → agent CLI default
  ---
  duration_ms: 1.956625
  type: 'test'
  ...
# Subtest: renderAgentsListing: parent model fall-through is labelled parent session model, never per-run override
ok 18 - renderAgentsListing: parent model fall-through is labelled parent session model, never per-run override
  ---
  duration_ms: 0.516833
  type: 'test'
  ...
# Subtest: renderAgentsListing: modelScope violation — explicit model is a launch refusal
ok 19 - renderAgentsListing: modelScope violation — explicit model is a launch refusal
  ---
  duration_ms: 0.197334
  type: 'test'
  ...
# Subtest: renderAgentsListing: modelScope violation — inherited model is a warning
ok 20 - renderAgentsListing: modelScope violation — inherited model is a warning
  ---
  duration_ms: 0.07325
  type: 'test'
  ...
# Subtest: renderAgentsListing: explicit pi-shaped model on a cursor role is a launch refusal
ok 21 - renderAgentsListing: explicit pi-shaped model on a cursor role is a launch refusal
  ---
  duration_ms: 0.161625
  type: 'test'
  ...
# Subtest: renderAgentsListing: inherited pi-shaped model on a cursor role is a documented drop
ok 22 - renderAgentsListing: inherited pi-shaped model on a cursor role is a documented drop
  ---
  duration_ms: 0.090625
  type: 'test'
  ...
# Subtest: renderAgentsListing: unresolvable configuration is reported, not guessed
ok 23 - renderAgentsListing: unresolvable configuration is reported, not guessed
  ---
  duration_ms: 0.099208
  type: 'test'
  ...
# Subtest: renderAgentsListing: alias and unenforced fields are surfaced
ok 24 - renderAgentsListing: alias and unenforced fields are surfaced
  ---
  duration_ms: 0.054958
  type: 'test'
  ...
# Subtest: command: registered with a description and scope completions
ok 25 - command: registered with a description and scope completions
  ---
  duration_ms: 3.704667
  type: 'test'
  ...
# Subtest: command: lists sandboxed + builtin roles, grouped, with file paths
ok 26 - command: lists sandboxed + builtin roles, grouped, with file paths
  ---
  duration_ms: 5.668125
  type: 'test'
  ...
# Subtest: command: scope=project skips user layers but keeps builtin roles
ok 27 - command: scope=project skips user layers but keeps builtin roles
  ---
  duration_ms: 3.480958
  type: 'test'
  ...
# Subtest: command: invalid scope notifies an error and sends nothing
ok 28 - command: invalid scope notifies an error and sends nothing
  ---
  duration_ms: 1.410458
  type: 'test'
  ...
# Subtest: command: settings flow through — override model + disableBuiltins
ok 29 - command: settings flow through — override model + disableBuiltins
  ---
  duration_ms: 1.81575
  type: 'test'
  ...
# Subtest: command: no roles at all → helpful empty state
ok 30 - command: no roles at all → helpful empty state
  ---
  duration_ms: 1.480625
  type: 'test'
  ...
# Subtest: command: a loadCatalog failure surfaces as ui.notify error, nothing sent
ok 31 - command: a loadCatalog failure surfaces as ui.notify error, nothing sent
  ---
  duration_ms: 0.570791
  type: 'test'
  ...
# Subtest: AgentsCommandDeps: loadCatalog receives the parsed scope untouched
ok 32 - AgentsCommandDeps: loadCatalog receives the parsed scope untouched
  ---
  duration_ms: 0.201334
  type: 'test'
  ...
# Subtest: scope: thinking suffix is stripped only for known levels
ok 33 - scope: thinking suffix is stripped only for known levels
  ---
  duration_ms: 2.466
  type: 'test'
  ...
# Subtest: scope: glob matching is case-insensitive and anchored
ok 34 - scope: glob matching is case-insensitive and anchored
  ---
  duration_ms: 0.146583
  type: 'test'
  ...
# Subtest: scope: explicit violation is an error, inherited is a warning
ok 35 - scope: explicit violation is an error, inherited is a warning
  ---
  duration_ms: 0.103791
  type: 'test'
  ...
# Subtest: scope: in-scope model yields no violation
ok 36 - scope: in-scope model yields no violation
  ---
  duration_ms: 1.027416
  type: 'test'
  ...
# Subtest: scope: enforcement without allow list is a no-op
ok 37 - scope: enforcement without allow list is a no-op
  ---
  duration_ms: 0.086167
  type: 'test'
  ...
# Subtest: scope: disabled enforcement never violates
ok 38 - scope: disabled enforcement never violates
  ---
  duration_ms: 0.0545
  type: 'test'
  ...
# Subtest: scope: parse rejects malformed config
ok 39 - scope: parse rejects malformed config
  ---
  duration_ms: 0.245958
  type: 'test'
  ...
# Subtest: scope: parse accepts a valid config
ok 40 - scope: parse accepts a valid config
  ---
  duration_ms: 0.068834
  type: 'test'
  ...
# Subtest: resolve: per-run override wins over everything
ok 41 - resolve: per-run override wins over everything
  ---
  duration_ms: 0.400209
  type: 'test'
  ...
# Subtest: resolve: preset model beats agentOverrides (level 2)
ok 42 - resolve: preset model beats agentOverrides (level 2)
  ---
  duration_ms: 0.346792
  type: 'test'
  ...
# Subtest: resolve: preset model beats the provider-scoped override too
ok 43 - resolve: preset model beats the provider-scoped override too
  ---
  duration_ms: 0.138084
  type: 'test'
  ...
# Subtest: resolve: no preset means the old chain is bit-for-bit unchanged
ok 44 - resolve: no preset means the old chain is bit-for-bit unchanged
  ---
  duration_ms: 0.055459
  type: 'test'
  ...
# Subtest: resolve: provider-scoped override beats plain override
ok 45 - resolve: provider-scoped override beats plain override
  ---
  duration_ms: 0.04775
  type: 'test'
  ...
# Subtest: resolve: plain override beats frontmatter
ok 46 - resolve: plain override beats frontmatter
  ---
  duration_ms: 0.047667
  type: 'test'
  ...
# Subtest: resolve: frontmatter beats defaultModel
ok 47 - resolve: frontmatter beats defaultModel
  ---
  duration_ms: 0.052458
  type: 'test'
  ...
# Subtest: resolve: defaultModel used when frontmatter is absent
ok 48 - resolve: defaultModel used when frontmatter is absent
  ---
  duration_ms: 0.040833
  type: 'test'
  ...
# Subtest: resolve: falls back to the dispatch model
ok 49 - resolve: falls back to the dispatch model
  ---
  duration_ms: 0.088791
  type: 'test'
  ...
# Subtest: resolve: 'inherit' selects the dispatch model explicitly
ok 50 - resolve: 'inherit' selects the dispatch model explicitly
  ---
  duration_ms: 0.040083
  type: 'test'
  ...
# Subtest: resolve: no candidates yields no model
ok 51 - resolve: no candidates yields no model
  ---
  duration_ms: 0.040167
  type: 'test'
  ...
# Subtest: resolve: providerOf extracts the provider half
ok 52 - resolve: providerOf extracts the provider half
  ---
  duration_ms: 0.054875
  type: 'test'
  ...
# Subtest: overrides: scalar fields replace frontmatter values
ok 53 - overrides: scalar fields replace frontmatter values
  ---
  duration_ms: 0.079167
  type: 'test'
  ...
# Subtest: overrides: arrays are copied, not aliased
ok 54 - overrides: arrays are copied, not aliased
  ---
  duration_ms: 0.058
  type: 'test'
  ...
# Subtest: overrides: disabled removes the agent
ok 55 - overrides: disabled removes the agent
  ---
  duration_ms: 0.067584
  type: 'test'
  ...
# Subtest: overrides: unknown agent names are ignored
ok 56 - overrides: unknown agent names are ignored
  ---
  duration_ms: 0.04
  type: 'test'
  ...
# Subtest: overrides: absent overrides returns the same list
ok 57 - overrides: absent overrides returns the same list
  ---
  duration_ms: 0.032875
  type: 'test'
  ...
# Subtest: overrides: applyOverride honours a preset reference
ok 58 - overrides: applyOverride honours a preset reference
  ---
  duration_ms: 0.051459
  type: 'test'
  ...
# Subtest: overrides: applyDefaultModel only fills agents without a model
ok 59 - overrides: applyDefaultModel only fills agents without a model
  ---
  duration_ms: 0.059916
  type: 'test'
  ...
# Subtest: overrides: applyDefaultModel is a no-op without a default
ok 60 - overrides: applyDefaultModel is a no-op without a default
  ---
  duration_ms: 0.035542
  type: 'test'
  ...
# Subtest: overrides: applyDefaultOnBlocked fills unset agents, keeps explicit choices
ok 61 - overrides: applyDefaultOnBlocked fills unset agents, keeps explicit choices
  ---
  duration_ms: 0.069875
  type: 'test'
  ...
# Subtest: settings: absent subagents key yields empty settings
ok 62 - settings: absent subagents key yields empty settings
  ---
  duration_ms: 0.080667
  type: 'test'
  ...
# Subtest: settings: rejects a non-object subagents value
ok 63 - settings: rejects a non-object subagents value
  ---
  duration_ms: 0.06275
  type: 'test'
  ...
# Subtest: settings: rejects an empty defaultModel
ok 64 - settings: rejects an empty defaultModel
  ---
  duration_ms: 0.055333
  type: 'test'
  ...
# Subtest: settings: defaultOnBlocked validates and merges
ok 65 - settings: defaultOnBlocked validates and merges
  ---
  duration_ms: 0.253208
  type: 'test'
  ...
# Subtest: settings: validates herdr numeric fields
ok 66 - settings: validates herdr numeric fields
  ---
  duration_ms: 0.2135
  type: 'test'
  ...
# Subtest: settings: rejects an invalid placement
ok 67 - settings: rejects an invalid placement
  ---
  duration_ms: 0.05
  type: 'test'
  ...
# Subtest: settings: project settings win over user settings
ok 68 - settings: project settings win over user settings
  ---
  duration_ms: 0.046
  type: 'test'
  ...
# Subtest: settings: agentOverrides shallow-merge across scopes
ok 69 - settings: agentOverrides shallow-merge across scopes
  ---
  duration_ms: 0.102291
  type: 'test'
  ...
# Subtest: settings: presets survive parseSubagentSettings (the whitelist)
ok 70 - settings: presets survive parseSubagentSettings (the whitelist)
  ---
  duration_ms: 0.085042
  type: 'test'
  ...
# Subtest: settings: unknown subagents keys ARE silently dropped (whitelist)
ok 71 - settings: unknown subagents keys ARE silently dropped (whitelist)
  ---
  duration_ms: 0.037083
  type: 'test'
  ...
# Subtest: settings: presets shallow-merge across user/project
ok 72 - settings: presets shallow-merge across user/project
  ---
  duration_ms: 0.043958
  type: 'test'
  ...
# Subtest: settings: project without presets keeps the user's presets
ok 73 - settings: project without presets keeps the user's presets
  ---
  duration_ms: 0.036792
  type: 'test'
  ...
# Subtest: settings: loadSubagentSettings tolerates a missing file
ok 74 - settings: loadSubagentSettings tolerates a missing file
  ---
  duration_ms: 0.135084
  type: 'test'
  ...
# Subtest: settings: loadSubagentSettings reports malformed JSON with the path
ok 75 - settings: loadSubagentSettings reports malformed JSON with the path
  ---
  duration_ms: 1.027292
  type: 'test'
  ...
# Subtest: settings: a project file overlays a user profile's agentOverrides
ok 76 - settings: a project file overlays a user profile's agentOverrides
  ---
  duration_ms: 0.80575
  type: 'test'
  ...
# Subtest: glob matching is linear, not exponential, on adversarial patterns
ok 77 - glob matching is linear, not exponential, on adversarial patterns
  ---
  duration_ms: 0.106375
  type: 'test'
  ...
# Subtest: glob semantics: full match, case-insensitive, star spans slashes
ok 78 - glob semantics: full match, case-insensitive, star spans slashes
  ---
  duration_ms: 0.066958
  type: 'test'
  ...
# Subtest: agentOverrides: a non-object value is rejected, not silently ignored
ok 79 - agentOverrides: a non-object value is rejected, not silently ignored
  ---
  duration_ms: 0.13125
  type: 'test'
  ...
# Subtest: agentOverrides: valid object values are accepted
ok 80 - agentOverrides: valid object values are accepted
  ---
  duration_ms: 0.05375
  type: 'test'
  ...
# Subtest: modelCandidates is unique and keeps an empty primary as one attempt
ok 81 - modelCandidates is unique and keeps an empty primary as one attempt
  ---
  duration_ms: 0.074083
  type: 'test'
  ...
# Subtest: settings: joinMode accepts each/smart, rejects anything else
ok 82 - settings: joinMode accepts each/smart, rejects anything else
  ---
  duration_ms: 0.14625
  type: 'test'
  ...
# Subtest: settings: joinFlushMs must be a positive integer
ok 83 - settings: joinFlushMs must be a positive integer
  ---
  duration_ms: 0.093625
  type: 'test'
  ...
# Subtest: settings: join keys default to absent and project overrides user
ok 84 - settings: join keys default to absent and project overrides user
  ---
  duration_ms: 0.052959
  type: 'test'
  ...
# Subtest: frontmatter: no fence yields empty frontmatter
ok 85 - frontmatter: no fence yields empty frontmatter
  ---
  duration_ms: 1.069583
  type: 'test'
  ...
# Subtest: frontmatter: unterminated fence is treated as body
ok 86 - frontmatter: unterminated fence is treated as body
  ---
  duration_ms: 0.072875
  type: 'test'
  ...
# Subtest: frontmatter: simple key/value + body
ok 87 - frontmatter: simple key/value + body
  ---
  duration_ms: 0.246083
  type: 'test'
  ...
# Subtest: frontmatter: quoted values are unquoted
ok 88 - frontmatter: quoted values are unquoted
  ---
  duration_ms: 0.064166
  type: 'test'
  ...
# Subtest: frontmatter: CRLF is normalized
ok 89 - frontmatter: CRLF is normalized
  ---
  duration_ms: 0.069583
  type: 'test'
  ...
# Subtest: frontmatter: literal block scalar preserves newlines
ok 90 - frontmatter: literal block scalar preserves newlines
  ---
  duration_ms: 0.15975
  type: 'test'
  ...
# Subtest: frontmatter: folded block scalar joins lines with spaces
ok 91 - frontmatter: folded block scalar joins lines with spaces
  ---
  duration_ms: 0.123333
  type: 'test'
  ...
# Subtest: frontmatter: block list is preserved for list parsing
ok 92 - frontmatter: block list is preserved for list parsing
  ---
  duration_ms: 4.486625
  type: 'test'
  ...
# Subtest: frontmatter: comments and blank lines are ignored
ok 93 - frontmatter: comments and blank lines are ignored
  ---
  duration_ms: 0.370791
  type: 'test'
  ...
# Subtest: parseFrontmatterList: comma separated
ok 94 - parseFrontmatterList: comma separated
  ---
  duration_ms: 0.351833
  type: 'test'
  ...
# Subtest: parseFrontmatterList: hyphenated values survive
ok 95 - parseFrontmatterList: hyphenated values survive
  ---
  duration_ms: 0.1225
  type: 'test'
  ...
# Subtest: parseFrontmatterList: undefined yields undefined
ok 96 - parseFrontmatterList: undefined yields undefined
  ---
  duration_ms: 0.044625
  type: 'test'
  ...
# Subtest: agent: requires name and description
ok 97 - agent: requires name and description
  ---
  duration_ms: 2.673
  type: 'test'
  ...
# Subtest: agent: defaults match the documented conventions
ok 98 - agent: defaults match the documented conventions
  ---
  duration_ms: 0.22425
  type: 'test'
  ...
# Subtest: agent: invalid kind degrades to pi instead of failing
ok 99 - agent: invalid kind degrades to pi instead of failing
  ---
  duration_ms: 0.455958
  type: 'test'
  ...
# Subtest: agent: valid non-pi kind is honored
ok 100 - agent: valid non-pi kind is honored
  ---
  duration_ms: 0.098625
  type: 'test'
  ...
# Subtest: agent: herdr grok kind is honored rather than coerced to pi
ok 101 - agent: herdr grok kind is honored rather than coerced to pi
  ---
  duration_ms: 0.050833
  type: 'test'
  ...
# Subtest: agent: tools parse from comma string and array spellings
ok 102 - agent: tools parse from comma string and array spellings
  ---
  duration_ms: 0.168625
  type: 'test'
  ...
# Subtest: agent: skills false is distinct from absent
ok 103 - agent: skills false is distinct from absent
  ---
  duration_ms: 0.171167
  type: 'test'
  ...
# Subtest: agent: numeric and boolean fields are coerced
ok 104 - agent: numeric and boolean fields are coerced
  ---
  duration_ms: 0.132125
  type: 'test'
  ...
# Subtest: agent: acceptance JSON is parsed
ok 105 - agent: acceptance JSON is parsed
  ---
  duration_ms: 0.109167
  type: 'test'
  ...
# Subtest: agent: malformed acceptance JSON is ignored, not fatal
ok 106 - agent: malformed acceptance JSON is ignored, not fatal
  ---
  duration_ms: 0.124708
  type: 'test'
  ...
# Subtest: agent: frontmatterFields records provenance
ok 107 - agent: frontmatterFields records provenance
  ---
  duration_ms: 0.06025
  type: 'test'
  ...
# Subtest: agent: frontmatter preset is parsed onto the config
ok 108 - agent: frontmatter preset is parsed onto the config
  ---
  duration_ms: 0.08975
  type: 'test'
  ...
# Subtest: discovery: loadAgentsFromDir skips bad files without throwing
ok 109 - discovery: loadAgentsFromDir skips bad files without throwing
  ---
  duration_ms: 1.394792
  type: 'test'
  ...
# Subtest: discovery: missing directory yields empty list
ok 110 - discovery: missing directory yields empty list
  ---
  duration_ms: 0.060125
  type: 'test'
  ...
# Subtest: discovery: findNearestProjectAgentsDir walks up
ok 111 - discovery: findNearestProjectAgentsDir walks up
  ---
  duration_ms: 1.399042
  type: 'test'
  ...
# Subtest: discovery: returns null when no project dir exists
ok 112 - discovery: returns null when no project dir exists
  ---
  duration_ms: 0.403208
  type: 'test'
  ...
# Subtest: discovery: project overrides user on name collision in 'both'
ok 113 - discovery: project overrides user on name collision in 'both'
  ---
  duration_ms: 1.763167
  type: 'test'
  ...
# Subtest: discovery: scope 'user' excludes project agents
ok 114 - discovery: scope 'user' excludes project agents
  ---
  duration_ms: 1.433541
  type: 'test'
  ...
# Subtest: discovery: scope 'project' excludes user agents
ok 115 - discovery: scope 'project' excludes user agents
  ---
  duration_ms: 1.3435
  type: 'test'
  ...
# Subtest: discovery: bundled roles are present by default
ok 116 - discovery: bundled roles are present by default
  ---
  duration_ms: 1.8645
  type: 'test'
  ...
# Subtest: discovery: includeBuiltin false drops the bundled roles
ok 117 - discovery: includeBuiltin false drops the bundled roles
  ---
  duration_ms: 0.306208
  type: 'test'
  ...
# Subtest: discovery: a user definition overrides a bundled role of the same name
ok 118 - discovery: a user definition overrides a bundled role of the same name
  ---
  duration_ms: 2.702292
  type: 'test'
  ...
# Subtest: discovery: a project definition overrides a bundled role in 'both'
ok 119 - discovery: a project definition overrides a bundled role in 'both'
  ---
  duration_ms: 2.006583
  type: 'test'
  ...
# Subtest: discovery: extra agent dirs load below the user dir in precedence
ok 120 - discovery: extra agent dirs load below the user dir in precedence
  ---
  duration_ms: 1.512042
  type: 'test'
  ...
# Subtest: formerly unenforced fields are now honoured
ok 121 - formerly unenforced fields are now honoured
  ---
  duration_ms: 0.158542
  type: 'test'
  ...
# Subtest: enforced fields are NOT reported as unenforced
ok 122 - enforced fields are NOT reported as unenforced
  ---
  duration_ms: 6.689041
  type: 'test'
  ...
# Subtest: acceptance.criteria is no longer reported unenforced (it is surfaced instead)
ok 123 - acceptance.criteria is no longer reported unenforced (it is surfaced instead)
  ---
  duration_ms: 0.177583
  type: 'test'
  ...
# Subtest: the reviewer role is read-only
ok 124 - the reviewer role is read-only
  ---
  duration_ms: 0.938875
  type: 'test'
  ...
# Subtest: bundled roles do not pin a vendor model
ok 125 - bundled roles do not pin a vendor model
  ---
  duration_ms: 0.654708
  type: 'test'
  ...
# Subtest: every bundled role thinks at max
ok 126 - every bundled role thinks at max
  ---
  duration_ms: 0.600834
  type: 'test'
  ...
# Subtest: formatAgentRoster lists user roles so the parent can pick search without list
ok 127 - formatAgentRoster lists user roles so the parent can pick search without list
  ---
  duration_ms: 0.179292
  type: 'test'
  ...
# Subtest: every bundled role ships a non-empty system prompt
ok 128 - every bundled role ships a non-empty system prompt
  ---
  duration_ms: 0.647666
  type: 'test'
  ...
# Subtest: a bundled role reports no unenforced fields
ok 129 - a bundled role reports no unenforced fields
  ---
  duration_ms: 5.294583
  type: 'test'
  ...
# Subtest: timeoutMs is parsed and is NOT reported as unenforced
ok 130 - timeoutMs is parsed and is NOT reported as unenforced
  ---
  duration_ms: 0.111834
  type: 'test'
  ...
# Subtest: toolTimeoutMs is parsed and is NOT reported as unenforced
ok 131 - toolTimeoutMs is parsed and is NOT reported as unenforced
  ---
  duration_ms: 0.063583
  type: 'test'
  ...
# Subtest: every bundled role declares a timeout budget the runtime honours
ok 132 - every bundled role declares a timeout budget the runtime honours
  ---
  duration_ms: 0.571417
  type: 'test'
  ...
# Subtest: acceptance: a nested YAML block is parsed, not just a JSON string
ok 133 - acceptance: a nested YAML block is parsed, not just a JSON string
  ---
  duration_ms: 0.152875
  type: 'test'
  ...
# Subtest: acceptance: the JSON-string spelling still works
ok 134 - acceptance: the JSON-string spelling still works
  ---
  duration_ms: 0.071667
  type: 'test'
  ...
# Subtest: acceptance: an invalid level is rejected rather than guessed
ok 135 - acceptance: an invalid level is rejected rather than guessed
  ---
  duration_ms: 0.055375
  type: 'test'
  ...
# Subtest: acceptance: criteria missing id or must are dropped
ok 136 - acceptance: criteria missing id or must are dropped
  ---
  duration_ms: 0.081291
  type: 'test'
  ...
# Subtest: acceptance: every bundled role parses its acceptance block
ok 137 - acceptance: every bundled role parses its acceptance block
  ---
  duration_ms: 0.549542
  type: 'test'
  ...
# Subtest: writer roles default to an isolated worktree
ok 138 - writer roles default to an isolated worktree
  ---
  duration_ms: 0.61625
  type: 'test'
  ...
# Subtest: findAgent matches canonical name and alias
ok 139 - findAgent matches canonical name and alias
  ---
  duration_ms: 0.132791
  type: 'test'
  ...
# Subtest: buildPiArgs injects the child-guard extension
ok 140 - buildPiArgs injects the child-guard extension
  ---
  duration_ms: 4.295167
  type: 'test'
  ...
# Subtest: buildPiArgs writes the frozen task appendix
ok 141 - buildPiArgs writes the frozen task appendix
  ---
  duration_ms: 8.997292
  type: 'test'
  ...
# Subtest: buildPiArgs allowNested omits the no-nested-agents constraint
ok 142 - buildPiArgs allowNested omits the no-nested-agents constraint
  ---
  duration_ms: 2.96725
  type: 'test'
  ...
# Subtest: buildPiArgs worktreeBranch lands in the task file
ok 143 - buildPiArgs worktreeBranch lands in the task file
  ---
  duration_ms: 2.987292
  type: 'test'
  ...
# Subtest: formatBlockedPrompt names the child and the reason
ok 144 - formatBlockedPrompt names the child and the reason
  ---
  duration_ms: 0.531
  type: 'test'
  ...
# Subtest: followUpFor: a decision resumes the watch; notify holds the pane
ok 145 - followUpFor: a decision resumes the watch; notify holds the pane
  ---
  duration_ms: 0.087375
  type: 'test'
  ...
# Subtest: forward: parent confirm yes approves the child
ok 146 - forward: parent confirm yes approves the child
  ---
  duration_ms: 0.424458
  type: 'test'
  ...
# Subtest: forward: parent confirm no rejects the child
ok 147 - forward: parent confirm no rejects the child
  ---
  duration_ms: 0.089416
  type: 'test'
  ...
# Subtest: forward without a TUI falls back to notify
ok 148 - forward without a TUI falls back to notify
  ---
  duration_ms: 0.145625
  type: 'test'
  ...
# Subtest: auto-approve skips the parent confirm
ok 149 - auto-approve skips the parent confirm
  ---
  duration_ms: 0.0745
  type: 'test'
  ...
# Subtest: notify only tells the parent; the child stays blocked
ok 150 - notify only tells the parent; the child stays blocked
  ---
  duration_ms: 0.125875
  type: 'test'
  ...
# Subtest: parseBudgetInt accepts 0 and positive integers
ok 151 - parseBudgetInt accepts 0 and positive integers
  ---
  duration_ms: 0.486375
  type: 'test'
  ...
# Subtest: wrapBashWithTimeout prefixes GNU timeout and does not double-wrap
ok 152 - wrapBashWithTimeout prefixes GNU timeout and does not double-wrap
  ---
  duration_ms: 0.1855
  type: 'test'
  ...
# Subtest: budgetExceededReason names the limit
ok 153 - budgetExceededReason names the limit
  ---
  duration_ms: 0.070541
  type: 'test'
  ...
# Subtest: child: herdr agent prompt/wait/send-keys/start are blocked
ok 154 - child: herdr agent prompt/wait/send-keys/start are blocked
  ---
  duration_ms: 0.92575
  type: 'test'
  ...
# Subtest: child: may read its own pane but not another
ok 155 - child: may read its own pane but not another
  ---
  duration_ms: 0.205417
  type: 'test'
  ...
# Subtest: child: pane split / tab create stay blocked
ok 156 - child: pane split / tab create stay blocked
  ---
  duration_ms: 0.127125
  type: 'test'
  ...
# Subtest: child: unknown own pane blocks every pane read
ok 157 - child: unknown own pane blocks every pane read
  ---
  duration_ms: 0.061375
  type: 'test'
  ...
# Subtest: child: herdr --help is blocked without the parent launch playbook
ok 158 - child: herdr --help is blocked without the parent launch playbook
  ---
  duration_ms: 0.189542
  type: 'test'
  ...
# Subtest: child block reasons do not tell the child to call subagent
ok 159 - child block reasons do not tell the child to call subagent
  ---
  duration_ms: 0.575375
  type: 'test'
  ...
# Subtest: formatChildTask appends the frozen constraints
ok 160 - formatChildTask appends the frozen constraints
  ---
  duration_ms: 0.121041
  type: 'test'
  ...
# Subtest: formatChildTask allowNested changes the nested-agents bullet
ok 161 - formatChildTask allowNested changes the nested-agents bullet
  ---
  duration_ms: 0.068792
  type: 'test'
  ...
# Subtest: formatChildTask worktreeBranch tells the child to ship via MR
ok 162 - formatChildTask worktreeBranch tells the child to ship via MR
  ---
  duration_ms: 0.31125
  type: 'test'
  ...
# Subtest: read-only role: writes and herdr prompts are blocked, recon commands pass
ok 163 - read-only role: writes and herdr prompts are blocked, recon commands pass
  ---
  duration_ms: 0.648833
  type: 'test'
  ...
# Subtest: writer role may run npm test
ok 164 - writer role may run npm test
  ---
  duration_ms: 0.117791
  type: 'test'
  ...
# Subtest: child-guard counts every tool call against toolBudget
ok 165 - child-guard counts every tool call against toolBudget
  ---
  duration_ms: 0.208916
  type: 'test'
  ...
# Subtest: child-guard wraps bash with timeout after classifying
ok 166 - child-guard wraps bash with timeout after classifying
  ---
  duration_ms: 0.139459
  type: 'test'
  ...
# Subtest: child-guard turn budget blocks tools after too many turns
ok 167 - child-guard turn budget blocks tools after too many turns
  ---
  duration_ms: 0.060417
  type: 'test'
  ...
# Subtest: read-only role: comparison/arrow operators are not redirects
ok 168 - read-only role: comparison/arrow operators are not redirects
  ---
  duration_ms: 0.097625
  type: 'test'
  ...
# Subtest: read-only role: real redirects are still blocked, including &>file
ok 169 - read-only role: real redirects are still blocked, including &>file
  ---
  duration_ms: 0.039875
  type: 'test'
  ...
# Subtest: child process does not register the subagent tool
ok 170 - child process does not register the subagent tool
  ---
  duration_ms: 0.641542
  type: 'test'
  ...
# Subtest: child bash interceptor blocks herdr agent prompt
ok 171 - child bash interceptor blocks herdr agent prompt
  ---
  duration_ms: 0.462375
  type: 'test'
  ...
# Subtest: nested-allowed child still registers the subagent tool
ok 172 - nested-allowed child still registers the subagent tool
  ---
  duration_ms: 0.733959
  type: 'test'
  ...
# (node:51983) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: findCursorChatDir locates by id and prefers a matching cwd
ok 173 - findCursorChatDir locates by id and prefers a matching cwd
  ---
  duration_ms: 15.565209
  type: 'test'
  ...
# Subtest: parseCursorChat skips injected rows and derives turns atomically
ok 174 - parseCursorChat skips injected rows and derives turns atomically
  ---
  duration_ms: 4.70025
  type: 'test'
  ...
# Subtest: parseCursorChat reports an unanswered turn as unsettled
ok 175 - parseCursorChat reports an unanswered turn as unsettled
  ---
  duration_ms: 6.175542
  type: 'test'
  ...
# Subtest: parseCursorChat refuses a future schemaVersion
ok 176 - parseCursorChat refuses a future schemaVersion
  ---
  duration_ms: 2.358042
  type: 'test'
  ...
# Subtest: parseCursorChat on a missing store is an empty session
ok 177 - parseCursorChat on a missing store is an empty session
  ---
  duration_ms: 0.312542
  type: 'test'
  ...
# Subtest: parseCursorChat on an unopenable store is an empty session
ok 178 - parseCursorChat on an unopenable store is an empty session
  ---
  duration_ms: 0.594208
  type: 'test'
  ...
# Subtest: parseCursorChat on a zero-byte store is an empty session
ok 179 - parseCursorChat on a zero-byte store is an empty session
  ---
  duration_ms: 0.656667
  type: 'test'
  ...
# Subtest: regression: no source file may statically import node:sqlite or bun:sqlite
ok 180 - regression: no source file may statically import node:sqlite or bun:sqlite
  ---
  duration_ms: 4.950417
  type: 'test'
  ...
# (node:51984) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: success JSON on stdout → parsed value
ok 181 - success JSON on stdout → parsed value
  ---
  duration_ms: 1.128791
  type: 'test'
  ...
# Subtest: error JSON on stderr with empty stdout and code 1 → ok:false with the stderr code (F21)
ok 182 - error JSON on stderr with empty stdout and code 1 → ok:false with the stderr code (F21)
  ---
  duration_ms: 0.187667
  type: 'test'
  ...
# Subtest: non-JSON garbage → ok:false with PARSE_ERROR (code 0) or HERDR_ERROR (non-zero)
ok 183 - non-JSON garbage → ok:false with PARSE_ERROR (code 0) or HERDR_ERROR (non-zero)
  ---
  duration_ms: 0.148958
  type: 'test'
  ...
# Subtest: agent_pane_busy error → mapped to PANE_BUSY (F19)
ok 184 - agent_pane_busy error → mapped to PANE_BUSY (F19)
  ---
  duration_ms: 0.059334
  type: 'test'
  ...
# Subtest: agent_name_taken error → mapped to NAME_TAKEN (F16)
ok 185 - agent_name_taken error → mapped to NAME_TAKEN (F16)
  ---
  duration_ms: 0.064041
  type: 'test'
  ...
# Subtest: missing herdr binary (ENOENT) → HERDR_UNAVAILABLE (F22)
ok 186 - missing herdr binary (ENOENT) → HERDR_UNAVAILABLE (F22)
  ---
  duration_ms: 0.0555
  type: 'test'
  ...
# Subtest: makeName lowercases, replaces spaces, appends the index (F17)
ok 187 - makeName lowercases, replaces spaces, appends the index (F17)
  ---
  duration_ms: 0.866958
  type: 'test'
  ...
# Subtest: makeName('9bad', 0) → starts with a letter, ≤32 chars
ok 188 - makeName('9bad', 0) → starts with a letter, ≤32 chars
  ---
  duration_ms: 0.326125
  type: 'test'
  ...
# Subtest: makeName with a 50-char input → ≤32 chars and still valid
ok 189 - makeName with a 50-char input → ≤32 chars and still valid
  ---
  duration_ms: 0.366459
  type: 'test'
  ...
# Subtest: isSafeNestedPathId rejects traversal and absolute paths
ok 190 - isSafeNestedPathId rejects traversal and absolute paths
  ---
  duration_ms: 5.465666
  type: 'test'
  ...
# Subtest: sanitizeNestedPath truncates to 4 entries
ok 191 - sanitizeNestedPath truncates to 4 entries
  ---
  duration_ms: 1.167375
  type: 'test'
  ...
# Subtest: sanitizeNestedPath drops junk entries, keeps good ones
ok 192 - sanitizeNestedPath drops junk entries, keeps good ones
  ---
  duration_ms: 0.126708
  type: 'test'
  ...
# Subtest: agentStart returns the session path for pi kind (F1)
ok 193 - agentStart returns the session path for pi kind (F1)
  ---
  duration_ms: 1.030542
  type: 'test'
  ...
# Subtest: agentStart reports NO session path for non-pi kinds (F7)
ok 194 - agentStart reports NO session path for non-pi kinds (F7)
  ---
  duration_ms: 2.824417
  type: 'test'
  ...
# Subtest: agentStart reports NO agent_session for other non-pi kinds (F7)
ok 195 - agentStart reports NO agent_session for other non-pi kinds (F7)
  ---
  duration_ms: 0.258708
  type: 'test'
  ...
# Subtest: agent_pane_busy race after split, retry succeeds (F19/F20)
ok 196 - agent_pane_busy race after split, retry succeeds (F19/F20)
  ---
  duration_ms: 0.395709
  type: 'test'
  ...
# Subtest: reusing a live name → agent_name_taken; freed after exit (F16)
ok 197 - reusing a live name → agent_name_taken; freed after exit (F16)
  ---
  duration_ms: 0.73825
  type: 'test'
  ...
# Subtest: ctrl+d exits the agent but ctrl+c does NOT (F11)
ok 198 - ctrl+d exits the agent but ctrl+c does NOT (F11)
  ---
  duration_ms: 0.302917
  type: 'test'
  ...
# Subtest: missing herdr binary surfaces as a start timeout, not a clear error (F22)
ok 199 - missing herdr binary surfaces as a start timeout, not a clear error (F22)
  ---
  duration_ms: 0.102625
  type: 'test'
  ...
# Subtest: start timeout maps to START_TIMEOUT (F22 family)
ok 200 - start timeout maps to START_TIMEOUT (F22 family)
  ---
  duration_ms: 0.045958
  type: 'test'
  ...
# Subtest: agentGet → session info; agentList → arrays
ok 201 - agentGet → session info; agentList → arrays
  ---
  duration_ms: 0.256958
  type: 'test'
  ...
# Subtest: agentGet on an unknown agent → NOT_FOUND (F21 shape: stderr, empty stdout)
ok 202 - agentGet on an unknown agent → NOT_FOUND (F21 shape: stderr, empty stdout)
  ---
  duration_ms: 0.186333
  type: 'test'
  ...
# Subtest: paneRead returns plain text, not JSON (F6)
ok 203 - paneRead returns plain text, not JSON (F6)
  ---
  duration_ms: 0.163375
  type: 'test'
  ...
# Subtest: tabCreate / tabList / tabClose round trip; tab close kills agents atomically (F15)
ok 204 - tabCreate / tabList / tabClose round trip; tab close kills agents atomically (F15)
  ---
  duration_ms: 0.309167
  type: 'test'
  ...
# Subtest: agentStart forwards extra args and timeout
ok 205 - agentStart forwards extra args and timeout
  ---
  duration_ms: 0.148125
  type: 'test'
  ...
# Subtest: client.available() is true against the fake, false for a missing binary
ok 206 - client.available() is true against the fake, false for a missing binary
  ---
  duration_ms: 0.138625
  type: 'test'
  ...
# Subtest: createCommandRunner: resolveHerdrBin honours HERDR_BIN env
ok 207 - createCommandRunner: resolveHerdrBin honours HERDR_BIN env
  ---
  duration_ms: 0.086083
  type: 'test'
  ...
# Subtest: tabCreate with workspaceId records --workspace then that Space id in argv
ok 208 - tabCreate with workspaceId records --workspace then that Space id in argv
  ---
  duration_ms: 0.673458
  type: 'test'
  ...
# Subtest: tabCreate without workspaceId does not add --workspace
ok 209 - tabCreate without workspaceId does not add --workspace
  ---
  duration_ms: 0.206917
  type: 'test'
  ...
# Subtest: tabCreate with workspaceId yields tab and root pane in that workspace
ok 210 - tabCreate with workspaceId yields tab and root pane in that workspace
  ---
  duration_ms: 0.160042
  type: 'test'
  ...
# Subtest: fake tab create without --workspace uses focusedWorkspaceId
ok 211 - fake tab create without --workspace uses focusedWorkspaceId
  ---
  duration_ms: 0.144958
  type: 'test'
  ...
# Subtest: fake tab create --workspace pins the tab to that Space not the focused one
ok 212 - fake tab create --workspace pins the tab to that Space not the focused one
  ---
  duration_ms: 0.118584
  type: 'test'
  ...
# Subtest: tabList(workspaceId) does not return a tab from another Space
ok 213 - tabList(workspaceId) does not return a tab from another Space
  ---
  duration_ms: 0.320291
  type: 'test'
  ...
# Subtest: join: default config is smart with a 10s window (constructor-only)
ok 214 - join: default config is smart with a 10s window (constructor-only)
  ---
  duration_ms: 0.77625
  type: 'test'
  ...
# Subtest: join: each mode delivers immediately, one notice per child
ok 215 - join: each mode delivers immediately, one notice per child
  ---
  duration_ms: 0.146584
  type: 'test'
  ...
# Subtest: join: all members terminal → one immediate grouped flush
ok 216 - join: all members terminal → one immediate grouped flush
  ---
  duration_ms: 0.466
  type: 'test'
  ...
# Subtest: join: window expiry with stragglers flushes only the finished ones
ok 217 - join: window expiry with stragglers flushes only the finished ones
  ---
  duration_ms: 0.152709
  type: 'test'
  ...
# Subtest: join: a busy parent extends the window at most MAX_BUSY_EXTENSIONS times
ok 218 - join: a busy parent extends the window at most MAX_BUSY_EXTENSIONS times
  ---
  duration_ms: 0.194
  type: 'test'
  ...
# Subtest: join: an idle parent flushes at the first window expiry
ok 219 - join: an idle parent flushes at the first window expiry
  ---
  duration_ms: 0.080208
  type: 'test'
  ...
# Subtest: join: remove() drops a member so the group can settle without it
ok 220 - join: remove() drops a member so the group can settle without it
  ---
  duration_ms: 0.147292
  type: 'test'
  ...
# Subtest: join: failed entries keep their failed status in the batch
ok 221 - join: failed entries keep their failed status in the batch
  ---
  duration_ms: 0.079625
  type: 'test'
  ...
# Subtest: join: onTerminal without tracking delivers directly instead of dropping
ok 222 - join: onTerminal without tracking delivers directly instead of dropping
  ---
  duration_ms: 4.032375
  type: 'test'
  ...
# Subtest: join: dispose cancels timers and swallows nothing
ok 223 - join: dispose cancels timers and swallows nothing
  ---
  duration_ms: 0.437458
  type: 'test'
  ...
# Subtest: join: two runs batch independently
ok 224 - join: two runs batch independently
  ---
  duration_ms: 0.152583
  type: 'test'
  ...
# Subtest: U4: onTerminal fails loud on a running entry instead of buffering a lie
ok 225 - U4: onTerminal fails loud on a running entry instead of buffering a lie
  ---
  duration_ms: 0.23475
  type: 'test'
  ...
# Subtest: U4: a running entry mixed into a batch is refused, not merged
ok 226 - U4: a running entry mixed into a batch is refused, not merged
  ---
  duration_ms: 0.062291
  type: 'test'
  ...
# Subtest: cursorModel keeps legacy Auto distinct from Auto Balance
ok 227 - cursorModel keeps legacy Auto distinct from Auto Balance
  ---
  duration_ms: 0.9175
  type: 'test'
  ...
# Subtest: cursorModel maps grok-4.6 plus thinking onto the CLI slug
ok 228 - cursorModel maps grok-4.6 plus thinking onto the CLI slug
  ---
  duration_ms: 0.261
  type: 'test'
  ...
# Subtest: cursorModel maps bare grok onto version-correct CLI slugs
ok 229 - cursorModel maps bare grok onto version-correct CLI slugs
  ---
  duration_ms: 0.06875
  type: 'test'
  ...
# Subtest: cursorModel repairs a wrongly-prefixed grok-4.7 slug
ok 230 - cursorModel repairs a wrongly-prefixed grok-4.7 slug
  ---
  duration_ms: 0.18075
  type: 'test'
  ...
# Subtest: cursorModel expands pi-cursor-sdk context aliases to the bracket form
ok 231 - cursorModel expands pi-cursor-sdk context aliases to the bracket form
  ---
  duration_ms: 0.15775
  type: 'test'
  ...
# Subtest: cursorModel maps thinking=false to the lowest effort in every branch
ok 232 - cursorModel maps thinking=false to the lowest effort in every branch
  ---
  duration_ms: 0.068334
  type: 'test'
  ...
# Subtest: cursorModel passes an unknown :level-suffixed slug through unchanged
ok 233 - cursorModel passes an unknown :level-suffixed slug through unchanged
  ---
  duration_ms: 0.810083
  type: 'test'
  ...
# Subtest: cursorModel leaves explicit bracket forms untouched
ok 234 - cursorModel leaves explicit bracket forms untouched
  ---
  duration_ms: 0.063917
  type: 'test'
  ...
# Subtest: nativeModelFor drops inherited pi ids for non-pi kinds
ok 235 - nativeModelFor drops inherited pi ids for non-pi kinds
  ---
  duration_ms: 0.355292
  type: 'test'
  ...
# Subtest: isPiShapedModel accepts provider/id(:level) and rejects CLIs' bare slugs
ok 236 - isPiShapedModel accepts provider/id(:level) and rejects CLIs' bare slugs
  ---
  duration_ms: 0.330625
  type: 'test'
  ...
# Subtest: applyThinkingSuffix appends :level for pi and drops it for false
ok 237 - applyThinkingSuffix appends :level for pi and drops it for false
  ---
  duration_ms: 0.11025
  type: 'test'
  ...
# Subtest: kind/model coherence guard: cursor + pi-shaped model throws, pi accepts
ok 238 - kind/model coherence guard: cursor + pi-shaped model throws, pi accepts
  ---
  duration_ms: 0.283667
  type: 'test'
  ...
# Subtest: planKindStart: every kind omits the task from start argv
ok 239 - planKindStart: every kind omits the task from start argv
  ---
  duration_ms: 1.212125
  type: 'test'
  ...
# Subtest: planKindStart: cursor starts --force unless the agent opts into a human gate
ok 240 - planKindStart: cursor starts --force unless the agent opts into a human gate
  ---
  duration_ms: 0.609625
  type: 'test'
  ...
# Subtest: typeTabLabel is parent-scoped so two Pis in one Space do not share a tab
ok 241 - typeTabLabel is parent-scoped so two Pis in one Space do not share a tab
  ---
  duration_ms: 0.668667
  type: 'test'
  ...
# Subtest: tileSplit is a 3-column grid: fill a row, then wrap down
ok 242 - tileSplit is a 3-column grid: fill a row, then wrap down
  ---
  duration_ms: 0.46275
  type: 'test'
  ...
# Subtest: claimName reserves names so two callers cannot both take scout-0
ok 243 - claimName reserves names so two callers cannot both take scout-0
  ---
  duration_ms: 0.26
  type: 'test'
  ...
# Subtest: liveNames unions claimed names with the fetched list
ok 244 - liveNames unions claimed names with the fetched list
  ---
  duration_ms: 0.139917
  type: 'test'
  ...
# Subtest: liveNames coalesces concurrent fetches
ok 245 - liveNames coalesces concurrent fetches
  ---
  duration_ms: 0.182541
  type: 'test'
  ...
# Subtest: acquireTypeTab serializes creators of the same type
ok 246 - acquireTypeTab serializes creators of the same type
  ---
  duration_ms: 1.522666
  type: 'test'
  ...
# Subtest: acquireTypeTab retries after the first creator fails
ok 247 - acquireTypeTab retries after the first creator fails
  ---
  duration_ms: 0.425333
  type: 'test'
  ...
# Subtest: assignPane serializes two racing splits of the same type
ok 248 - assignPane serializes two racing splits of the same type
  ---
  duration_ms: 0.150375
  type: 'test'
  ...
# Subtest: releasePane drops the type tab when the last pane is gone
ok 249 - releasePane drops the type tab when the last pane is gone
  ---
  duration_ms: 0.570125
  type: 'test'
  ...
# Subtest: renderer: collapsed success is one compact row
ok 250 - renderer: collapsed success is one compact row
  ---
  duration_ms: 16.184084
  type: 'test'
  ...
# Subtest: renderer: collapsed success stays one row at hostile widths
ok 251 - renderer: collapsed success stays one row at hostile widths
  ---
  duration_ms: 0.708333
  type: 'test'
  ...
# Subtest: renderer: hostile names render as one row without escapes
ok 252 - renderer: hostile names render as one row without escapes
  ---
  duration_ms: 0.239166
  type: 'test'
  ...
# Subtest: renderer: expanded success falls back to the default Markdown block
ok 253 - renderer: expanded success falls back to the default Markdown block
  ---
  duration_ms: 0.058042
  type: 'test'
  ...
# Subtest: renderer: failures and stops always use the full default block
ok 254 - renderer: failures and stops always use the full default block
  ---
  duration_ms: 0.147667
  type: 'test'
  ...
# Subtest: renderer: notices without details (old sessions) fall back
ok 255 - renderer: notices without details (old sessions) fall back
  ---
  duration_ms: 0.054
  type: 'test'
  ...
# Subtest: renderer: details round-trips through JSON and still collapses
ok 256 - renderer: details round-trips through JSON and still collapses
  ---
  duration_ms: 0.20325
  type: 'test'
  ...
# Subtest: completionStatusOf: success is completed, abort is stopped, else failed
ok 257 - completionStatusOf: success is completed, abort is stopped, else failed
  ---
  duration_ms: 7.189292
  type: 'test'
  ...
# Subtest: formatCompletionNotice: success is displayed and carries renderer details
ok 258 - formatCompletionNotice: success is displayed and carries renderer details
  ---
  duration_ms: 0.254417
  type: 'test'
  ...
# Subtest: formatCompletionNotice: failure is displayed
ok 259 - formatCompletionNotice: failure is displayed
  ---
  duration_ms: 0.082166
  type: 'test'
  ...
# Subtest: formatCompletionNotice: aborted maps to stopped and is displayed
ok 260 - formatCompletionNotice: aborted maps to stopped and is displayed
  ---
  duration_ms: 0.064791
  type: 'test'
  ...
# Subtest: formatNoticeHeadline: one line with glyph, verdict and size
ok 261 - formatNoticeHeadline: one line with glyph, verdict and size
  ---
  duration_ms: 0.228291
  type: 'test'
  ...
# Subtest: formatNoticeHeadline: hostile fields cannot break the one-line contract
ok 262 - formatNoticeHeadline: hostile fields cannot break the one-line contract
  ---
  duration_ms: 0.090167
  type: 'test'
  ...
# Subtest: sanitizeNoticeField strips control characters only
ok 263 - sanitizeNoticeField strips control characters only
  ---
  duration_ms: 0.5955
  type: 'test'
  ...
# Subtest: formatCompletionNotice: details survive a JSON round-trip (session reload)
ok 264 - formatCompletionNotice: details survive a JSON round-trip (session reload)
  ---
  duration_ms: 1.003292
  type: 'test'
  ...
# Subtest: formatCollectFailure wraps an exception as a failed notice
ok 265 - formatCollectFailure wraps an exception as a failed notice
  ---
  duration_ms: 0.391375
  type: 'test'
  ...
# Subtest: completionDeliveryOptions follows up instead of steering
ok 266 - completionDeliveryOptions follows up instead of steering
  ---
  duration_ms: 0.695125
  type: 'test'
  ...
# Subtest: previewOutput truncates long text
ok 267 - previewOutput truncates long text
  ---
  duration_ms: 0.151458
  type: 'test'
  ...
# Subtest: deliverCompletion sends subagent-notify with followUp wakeup
ok 268 - deliverCompletion sends subagent-notify with followUp wakeup
  ---
  duration_ms: 0.106208
  type: 'test'
  ...
# Subtest: deliverCompletion returns false when sendMessage throws
ok 269 - deliverCompletion returns false when sendMessage throws
  ---
  duration_ms: 0.066042
  type: 'test'
  ...
# Subtest: U3: completionStatusOf reports `running` as itself (never folded into failed)
ok 270 - U3: completionStatusOf reports `running` as itself (never folded into failed)
  ---
  duration_ms: 0.035666
  type: 'test'
  ...
# Subtest: U3: formatCompletionNotice fails loud on a running snapshot (B)
ok 271 - U3: formatCompletionNotice fails loud on a running snapshot (B)
  ---
  duration_ms: 0.184042
  type: 'test'
  ...
# Subtest: U3: a running snapshot never surfaces as a failed notice by accident (B regression)
ok 272 - U3: a running snapshot never surfaces as a failed notice by accident (B regression)
  ---
  duration_ms: 0.073334
  type: 'test'
  ...
# Subtest: completionStatusOf: unknown with a parsed verdict is completed, not failed
ok 273 - completionStatusOf: unknown with a parsed verdict is completed, not failed
  ---
  duration_ms: 0.034125
  type: 'test'
  ...
# Subtest: formatCompletionNotice: settled cursor answer reports completed with its verdict
ok 274 - formatCompletionNotice: settled cursor answer reports completed with its verdict
  ---
  duration_ms: 0.056583
  type: 'test'
  ...
# Subtest: formatGroupedNotice: multiple entries merge into one notice with a header
ok 275 - formatGroupedNotice: multiple entries merge into one notice with a header
  ---
  duration_ms: 0.154
  type: 'test'
  ...
# Subtest: formatGroupedNotice: recycle markers are per-entry, not a blanket footer
ok 276 - formatGroupedNotice: recycle markers are per-entry, not a blanket footer
  ---
  duration_ms: 0.095209
  type: 'test'
  ...
# Subtest: formatGroupedNotice: any failed → failed aggregate and display
ok 277 - formatGroupedNotice: any failed → failed aggregate and display
  ---
  duration_ms: 0.055875
  type: 'test'
  ...
# Subtest: formatGroupedNotice: no runId omits the run header; stillRunning line appended
ok 278 - formatGroupedNotice: no runId omits the run header; stillRunning line appended
  ---
  duration_ms: 0.07025
  type: 'test'
  ...
# Subtest: formatGroupedNotice: a single entry still uses the grouped shape
ok 279 - formatGroupedNotice: a single entry still uses the grouped shape
  ---
  duration_ms: 0.121167
  type: 'test'
  ...
# Subtest: formatGroupedNotice: per-entry previews are capped so the batch stays bounded
ok 280 - formatGroupedNotice: per-entry previews are capped so the batch stays bounded
  ---
  duration_ms: 0.08
  type: 'test'
  ...
# Subtest: parent-label: no pane id means no-op
ok 281 - parent-label: no pane id means no-op
  ---
  duration_ms: 0.717958
  type: 'test'
  ...
# Subtest: parent-label: reports idle state-label with TTL and source
ok 282 - parent-label: reports idle state-label with TTL and source
  ---
  duration_ms: 2.376792
  type: 'test'
  ...
# Subtest: parent-label: skips an unchanged label inside the dedupe window
ok 283 - parent-label: skips an unchanged label inside the dedupe window
  ---
  duration_ms: 16.45425
  type: 'test'
  ...
# Subtest: parent-label: a changed label reports immediately
ok 284 - parent-label: a changed label reports immediately
  ---
  duration_ms: 4.280625
  type: 'test'
  ...
# Subtest: parent-label: clear sends clear-state-labels and resets dedupe
ok 285 - parent-label: clear sends clear-state-labels and resets dedupe
  ---
  duration_ms: 8.118125
  type: 'test'
  ...
# Subtest: parent-label: report(undefined) clears via the busy hook path
ok 286 - parent-label: report(undefined) clears via the busy hook path
  ---
  duration_ms: 3.64075
  type: 'test'
  ...
# Subtest: parent-label: a failed report is retried on the next tick
ok 287 - parent-label: a failed report is retried on the next tick
  ---
  duration_ms: 6.266167
  type: 'test'
  ...
# Subtest: parent-label: concurrent reports coalesce (in-flight guard)
ok 288 - parent-label: concurrent reports coalesce (in-flight guard)
  ---
  duration_ms: 21.706375
  type: 'test'
  ...
# Subtest: plan: exactly one request shape must be provided
ok 289 - plan: exactly one request shape must be provided
  ---
  duration_ms: 0.691083
  type: 'test'
  ...
# Subtest: plan: a single agent+task is accepted
ok 290 - plan: a single agent+task is accepted
  ---
  duration_ms: 0.429667
  type: 'test'
  ...
# Subtest: plan: a single request with a blank task is refused
ok 291 - plan: a single request with a blank task is refused
  ---
  duration_ms: 0.084958
  type: 'test'
  ...
# Subtest: plan: tasks[] entries are validated
ok 292 - plan: tasks[] entries are validated
  ---
  duration_ms: 0.119792
  type: 'test'
  ...
# Subtest: plan: tasks[] preserves a per-child worktree flag
ok 293 - plan: tasks[] preserves a per-child worktree flag
  ---
  duration_ms: 0.1325
  type: 'test'
  ...
# Subtest: plan: chain[] entries are validated
ok 294 - plan: chain[] entries are validated
  ---
  duration_ms: 0.075625
  type: 'test'
  ...
# Subtest: plan: chain substitutes {previous} in every step after the first
ok 295 - plan: chain substitutes {previous} in every step after the first
  ---
  duration_ms: 0.147291
  type: 'test'
  ...
# Subtest: plan: the unknown-agent refusal is a single, complete line
ok 296 - plan: the unknown-agent refusal is a single, complete line
  ---
  duration_ms: 0.078959
  type: 'test'
  ...
# Subtest: plan: the unknown-agent refusal says "none" when no agent is known
ok 297 - plan: the unknown-agent refusal says "none" when no agent is known
  ---
  duration_ms: 0.284583
  type: 'test'
  ...
# Subtest: playbook text is the frozen launch recipe
ok 298 - playbook text is the frozen launch recipe
  ---
  duration_ms: 0.568125
  type: 'test'
  ...
# Subtest: shellChunks splits compound commands
ok 299 - shellChunks splits compound commands
  ---
  duration_ms: 0.486375
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: the herdr skill discovery ritual
ok 300 - forbiddenDispatchReason: the herdr skill discovery ritual
  ---
  duration_ms: 0.359334
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: the old dispatch ritual
ok 301 - forbiddenDispatchReason: the old dispatch ritual
  ---
  duration_ms: 0.16175
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: HERDR_ENV prelude
ok 302 - forbiddenDispatchReason: HERDR_ENV prelude
  ---
  duration_ms: 0.127834
  type: 'test'
  ...
# Subtest: forbiddenDispatchReason: inspection commands stay allowed
ok 303 - forbiddenDispatchReason: inspection commands stay allowed
  ---
  duration_ms: 0.128417
  type: 'test'
  ...
# Subtest: playbook explains merged completion notices and the wait action
ok 304 - playbook explains merged completion notices and the wait action
  ---
  duration_ms: 0.1435
  type: 'test'
  ...
# Subtest: U8: playbook explains that a collect timeout notice is a progress signal
ok 305 - U8: playbook explains that a collect timeout notice is a progress signal
  ---
  duration_ms: 0.062583
  type: 'test'
  ...
# Subtest: BUG P1: an undefined preset must not abort the whole tasks[] batch
ok 306 - BUG P1: an undefined preset must not abort the whole tasks[] batch
  ---
  duration_ms: 5576.928667
  type: 'test'
  ...
# Subtest: BUG P1: the healthy sibling actually LAUNCHES despite the bad preset
ok 307 - BUG P1: the healthy sibling actually LAUNCHES despite the bad preset
  ---
  duration_ms: 5317.719
  type: 'test'
  ...
# Subtest: BUG P1: the refusal names the presets that ARE defined
ok 308 - BUG P1: the refusal names the presets that ARE defined
  ---
  duration_ms: 228.04325
  type: 'test'
  ...
# Subtest: launch: a defined preset's model reaches the herdr argv
ok 309 - launch: a defined preset's model reaches the herdr argv
  ---
  duration_ms: 5135.365334
  type: 'test'
  ...
# Subtest: launch: a preset beats a folded agentOverrides model, end to end
ok 310 - launch: a preset beats a folded agentOverrides model, end to end
  ---
  duration_ms: 5500.146584
  type: 'test'
  ...
# Subtest: launch: the tool `preset` param selects a different preset
ok 311 - launch: the tool `preset` param selects a different preset
  ---
  duration_ms: 5174.509084
  type: 'test'
  ...
# Subtest: e2e: an inherited parent model is dropped and reported, not refused
ok 312 - e2e: an inherited parent model is dropped and reported, not refused
  ---
  duration_ms: 2840.323875
  type: 'test'
  ...
# Subtest: e2e: an explicit model the kind cannot express is refused, launching nothing
ok 313 - e2e: an explicit model the kind cannot express is refused, launching nothing
  ---
  duration_ms: 265.7715
  type: 'test'
  ...
# Subtest: presets: absent key yields undefined, not an error
ok 314 - presets: absent key yields undefined, not an error
  ---
  duration_ms: 0.650792
  type: 'test'
  ...
# Subtest: presets: rejects a non-object presets value
ok 315 - presets: rejects a non-object presets value
  ---
  duration_ms: 0.2345
  type: 'test'
  ...
# Subtest: presets: rejects a non-object preset entry
ok 316 - presets: rejects a non-object preset entry
  ---
  duration_ms: 0.103791
  type: 'test'
  ...
# Subtest: presets: rejects an unknown kind
ok 317 - presets: rejects an unknown kind
  ---
  duration_ms: 0.0705
  type: 'test'
  ...
# Subtest: presets: rejects an empty model and a non-string thinking
ok 318 - presets: rejects an empty model and a non-string thinking
  ---
  duration_ms: 0.183458
  type: 'test'
  ...
# Subtest: presets: accepts a full and a partial preset; thinking: false is kept
ok 319 - presets: accepts a full and a partial preset; thinking: false is kept
  ---
  duration_ms: 0.370916
  type: 'test'
  ...
# Subtest: presets: tool param wins over the agent's own preset
ok 320 - presets: tool param wins over the agent's own preset
  ---
  duration_ms: 0.133667
  type: 'test'
  ...
# Subtest: presets: falls back to the agent's preset; absent means undefined
ok 321 - presets: falls back to the agent's preset; absent means undefined
  ---
  duration_ms: 0.054625
  type: 'test'
  ...
# Subtest: presets: a blank tool param is ignored, not treated as a name
ok 322 - presets: a blank tool param is ignored, not treated as a name
  ---
  duration_ms: 0.273042
  type: 'test'
  ...
# Subtest: presets: requirePreset returns the entry when defined
ok 323 - presets: requirePreset returns the entry when defined
  ---
  duration_ms: 0.336042
  type: 'test'
  ...
# Subtest: presets: requirePreset error names the defined presets
ok 324 - presets: requirePreset error names the defined presets
  ---
  duration_ms: 0.160541
  type: 'test'
  ...
# Subtest: presets: requirePreset says 'None are defined' for an empty/absent map
ok 325 - presets: requirePreset says 'None are defined' for an empty/absent map
  ---
  duration_ms: 0.070375
  type: 'test'
  ...
# Subtest: presets: coherence guard rejects a pi-shaped model on cursor
ok 326 - presets: coherence guard rejects a pi-shaped model on cursor
  ---
  duration_ms: 0.202083
  type: 'test'
  ...
# Subtest: presets: coherence guard accepts a pi-shaped model on pi
ok 327 - presets: coherence guard accepts a pi-shaped model on pi
  ---
  duration_ms: 0.078
  type: 'test'
  ...
# Subtest: presets: coherence guard accepts a cursor slug on cursor and no model
ok 328 - presets: coherence guard accepts a cursor slug on cursor and no model
  ---
  duration_ms: 0.151
  type: 'test'
  ...
# Subtest: presets: the guard reports where the model came from
ok 329 - presets: the guard reports where the model came from
  ---
  duration_ms: 0.061208
  type: 'test'
  ...
# Subtest: presets: applyPreset replaces kind/model/thinking atomically
ok 330 - presets: applyPreset replaces kind/model/thinking atomically
  ---
  duration_ms: 0.060709
  type: 'test'
  ...
# Subtest: presets: applyPreset records provenance and copies the agent
ok 331 - presets: applyPreset records provenance and copies the agent
  ---
  duration_ms: 0.04375
  type: 'test'
  ...
# Subtest: presets: applyPreset keeps untouched fields; thinking: false disables
ok 332 - presets: applyPreset keeps untouched fields; thinking: false disables
  ---
  duration_ms: 0.037417
  type: 'test'
  ...
# Subtest: every bundled role is assigned a cheap/medium/strong tier
ok 333 - every bundled role is assigned a cheap/medium/strong tier
  ---
  duration_ms: 0.990708
  type: 'test'
  ...
# Subtest: name heuristics: flash/haiku/sonnet/opus bands
ok 334 - name heuristics: flash/haiku/sonnet/opus bands
  ---
  duration_ms: 0.234792
  type: 'test'
  ...
# Subtest: classify: flash is cheap, opus is strong
ok 335 - classify: flash is cheap, opus is strong
  ---
  duration_ms: 0.45225
  type: 'test'
  ...
# Subtest: classify: official cost metadata is recorded as a source
ok 336 - classify: official cost metadata is recorded as a source
  ---
  duration_ms: 0.113
  type: 'test'
  ...
# Subtest: pickTierModels: quota sits lower than quality
ok 337 - pickTierModels: quota sits lower than quality
  ---
  duration_ms: 0.206625
  type: 'test'
  ...
# Subtest: pickTierModels: a single model fills every tier
ok 338 - pickTierModels: a single model fills every tier
  ---
  duration_ms: 0.064708
  type: 'test'
  ...
# Subtest: filterDominatedModels: cheaper equal-or-better model wins
ok 339 - filterDominatedModels: cheaper equal-or-better model wins
  ---
  duration_ms: 0.187334
  type: 'test'
  ...
# Subtest: buildProfileFile maps our five roles onto the three tiers
ok 340 - buildProfileFile maps our five roles onto the three tiers
  ---
  duration_ms: 0.104334
  type: 'test'
  ...
# Subtest: normalizePathToken rejects traversal and empty names
ok 341 - normalizePathToken rejects traversal and empty names
  ---
  duration_ms: 0.426333
  type: 'test'
  ...
# Subtest: applySubagentProfile writes agentOverrides and keeps other settings
ok 342 - applySubagentProfile writes agentOverrides and keeps other settings
  ---
  duration_ms: 2.419916
  type: 'test'
  ...
# Subtest: readSubagentProfile reports malformed JSON with its file path
ok 343 - readSubagentProfile reports malformed JSON with its file path
  ---
  duration_ms: 1.304917
  type: 'test'
  ...
# Subtest: list/read profiles ignore the providers subdirectory
ok 344 - list/read profiles ignore the providers subdirectory
  ---
  duration_ms: 1.319375
  type: 'test'
  ...
# Subtest: validateSubagentProfile rejects a missing agentOverrides object
ok 345 - validateSubagentProfile rejects a missing agentOverrides object
  ---
  duration_ms: 0.097917
  type: 'test'
  ...
# Subtest: generateProfilesForProvider writes quota and quality files
ok 346 - generateProfilesForProvider writes quota and quality files
  ---
  duration_ms: 3.767083
  type: 'test'
  ...
# Subtest: refresh reuses a fresh catalog and refreshes a stale one
ok 347 - refresh reuses a fresh catalog and refreshes a stale one
  ---
  duration_ms: 1.578166
  type: 'test'
  ...
# Subtest: checkSubagentProfile reports registry hits without probing
ok 348 - checkSubagentProfile reports registry hits without probing
  ---
  duration_ms: 3.520541
  type: 'test'
  ...
# Subtest: refresh reports unknown providers clearly
ok 349 - refresh reports unknown providers clearly
  ---
  duration_ms: 1.236417
  type: 'test'
  ...
# Subtest: slash arg parsing: required name, force, no-probe
ok 350 - slash arg parsing: required name, force, no-probe
  ---
  duration_ms: 0.898333
  type: 'test'
  ...
# Subtest: getAgentDir honours PI_CODING_AGENT_DIR
ok 351 - getAgentDir honours PI_CODING_AGENT_DIR
  ---
  duration_ms: 0.122
  type: 'test'
  ...
# Subtest: progressFromSession: model_change is enough before any assistant message
ok 352 - progressFromSession: model_change is enough before any assistant message
  ---
  duration_ms: 0.95425
  type: 'test'
  ...
# Subtest: progressFromSession: turns and in-flight tools come from the last assistant
ok 353 - progressFromSession: turns and in-flight tools come from the last assistant
  ---
  duration_ms: 0.343083
  type: 'test'
  ...
# Subtest: progressFromSession: a finished text turn does not keep stale tools
ok 354 - progressFromSession: a finished text turn does not keep stale tools
  ---
  duration_ms: 0.187209
  type: 'test'
  ...
# Subtest: progressFromAgentInfo: aligns cursor-like labels/tokens onto the pi fields
ok 355 - progressFromAgentInfo: aligns cursor-like labels/tokens onto the pi fields
  ---
  duration_ms: 1.733875
  type: 'test'
  ...
# Subtest: progressFromAgentInfo: ignores usage-shaped tokens and finds a model-like label
ok 356 - progressFromAgentInfo: ignores usage-shaped tokens and finds a model-like label
  ---
  duration_ms: 0.431542
  type: 'test'
  ...
# Subtest: progressFromPaneInfo: pulls a provider/id out of the terminal title
ok 357 - progressFromPaneInfo: pulls a provider/id out of the terminal title
  ---
  duration_ms: 0.157625
  type: 'test'
  ...
# Subtest: mergeProgress: later sources win, empty parts do not clobber
ok 358 - mergeProgress: later sources win, empty parts do not clobber
  ---
  duration_ms: 0.157417
  type: 'test'
  ...
# Subtest: formatAlreadyRecycled is a no-op explanation, not a new close
ok 359 - formatAlreadyRecycled is a no-op explanation, not a new close
  ---
  duration_ms: 2.341333
  type: 'test'
  ...
# Subtest: canUseCachedCollect is true after collect, not while the child is working
ok 360 - canUseCachedCollect is true after collect, not while the child is working
  ---
  duration_ms: 0.104541
  type: 'test'
  ...
# Subtest: runtime: async watch notifies the parent once and drops the widget entry
ok 361 - runtime: async watch notifies the parent once and drops the widget entry
  ---
  duration_ms: 7.994375
  type: 'test'
  ...
# Subtest: runtime: watch recycles the pane after a terminal collect
ok 362 - runtime: watch recycles the pane after a terminal collect
  ---
  duration_ms: 5.194458
  type: 'test'
  ...
# Subtest: runtime: a blocked child is not recycled
ok 363 - runtime: a blocked child is not recycled
  ---
  duration_ms: 5.1895
  type: 'test'
  ...
# Subtest: runtime: an explicit collect suppresses the completion message
ok 364 - runtime: an explicit collect suppresses the completion message
  ---
  duration_ms: 5.837166
  type: 'test'
  ...
# Subtest: runtime: collect failure still wakes the parent
ok 365 - runtime: collect failure still wakes the parent
  ---
  duration_ms: 6.631291
  type: 'test'
  ...
# Subtest: runtime: dispose clears jobs and busy overlay
ok 366 - runtime: dispose clears jobs and busy overlay
  ---
  duration_ms: 0.309959
  type: 'test'
  ...
# Subtest: runtime: collect after watch finished returns the cached snapshot
ok 367 - runtime: collect after watch finished returns the cached snapshot
  ---
  duration_ms: 11.201125
  type: 'test'
  ...
# Subtest: runtime: a blocked child asks the parent and does not recycle
ok 368 - runtime: a blocked child asks the parent and does not recycle
  ---
  duration_ms: 6.00525
  type: 'test'
  ...
# Subtest: runtime: approving a blocked child rewatches instead of releasing
ok 369 - runtime: approving a blocked child rewatches instead of releasing
  ---
  duration_ms: 5.16175
  type: 'test'
  ...
# Subtest: runtime: session jsonl fills model, turns, and in-flight tools
ok 370 - runtime: session jsonl fills model, turns, and in-flight tools
  ---
  duration_ms: 2.567125
  type: 'test'
  ...
# Subtest: runtime: non-pi probe fills the same live fields
ok 371 - runtime: non-pi probe fills the same live fields
  ---
  duration_ms: 25.265708
  type: 'test'
  ...
# Subtest: shouldRecycleAfterCollect keeps running/blocked panes, recycles unknown
ok 372 - shouldRecycleAfterCollect keeps running/blocked panes, recycles unknown
  ---
  duration_ms: 0.111042
  type: 'test'
  ...
# Subtest: runtime: same-run children batch into exactly one grouped notice
ok 373 - runtime: same-run children batch into exactly one grouped notice
  ---
  duration_ms: 29.362542
  type: 'test'
  ...
# Subtest: runtime: flush window expiry delivers a partial batch; the straggler flushes alone
ok 374 - runtime: flush window expiry delivers a partial batch; the straggler flushes alone
  ---
  duration_ms: 59.10375
  type: 'test'
  ...
# Subtest: runtime: joinMode each sends one notice per child
ok 375 - runtime: joinMode each sends one notice per child
  ---
  duration_ms: 6.097166
  type: 'test'
  ...
# Subtest: runtime: a blocked sibling does not block the group's flush; resume rejoins it
ok 376 - runtime: a blocked sibling does not block the group's flush; resume rejoins it
  ---
  duration_ms: 58.057333
  type: 'test'
  ...
# Subtest: runtime: retire runs during the batch window, not after the flush
ok 377 - runtime: retire runs during the batch window, not after the flush
  ---
  duration_ms: 12.223917
  type: 'test'
  ...
# Subtest: runtime.wait: aggregates both children, recycles panes, suppresses notify
ok 378 - runtime.wait: aggregates both children, recycles panes, suppresses notify
  ---
  duration_ms: 26.578333
  type: 'test'
  ...
# Subtest: runtime.wait: the hit path itself releases the job (no watch finally to hide it)
ok 379 - runtime.wait: the hit path itself releases the job (no watch finally to hide it)
  ---
  duration_ms: 0.297584
  type: 'test'
  ...
# Subtest: runtime.wait: timeout yields stillRunning, resets consumedByTool, auto-notify lands
ok 380 - runtime.wait: timeout yields stillRunning, resets consumedByTool, auto-notify lands
  ---
  duration_ms: 57.532042
  type: 'test'
  ...
# Subtest: runtime.wait: finished-cache hits return instantly; unknown names are missing
ok 381 - runtime.wait: finished-cache hits return instantly; unknown names are missing
  ---
  duration_ms: 6.309833
  type: 'test'
  ...
# Subtest: runtime.wait: a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch
ok 382 - runtime.wait: a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch
  ---
  duration_ms: 12.326
  type: 'test'
  ...
# Subtest: runtime.wait: a non-terminal (running) snapshot keeps the job active and unretired
ok 383 - runtime.wait: a non-terminal (running) snapshot keeps the job active and unretired
  ---
  duration_ms: 0.394667
  type: 'test'
  ...
# Subtest: U1: watch re-arms instead of notifying when collect times out on a live child
ok 384 - U1: watch re-arms instead of notifying when collect times out on a live child
  ---
  duration_ms: 32.840292
  type: 'test'
  ...
# Subtest: U2: the re-armed watch never treats the same running snapshot as terminal
ok 385 - U2: the re-armed watch never treats the same running snapshot as terminal
  ---
  duration_ms: 26.897125
  type: 'test'
  ...
# Subtest: U2: a re-arming watch joins no group until it really finishes
ok 386 - U2: a re-arming watch joins no group until it really finishes
  ---
  duration_ms: 51.0685
  type: 'test'
  ...
# Subtest: U5: a running snapshot is not cached as a finished result
ok 387 - U5: a running snapshot is not cached as a finished result
  ---
  duration_ms: 0.298125
  type: 'test'
  ...
# Subtest: U5: a terminal snapshot is still cached (the exclusion is running-only)
ok 388 - U5: a terminal snapshot is still cached (the exclusion is running-only)
  ---
  duration_ms: 0.120709
  type: 'test'
  ...
# Subtest: success turn → status success
ok 389 - success turn → status success
  ---
  duration_ms: 1.076625
  type: 'test'
  ...
# Subtest: stopReason error + message → failed, errorMessage preserved
ok 390 - stopReason error + message → failed, errorMessage preserved
  ---
  duration_ms: 0.152167
  type: 'test'
  ...
# Subtest: stopReason error + message containing aborted → aborted (F29)
ok 391 - stopReason error + message containing aborted → aborted (F29)
  ---
  duration_ms: 0.103875
  type: 'test'
  ...
# Subtest: stopReason length → truncated
ok 392 - stopReason length → truncated
  ---
  duration_ms: 0.079791
  type: 'test'
  ...
# Subtest: stopReason toolUse as last assistant → aborted (killed mid-tool)
ok 393 - stopReason toolUse as last assistant → aborted (killed mid-tool)
  ---
  duration_ms: 0.09825
  type: 'test'
  ...
# Subtest: user msg with no assistant reply → aborted, lastTurnMissing true (F29)
ok 394 - user msg with no assistant reply → aborted, lastTurnMissing true (F29)
  ---
  duration_ms: 0.064958
  type: 'test'
  ...
# Subtest: no messages at all → unknown
ok 395 - no messages at all → unknown
  ---
  duration_ms: 0.050584
  type: 'test'
  ...
# Subtest: turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)
ok 396 - turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)
  ---
  duration_ms: 0.19075
  type: 'test'
  ...
# Subtest: torn/truncated JSON line → counted in tornLines, does not throw (F12)
ok 397 - torn/truncated JSON line → counted in tornLines, does not throw (F12)
  ---
  duration_ms: 0.433083
  type: 'test'
  ...
# Subtest: usage accumulation across 3 assistant messages
ok 398 - usage accumulation across 3 assistant messages
  ---
  duration_ms: 0.699875
  type: 'test'
  ...
# Subtest: unknown stopReason value → failed with a reason
ok 399 - unknown stopReason value → failed with a reason
  ---
  duration_ms: 0.180833
  type: 'test'
  ...
# Subtest: extractVerdict('{"ok":false,"reason":"x"}') → {ok:false, reason:"x"} (F33)
ok 400 - extractVerdict('{"ok":false,"reason":"x"}') → {ok:false, reason:"x"} (F33)
  ---
  duration_ms: 0.157417
  type: 'test'
  ...
# Subtest: extractVerdict("plain text") → null
ok 401 - extractVerdict("plain text") → null
  ---
  duration_ms: 0.124625
  type: 'test'
  ...
# Subtest: extractVerdict on fenced ```json block parses the JSON inside
ok 402 - extractVerdict on fenced ```json block parses the JSON inside
  ---
  duration_ms: 0.108708
  type: 'test'
  ...
# Subtest: model_change header populates parsed.model before any assistant message
ok 403 - model_change header populates parsed.model before any assistant message
  ---
  duration_ms: 0.0495
  type: 'test'
  ...
# Subtest: assistant model overrides an earlier model_change
ok 404 - assistant model overrides an earlier model_change
  ---
  duration_ms: 0.0555
  type: 'test'
  ...
# Subtest: parseSessionFile: missing file → empty ParsedSession (no throw)
ok 405 - parseSessionFile: missing file → empty ParsedSession (no throw)
  ---
  duration_ms: 0.099333
  type: 'test'
  ...
# Subtest: parseSessionFile: real file round-trips like text
ok 406 - parseSessionFile: real file round-trips like text
  ---
  duration_ms: 0.921292
  type: 'test'
  ...
# Subtest: F32: agent self-reporting failure still has stopReason stop → mechanically success
ok 407 - F32: agent self-reporting failure still has stopReason stop → mechanically success
  ---
  duration_ms: 0.085833
  type: 'test'
  ...
# Subtest: extractVerdict ignores non-verdict JSON objects
ok 408 - extractVerdict ignores non-verdict JSON objects
  ---
  duration_ms: 0.12975
  type: 'test'
  ...
# Subtest: stripPromptEcho drops the launch prompt once but keeps a later verdict
ok 409 - stripPromptEcho drops the launch prompt once but keeps a later verdict
  ---
  duration_ms: 0.181584
  type: 'test'
  ...
# Subtest: paneLooksStuck detects Cursor trust and paste-preview chrome
ok 410 - paneLooksStuck detects Cursor trust and paste-preview chrome
  ---
  duration_ms: 1.589167
  type: 'test'
  ...
# Subtest: paneLooksStuck ignores leftover paste chrome once a live reply exists
ok 411 - paneLooksStuck ignores leftover paste chrome once a live reply exists
  ---
  duration_ms: 2.335542
  type: 'test'
  ...
# Subtest: paneHasLiveReply reads every rotating cursor banner variant as not-yet-replied
ok 412 - paneHasLiveReply reads every rotating cursor banner variant as not-yet-replied
  ---
  duration_ms: 0.513083
  type: 'test'
  ...
# Subtest: paneHasLiveReply still sees a real reply under the banner
ok 413 - paneHasLiveReply still sees a real reply under the banner
  ---
  duration_ms: 0.075625
  type: 'test'
  ...
# Subtest: turn boundaries are split by user messages; per-turn stats are independent
ok 414 - turn boundaries are split by user messages; per-turn stats are independent
  ---
  duration_ms: 0.167625
  type: 'test'
  ...
# Subtest: hard kill mid-turn: user msg then only toolResult, no assistant → aborted
ok 415 - hard kill mid-turn: user msg then only toolResult, no assistant → aborted
  ---
  duration_ms: 0.05975
  type: 'test'
  ...
# Subtest: toolResult before any user message does not crash
ok 416 - toolResult before any user message does not crash
  ---
  duration_ms: 4.813583
  type: 'test'
  ...
# Subtest: scalar JSON lines are treated as damaged, never crash the parse
ok 417 - scalar JSON lines are treated as damaged, never crash the parse
  ---
  duration_ms: 0.215667
  type: 'test'
  ...
# Subtest: a null line does not prevent the valid lines around it from parsing
ok 418 - a null line does not prevent the valid lines around it from parsing
  ---
  duration_ms: 0.178667
  type: 'test'
  ...
# Subtest: parseSessionText never throws on hostile input
ok 419 - parseSessionText never throws on hostile input
  ---
  duration_ms: 0.637084
  type: 'test'
  ...
# Subtest: success
ok 420 - success
  ---
  duration_ms: 0.912583
  type: 'test'
  ...
# Subtest: error
ok 421 - error
  ---
  duration_ms: 0.127959
  type: 'test'
  ...
# Subtest: aborted via missing reply
ok 422 - aborted via missing reply
  ---
  duration_ms: 0.068166
  type: 'test'
  ...
# Subtest: toolUse as final => aborted
ok 423 - toolUse as final => aborted
  ---
  duration_ms: 0.071875
  type: 'test'
  ...
# Subtest: tool error then clean stop => success with toolErrors
ok 424 - tool error then clean stop => success with toolErrors
  ---
  duration_ms: 0.198208
  type: 'test'
  ...
# Subtest: torn line tolerated
ok 425 - torn line tolerated
  ---
  duration_ms: 0.17325
  type: 'test'
  ...
# Subtest: verdict
ok 426 - verdict
  ---
  duration_ms: 0.584333
  type: 'test'
  ...
# Subtest: names
ok 427 - names
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: names: a non-finite index still yields a valid name
ok 428 - names: a non-finite index still yields a valid name
  ---
  duration_ms: 0.358042
  type: 'test'
  ...
# Subtest: names: every generated name is valid, across hostile inputs
ok 429 - names: every generated name is valid, across hostile inputs
  ---
  duration_ms: 0.780292
  type: 'test'
  ...
# Subtest: names: distinct indexes yield distinct names
ok 430 - names: distinct indexes yield distinct names
  ---
  duration_ms: 1.298375
  type: 'test'
  ...
# Subtest: nested path safety
ok 431 - nested path safety
  ---
  duration_ms: 0.146834
  type: 'test'
  ...
# Subtest: herdr error on stderr
ok 432 - herdr error on stderr
  ---
  duration_ms: 0.142375
  type: 'test'
  ...
# Subtest: herdr success on stdout
ok 433 - herdr success on stdout
  ---
  duration_ms: 0.043208
  type: 'test'
  ...
# Subtest: buildPiArgs: a multi-line task goes through a file, not argv
ok 434 - buildPiArgs: a multi-line task goes through a file, not argv
  ---
  duration_ms: 3.322416
  type: 'test'
  ...
# Subtest: buildPiArgs: a short single-line task also uses the file (no context switch)
ok 435 - buildPiArgs: a short single-line task also uses the file (no context switch)
  ---
  duration_ms: 0.728083
  type: 'test'
  ...
# Subtest: formatElapsed rounds to seconds
ok 436 - formatElapsed rounds to seconds
  ---
  duration_ms: 0.650583
  type: 'test'
  ...
# Subtest: formatFooterStatus is empty when nothing is running
ok 437 - formatFooterStatus is empty when nothing is running
  ---
  duration_ms: 0.074916
  type: 'test'
  ...
# Subtest: formatBusyLabel matches the herdr overlay copy
ok 438 - formatBusyLabel matches the herdr overlay copy
  ---
  duration_ms: 0.078875
  type: 'test'
  ...
# Subtest: formatWidgetLines keeps the compact roster when no extra fields are set
ok 439 - formatWidgetLines keeps the compact roster when no extra fields are set
  ---
  duration_ms: 0.482959
  type: 'test'
  ...
# Subtest: formatWidgetLines adds model, thinking, kind, tools, and worktree
ok 440 - formatWidgetLines adds model, thinking, kind, tools, and worktree
  ---
  duration_ms: 0.184416
  type: 'test'
  ...
# Subtest: applyStatus paints above the editor and in the footer
ok 441 - applyStatus paints above the editor and in the footer
  ---
  duration_ms: 0.272416
  type: 'test'
  ...
# Subtest: applyStatus is a no-op without UI
ok 442 - applyStatus is a no-op without UI
  ---
  duration_ms: 0.055792
  type: 'test'
  ...
# Subtest: status board registers a persistent factory and then requestRender
ok 443 - status board registers a persistent factory and then requestRender
  ---
  duration_ms: 0.310167
  type: 'test'
  ...
# Subtest: formatWidgetLines crash replica exceeds a 66-column terminal before truncation
ok 444 - formatWidgetLines crash replica exceeds a 66-column terminal before truncation
  ---
  duration_ms: 1.487833
  type: 'test'
  ...
# Subtest: status board render truncates crash-replica titles to terminal width
ok 445 - status board render truncates crash-replica titles to terminal width
  ---
  duration_ms: 10.723417
  type: 'test'
  ...
# Subtest: status board render truncates multi-child tree prefixes and ANSI colors
ok 446 - status board render truncates multi-child tree prefixes and ANSI colors
  ---
  duration_ms: 4.936875
  type: 'test'
  ...
# Subtest: status board keeps short titles intact on a wide terminal
ok 447 - status board keeps short titles intact on a wide terminal
  ---
  duration_ms: 0.24525
  type: 'test'
  ...
# Subtest: step-model: preset beats agentOverrides AFTER loadCatalog folds them in
ok 448 - step-model: preset beats agentOverrides AFTER loadCatalog folds them in
  ---
  duration_ms: 1.221792
  type: 'test'
  ...
# Subtest: step-model: a per-run tool `model` still beats the preset
ok 449 - step-model: a per-run tool `model` still beats the preset
  ---
  duration_ms: 0.147458
  type: 'test'
  ...
# Subtest: step-model: tool `preset` beats the agent's own frontmatter preset
ok 450 - step-model: tool `preset` beats the agent's own frontmatter preset
  ---
  duration_ms: 0.162208
  type: 'test'
  ...
# Subtest: step-model: the preset's kind and thinking reach the launched agent
ok 451 - step-model: the preset's kind and thinking reach the launched agent
  ---
  duration_ms: 0.423792
  type: 'test'
  ...
# Subtest: step-model: an agentOverrides-supplied preset reference is honoured
ok 452 - step-model: an agentOverrides-supplied preset reference is honoured
  ---
  duration_ms: 0.290625
  type: 'test'
  ...
# Subtest: step-model: an agent with no preset is untouched
ok 453 - step-model: an agent with no preset is untouched
  ---
  duration_ms: 0.616292
  type: 'test'
  ...
# Subtest: step-model: no preset + no overrides falls through to defaultModel
ok 454 - step-model: no preset + no overrides falls through to defaultModel
  ---
  duration_ms: 0.103167
  type: 'test'
  ...
# Subtest: BUG A1: preset kind + tool `model` override must not ship incoherently
ok 455 - BUG A1: preset kind + tool `model` override must not ship incoherently
  ---
  duration_ms: 3.086833
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset + defaultModel must not ship incoherently
ok 456 - BUG A1: a kind-only preset + defaultModel must not ship incoherently
  ---
  duration_ms: 0.40025
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset + the dispatch model must not ship incoherently
ok 457 - BUG A1: a kind-only preset + the dispatch model must not ship incoherently
  ---
  duration_ms: 0.3955
  type: 'test'
  ...
# Subtest: BUG A1: the refusal names the real model source, not the preset
ok 458 - BUG A1: the refusal names the real model source, not the preset
  ---
  duration_ms: 0.13875
  type: 'test'
  ...
# Subtest: BUG A1: a tool `model` override and the parent model are blamed apart
ok 459 - BUG A1: a tool `model` override and the parent model are blamed apart
  ---
  duration_ms: 0.104458
  type: 'test'
  ...
# Subtest: BUG A1: a coherent preset still launches (guard is not over-eager)
ok 460 - BUG A1: a coherent preset still launches (guard is not over-eager)
  ---
  duration_ms: 0.121042
  type: 'test'
  ...
# Subtest: BUG A1: a kind-only preset with a COMPATIBLE model is allowed
ok 461 - BUG A1: a kind-only preset with a COMPATIBLE model is allowed
  ---
  duration_ms: 0.092875
  type: 'test'
  ...
# Subtest: step-model: an undefined preset throws (never a silent fallback)
ok 462 - step-model: an undefined preset throws (never a silent fallback)
  ---
  duration_ms: 0.056417
  type: 'test'
  ...
# Subtest: origin: frontmatter, agentOverrides and preset are explicit choices
ok 463 - origin: frontmatter, agentOverrides and preset are explicit choices
  ---
  duration_ms: 0.065
  type: 'test'
  ...
# Subtest: origin: defaultModel and the parent session model are inherited
ok 464 - origin: defaultModel and the parent session model are inherited
  ---
  duration_ms: 0.050334
  type: 'test'
  ...
# Subtest: origin: a per-run model param is an explicit choice
ok 465 - origin: a per-run model param is an explicit choice
  ---
  duration_ms: 0.043875
  type: 'test'
  ...
# Subtest: origin: no model anywhere is inherited (nothing was chosen)
ok 466 - origin: no model anywhere is inherited (nothing was chosen)
  ---
  duration_ms: 0.035792
  type: 'test'
  ...
# Subtest: createRun generates r- prefixed runId and persists run.json
ok 467 - createRun generates r- prefixed runId and persists run.json
  ---
  duration_ms: 4.456375
  type: 'test'
  ...
# Subtest: createRun rejects empty task / cwd
ok 468 - createRun rejects empty task / cwd
  ---
  duration_ms: 0.621833
  type: 'test'
  ...
# Subtest: createRun accepts nested path and derives depth
ok 469 - createRun accepts nested path and derives depth
  ---
  duration_ms: 3.350791
  type: 'test'
  ...
# Subtest: createRun truncates nested path to 4 entries
ok 470 - createRun truncates nested path to 4 entries
  ---
  duration_ms: 1.635542
  type: 'test'
  ...
# Subtest: create/read round-trip preserves all fields
ok 471 - create/read round-trip preserves all fields
  ---
  duration_ms: 1.410167
  type: 'test'
  ...
# Subtest: readRun returns null for a missing run
ok 472 - readRun returns null for a missing run
  ---
  duration_ms: 0.298209
  type: 'test'
  ...
# Subtest: readRun throws for traversal runIds
ok 473 - readRun throws for traversal runIds
  ---
  duration_ms: 0.254916
  type: 'test'
  ...
# Subtest: writeRun updates updatedAt and round-trips
ok 474 - writeRun updates updatedAt and round-trips
  ---
  duration_ms: 1.501833
  type: 'test'
  ...
# Subtest: writeRun rejects a non-RunRecord shape
ok 475 - writeRun rejects a non-RunRecord shape
  ---
  duration_ms: 0.465584
  type: 'test'
  ...
# Subtest: atomic write leaves no .tmp behind
ok 476 - atomic write leaves no .tmp behind
  ---
  duration_ms: 1.51125
  type: 'test'
  ...
# Subtest: run.json still parses after many rapid writes (no partial state)
ok 477 - run.json still parses after many rapid writes (no partial state)
  ---
  duration_ms: 6.361583
  type: 'test'
  ...
# Subtest: run.json is created with restrictive file mode
ok 478 - run.json is created with restrictive file mode
  ---
  duration_ms: 1.029667
  type: 'test'
  ...
# Subtest: corrupt run.json: readRun returns null and quarantines as .corrupt
ok 479 - corrupt run.json: readRun returns null and quarantines as .corrupt
  ---
  duration_ms: 1.487959
  type: 'test'
  ...
# Subtest: corrupt run.json with valid JSON but wrong shape is quarantined
ok 480 - corrupt run.json with valid JSON but wrong shape is quarantined
  ---
  duration_ms: 1.386625
  type: 'test'
  ...
# Subtest: after corruption the run can be recreated cleanly
ok 481 - after corruption the run can be recreated cleanly
  ---
  duration_ms: 2.049167
  type: 'test'
  ...
# Subtest: listRuns skips corrupt runs without throwing
ok 482 - listRuns skips corrupt runs without throwing
  ---
  duration_ms: 1.859667
  type: 'test'
  ...
# Subtest: sessionFileFor pre-creates an empty file at mode 0600 and returns the path
ok 483 - sessionFileFor pre-creates an empty file at mode 0600 and returns the path
  ---
  duration_ms: 1.283583
  type: 'test'
  ...
# Subtest: sessionFileFor is idempotent — no data loss on repeat calls
ok 484 - sessionFileFor is idempotent — no data loss on repeat calls
  ---
  duration_ms: 1.229958
  type: 'test'
  ...
# Subtest: sessionFileFor creates the run dir on demand
ok 485 - sessionFileFor creates the run dir on demand
  ---
  duration_ms: 0.741792
  type: 'test'
  ...
# Subtest: sanitizeNameForFs neutralizes path traversal
ok 486 - sanitizeNameForFs neutralizes path traversal
  ---
  duration_ms: 1.210333
  type: 'test'
  ...
# Subtest: sanitizeNameForFs: ../../etc/passwd becomes passwd
ok 487 - sanitizeNameForFs: ../../etc/passwd becomes passwd
  ---
  duration_ms: 0.232708
  type: 'test'
  ...
# Subtest: sanitizeNameForFs replaces spaces and unicode
ok 488 - sanitizeNameForFs replaces spaces and unicode
  ---
  duration_ms: 0.313875
  type: 'test'
  ...
# Subtest: sanitizeNameForFs rejects names that sanitize to nothing
ok 489 - sanitizeNameForFs rejects names that sanitize to nothing
  ---
  duration_ms: 0.257333
  type: 'test'
  ...
# Subtest: sessionFileFor with a hostile name still creates a file inside the run dir
ok 490 - sessionFileFor with a hostile name still creates a file inside the run dir
  ---
  duration_ms: 1.431292
  type: 'test'
  ...
# Subtest: addChild appends, bumps budget, and generates ownerToken when missing
ok 491 - addChild appends, bumps budget, and generates ownerToken when missing
  ---
  duration_ms: 2.402125
  type: 'test'
  ...
# Subtest: addChild rejects duplicate child names
ok 492 - addChild rejects duplicate child names
  ---
  duration_ms: 1.436042
  type: 'test'
  ...
# Subtest: findChild returns null for unknown child
ok 493 - findChild returns null for unknown child
  ---
  duration_ms: 0.826917
  type: 'test'
  ...
# Subtest: updateChild mutates only the named child and persists
ok 494 - updateChild mutates only the named child and persists
  ---
  duration_ms: 1.60375
  type: 'test'
  ...
# Subtest: updateChild throws NOT_FOUND for unknown child
ok 495 - updateChild throws NOT_FOUND for unknown child
  ---
  duration_ms: 0.850291
  type: 'test'
  ...
# Subtest: updateRun read-modify-write round trip
ok 496 - updateRun read-modify-write round trip
  ---
  duration_ms: 1.094208
  type: 'test'
  ...
# Subtest: updateRun throws NOT_FOUND for a missing run
ok 497 - updateRun throws NOT_FOUND for a missing run
  ---
  duration_ms: 0.236584
  type: 'test'
  ...
# Subtest: concurrent updateRun calls on the same run serialize (no lost update)
ok 498 - concurrent updateRun calls on the same run serialize (no lost update)
  ---
  duration_ms: 9.637584
  type: 'test'
  ...
# Subtest: concurrent addChild calls all land (mutex under contention)
ok 499 - concurrent addChild calls all land (mutex under contention)
  ---
  duration_ms: 4.074917
  type: 'test'
  ...
# Subtest: a failing mutator does not poison the lock for later callers
ok 500 - a failing mutator does not poison the lock for later callers
  ---
  duration_ms: 1.214583
  type: 'test'
  ...
# Subtest: artifactDirFor creates <runDir>/out
ok 501 - artifactDirFor creates <runDir>/out
  ---
  duration_ms: 1.024209
  type: 'test'
  ...
# Subtest: prune deletes only sessions older than retentionDays
ok 502 - prune deletes only sessions older than retentionDays
  ---
  duration_ms: 1.693958
  type: 'test'
  ...
# Subtest: prune removes whole run dirs whose run.json is older than retention
ok 503 - prune removes whole run dirs whose run.json is older than retention
  ---
  duration_ms: 1.432875
  type: 'test'
  ...
# Subtest: prune never deletes run.json of a run newer than retention
ok 504 - prune never deletes run.json of a run newer than retention
  ---
  duration_ms: 1.305875
  type: 'test'
  ...
# Subtest: prune enforces maxBytesPerRun by dropping oldest sessions first
ok 505 - prune enforces maxBytesPerRun by dropping oldest sessions first
  ---
  duration_ms: 2.514375
  type: 'test'
  ...
# Subtest: prune is a no-op when there is nothing to do
ok 506 - prune is a no-op when there is nothing to do
  ---
  duration_ms: 5.644875
  type: 'test'
  ...
# Subtest: prune ignores dirs without run.json
ok 507 - prune ignores dirs without run.json
  ---
  duration_ms: 2.267166
  type: 'test'
  ...
# Subtest: prune rejects non-positive retentionDays
ok 508 - prune rejects non-positive retentionDays
  ---
  duration_ms: 0.396541
  type: 'test'
  ...
# Subtest: listRuns returns runs ordered oldest-first
ok 509 - listRuns returns runs ordered oldest-first
  ---
  duration_ms: 11.10925
  type: 'test'
  ...
# Subtest: store works without a runs dir present
ok 510 - store works without a runs dir present
  ---
  duration_ms: 5.656333
  type: 'test'
  ...
# Subtest: RunStore requires rootDir
ok 511 - RunStore requires rootDir
  ---
  duration_ms: 0.330625
  type: 'test'
  ...
# Subtest: sessionFileFor does not leak file descriptors across repeated calls
ok 512 - sessionFileFor does not leak file descriptors across repeated calls
  ---
  duration_ms: 20.730459
  type: 'test'
  ...
# Subtest: sessionFileFor keeps the pre-creation contract
ok 513 - sessionFileFor keeps the pre-creation contract
  ---
  duration_ms: 3.057917
  type: 'test'
  ...
# Subtest: pickChildByName does not return another parent's child of the same name
ok 514 - pickChildByName does not return another parent's child of the same name
  ---
  duration_ms: 3.158625
  type: 'test'
  ...
# Subtest: pickChildByName prefers a live child over an older retired one
ok 515 - pickChildByName prefers a live child over an older retired one
  ---
  duration_ms: 2.822667
  type: 'test'
  ...
# Subtest: formatters follow the compact summary conventions
ok 516 - formatters follow the compact summary conventions
  ---
  duration_ms: 0.832916
  type: 'test'
  ...
# Subtest: summaryRole prefers agent verbatim and strips the counter only from name
ok 517 - summaryRole prefers agent verbatim and strips the counter only from name
  ---
  duration_ms: 0.186167
  type: 'test'
  ...
# Subtest: aggregateSubagentRuns groups by agent, prefers execution snapshots, and falls back to jsonl
ok 518 - aggregateSubagentRuns groups by agent, prefers execution snapshots, and falls back to jsonl
  ---
  duration_ms: 13.595042
  type: 'test'
  ...
# Subtest: non-pi zero session usage is unavailable, and awaiting execution counts as both outcome and running
ok 519 - non-pi zero session usage is unavailable, and awaiting execution counts as both outcome and running
  ---
  duration_ms: 12.149459
  type: 'test'
  ...
# Subtest: a missing or empty session file yields no usage, not parser-shaped zeros
ok 520 - a missing or empty session file yields no usage, not parser-shaped zeros
  ---
  duration_ms: 3.565833
  type: 'test'
  ...
# Subtest: a running non-pi child does not display stale session usage
ok 521 - a running non-pi child does not display stale session usage
  ---
  duration_ms: 2.516792
  type: 'test'
  ...
# Subtest: formatSubagentSummary renders the fixed seven-column table and empty state
ok 522 - formatSubagentSummary renders the fixed seven-column table and empty state
  ---
  duration_ms: 0.211791
  type: 'test'
  ...
# Subtest: formatSubagentDetail includes available fields and omits missing pane/tab/worktree data
ok 523 - formatSubagentDetail includes available fields and omits missing pane/tab/worktree data
  ---
  duration_ms: 0.408209
  type: 'test'
  ...
# Subtest: registerSummaryCommand registers completion and emits slash text
ok 524 - registerSummaryCommand registers completion and emits slash text
  ---
  duration_ms: 5.310125
  type: 'test'
  ...
# Subtest: teams: environment wins over settings, then default
ok 525 - teams: environment wins over settings, then default
  ---
  duration_ms: 0.973958
  type: 'test'
  ...
# Subtest: teams: default returns the exact input array
ok 526 - teams: default returns the exact input array
  ---
  duration_ms: 0.160834
  type: 'test'
  ...
# Subtest: teams: members preserve first-seen order and warnings are exact
ok 527 - teams: members preserve first-seen order and warnings are exact
  ---
  duration_ms: 0.177709
  type: 'test'
  ...
# Subtest: teams: star expands each role once and later object overrides win
ok 528 - teams: star expands each role once and later object overrides win
  ---
  duration_ms: 0.1785
  type: 'test'
  ...
# Subtest: teams: a later member or star restores a role removed by disabled
ok 529 - teams: a later member or star restores a role removed by disabled
  ---
  duration_ms: 0.178541
  type: 'test'
  ...
# Subtest: teams: object member agent:"*" is not a wildcard and warns as a missing role
ok 530 - teams: object member agent:"*" is not a wildcard and warns as a missing role
  ---
  duration_ms: 0.427333
  type: 'test'
  ...
# Subtest: teams: undefined constructor selection warns and returns the full catalog
ok 531 - teams: undefined constructor selection warns and returns the full catalog
  ---
  duration_ms: 0.155459
  type: 'test'
  ...
# Subtest: teams: configured constructor key is an own, usable team name
ok 532 - teams: configured constructor key is an own, usable team name
  ---
  duration_ms: 0.090459
  type: 'test'
  ...
# Subtest: teams: missing active name falls back to all roles with exact warning
ok 533 - teams: missing active name falls back to all roles with exact warning
  ---
  duration_ms: 0.308375
  type: 'test'
  ...
# Subtest: teams: list puts default first and keeps configured insertion order
ok 534 - teams: list puts default first and keeps configured insertion order
  ---
  duration_ms: 0.317208
  type: 'test'
  ...
# Subtest: settings: project team entries replace same names; absent project teams keep user teams
ok 535 - settings: project team entries replace same names; absent project teams keep user teams
  ---
  duration_ms: 0.223333
  type: 'test'
  ...
# Subtest: settings: team structure, description, reserved names, and member override types validate
ok 536 - settings: team structure, description, reserved names, and member override types validate
  ---
  duration_ms: 0.499583
  type: 'test'
  ...
# Subtest: slash: team argument boundaries reject malformed and extra tokens
ok 537 - slash: team argument boundaries reject malformed and extra tokens
  ---
  duration_ms: 0.197208
  type: 'test'
  ...
# Subtest: slash: settings writer preserves unrelated keys
ok 538 - slash: settings writer preserves unrelated keys
  ---
  duration_ms: 1.962875
  type: 'test'
  ...
# Subtest: slash: use/create success messages are exact and environment override is disclosed
ok 539 - slash: use/create success messages are exact and environment override is disclosed
  ---
  duration_ms: 1.550041
  type: 'test'
  ...
# Subtest: slash: unknown, reserved, and existing teams error without changing file bytes
ok 540 - slash: unknown, reserved, and existing teams error without changing file bytes
  ---
  duration_ms: 1.175375
  type: 'test'
  ...
# Subtest: slash: --global use/create update temporary user settings only
ok 541 - slash: --global use/create update temporary user settings only
  ---
  duration_ms: 1.112417
  type: 'test'
  ...
# Subtest: slash: list and status report current team and warnings
ok 542 - slash: list and status report current team and warnings
  ---
  duration_ms: 0.433042
  type: 'test'
  ...
# Subtest: catalog: filters agents, keeps allAgents, and team overrides precede defaults
ok 543 - catalog: filters agents, keeps allAgents, and team overrides precede defaults
  ---
  duration_ms: 2.3075
  type: 'test'
  ...
# Subtest: catalog: missing and constructor-selected teams warn and keep the full catalog
ok 544 - catalog: missing and constructor-selected teams warn and keep the full catalog
  ---
  duration_ms: 1.566375
  type: 'test'
  ...
# Subtest: listing and roster: default/no-warning text is byte-for-byte legacy; team lines are conditional
ok 545 - listing and roster: default/no-warning text is byte-for-byte legacy; team lines are conditional
  ---
  duration_ms: 0.316375
  type: 'test'
  ...
# Subtest: launch refusal: only a real team-filtered role gets team wording
ok 546 - launch refusal: only a real team-filtered role gets team wording
  ---
  duration_ms: 0.105625
  type: 'test'
  ...
# Subtest: control resolution prefers team override, then recovers a filtered role from allAgents
ok 547 - control resolution prefers team override, then recovers a filtered role from allAgents
  ---
  duration_ms: 0.067666
  type: 'test'
  ...
# Subtest: control wait: filtered child falls back to allAgents timeout
ok 548 - control wait: filtered child falls back to allAgents timeout
  ---
  duration_ms: 3.925834
  type: 'test'
  ...
# Subtest: control wait: team-overridden role definition wins over allAgents
ok 549 - control wait: team-overridden role definition wins over allAgents
  ---
  duration_ms: 1.912709
  type: 'test'
  ...
# Subtest: profiles: malformed JSON error includes the file path
ok 550 - profiles: malformed JSON error includes the file path
  ---
  duration_ms: 0.964708
  type: 'test'
  ...
# Subtest: index mainline: launchFamily passes a named team through tab, split, and start
ok 551 - index mainline: launchFamily passes a named team through tab, split, and start
  ---
  duration_ms: 5114.533042
  type: 'test'
  ...
# Subtest: index mainline: default team omits env on split and new-tab paths
ok 552 - index mainline: default team omits env on split and new-tab paths
  ---
  duration_ms: 7521.015166
  type: 'test'
  ...
# Subtest: index mainline: env=default overrides settings and is passed to a new tab
ok 553 - index mainline: env=default overrides settings and is passed to a new tab
  ---
  duration_ms: 2649.098
  type: 'test'
  ...
# Subtest: index mainline: revive finds a child filtered from the selected team and inherits team env
ok 554 - index mainline: revive finds a child filtered from the selected team and inherits team env
  ---
  duration_ms: 682.605333
  type: 'test'
  ...
# Subtest: index mainline: revive uses the selected team's override for an existing child
ok 555 - index mainline: revive uses the selected team's override for an existing child
  ---
  duration_ms: 693.996333
  type: 'test'
  ...
# Subtest: index mainline: collect applies the selected team's timeout to an existing child
ok 556 - index mainline: collect applies the selected team's timeout to an existing child
  ---
  duration_ms: 3102.321792
  type: 'test'
  ...
# Subtest: waitAction: a finished child is waitable via the finished-cache probe
ok 557 - waitAction: a finished child is waitable via the finished-cache probe
  ---
  duration_ms: 6.604833
  type: 'test'
  ...
# Subtest: waitAction: an untracked name with no cache is a loud unknown child
ok 558 - waitAction: an untracked name with no cache is a loud unknown child
  ---
  duration_ms: 0.629292
  type: 'test'
  ...
# Subtest: waitAction: default timeout is the strictest (smallest) role timeout
ok 559 - waitAction: default timeout is the strictest (smallest) role timeout
  ---
  duration_ms: 0.481958
  type: 'test'
  ...
# Subtest: waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs
ok 560 - waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs
  ---
  duration_ms: 0.255958
  type: 'test'
  ...
# Subtest: renderWait: summary line counts done and still-running
ok 561 - renderWait: summary line counts done and still-running
  ---
  duration_ms: 0.143459
  type: 'test'
  ...
# Subtest: resolveWaitTargets: all picks working and blocked children
ok 562 - resolveWaitTargets: all picks working and blocked children
  ---
  duration_ms: 0.807333
  type: 'test'
  ...
# Subtest: resolveWaitTargets: all with nothing running is a loud miss
ok 563 - resolveWaitTargets: all with nothing running is a loud miss
  ---
  duration_ms: 0.123375
  type: 'test'
  ...
# Subtest: resolveWaitTargets: a tracked name resolves alone
ok 564 - resolveWaitTargets: a tracked name resolves alone
  ---
  duration_ms: 0.066875
  type: 'test'
  ...
# Subtest: resolveWaitTargets: an untracked name fails with the unknown-child wording
ok 565 - resolveWaitTargets: an untracked name fails with the unknown-child wording
  ---
  duration_ms: 0.060667
  type: 'test'
  ...
# Subtest: resolveWaitTargets: neither name nor all is rejected
ok 566 - resolveWaitTargets: neither name nor all is rejected
  ---
  duration_ms: 0.059791
  type: 'test'
  ...
# Subtest: worktreePathFor nests under the run dir
ok 567 - worktreePathFor nests under the run dir
  ---
  duration_ms: 0.651584
  type: 'test'
  ...
# Subtest: resolveLaunchWorktree lets the parent override the role default
ok 568 - resolveLaunchWorktree lets the parent override the role default
  ---
  duration_ms: 0.083167
  type: 'test'
  ...
# Subtest: createChildWorktree refuses a non-git cwd
ok 569 - createChildWorktree refuses a non-git cwd
  ---
  duration_ms: 67.1075
  type: 'test'
  ...
# Subtest: createChildWorktree adds a named branch checkout and remove rolls it back
ok 570 - createChildWorktree adds a named branch checkout and remove rolls it back
  ---
  duration_ms: 146.08325
  type: 'test'
  ...
# Subtest: worktreeBranchFor is unique per nonce
ok 571 - worktreeBranchFor is unique per nonce
  ---
  duration_ms: 0.138875
  type: 'test'
  ...
1..571
# tests 571
# suites 0
# pass 571
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 30746.615875
npm notice run @zzjcool/pi-herdr-subagents@0.10.0 test:integration
npm notice run node --experimental-strip-types --test test/integration/*.test.ts
TAP version 13
# (node:56054) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: preCreateSessionFile creates an empty 0600 file and is idempotent
ok 1 - preCreateSessionFile creates an empty 0600 file and is idempotent
  ---
  duration_ms: 1.748917
  type: 'test'
  ...
# Subtest: launch pre-creates the session file before starting the agent (F4)
ok 2 - launch pre-creates the session file before starting the agent (F4)
  ---
  duration_ms: 4.674875
  type: 'test'
  ...
# Subtest: launch records the child with provenance
ok 3 - launch records the child with provenance
  ---
  duration_ms: 1.8315
  type: 'test'
  ...
# Subtest: launch retries agent_pane_busy until the pane is ready (F19)
ok 4 - launch retries agent_pane_busy until the pane is ready (F19)
  ---
  duration_ms: 1.483333
  type: 'test'
  ...
# Subtest: a failed launch rolls back its pane instead of leaking it
ok 5 - a failed launch rolls back its pane instead of leaking it
  ---
  duration_ms: 2.034292
  type: 'test'
  ...
# Subtest: collect derives success from the session, not agent_status (F26)
ok 6 - collect derives success from the session, not agent_status (F26)
  ---
  duration_ms: 2.274
  type: 'test'
  ...
# Subtest: collect reports failure for an LLM error even though herdr says done (F26)
ok 7 - collect reports failure for an LLM error even though herdr says done (F26)
  ---
  duration_ms: 2.115875
  type: 'test'
  ...
# Subtest: collect reports abort when the agent is GONE and the last prompt has no reply (F29)
ok 8 - collect reports abort when the agent is GONE and the last prompt has no reply (F29)
  ---
  duration_ms: 1.76825
  type: 'test'
  ...
# Subtest: collect reports `running` (not aborted) when the agent is still alive
ok 9 - collect reports `running` (not aborted) when the agent is still alive
  ---
  duration_ms: 2.173083
  type: 'test'
  ...
# Subtest: collect turns a self-reported verdict into acceptance (F33)
ok 10 - collect turns a self-reported verdict into acceptance (F33)
  ---
  duration_ms: 2.557583
  type: 'test'
  ...
# Subtest: collect on an unknown child throws
ok 11 - collect on an unknown child throws
  ---
  duration_ms: 0.465833
  type: 'test'
  ...
# Subtest: retire snapshots the outcome before the agent disappears (F27)
ok 12 - retire snapshots the outcome before the agent disappears (F27)
  ---
  duration_ms: 1.8395
  type: 'test'
  ...
# Subtest: retire leaves the session file on disk so resume stays possible (F12)
ok 13 - retire leaves the session file on disk so resume stays possible (F12)
  ---
  duration_ms: 1.315584
  type: 'test'
  ...
# Subtest: retire exits the agent and closes its pane
ok 14 - retire exits the agent and closes its pane
  ---
  duration_ms: 1.446917
  type: 'test'
  ...
# Subtest: retire is idempotent
ok 15 - retire is idempotent
  ---
  duration_ms: 2.114917
  type: 'test'
  ...
# Subtest: retireAll reaps every child (F15)
ok 16 - retireAll reaps every child (F15)
  ---
  duration_ms: 1.9935
  type: 'test'
  ...
# Subtest: allocateName produces valid, non-colliding names
ok 17 - allocateName produces valid, non-colliding names
  ---
  duration_ms: 0.288916
  type: 'test'
  ...
# Subtest: steer forwards a prompt to a live child (F10)
ok 18 - steer forwards a prompt to a live child (F10)
  ---
  duration_ms: 1.151792
  type: 'test'
  ...
# Subtest: steer on a missing child throws
ok 19 - steer on a missing child throws
  ---
  duration_ms: 0.296708
  type: 'test'
  ...
# Subtest: auditOrphans reports panes in the tab that the tree does not know about
ok 20 - auditOrphans reports panes in the tab that the tree does not know about
  ---
  duration_ms: 1.530166
  type: 'test'
  ...
# Subtest: restore rehydrates children from a persisted record
ok 21 - restore rehydrates children from a persisted record
  ---
  duration_ms: 1.051708
  type: 'test'
  ...
# Subtest: collect runs verification-output criteria and promotes attested to verified
ok 22 - collect runs verification-output criteria and promotes attested to verified
  ---
  duration_ms: 1.366041
  type: 'test'
  ...
# Subtest: collect reports blocked without waiting out the timeout
ok 23 - collect reports blocked without waiting out the timeout
  ---
  duration_ms: 1.027792
  type: 'test'
  ...
# Subtest: cachedCollect returns the snapshot after retire so a later collect is a no-wait
ok 24 - cachedCollect returns the snapshot after retire so a later collect is a no-wait
  ---
  duration_ms: 1.594416
  type: 'test'
  ...
# Subtest: approveBlocked sends y and lets collect run again
ok 25 - approveBlocked sends y and lets collect run again
  ---
  duration_ms: 1.222625
  type: 'test'
  ...
# Subtest: launch worktree:true is refused outside a git repo
ok 26 - launch worktree:true is refused outside a git repo
  ---
  duration_ms: 14.730708
  type: 'test'
  ...
# Subtest: launch worktree:true sets pane cwd and retire leaves the tree
ok 27 - launch worktree:true sets pane cwd and retire leaves the tree
  ---
  duration_ms: 136.841791
  type: 'test'
  ...
# Subtest: launch worktree: false opts out of the role default
ok 28 - launch worktree: false opts out of the role default
  ---
  duration_ms: 72.327666
  type: 'test'
  ...
# Subtest: launch worktree: true isolates even when the role did not default it
ok 29 - launch worktree: true isolates even when the role did not default it
  ---
  duration_ms: 165.801208
  type: 'test'
  ...
# Subtest: launch retries fallbackModels after a start failure
ok 30 - launch retries fallbackModels after a start failure
  ---
  duration_ms: 1.29875
  type: 'test'
  ...
# Subtest: completionGuard rejects a successful turn with no verdict JSON
ok 31 - completionGuard rejects a successful turn with no verdict JSON
  ---
  duration_ms: 1.524208
  type: 'test'
  ...
# Subtest: launch injects budget and nested-allow env into the pane
ok 32 - launch injects budget and nested-allow env into the pane
  ---
  duration_ms: 1.088125
  type: 'test'
  ...
# Subtest: probeProgress maps non-pi herdr labels onto the same live fields as jsonl
ok 33 - probeProgress maps non-pi herdr labels onto the same live fields as jsonl
  ---
  duration_ms: 2.657167
  type: 'test'
  ...
# Subtest: every kind starts via herdr then gets the task as agent prompt
ok 34 - every kind starts via herdr then gets the task as agent prompt
  ---
  duration_ms: 4.47425
  type: 'test'
  ...
# Subtest: cursor launch auto-installs a missing integration hook
ok 35 - cursor launch auto-installs a missing integration hook
  ---
  duration_ms: 1.726709
  type: 'test'
  ...
# Subtest: cursor launch probes the integration once per kind, not per launch
ok 36 - cursor launch probes the integration once per kind, not per launch
  ---
  duration_ms: 2.615208
  type: 'test'
  ...
# Subtest: cursor launch refuses cleanly when the hook cannot be installed
ok 37 - cursor launch refuses cleanly when the hook cannot be installed
  ---
  duration_ms: 0.309292
  type: 'test'
  ...
# Subtest: an older herdr without integration commands must not brick launches
ok 38 - an older herdr without integration commands must not brick launches
  ---
  duration_ms: 1.40475
  type: 'test'
  ...
# Subtest: pi launches never probe integrations
ok 39 - pi launches never probe integrations
  ---
  duration_ms: 0.872416
  type: 'test'
  ...
# Subtest: a hook that reports not-installed even after a successful install refuses the launch
ok 40 - a hook that reports not-installed even after a successful install refuses the launch
  ---
  duration_ms: 0.317875
  type: 'test'
  ...
# Subtest: pane collect does not attest a system-prompt template verdict
ok 41 - pane collect does not attest a system-prompt template verdict
  ---
  duration_ms: 4.244375
  type: 'test'
  ...
# Subtest: cursor collect sends enter when the pane is still a paste preview
ok 42 - cursor collect sends enter when the pane is still a paste preview
  ---
  duration_ms: 3.045458
  type: 'test'
  ...
# Subtest: cursor collect does not settle on an idle Working spinner (debugger 7s retire)
ok 43 - cursor collect does not settle on an idle Working spinner (debugger 7s retire)
  ---
  duration_ms: 3.625875
  type: 'test'
  ...
# Subtest: launch: an explicit model the kind cannot accept is refused, leaking no pane
ok 44 - launch: an explicit model the kind cannot accept is refused, leaking no pane
  ---
  duration_ms: 0.377125
  type: 'test'
  ...
# Subtest: launch: an INHERITED model the kind cannot accept is dropped, not refused
ok 45 - launch: an INHERITED model the kind cannot accept is dropped, not refused
  ---
  duration_ms: 1.574625
  type: 'test'
  ...
# Subtest: launch: a compatible model still launches for a non-pi kind
ok 46 - launch: a compatible model still launches for a non-pi kind
  ---
  duration_ms: 1.540292
  type: 'test'
  ...
# Subtest: launch: an incompatible candidate is skipped in favour of a usable fallback
ok 47 - launch: an incompatible candidate is skipped in favour of a usable fallback
  ---
  duration_ms: 1.624792
  type: 'test'
  ...
# Subtest: launch: the default origin treats an explicit `model` param as a choice
ok 48 - launch: the default origin treats an explicit `model` param as a choice
  ---
  duration_ms: 0.35425
  type: 'test'
  ...
# Subtest: launch: an agent with no model at all still launches
ok 49 - launch: an agent with no model at all still launches
  ---
  duration_ms: 0.941083
  type: 'test'
  ...
# Subtest: cursor collect nudges Enter when the pane shows the real launch banner
ok 50 - cursor collect nudges Enter when the pane shows the real launch banner
  ---
  duration_ms: 3.458333
  type: 'test'
  ...
# Subtest: every observed Tip wording reaches the nudge (wording must not matter)
ok 51 - every observed Tip wording reaches the nudge (wording must not matter)
  ---
  duration_ms: 9.387083
  type: 'test'
  ...
# Subtest: cursor collect reads the verdict from the chat store, not the pane
ok 52 - cursor collect reads the verdict from the chat store, not the pane
  ---
  duration_ms: 3.303084
  type: 'test'
  ...
# Subtest: cursor collect keeps waiting while the store has no answer yet
ok 53 - cursor collect keeps waiting while the store has no answer yet
  ---
  duration_ms: 3.843542
  type: 'test'
  ...
# Subtest: U6: a timed-out (running) collect leaves the child in `working`, not `awaiting`
ok 54 - U6: a timed-out (running) collect leaves the child in `working`, not `awaiting`
  ---
  duration_ms: 1.382375
  type: 'test'
  ...
# Subtest: U6: a terminal collect still marks the child `awaiting` (the change is running-only)
ok 55 - U6: a terminal collect still marks the child `awaiting` (the change is running-only)
  ---
  duration_ms: 1.090458
  type: 'test'
  ...
# Subtest: U7: a still-growing session file extends the collect deadline instead of reporting `running`
ok 56 - U7: a still-growing session file extends the collect deadline instead of reporting `running`
  ---
  duration_ms: 2.136291
  type: 'test'
  ...
# Subtest: U7: a quiet artifact still times out as `running` (no extension, no hang)
ok 57 - U7: a quiet artifact still times out as `running` (no extension, no hang)
  ---
  duration_ms: 1.204792
  type: 'test'
  ...
# (node:56055) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: regression: stopReason 'aborted' maps to aborted, not failed
ok 58 - regression: stopReason 'aborted' maps to aborted, not failed
  ---
  duration_ms: 1.297959
  type: 'test'
  ...
# Subtest: regression: absent stopReason is treated as a truncated stream (aborted)
ok 59 - regression: absent stopReason is treated as a truncated stream (aborted)
  ---
  duration_ms: 0.1215
  type: 'test'
  ...
# Subtest: regression: an UNRECOGNIZED stopReason is still reported as failed
ok 60 - regression: an UNRECOGNIZED stopReason is still reported as failed
  ---
  duration_ms: 0.097791
  type: 'test'
  ...
# Subtest: regression: collect() returns immediately when the turn already finished
ok 61 - regression: collect() returns immediately when the turn already finished
  ---
  duration_ms: 6.027541
  type: 'test'
  ...
# Subtest: isLastTurnComplete distinguishes settled, mid-tool, and unanswered turns
ok 62 - isLastTurnComplete distinguishes settled, mid-tool, and unanswered turns
  ---
  duration_ms: 0.227084
  type: 'test'
  ...
# Subtest: regression: collect aborts immediately after tab close mid-toolUse (F15)
ok 63 - regression: collect aborts immediately after tab close mid-toolUse (F15)
  ---
  duration_ms: 2.648459
  type: 'test'
  ...
# Subtest: regression: collect aborts immediately when tab close happens before any reply (F15)
ok 64 - regression: collect aborts immediately when tab close happens before any reply (F15)
  ---
  duration_ms: 2.711166
  type: 'test'
  ...
# Subtest: regression: the persisted child carries a real, unique ownerToken
ok 65 - regression: the persisted child carries a real, unique ownerToken
  ---
  duration_ms: 4.300083
  type: 'test'
  ...
# Subtest: regression: concurrent launches all succeed against a busy-pane window (F19/F20)
ok 66 - regression: concurrent launches all succeed against a busy-pane window (F19/F20)
  ---
  duration_ms: 5.525416
  type: 'test'
  ...
# Subtest: regression: launch() falls back to the agent's configured model
ok 67 - regression: launch() falls back to the agent's configured model
  ---
  duration_ms: 1.61275
  type: 'test'
  ...
# Subtest: regression: launch propagates lineage and depth to the child pane
ok 68 - regression: launch propagates lineage and depth to the child pane
  ---
  duration_ms: 2.048
  type: 'test'
  ...
# Subtest: regression: lineage also survives the new-tab fallback
ok 69 - regression: lineage also survives the new-tab fallback
  ---
  duration_ms: 1.31125
  type: 'test'
  ...
# Subtest: regression: active team env reaches split and tab children, but default omits it
ok 70 - regression: active team env reaches split and tab children, but default omits it
  ---
  duration_ms: 6.9925
  type: 'test'
  ...
# Subtest: regression: nesting beyond maxDepth is refused
ok 71 - regression: nesting beyond maxDepth is refused
  ---
  duration_ms: 0.558125
  type: 'test'
  ...
# Subtest: regression: childPath appends this run to the inherited lineage
ok 72 - regression: childPath appends this run to the inherited lineage
  ---
  duration_ms: 0.175792
  type: 'test'
  ...
# Subtest: regression: the spawn budget is enforced and reports remaining
ok 73 - regression: the spawn budget is enforced and reports remaining
  ---
  duration_ms: 2.035167
  type: 'test'
  ...
# Subtest: regression: an unlimited budget reports null remaining
ok 74 - regression: an unlimited budget reports null remaining
  ---
  duration_ms: 0.184583
  type: 'test'
  ...
# Subtest: regression: a name held by an unrelated live agent is avoided up front
ok 75 - regression: a name held by an unrelated live agent is avoided up front
  ---
  duration_ms: 1.080916
  type: 'test'
  ...
# Subtest: regression: a name claimed between check and start is retried, not fatal
ok 76 - regression: a name claimed between check and start is retried, not fatal
  ---
  duration_ms: 1.14175
  type: 'test'
  ...
# Subtest: regression: the session file follows a mid-launch rename
ok 77 - regression: the session file follows a mid-launch rename
  ---
  duration_ms: 1.056458
  type: 'test'
  ...
# Subtest: regression: split placement falls back to a new tab without HERDR_PANE_ID
ok 78 - regression: split placement falls back to a new tab without HERDR_PANE_ID
  ---
  duration_ms: 0.893917
  type: 'test'
  ...
# Subtest: regression: split placement is honoured when HERDR_PANE_ID is present
ok 79 - regression: split placement is honoured when HERDR_PANE_ID is present
  ---
  duration_ms: 1.4655
  type: 'test'
  ...
# Subtest: regression: same-type panes tile as a 3-column grid, not a vertical stack
ok 80 - regression: same-type panes tile as a 3-column grid, not a vertical stack
  ---
  duration_ms: 2.396917
  type: 'test'
  ...
# Subtest: regression: retiring the last child of a type closes the type tab
ok 81 - regression: retiring the last child of a type closes the type tab
  ---
  duration_ms: 2.028666
  type: 'test'
  ...
# Subtest: regression: an explicit new-tab placement never splits
ok 82 - regression: an explicit new-tab placement never splits
  ---
  duration_ms: 0.93775
  type: 'test'
  ...
# Subtest: regression: an unwritable run root fails with an actionable error
ok 83 - regression: an unwritable run root fails with an actionable error
  ---
  duration_ms: 0.647709
  type: 'test'
  ...
# Subtest: regression: a writable run root is unaffected
ok 84 - regression: a writable run root is unaffected
  ---
  duration_ms: 0.93875
  type: 'test'
  ...
# Subtest: regression: declared acceptance criteria reach the caller as a checklist
ok 85 - regression: declared acceptance criteria reach the caller as a checklist
  ---
  duration_ms: 1.395208
  type: 'test'
  ...
# Subtest: regression: an agent without criteria reports none
ok 86 - regression: an agent without criteria reports none
  ---
  duration_ms: 1.191125
  type: 'test'
  ...
# Subtest: regression: a multi-line task never lands in start argv (F38)
ok 87 - regression: a multi-line task never lands in start argv (F38)
  ---
  duration_ms: 0.967708
  type: 'test'
  ...
# Subtest: regression: same-type children share one tab as panes
ok 88 - regression: same-type children share one tab as panes
  ---
  duration_ms: 1.512958
  type: 'test'
  ...
# Subtest: regression: different agent types get different tabs
ok 89 - regression: different agent types get different tabs
  ---
  duration_ms: 1.391875
  type: 'test'
  ...
# Subtest: regression: a run tab is created even outside a herdr pane (headless)
ok 90 - regression: a run tab is created even outside a herdr pane (headless)
  ---
  duration_ms: 0.921125
  type: 'test'
  ...
# Subtest: regression: a later launch of the same type joins the existing type tab
ok 91 - regression: a later launch of the same type joins the existing type tab
  ---
  duration_ms: 1.783375
  type: 'test'
  ...
# Subtest: regression: a recycled type tab is replaced, not reused
ok 92 - regression: a recycled type tab is replaced, not reused
  ---
  duration_ms: 1.682208
  type: 'test'
  ...
# Subtest: regression: parallel same-type launches share one tab (two tool calls)
ok 93 - regression: parallel same-type launches share one tab (two tool calls)
  ---
  duration_ms: 1.693833
  type: 'test'
  ...
# Subtest: regression: an aborted turn must not inherit the previous turn's verdict (F39)
ok 94 - regression: an aborted turn must not inherit the previous turn's verdict (F39)
  ---
  duration_ms: 2.247625
  type: 'test'
  ...
# Subtest: regression: a hard-killed turn must not inherit the previous verdict either (F39)
ok 95 - regression: a hard-killed turn must not inherit the previous verdict either (F39)
  ---
  duration_ms: 1.22675
  type: 'test'
  ...
# Subtest: regression: a LATER turn's rejection must override an earlier acceptance (F39)
ok 96 - regression: a LATER turn's rejection must override an earlier acceptance (F39)
  ---
  duration_ms: 1.240792
  type: 'test'
  ...
# Subtest: regression: child tab lands in parent Space, not the focused Space
ok 97 - regression: child tab lands in parent Space, not the focused Space
  ---
  duration_ms: 1.211083
  type: 'test'
  ...
# Subtest: regression: new-tab placement pins to parent workspaceId under a focused Space
ok 98 - regression: new-tab placement pins to parent workspaceId under a focused Space
  ---
  duration_ms: 0.933375
  type: 'test'
  ...
# Subtest: regression: adopt does not steal a same-label tab from another Space
ok 99 - regression: adopt does not steal a same-label tab from another Space
  ---
  duration_ms: 0.98275
  type: 'test'
  ...
# Subtest: regression: HERDR_WORKSPACE_ID env pins when workspaceId is omitted
ok 100 - regression: HERDR_WORKSPACE_ID env pins when workspaceId is omitted
  ---
  duration_ms: 1.139583
  type: 'test'
  ...
# Subtest: regression: two parent panes in one Space get separate type tabs
ok 101 - regression: two parent panes in one Space get separate type tabs
  ---
  duration_ms: 2.461459
  type: 'test'
  ...
# Subtest: regression: retiring one parent does not tab-close another parent's pane
ok 102 - regression: retiring one parent does not tab-close another parent's pane
  ---
  duration_ms: 1.79175
  type: 'test'
  ...
1..102
# tests 102
# suites 0
# pass 102
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 662.378208
```

Mutation-check results (temporary copies; each expected regression was caught):

```text
MUTATION CAUGHT: control-fallback
not ok 1 - index mainline: revive finds a child filtered from the selected team and inherits team env
# pass 0
# fail 1

MUTATION CAUGHT: env-default
not ok 1 - index mainline: env=default overrides settings and is passed to a new tab
# pass 0
# fail 1

MUTATION CAUGHT: default-output
not ok 1 - listing and roster: default/no-warning text is byte-for-byte legacy; team lines are conditional
# pass 0
# fail 1

WORKTREE UNCHANGED BY TEMP-COPY MUTATION: yes
```

### MR/PR 与未决问题

- MR/PR: https://github.com/zzjcool/pi-herdr-subagents/pull/3
- 未决问题：无；最终验证序列中 typecheck、571 个 unit tests、102 个 integration tests 全部通过。
