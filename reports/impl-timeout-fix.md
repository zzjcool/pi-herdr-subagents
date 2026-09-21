# 实现报告：collect 超时误报修复

- 工作区：`/root/.herdr/worktrees/herdr-subagents/wait-agent`，分支 `wait-agent`，基线 `8763e42`
- 计划：`reports/plan-timeout-fix.md`（接口/行为按 §1 冻结）
- 约束遵守：**未 commit**（改动全部留在工作区，由主 agent 验收后提交）；未改 `src/herdr/client.ts`、`src/runs/store.ts`；既有测试只追加

## 1. 每项修复的处置

### A. watch 对 running 快照 re-arm — `src/extension/runtime.ts`（实施）
`watch()` 内 `ensureCollect` 返回后、`job.state = "awaiting"` 之前新增 running 分支（位于 blocked 分支之后）：

```ts
if (snapshot.execution.status === "running") {
    job.state = "working";
    job.collectPromise = undefined;
    job.notified = false;
    job.consumedByTool = false;
    join.addPending(job.runId, job.name);
    runtime.watch(name, opts);
    return;
}
```

- **与 blocked-resume 同构但走独立分支**：不调用 `handleBlocked`（无审批要弹）；调用 `join.addPending`（对 Set 是幂等 no-op，注释已说明"成员从未 onTerminal、pending 仍含它，重加无害且与 resume 分支对称"）。
- **generation 检查照旧**：沿用 `if (disposed || job.generation !== gen) return;`；新 `runtime.watch` 自增 generation，旧 watch 立即返回，无双重 watch。U2 覆盖。
- **同步更新了 waitOne 注释**：原文"Skip this branch for a merely-running snapshot — a fresh watch would re-collect the SAME running snapshot..."改为说明 running 快照现在由 watch 自身 re-arm（re-arm 的 collect 是全新调用、会阻塞到下一轮超时，不会立刻返回同一快照），waitOne 不需要也不应该自己触发 rewatch。

### B. completionStatusOf 显式 running + fail loud — `src/extension/notify.ts`（实施）
- `CompletionStatus` 联合类型追加 `"running"`。
- `completionStatusOf` 首行对 `"running"` 显式返回 `"running"`（不再落 `failed` 兜底）。
- `formatCompletionNotice` 开头：`status === "running"` 时 `throw new Error("running snapshot is not a completion")`。
- 类型扩散处理：`join.ts` 的 `BufferedEntry` 只需 `status` 为 `CompletionStatus`，**无需额外过滤**（扩散为零，未触及 `api.ts` 公共面）。在 `JoinCoordinator.onTerminal` 入口加了显式 fail-loud 抛错（U4），**没有任何静默映射回 failed 的路径**。

### C. state 与 finished 缓存的终态语义（实施）
- `src/runs/orchestrator.ts` `finishCollect`：`if (execution.status !== "running") child.state = "awaiting";` —— running 时保持 `working`。
- `src/extension/runtime.ts` `ensureCollect`：`finished.set` 条件加了 `&& snapshot.execution.status !== "running"`，过期 running 快照不再进缓存。

### D. collect 超时活跃度宽限 — `src/runs/orchestrator.ts`（实施，未降级）
先读了 :1139 附近结构再动手，结论是**能干净插入**：超时判定发生在 `awaitTurn`/`awaitHerdrSettle` 返回 `"timeout"` 之后、`finishCollect` 之前，是一个纯顺序点，不是更底层的竞态。实现：

- 常量 `COLLECT_GRACE_EXTENSIONS = 2`（导出，便于测试引用）。
- 在首次 wait 之后加一个有界 for 循环：每次用新助手 `collectArtifactGrowing(child, chatDir)` 探测（cursor 取 `chatDir/store.db`，否则取 session jsonl；采样一次 → `sleep(pollIntervalMs)` → 再采样，比对 size 差值），**文件仍在增长**则 `deadline += timeoutMs` 并重新 `awaitTurn`/`awaitHerdrSettle`；**静默则 break**，保持原超时 → 返回 running 快照 → 由 A 的 re-arm 接管。
- **无竞态**：严格顺序（探测 → 延长 → 再等），不存在第二个并发 waiter；`wait` 变量由 `const` 改 `let`，`deadline` 由 `const` 改 `let`。
- 新增私有方法 `collectArtifactGrowing` 与文件级纯函数 `artifactSize`。刻意不复用 `waitForQuiet`（它在"安静"时返回，会丢掉我们真正想要的"仍在增长"答案）。
- 边界：文件不存在/不可读（size 0）→ `false` → 不宽限，保持普通超时。总等待 ≤ (1+2)×timeoutMs。

### E. playbook 兜底文案（实施）
- `src/extension/playbook.ts` `PARENT_PLAYBOOK` 新增第 5 条（冻结文本原样），原第 5 条"Isolation is YOUR call"顺延为第 6 条。
- `skills/pi-herdr-subagents/SKILL.md` 新增等价一段（progress signal, not a verdict / will notify again / `continue` mid-turn appends to queue）。

## 2. 测试清单（U1–U8 全部存在）

| # | 测试 | 文件 | 结果 |
|---|---|---|---|
| U1 | watch 收到 running → 不通知、仍被跟踪、collectPromise 清、第二次 collect 终态后正常通知 | runtime.test.ts | ✅ |
| U2 | re-arm 的新 watch 不把同一 running 快照当终态（1 条 success、无 failed）；且 re-arm 不误入 join 组（仍 `Still running: live`） | runtime.test.ts | ✅ |
| U3 | `completionStatusOf("running")==="running"`；`formatCompletionNotice` 对 running 抛错；永不误报 failed | notify.test.ts | ✅ |
| U4 | `join.onTerminal` 收到 running entry 抛错（单条 + 混入批次两种） | join.test.ts | ✅ |
| U5 | running 快照不进 finished 缓存（consumeCollect/wait 均拿不到）；终态快照仍缓存 | runtime.test.ts | ✅ |
| U6 | `finishCollect`：running → child.state 保持 `working`；终态 → `awaiting` | integration/orchestrator.test.ts | ✅ |
| U7 | D 已落地：文件仍增长 → deadline 延长（elapsed > timeoutMs）并拿到 success；文件静默 → 返回 running 且不延长 | integration/orchestrator.test.ts | ✅ |
| U8 | playbook 文案断言（progress signal / notify again / appends to its queue） | playbook.test.ts | ✅ |

**既有测试只允许追加**：`test/` 下总删除行 = **1**，即 `notify.test.ts:20` 的 `assert.equal(completionStatusOf("running"), "failed")`。这一行**直接钉死了 B 要修的 bug 本身**（把 running 断言为 failed），必须翻转，无法"只追加"。除此之外既有测试零删除。计划未把该行列入例外，此处按 U3 的冻结语义处理并在此明示。

## 3. Mutation 自检（删掉必红，改完恢复）

| 目标 | 变异 | 结果 |
|---|---|---|
| A re-arm 分支 | 整段删除 | U1/U2 ×3 全红（`collectCalls` 停在 1、job 被 release、报 failed）→ 恢复后 28/28 绿 |
| B 抛错 + running 映射 | 同时删掉 notify/join 的 running 抛错与显式映射 | U3 ×3 + U4 ×2 + 旧断言全红（6 fail）→ 恢复后 33/33 绿 |
| C finished 缓存排除 | 条件还原为 `!snapshot.blocked` | U5 红（consumeCollect 拿到过期 running 快照）→ 恢复后绿 |
| C finishCollect 状态 | 还原为无条件 `child.state = "awaiting"` | U6 红 → 恢复后绿 |
| D 宽限循环 | 整段删除 | U7(growing) 红 → 恢复后绿 |

## 4. 验证输出（原样）

```
$ npm run typecheck
> @zzjcool/pi-herdr-subagents@0.6.1 typecheck
> tsc --noEmit
（exit 0，无输出）

$ npm test
# tests 474
# suites 0
# pass 474
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 29887.646107

$ npm run test:integration
# tests 95
# pass 95
# fail 0
# duration_ms 854.975553
```

三项全绿。

## 5. 未决问题 / 说明

1. **无 MR / 无 commit**：按任务硬性约束"不 commit，改动留在工作区"，本轮未提交、未 push、未开 MR。改动清单（`git status`）：
   `skills/pi-herdr-subagents/SKILL.md`、`src/runs/orchestrator.ts`、`src/extension/{runtime,notify,join,playbook}.ts`、`test/unit/{runtime,notify,join,playbook}.test.ts`、`test/integration/orchestrator.test.ts`（+556 −19，不含未跟踪的 plan 文档）。
2. **额外的最小清理**：`src/extension/runtime.ts` 顶层 `let ctx` 是 write-only（仅 `bind`/`dispose` 赋值、无读取），HEAD 处即如此。被 lint 以 🔴 报出后删除了这个死变量及其两处赋值（行为等价，`board.bind` 仍持有 UI 句柄）。这是 A 改动文件内的死代码清理，与 plan 的 A 同文件、无接口影响；如在评审中认为超出授权，可单独 revert 该 3 行。
3. **D 的宽限上限语义**：实现为"每次延长一个完整 `timeoutMs`"，故总等待 ≤ 3×timeoutMs（与计划 §1.D 一致）；`deadline += timeoutMs` 而非 `now + timeoutMs`，以免探测消耗的 poll 轮次把上界撑破。
