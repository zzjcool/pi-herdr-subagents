# 调研：父 agent 等待异步回调时，herdr 误判为"完成"

日期：2026-09-23
结论状态：调研完成，方案待定夺

## 现象

subagent 异步执行（工具立即返回、子 agent 在自己的 pane 里跑），父 agent
本回合结束后停下等待完成回调。此时父 pane 在 herdr 侧边栏/agent 面板被判定为
完成（idle），实际上父 agent 处于"编排等待"状态——pi 的 TUI 状态栏还能看到
`⏳ N subagents (…)`，但 herdr 层面状态是 done。

## 根因

### 状态权威在 herdr 的集成文件，不在插件

herdr 通过 `~/.pi/agent/extensions/herdr-agent-state.ts`（herdr 自动安装并管理，
`HERDR_INTEGRATION_VERSION=9`，herdr 0.9.1）感知 pi 的状态。该集成：

- 监听 `agent_start` → 上报 `working`
- 监听 `agent_settled` 且 `ctx.isIdle()` → 上报 `idle`
- 监听 `pi.events.on("herdr:blocked")` → 上报 `blocked`（含 message）
- 上报通道：unix socket（`HERDR_SOCKET_PATH`）→ `pane.report_agent`
  `{pane_id, source: "herdr:pi", agent: "pi", state, message, seq}`

异步编排下父 agent 的 `agent_settled` 一定会先于子任务完成而触发 → 上报
idle → herdr 判定完成。这是**模型错位**：pi 认为父会话空闲是真的，但编排
语义上父会话还"持有"未结算的子任务。

### `herdr:busy` 事件是死代码（关键发现）

`index.ts:210-219`（commit 148b9ad 引入）：插件在 runtime 跟踪到存活子任务时
`pi.events.emit("herdr:busy", {active: true, label})`，label 来自
`formatBusyLabel`：`⏳ 2 subagents (worker-0, …)`；全部结束时发
`{active: false}`。

对 herdr 0.9.1 二进制做 strings 提取（`/tmp/herdr-strings.txt`，行 17153/17467）：
**集成内嵌代码只出现 `pi.events.on("herdr:blocked", …)`，全二进制无任何
`herdr:busy` 消费者**。插件发出的事件没有任何监听者。注释里写的
"herdr's busy overlay is optional" 实际是"不存在"。

## 方案

### A（推荐）：herdr 集成增加 `herdr:busy` 消费 —— upstream

在 herdr 内嵌的 pi 集成中，照 `blockedCount` 机制增加：

```ts
let busyCount = 0;
let busyMessage: string | undefined;

pi.events.on("herdr:busy", (data) => {
  if (!rootSession) return;
  if (!data?.active) {
    busyCount = Math.max(0, busyCount - 1);
    if (busyCount === 0) busyMessage = undefined;
    publishState();
    return;
  }
  busyCount += 1;
  busyMessage = data.label;
  publishState();
});

// desiredState() 优先级变为：
// blocked > busy(working + message) > working > idle
```

- 不能复用 `herdr:blocked` 通道：blocked 在 herdr 里有"需要人介入确认"的
  专门 UI/attention 语义，等待回调不是 blocked。
- 效果：父 agent 等回调时 herdr 显示 `working ⏳ 2 subagents (worker-0)`，
  子任务全部结束、回调唤醒父 agent 时自然转回 working。
- 交付方式：本地可直接 patch `~/.pi/agent/extensions/herdr-agent-state.ts`
  验证效果；持久解需提给 herdr upstream（该文件被 herdr 管理，更新会覆盖）。
- 插件侧已就绪，无需改动（事件协议已存在）。

### B：插件自己开 socket 上报 —— 不动 herdr

插件进程内有 `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`，模仿集成直接发
`pane.report_agent`，用独立 source（如 `pi-herdr-subagents`）+ 独立 seq，
在子任务存活期间报 `working`，全部结束时报回。

**未验证的风险（做之前必须实验）**：

1. herdr 对同 pane 多 source 的 agent 状态仲裁规则未知（按 seq 全局比、按
   source 各自记账、还是按到达顺序覆盖）。二进制里有
   `PaneClearAgentAuthorityParams` / `full_lifecycle_hook_authority` 等线索，
   说明 source 有"权威"概念，但规则看不出来。
2. 不能劫持同 source（`herdr:pi`）：集成的 seq 计数器在集成进程内
   （`Date.now()*1000` 起步、每次 +1），插件无法得知；插件发一个更大的 seq
   会让集成后续所有上报（含下一回合的 working）因 seq 更小而被丢弃。

实验：source A 报 idle → source B 报 working → 查 `agent list`/侧边栏谁生效；
再让 source A 报 working，看是否被 B 的旧 seq 压制。

### C：`pane report-metadata --state-label` —— 廉价显示层缓解

herdr CLI 已支持：

```bash
herdr pane report-metadata <pane> --source <id> \
  --state-label idle="waiting 2 subagents" [--ttl-ms N]
```

配合侧边栏 rows 的 `state_text`，把父 pane 的 idle 态显示成自定义文案。

- 优点：插件已有 `paneReportMetadata` 通道（`announceChild` 在用），加到
  父 pane（`HERDR_PANE_ID`）只需几行；`--ttl-ms` 可自动过期，不必精确清理。
- 缺点：**不翻转 agent_status**，状态图标仍是 done，只是文字标注。
- 适合作为 A 落地前的过渡，或 B 实验失败后的兜底。

## 代码位置索引

| 内容 | 位置 |
| --- | --- |
| `herdr:busy` 发射（死事件） | `index.ts:210-219` |
| busy label 生成 | `src/tui/status.ts` `formatBusyLabel` |
| 状态跟踪/collect 生命周期 | `src/extension/runtime.ts`（syncBusy、watch 重臂） |
| herdr 集成（消费端缺失） | `~/.pi/agent/extensions/herdr-agent-state.ts` |
| report-metadata 通道 | `src/herdr/client.ts` `paneReportMetadataArgs` |
| report_agent 协议（集成内嵌） | herdr 二进制 strings：`pane.report_agent` / `pane.report_agent_session` |

## 建议路径

1. 立即：方案 C 先上（零风险显示缓解）+ 本地 patch 集成文件验证方案 A 效果。
2. 主线：方案 A 提 herdr upstream——协议插件侧已就绪，只差消费端 ~15 行。
3. 备选：herdr 不收 upstream 时走方案 B，前置多 source 仲裁实验。

## 实施记录：方案 C 已落地（2026-09-23）

用户选定方案 C（“侧边栏有就可以了”）。

- `src/extension/parent-label.ts`（新增）：`ParentPaneLabeler`——去重（文本不变且 TTL
  剩余过半则跳过）、TTL 15s 自动过期、in-flight 合并、失败不钉住去重状态、
  `report(undefined)`/`clear()` 发 `--clear-state-labels`。
- `src/herdr/client.ts` + `src/shared/types.ts`：`paneReportMetadata` 增加
  `stateLabel` / `ttlMs` / `clearStateLabels` 参数。
- `index.ts`：`emitBusy` 钩子里 `parentLabeler.report(active ? label : undefined)`；
  `session_shutdown` 时 clear；`HERDR_PANE_ID` 缺失时全 no-op。
- label 文本即现有 `formatBusyLabel` 输出：`⏳ 2 subagents (worker-0, …)`。
- 验证：单测 8/8，全量 496 单测 + 95 集成全绿；真机对 live pane 报/清验证
  `state_labels` 生效与消失。
- 状态图标仍是 herdr 自己的判定（idle），本方案只改显示文案。
