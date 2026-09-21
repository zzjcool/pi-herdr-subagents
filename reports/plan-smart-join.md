# 计划：subagent 完成通知合并交付（smart join + wait 原语）

## 0. 目标与不做的事

**目标**：`tasks[]` 派发的多个 child 完成后，通知按 runId 攒批合并送达（smart 模式默认）；新增 `action:"wait"` 显式等待原语，聚合返回被点名 child 的结果。

**Non-goals**：
- 不改 orchestrator/store 的 runId 产生与持久化（已就绪）。
- 不做跨 run 合并、不做全局通知路由。
- 不改 blocked 转发策略（`applyOnBlockedPolicy`）。
- 不给 wait 加 num_returns 语义（只有 name/all 两种目标集）。
- `wait` 只针对本 session runtime 内被 track 的 live child；未 track 的名字报错，不走 orchestrator 重建路径。

## 1. 冻结接口

### 1.1 `src/extension/join.ts`（新文件，组状态机独立模块）

```ts
import type { CompletionNotice } from "./notify.ts";

export type JoinMode = "each" | "smart";

export const DEFAULT_JOIN_MODE: JoinMode = "smart";
export const DEFAULT_FLUSH_MS = 10_000;
/** parent 忙时最多延长窗口的次数（总窗口 ≤ (1+3)×flushMs）。 */
export const MAX_BUSY_EXTENSIONS = 3;

export interface JoinConfig {
	mode: JoinMode;
	flushMs: number;
	/** 感知 parent 是否在 in-flight turn；缺省视为不忙。 */
	parentBusy?: () => boolean;
}

/** 默认配置：smart / 10s。 */
export function defaultJoinConfig(): JoinConfig;

export interface JoinEntry {
	runId: string;
	name: string;
	/** 已用 formatCompletionNotice/formatCollectFailure 预格式化的单 child 结果。 */
	notice: CompletionNotice;
	/** 来自触发本次 collect 的 watch() 调用参数。 */
	triggerTurn: boolean;
}

export interface JoinSchedulerHandle {
	cancel: () => void;
}

export interface JoinCoordinatorDeps {
	now: () => number;
	/** 可注入的定时器（默认 setTimeout + unref），测试用手动触发。 */
	schedule: (ms: number, fn: () => void) => JoinSchedulerHandle;
	/** 组 flush 的唯一出口：runtime 传入 deliverCompletion 包装。 */
	deliver: (entries: JoinEntry[]) => void;
}

/**
 * runId 分组的通知攒批状态机。纯协调器：不持有 job、不碰 UI、不 retire。
 *
 * 状态机（smart 模式，单个 runId 组）：
 *  - pending:   已 track、未终态的成员（track 时 addPending；rewatch/block-resume 重新 addPending）
 *  - buffered: 已终态、等 flush 的 JoinEntry（watch 完成/失败时 onTerminal）
 *  - flushed:   已 deliver，无状态保留
 *
 * 判定（onTerminal 时）：
 *  1. mode==="each" → 立即 deliver（单条，等价旧行为）
 *  2. 该成员从 pending 移除后 pending 为空（含 blocked 成员被排除的计算，见下）
 *     → 立即 flush 全部 buffered
 *  3. 否则入 buffered；窗口从本组第一个 onTerminal 起算 flushMs
 *
 * 窗口到期：
 *  - parentBusy() 为真且已延长次数 < MAX_BUSY_EXTENSIONS → 重新起一个 flushMs 窗口
 *  - 否则 flush 当前 buffered；pending 保留，慢者完成后自行再走一轮判定
 *    （届时 pending 为空 → 立即 flush 只含它的新一批）
 *
 * blocked 成员：不 terminal、也不参与"pending 是否为空"的判定
 *  （即不阻塞组 flush）；resume 后重新 addPending。
 */
export class JoinCoordinator {
	constructor(deps: JoinCoordinatorDeps);
	getConfig(): JoinConfig;
	setConfig(config: JoinConfig): void;
	/** track()/rewatch() 时登记。 */
	addPending(runId: string, name: string): void;
	/** release()/retire 后清理簿记。 */
	remove(name: string): void;
	/** 终态入口（成功走 formatCompletionNotice，失败走 formatCollectFailure）。 */
	onTerminal(entry: JoinEntry): void;
	/** 仅计非 blocked pending 成员是否为空。 */
	allSettled(runId: string): boolean;
	/** 取消全部定时器并清空状态（runtime.dispose 调用）。 */
	dispose(): void;
}
```

### 1.2 `src/extension/notify.ts`（追加）

```ts
export interface GroupedEntry extends CompletionInput {
	status: CompletionStatus;
}

export interface GroupedCompletionInput {
	/** 未传则省略 run 头行。 */
	runId?: string;
	entries: GroupedEntry[];
	/** flush 时仍在跑的成员名（部分 flush 场景）。 */
	stillRunning?: string[];
}

/**
 * 合并通知格式：
 *   Background tasks completed (2 of 3):
 *   - worker-0 (worker): completed — acceptance: accepted (attested)
 *     <previewOutput，单条上限 max(500, PREVIEW_CHARS/entries.length)>
 *   - reviewer-1: failed (model error)
 *     ...
 *   Still running: slow-2 (notifies separately when it finishes)
 *   Pane recycled. Resume from session files if you need a child again.
 *
 * status: any failed → "failed"；else any stopped → "stopped"；else "completed"。
 * display: status !== "completed"。
 */
export function formatGroupedNotice(
	input: GroupedCompletionInput,
): CompletionNotice;
```

`deliverCompletion` / `completionDeliveryOptions` / `SUBAGENT_NOTIFY_TYPE` 不变——grouped notice 复用同一条 `sendMessage` 通道，options 仍为 `followUp + triggerTurn`。

### 1.3 `src/extension/runtime.ts`（修改）

```ts
export interface SessionRuntimeDeps {
	sendMessage: SendMessageApi["sendMessage"];
	emitBusy?: (active: boolean, label?: string) => void;
	now?: () => number;
	refreshMs?: number;
	probeMs?: number;
	/** 攒批配置 getter；缺省 defaultJoinConfig()。 */
	getJoinConfig?: () => JoinConfig;
}

export interface WaitResult {
	name: string;
	/** 终态快照（wait 命中或超时前完成）。 */
	snapshot?: CollectSnapshot;
	/** 超时未完成。 */
	stillRunning?: boolean;
}

export interface SessionRuntime {
	// ...现有成员不变...
	/** 显式等待：对目标 child 设 consumedByTool 抑制自动通知，聚合返回。 */
	wait(
		names: string[],
		opts?: { timeoutMs?: number },
	): Promise<WaitResult[]>;
}
```

runtime 内部改动（worker 按此实现，不再自行设计）：

1. 构造 `JoinCoordinator`，`deliver` = `(entries) => entries` **不可**逐条送——flush 时把 buffered entries 合成**一条** `formatGroupedNotice`（单 entry 组退化为一条 grouped notice；`mode==="each"` 或单成员组在 coordinator 内部立即 deliver 单条 `formatCompletionNotice` 的 notice content）。具体：
   - coordinator 的 `deliver(entries)` 收到的 entries 已含预格式化 `CompletionNotice`；flush 出口用 `formatGroupedNotice` 把 entries 的原始 `CompletionInput` 合并——因此 **JoinEntry 需携带原始 `CompletionInput`**。修正冻结：
     ```ts
     export interface JoinEntry {
     	runId: string;
     	name: string;
     	/** 原始输入，flush 时喂 formatGroupedNotice。 */
     	input: CompletionInput;
     	/** collect 抛错时构造的 failed 输入（formatCollectFailure 同源）。 */
     	triggerTurn: boolean;
     }
     ```
     coordinator 内部对每个 entry 先算 `status = completionStatusOf(...)`；`deliver` 收到 `Array<JoinEntry & {status}>`。
2. `watch()` 的成功/失败通知改为：
   ```ts
   if (!job.consumedByTool && !job.notified) {
   	job.notified = true;
   	join.onTerminal({
   		runId: job.runId, name: job.name,
   		input: { name: job.name, agent: job.agent, execution: snapshot.execution,
   		         output: snapshot.output, sessionFile: job.sessionFile,
   		         acceptance: snapshot.acceptance,
   		         recycled: shouldRecycleAfterCollect(snapshot.execution.status) },
   		triggerTurn,
   	});
   }
   ```
   失败路径同样 `onTerminal`（input 用 `{name, execution:{status:"failed",reason:String(error)}, output:String(error), recycled:false}`）。**retire 仍在 watch 的 finally 里立即执行**——pane 回收与通知攒批解耦，不推迟。
3. `track()` 时 `join.addPending(input.runId, input.name)`；`rewatch()` 重置后再次 `addPending`；`release()` 时 `join.remove(name)`；`dispose()` 时 `join.dispose()`。
4. **定时器关系**：flush 窗口是 coordinator 内 per-group `setTimeout`（经 `schedule` 注入，默认实现 `t => { const id = setTimeout(fn, ms); id.unref?.(); return { cancel: () => clearTimeout(id) } }`），与 500ms `refreshUi` `setInterval` 完全独立、互不引用；两个都 unref，`dispose` 双清。现有测试传冻结 `now:()=>1_000` 不受影响——单 child 组路径不经过定时器。
5. `wait(names, opts)` 实现：
   - 逐个：`job = jobs.get(name)`；若 job 存在：`job.consumedByTool = true; const p = ensureCollect(job);` 与 `timeoutMs`（默认 `DEFAULTS.turnTimeoutMs`）race；
     - 命中：返回 `{name, snapshot}`；`shouldRecycleAfterCollect` 时走 `job.retire?.()`，然后 `release(name)`（persist 已由 ensureCollect 内的 `job.persist` 完成）；
     - 超时：**重置 `job.consumedByTool = false`**（watch 在飞，完成时自动通知/smart join 照常），返回 `{name, stillRunning: true}`；
   - job 不存在：查 `finished` 缓存 → `{name, snapshot: cached}`；都没有 → `{name, missing: true}`（index 层预校验后不应出现，仅兜底）。

### 1.4 settings（`src/shared/types.ts` + `src/agents/settings.ts`）

```ts
// SubagentsSettings 追加（flat，与 defaultModel 等同层）：
	/** 完成通知合并模式。默认 "smart"。 */
	joinMode?: "each" | "smart";
	/** smart 模式组 flush 窗口（ms）。默认 10000。 */
	joinFlushMs?: number;
```

- `parseSubagentSettings`：`joinMode` 用枚举校验（非 `"each"|"smart"` 抛 `invalid 'joinMode'`）；`joinFlushMs` 用现有 `positiveInt`。
- `resolveSubagentSettings`：project 覆盖 user，两个 key 各一行 if。
- index.ts 在 `execute()` 的 `loadCatalog` 之后：`runtime.setJoinConfig?.(...)` —— 不对，config 在 coordinator 上。冻结为 runtime 新增透传：`SessionRuntime.setJoinConfig(config: JoinConfig): void`（转发给内部 coordinator）。

### 1.5 工具参数（根 `index.ts`）

```ts
// SubagentParams 追加：
	action union 追加 Type.Literal("wait")
	all: Type.Optional(Type.Boolean({ description:
		"wait: wait for every currently-running child in this session" })),
	timeoutMs: Type.Optional(Type.Number({ description:
		"wait: per-child timeout in ms (default: role turnTimeoutMs)" })),
```

`controlAction` 前置校验：`action==="wait"` 时 `name` 与 `all` 恰好一个（都无 → INVALID_PARAMS "`name` or `all` is required for wait"；都有 → INVALID_PARAMS）。

`waitAction`（新导出纯函数便于测试）：

```ts
export function resolveWaitTargets(
	params: { name?: string; all?: boolean },
	jobs: Array<{ name: string; state: string }>,
): { ok: true; names: string[] } | { ok: false; message: string };

async function waitAction(input: {
	params: SubagentParams; runtime: SessionRuntime;
	agents: AgentConfig[]; store: RunStore; found?: ...;
}): Promise<AgentToolResult<unknown>>;
```

- `resolveWaitTargets`：`all` → runtime.activeJobs() 中 state 为 `"working"` 或 `"blocked"` 的全部；`name` → 单元素（若该 name 不在 activeJobs 且 `finished` 无缓存 → NOT_FOUND，复用 unknownChild 文案）。
- 结果渲染 `renderWait(results)`（index.ts 内，非导出）：完成的逐个复用现有 `renderCollect(name, snapshot)`；`stillRunning` → `── name ──\nstill running`；末尾一行汇总 `N done, M still running`。

### 1.6 文案（playbook.ts + skills）

`PARENT_PLAYBOOK` 第 3 条后补一句（冻结文本）：

> "Parallel children launched together finish at different times; their completion notices are merged and delivered as one grouped message — read it once and synthesize a combined summary instead of reacting per child. If you need first-finished-first or know runtimes differ wildly, call `subagent({ action: "wait", all: true, timeoutMs })` (or `wait` with `name`) to block for results."

`TOOL_DESCRIPTION` 的 Actions 行补 `wait`。`skills/pi-herdr-subagents/SKILL.md` 同步补等价两行。playbook 检测器 `forbiddenDispatchReason` **不改**——`herdr agent wait` 仍应被拦（wait 走 subagent 工具）。

## 2. 步骤拆分（含并行标注）

### S1（三者可并行，互不依赖）

**S1a — notify.ts：grouped 格式**
- 文件：`src/extension/notify.ts`，`test/unit/notify.test.ts`
- 接口：§1.2
- 验收：`formatGroupedNotice` 新单测（见 §3 测试清单 T1）；`npm run typecheck && npm test` 全绿，现有 notify 测试零改动。

**S1b — settings：joinMode/joinFlushMs**
- 文件：`src/shared/types.ts`，`src/agents/settings.ts`，`test/unit/agents-model.test.ts`
- 接口：§1.4
- 验收：parse 校验 + resolve 覆盖新单测（T2）；全绿。

**S1c — join.ts：JoinCoordinator**
- 文件：新增 `src/extension/join.ts`，新增 `test/unit/join.test.ts`
- 接口：§1.1（含修正后的 JoinEntry）
- 关键实现约束：coordinator 自带 `schedule` 默认实现（unref）；测试用手动 `schedule`（记录 fn，测试里同步调）+ 可控 `now`。
- 验收：状态机全路径单测（T3）；全绿。

### S2 — runtime 集成（依赖 S1a + S1c）

- 文件：`src/extension/runtime.ts`，`test/unit/runtime.test.ts`
- 接口：§1.3（watch 改造 + `wait()` + `setJoinConfig` + track/release/dispose 挂钩）
- 实现要点：retire 不推迟；失败路径也走 onTerminal；`getJoinConfig` 缺省 `defaultJoinConfig()`。
- 验收：现有 runtime 测试**零改动全绿**（单 child 组即时通知保证零回归）；新增 T4 系列测试；`npm test` 全绿。

### S3 — 工具接线（依赖 S2 + S1b）

- 文件：根 `index.ts`，`test/unit/wait-action.test.ts`（新）
- 接口：§1.5（params、resolveWaitTargets、waitAction、renderWait）；execute 中 `loadCatalog` 后 `runtime.setJoinConfig({ mode: settings.joinMode ?? "smart", flushMs: settings.joinFlushMs ?? 10000, parentBusy: () => parentTurnActive })`——`parentTurnActive` 由现有 `turn_start`/`turn_end` 事件绑定处维护（index.ts 已 bind 这些事件，加一个布尔翻转即可）。
- 验收：resolveWaitTargets 纯函数单测（T6）；typecheck + 全测试绿。

### S4 — 文案（与 S3 并行；S3 冻结了文本，文件不相交）

- 文件：`src/extension/playbook.ts`，`skills/pi-herdr-subagents/SKILL.md`
- 内容：§1.6 冻结文本；`test/unit/playbook.test.ts` 若断言 playbook 全文需同步（先跑测试确认）。
- 验收：`npm test` 绿。

## 3. 测试清单（按步骤映射）

| # | 测试 | 文件 | 覆盖 |
|---|---|---|---|
| T1 | formatGroupedNotice：多 entry 合并、any-failed → display/failed、单 entry 退化、stillRunning 行、每条 preview 截断 | notify.test.ts | S1a |
| T2 | joinMode 枚举校验抛错、joinFlushMs positiveInt、project 覆盖 user、默认缺省 | agents-model.test.ts | S1b |
| T3 | coordinator：each 立即 deliver；多成员全终态立即 flush 一条；窗口到部分 flush；慢者完成后新一轮立即 flush；blocked 不阻塞 allSettled；parentBusy 延长 ≤3 次；dispose 取消定时器 | join.test.ts | S1c |
| T4a | runtime：同 runId 双 child 攒批 → 恰好 1 条 grouped 通知（含两名、双 verdict） | runtime.test.ts | S2 |
| T4b | runtime：flushMs 到（用小窗口 50ms + 真 timer + waitFor）→ 部分 flush；慢者随后单独 flush | runtime.test.ts | S2 |
| T4c | runtime：单 child smart 模式零回归（现有第一条测试不改即证） | runtime.test.ts | S2 |
| T4d | runtime：joinMode "each" 多 child 逐条通知（数量=child 数） | runtime.test.ts | S2 |
| T4e | runtime：blocked child 存在时其余终态仍按窗口 flush；block 恢复（rewatch）后重新入组 | runtime.test.ts | S2 |
| T4f | runtime：retire 在攒批期间照常立即执行（不等 flush） | runtime.test.ts | S2 |
| T5a | runtime.wait：聚合返回双 child 的 verdict+输出；双方 pane recycle、job release | runtime.test.ts | S2 |
| T5b | runtime.wait：超时 → stillRunning，consumedByTool 复位，之后自动通知照常送达 | runtime.test.ts | S2 |
| T5c | runtime.wait：已完成 child（finished 缓存）立即返回；未 track 名字 → missing | runtime.test.ts | S2 |
| T6 | resolveWaitTargets：all 取 working+blocked；name 未 track 报错文案；name+all 冲突 | wait-action.test.ts | S3 |
| T7 | playbook 文本含 wait/合并说明（如现有测试为全文断言则同步） | playbook.test.ts | S4 |

## 4. 风险点与回滚

1. **单 child / each 模式回归**（最高风险）：保证 = onTerminal 移除自身后 pending 为空即立即 deliver，路径与旧代码等价；T4c/T4d 专项。回滚：settings `joinMode:"each"` 可运行时关掉 smart 行为；代码级回滚点 = S2 单独 revert（S1 是纯新增，revert S2 即恢复旧通知路径）。
2. **wait 与自动通知双重交付**：`consumedByTool` 在超时路径必须复位（`stillRunning` 分支），且 watch 在飞时共享同一 `collectPromise`——若复位数值时序错了会出现「工具返回 + 又通知」双份。T5b 专项；S2 内聚，revert S3 即整体退回（wait 是纯增量入口）。
3. **flush 定时器泄漏/与 refreshUi 打架**：两个 timer 完全独立、都 unref、dispose 双清；coordinator `schedule` 注入使测试不依赖真时钟。风险低，但 dispose 顺序（jobs 清了但 coordinator 定时器还在 → deliver 到已 dispose session）由 `deliver` 内 try/catch（deliverCompletion 已有）兜底。

## 5. 验收标准（机器可查）

```
cd /root/.herdr/worktrees/herdr-subagents/wait-agent
npm run typecheck && npm test && npm run test:integration
```

全部通过，且 `git diff test/unit/runtime.test.ts` 中**既有测试无删除/修改**（只允许追加），`test/unit/notify.test.ts`、`test/unit/agents-model.test.ts` 同理只追加。本计划不改 `src/runs/orchestrator.ts`、`src/runs/store.ts`、`src/herdr/client.ts`。

---

**P2 评估结论（任务问的第 3 条判定）**：parent 忙闲**可以感知**——index.ts 已经绑定 `turn_start`/`turn_end` 事件（bindUi 挂在这两个事件上），维护一个布尔即可。故不做 P2 删除，实现为「窗口到期 + parentBusy → 重开窗口，最多 MAX_BUSY_EXTENSIONS=3 次后强制 flush」，避免 parent 长忙 + 一个 blocked child 导致已完成者永不通知。

**runId 链路结论**：已在 `TrackedJobInput.runId`（必填），`launchFamily→followLaunched`（session.runId）与 `controlAction→followChild`（found.runId）两条链路全覆盖，本次零改动；组状态机放独立模块 `src/extension/join.ts`（coordinator 不持有 job/UI/retire 职责，runtime 只做挂钩）。

```json
{"ok": true, "reason": "plan ready, 5 phases (S1a/S1b/S1c parallel, S2, S3+S4 parallel); note: read-only planner could not write reports/plan-smart-join.md — full plan delivered inline for a worker to persist"}
```
