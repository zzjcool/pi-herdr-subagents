# 计划：collect 超时误报修复（running≠failed，别孤儿化活着的 child）

## 0. 事故背景（为什么修）

worker-1 collect 30 分钟超时，但 agent 实际仍在推进（session jsonl 证实 07:44–07:47 连续活跃 tool call）。插件当时的行为链：

1. 通知报 "Background task **failed**"，正文却写 "still alive"——自相矛盾，误导主 agent
2. `watch()` 把 running 快照当终态处理：发（谎报的）通知 + `release(name)` 出跟踪表——之后真正完成无人通知，child 成孤儿（本次靠 continue 的 followChild re-watch 副作用意外救回）
3. `status` 显示 `state=awaiting`，主 agent 误以为"turn 已结束只差收尾"

三个根因：❶ `completionStatusOf("running")` 落兜底分支返回 failed；❷ watch 对 running 快照做终态处理；❸ `finishCollect` 无条件 awaiting + `finished` 缓存不排除 running。

## 1. 修复项（全部必修）

### A. watch() 对 running 快照按非终态处理 — `src/extension/runtime.ts`

`watch()` 内 `ensureCollect` 返回后，在 blocked 分支之后、`job.state = "awaiting"` 之前新增 running 分支：

```ts
if (snapshot.execution.status === "running") {
    // Not terminal: collect timed out but the agent is alive (F29
    // discriminator). A notice here would misreport "failed", and a
    // release would orphan the child — the eventual completion would
    // never surface. Re-arm instead: clear the settled collect promise
    // and watch again. collect() blocks until the next timeout, so this
    // is not a busy loop.
    job.state = "working";
    job.collectPromise = undefined;
    job.notified = false;          // 前一轮可能已被置位（防御）
    job.consumedByTool = false;    // 同上
    runtime.watch(name, opts);     // generation 递增，旧 watch 已 return
    return;
}
```

注意：
- 与 blocked-resume 分支（`next === "resume"`）同构，但**不走 handleBlocked**（没有审批要弹）
- `join` 簿记：成员从未 onTerminal，pending 仍包含它，无需 addPending（但调用一次无害，保持与 resume 分支对称也行——二选一，注释说明）
- generation 检查照旧：新 watch 前先确认 `job.generation === gen`（结构上 resume 分支怎么写就怎么写）
- `waitOne` 里那段"Skip this branch for a merely-running snapshot"注释的顾虑已被本修法解决（新 watch 的 collect 是全新调用、会阻塞到下一轮超时，不会立刻返回同一快照）——**更新那段注释**，说明 running 快照现在由 watch 自身 re-arm，waitOne 不需要也不应该自己触发 rewatch

### B. completionStatusOf 显式处理 running — `src/extension/notify.ts`

`executionStatus === "running"` 不可能再走到通知（A 已拦），但作为防御显式化：

- 方案（冻结）：`CompletionStatus` 联合类型追加 `"running"`，`completionStatusOf` 对 `"running"` 显式返回 `"running"`；`formatCompletionNotice` 开头若 `status === "running"` 抛 `Error("running snapshot is not a completion")`（fail loud，防回归）；调用方（runtime/join）在类型层面就不会再误传
- 若类型扩散导致 join.ts 的 `BufferedEntry` 等需要过滤，在 join.onTerminal 入口 `assert status !== "running"` 或类型排除——以最小扩散为准，但**不许静默映射回 failed**

### C. state 与 finished 缓存的终态语义

- `src/runs/orchestrator.ts` `finishCollect`：`execution.status === "running"` 时 `child.state` 保持 `"working"`（只有真终态才置 awaiting）
- `src/extension/runtime.ts` `ensureCollect`（:308 一带）：`finished.set` 条件从 `!snapshot.blocked` 改为 `!snapshot.blocked && snapshot.execution.status !== "running"`（过期 running 快照进缓存会让 wait/consumeCollect 拿它当终态）

### D. collect 超时的活跃度宽限 — `src/runs/orchestrator.ts`

collect 超时判定处（:1139 `timeoutMs` 附近的使用路径）：

- 超时到期时若 session 文件自上次 poll 仍在增长（复用 `waitForQuiet` 的尺寸探测思路），判定"仍在活跃推进"，延长 deadline 一次（常量 `COLLECT_GRACE_EXTENSIONS = 2`，即最多 2 次宽限，总等待 ≤ 3×timeoutMs）
- 只有"超时且文件静默"才返回 running 快照——此时 A 的 re-arm 会接管
- 若 collect 的实现结构让宽限很难插（比如超时在更底层），降级为：`resolveExecution` 已能区分，保持现状，在报告里写明放弃理由——**不许硬改出竞态**

### E. playbook 兜底文案 — `src/extension/playbook.ts`

PARENT_PLAYBOOK 追加（冻结文本）：

> "A completion notice reading `collect timed out … the agent is still alive` is a progress signal, not a verdict: the child keeps running and will notify again when it truly finishes. Check `status` and the child's session tail before deciding to steer or continue — a `continue` while it is mid-turn appends to its queue rather than interrupting."

`skills/pi-herdr-subagents/SKILL.md` 同步等价一句。

## 2. 测试清单

| # | 测试 | 文件 | 覆盖 |
|---|---|---|---|
| U1 | watch：collect 返回 `{execution:{status:"running"}}` → 不发任何通知、job 仍被跟踪（activeJobs 非空）、collectPromise 被清、随后第二次 collect 返回终态 → 通知正常送达 | runtime.test.ts | A |
| U2 | watch：running 快照后 re-arm 的新 watch 不会立刻把同一 running 快照再当终态（mock collect 第一次 running 第二次 success，断言只收到 1 条 success 通知、无 failed） | runtime.test.ts | A |
| U3 | completionStatusOf("running") === "running"；formatCompletionNotice 对 running 抛错 | notify.test.ts | B |
| U4 | join.onTerminal 收到 status:"running" 的 entry 时 fail loud（若采用类型排除则对应编译期测试） | join.test.ts | B |
| U5 | ensureCollect：running 快照不进 finished 缓存（后续 wait 拿不到过期快照） | runtime.test.ts | C |
| U6 | finishCollect：running 时 child.state 保持 working（若 orchestrator 层可单测；不可则用 store 断言，参考现有 orchestrator 测试模式） | 既有 orchestrator 测试文件 | C |
| U7 | D 若实现：文件仍增长 → deadline 延长 ≤2 次；文件静默 → 超时返回 running | orchestrator 测试 | D |
| U8 | playbook 文案断言（追加，与上轮 T7 同模式） | playbook.test.ts | E |

既有测试仍然只许追加；`src/herdr/client.ts`、`src/runs/store.ts` 不改。

## 3. 验收

```
npm run typecheck && npm test && npm run test:integration
```

全绿，且 U1–U8（U7 视 D 的落地形态）全部存在并被 mutation 思维检查过（删掉 A 的 re-arm 分支 U1/U2 必红；把 B 的抛错删掉 U3 必红）。

## 4. 风险与回滚

- A 的 re-arm 若与 rewatch/waitOne 的 collectPromise 清理交错，可能双 watch：generation 机制是既有防线，U2 覆盖
- B 的类型扩散若波及 api.ts 公共面，退回"抛错不动类型"的等价实现
- 回滚点：A–C 各自独立成 commit 语义块（一起提交也行，但 diff 内分块清晰），单独 revert 不伤 smart-join 主功能
