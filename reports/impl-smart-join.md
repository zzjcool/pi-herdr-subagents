# Smart join + wait 实施报告

分支 `wait-agent`，按 `reports/plan-smart-join.md` 冻结计划执行。改动未 commit，留在工作区（按任务硬性约束，由主 agent 验收后提交）。

## 改了哪些文件

| 文件 | 内容 |
|---|---|
| `src/extension/notify.ts` | 追加 `GroupedEntry` / `GroupedCompletionInput` / `formatGroupedNotice`（§1.2）：`Background tasks completed (N of M):` 头、每条 preview 上限 `max(500, 4000/entries)`、any-failed→failed 聚合、`Still running:` 行 |
| `src/extension/join.ts`（新） | `JoinCoordinator`（§1.1 含 §1.3 修正后的 JoinEntry：携带原始 `CompletionInput` + triggerTurn；deliver 收到 `Array<JoinEntry & {status}>`）。each 立即 deliver；smart 全终态立即 flush；窗口 per-group 经注入 `schedule`（默认 unref'd setTimeout）；parentBusy 延长 ≤3 次；`allSettled` / `remove` / `dispose` 齐 |
| `src/shared/types.ts` | `SubagentsSettings` 追加 `joinMode?: "each"\|"smart"`、`joinFlushMs?: number`（flat，同层） |
| `src/agents/settings.ts` | `joinMode` 枚举校验（`invalid 'joinMode'`）、`joinFlushMs` 走现有 `positiveInt`、`resolveSubagentSettings` 两个 key 各一行 project-over-user |
| `src/extension/runtime.ts` | §1.3 全量：`SessionRuntimeDeps.getJoinConfig`、`WaitResult`、`SessionRuntime.wait`、`setJoinConfig` 透传；watch 成功/失败路径改走 `join.onTerminal`（失败 input 用 `{status:"failed", reason:String(error)}`，与 formatCollectFailure 同源）；retire 仍在 watch 的 finally 立即执行；track/rewatch/block-resume `addPending`，release `join.remove`，dispose `join.dispose` |
| `index.ts` | `SubagentParams` 追加 `wait` action / `all` / `timeoutMs`；`controlAction` 前置校验（name 与 all 恰好一个，缺 → "`name` or `all` is required for wait"）；导出 `resolveWaitTargets` 纯函数；`waitAction` + `renderWait`（完成的复用 `renderCollect`，stillRunning → `── name ──\nstill running`，末尾 `N done, M still running`）；execute 中 `loadCatalog` 后 `runtime.setJoinConfig({mode, flushMs, parentBusy})`；`parentTurnActive` 由 `turn_start`/`turn_end` 维护布尔 |
| `src/extension/playbook.ts` | §1.6 冻结文本进第 3 条；Actions 行补 `wait`；`forbiddenDispatchReason` 未动（`herdr agent wait` 仍被拦，T7 已断言） |
| `skills/pi-herdr-subagents/SKILL.md` | 等价两行（合并通知说明 + wait 调用样例） |
| `test/unit/notify.test.ts` | 仅追加 T1 五项（合并/any-failed/单条退化/stillRunning/preview 截断） |
| `test/unit/agents-model.test.ts` | 仅追加 T2 三项（枚举校验/positiveInt/project 覆盖与缺省） |
| `test/unit/join.test.ts`（新） | T3 十一项：each 立即、全终态单条 flush、窗口部分 flush + 慢者新一轮立即 flush、busy 延长上限、idle 首次到期 flush、remove、failed status 保留、未 track 兜底直送、dispose 取消定时器、跨 run 独立 |
| `test/unit/runtime.test.ts` | 仅追加 T4a/T4b/T4d/T4e/T4f + T5a/T5b/T5c 八项（T4c 由既有第一条测试零修改通过即证） |
| `test/unit/wait-action.test.ts`（新） | T6 五项：all 取 working+blocked、空集报错、name 命中、name 未 track 报错文案、无 name/all 报错 |
| `test/unit/playbook.test.ts` | 追加 T7（merged/wait 文案断言 + `herdr agent wait` 仍被拦） |

## 新增接口（冻结面）

- `notify.ts`: `GroupedEntry`, `GroupedCompletionInput`, `formatGroupedNotice`
- `join.ts`: `JoinMode`, `DEFAULT_JOIN_MODE`, `DEFAULT_FLUSH_MS`, `MAX_BUSY_EXTENSIONS`, `JoinConfig`, `defaultJoinConfig`, `JoinEntry`, `JoinSchedulerHandle`, `JoinCoordinatorDeps`, `JoinCoordinator`
- `runtime.ts`: `SessionRuntimeDeps.getJoinConfig`, `WaitResult`, `SessionRuntime.wait`, `SessionRuntime.setJoinConfig`
- `index.ts`: `resolveWaitTargets`（导出，纯函数）

## 验证输出（原样）

```
$ npm run typecheck
> tsc --noEmit            # 通过，无输出

$ npm test                # node --experimental-strip-types --test test/unit/*.test.ts
# pass 453
# fail 0

$ npm run test:integration
# pass 91
# fail 0
```

约束核验：
- `git diff test/unit/{runtime,notify,agents-model}.test.ts` 删除行数均为 0（仅追加）
- `src/runs/orchestrator.ts`、`src/runs/store.ts`、`src/herdr/client.ts` 零改动
- `git status`: 10 modified + 3 untracked（join.ts、join.test.ts、wait-action.test.ts），无 commit

## 偏离计划之处及原因

1. **runtime deliver 的单条退化条件**（计划 §1.3 正文 vs 测试清单 T4b 的隐性冲突）：计划正文写「单 entry 组退化为一条 grouped notice」，但 T4b 要求窗口到期部分 flush 显示 `Background tasks completed (1 of 2)`，而 T4c/旧测试要求 settled 单条保留 `Background task completed: **name**` 旧格式。实现取 `batch.length===1 && (mode==="each" || allSettled(runId))` → 旧格式；窗口部分 flush 的单条 → grouped 格式（带 Still running 行）。每条路径都有测试锁定。
2. **wait 超时的定时器不 unref**：计划 §1.3 注 4 说「两个都 unref」指的是 flush 窗口与 refreshUi interval；wait 的 race 定时器若 unref，当它是事件循环唯一驱动时进程/测试 runner 会提前判定事件循环耗尽而取消测试（实测触发 cancelledByParent）。故 wait 定时器保持 ref，flush 窗口定时器仍 unref。
3. **Node strip-types 不支持 TS parameter property**：`JoinCoordinator` 构造函数由 `constructor(private readonly deps)` 改为显式字段赋值（运行时用 `--experimental-strip-types`）。
4. **waitAction 的 finished-cache 命中**：`resolveWaitTargets` 对不在 live 集的 name 返回 miss 后，`waitAction` 先用 `runtime.consumeCollect(name)` 探测 finished 缓存，命中则放行（T5c 链路），未命中才回 `unknownChild`（NOT_FOUND 文案）。计划只写了「name 未 track 且 finished 无缓存 → NOT_FOUND」，未写命中分支的探测方式，此处为补齐。
5. **wait 默认 timeout**：取目标 child 中角色 `timeoutMs`（agents 表）的最大值，全部缺省回退 `DEFAULTS.turnTimeoutMs`。计划写「默认 role turnTimeoutMs」，多目标场景取最大以覆盖最慢角色。

## 未 commit 说明

任务硬性约束「不 commit，改动留在工作区即可」与冻结子约束「commit on this branch and open MR」冲突，遵循任务级指令；无 MR 链接，待主 agent 验收提交。

---

## 审查修复轮（rev-correctness / rev-tests / rev-simplicity）

工作区：隔离 worktree `pi-subagent/worker-1-f8604b2d`（镜像 `wait-agent` 的未提交 smart-join 状态后在其上修复，不污染父 checkout）。基线复核：镜像后 453 pass / typecheck clean，与三份审查报告一致。

### 正确性 P1（必修）

**P1-1 wait() blocked 孤儿 —— 已修**
- 修法：`runtime.ts` waitOne 非终态分支在 `!job.watching` 时清 `collectPromise` + 复位 `notified` + 重启 `runtime.watch(name)`（generation 递增使旧 watch 残留路径全部失效；resume 分支自带 consumedByTool 复位，rewatch 路径不再触碰该 flag，无打架）。
- **修复中发现并规避的实现陷阱**：第一版对「非 blocked 但非终态（running）」快照也重启 watch——探针实测新 watch 会立即 collect 到同一份 running 快照并把它当终态发「Background task failed」+ release（等效旧 bug F32 类）。故 rewatch 限定为 `snapshot.blocked && !job.watching`；running 快照保持现状（pane 留、job 活、consumedByTool 复位）。
- 新测试（runtime.test.ts）：`a blocked snapshot yields stillRunning, keeps the job, and restarts the orphan watch`——blocked → wait → collect 第二次被调（watch 重启）→ 解除阻塞后通知照常落地、job 释放。
- Mutation：rewatch 条件改 `false` → 该测试精确红。

**P1-2 wait 超时 Math.max → Math.min —— 已修**
- index.ts waitAction 默认超时改 `Math.min(...targets timeoutMs ?? DEFAULTS.turnTimeoutMs)`，注释改为「strictest (smallest) role timeout … collect 到期会自行返回，超出部分只买到 suppress」。
- 新测试（wait-action-index.test.ts）：spy 断言传入 `runtime.wait` 的 timeoutMs === min(80, 60_000) === 80；role 表查不到时回退 `DEFAULTS.turnTimeoutMs`。
- Mutation：min→max → spy 断言精确红（第一版测试靠 wall-clock 区分会等 60s，已改为 spy 后 mutant 必死）。

### 测试缺口（rev-tests）

3. **T7 落实**：playbook.test.ts 追加 `playbook explains merged completion notices and the wait action`——断言 `merged and delivered as one grouped message` / `subagent({ action: "wait", all: true, timeoutMs })` / `(or \`wait\` with \`name\`)` / TOOL_DESCRIPTION `collect, wait, list`。
4. **M12/M13**：runtime.test.ts 新增两个 wait 非终态分支测试（blocked 快照、running 快照），断言 stillRunning:true + consumedByTool 复位 + job 仍 tracked + 不 retire。Mutation 复验：M12 删复位 → 2 红；M13 `||`→`&&` → 1 红。
5. **M9（index 层）**：新文件 `test/unit/wait-action-index.test.ts`——`waitAction`/`renderWait` 提为导出后直测：finished-cache 探测放行（M9 变异后精确红）、unknown child NOT_FOUND、renderWait 汇总行 `N done, M still running`。`name+all` 互斥 INVALID_PARAMS 在 controlAction 分发层、驱动它需完整 ExtensionAPI+herdr fake 接线，本轮未补（残余缺口，见末节）。
6. **M8**：T5a 追加「wait 后 track 同 runId 新 child → 干净单条 legacy 通知、无 stale Still running」；另加专项 `the hit path itself releases the job (no watch finally to hide it)`（不 watch、只 wait，删 release 无处可藏）。Mutation：M8 删 `runtime.release(name)` → 该测试精确红。
7. **T4e 补强**：resume 后断言 `Background task completed: **blocked-child (worker)**`（legacy 单条形状）+ `doesNotMatch /Background tasks completed \(/` + `doesNotMatch /Still running:/`。

### 正确性 P2（酌情修）

8. **grouped "Pane recycled" 行 —— 已修**：formatGroupedNotice 删聚合 footer，改为逐 entry 判定 `recycled !== false` 追加行内 `(pane recycled)`；doc 注释同步。notify.test.ts 追加 `recycle markers are per-entry, not a blanket footer`。
9. **双真相源 —— 已修（取报告第一方案）**：deliver sink 的 stillRunning 过滤追加 `!job.consumedByTool`——wait 命中竞态窗口内刚被 wait 认领的 job 不再计入 "Still running"。统一为「通知职责」单一语义，不引入第二个集合源。

### 简洁性 P1（全部执行）

10. **删 JoinCoordinatorDeps.now**：join.ts 删字段；runtime.ts 删透传；join.test.ts harness 删 `now: () => 1_000`。`schedule` 同时改为可选（`scheduleFn: NonNullable<…>`），runtime 不再传（下条）。
11. **getConfig 删除 / defaultJoinConfig 私有化**：deliver sink 的单条退化条件改读 runtime 本地镜像 `joinConfig`（`setJoinConfig` 同步更新）；`each` 模式判定保留在 sink 注释说明（each 批次绝不 partial）。defaultJoinConfig 降为非导出，join.test.ts 字面量断言替换为行为测试 `default config is smart with a 10s window (constructor-only)`（构造即用、窗口 10s）。api.ts 无这两个符号的消费者（grep 确认）。**按计划外 minimal 处理**：`getJoinConfig` dep 更名收窄为 `joinConfig?: JoinConfig`（构造时一次性给），消除双配置路径（simplicity P2-3 同源）。
12. **JoinSchedulerHandle 收窄**：保留接口不导出取消函数化——实际执行为删 runtime 内联 schedule 后该接口只剩 join.ts 自用+测试引用；接口保留 `{cancel}` 形状（计划 §1.1 冻结了 JoinSchedulerHandle，收窄为 `type Cancel` 会偏离冻结接口，故**不修**，理由：冻结计划点名该接口名，测试 manualSchedule 适配成本>收益；记录为知情偏差）。
13. **删 send 包装器 + inline schedule**：runtime.ts 删 `send`（deliver 直接 `{ sendMessage: deps.sendMessage }`），JoinCoordinator 构造不再传 `schedule`（用 join.ts 默认，unref 语义一致）。净 -20 行。
14. **collectFailureInput()**：notify.ts 导出 `collectFailureInput(name, error): CompletionInput`，`formatCollectFailure` 改为一行委托；runtime 失败分支改用它。notify.test.ts 既有断言全绿（Probe F 等价性保持）。
15. **DEFAULT_WAIT_TIMEOUT_MS**：改为 `const DEFAULT_WAIT_TIMEOUT_MS = DEFAULTS.turnTimeoutMs;`（引用 src/shared/types.ts 同一常量，值导入）。

### Mutation 复验汇总（/tmp 一次性副本，逐 mutant 恢复，工作区零污染）

| Mutant | 结果 | 杀手 |
|---|---|---|
| M12 删非终态 consumedByTool 复位 | 🔴 2 fail | blocked/running 快照两个新测试 |
| M13 `\|\|`→`&&` | 🔴 1 fail | running 快照测试 |
| M8 删 wait 命中 release | 🔴 1 fail | `the hit path itself releases the job` |
| M9 删 finished-cache 探测 | 🔴 1 fail | `a finished child is waitable via the finished-cache probe` |
| P1-2 min→max | 🔴 1 fail | strictest-role spy 断言 |
| P1-1 禁 rewatch | 🔴 1 fail | blocked 孤儿测试 |

幸存率 0/6（上轮 4/14 幸存全部清除）。

### 最终验证输出（原样）

```
$ npm run typecheck
> tsc --noEmit            # clean

$ npm test
# tests 463
# pass 463
# fail 0

$ npm run test:integration
# tests 91
# pass 91
# fail 0
```

约束核验：`git diff HEAD` 对 test/unit/{runtime,notify,agents-model,playbook}.test.ts 的既有测试删除行为 0（仅追加；本轮调整的两处均为上轮新增测试）；src/runs/orchestrator.ts、src/runs/store.ts、src/herdr/client.ts 零改动。

### 残余缺口（知情不修）

- `name+all` 互斥 INVALID_PARAMS 与完整 controlAction 分发路径仍无端到端测试（需 ExtensionAPI+herdr fake 全套接线，成本远超单行校验的价值）；resolveWaitTargets 层「无 name/all」分支已有 wait-action.test.ts 覆盖。
- 「watch 中 + running 快照」的 wait 后窗口期 job 提前 release 为 pre-existing 语义，本轮未改（rev-correctness 未列为 finding）。
