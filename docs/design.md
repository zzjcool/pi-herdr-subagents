# herdr-subagents 设计文档

> 基于 10 组实测实验（exp1–exp10）得出的设计。所有结论都标注了实验依据，
> 未经验证的假设明确标记为「待验证」。

## 0. 核心命题

**herdr 的 subagent 不是「函数调用」，而是「受监督的活进程」。**

这个差异决定了整个设计：

| 维度 | spawn 模型（pi-subagents） | herdr 模型（本设计） |
| --- | --- | --- |
| 生命周期 | 调用开始→返回即结束 | pane 常驻，可多轮、可续跑 |
| 完成语义 | 退出 = 结束 | `done` = 本轮说完，**不等于结束** |
| 父进程死 | 子进程全死 | **子进程继续跑**（exp8 实测） |
| 结果通道 | stdout / `--mode json` | session jsonl（结构化）+ pane read |
| 隔离 | 进程级天然隔离 | **无隔离，需靠纪律**（exp10 实测） |
| 回收 | 自动 | 需显式，但 tab close 可原子化 |

---

## 1. 实测结论汇总（33 条）

### 1.1 结果通道

| # | 结论 | 证据 |
| --- | --- | --- |
| F1 | `agent start` 返回子 agent 的 **session 路径** | `result.agent.agent_session.value`，不传 `--session` 时返回 pi 默认路径 |
| F2 | session jsonl 是**准实时流**，1–3s 粒度 | exp1：t=43.1s 写完 `assistant:stop`，逐秒可读 |
| F3 | session 文件**惰性创建**：无 turn 则文件不存在 | exp6：start 后 size=401（session+model_change 头）；exp3：未跑 turn 的 w1/w2 MISSING |
| F4 | **预创建空文件可关闭数据丢失窗口**，且不影响正常写入 | exp6：预创建后 size=401，5 行，resume 正常 |
| F5 | session jsonl 提供 `usage`（input/output/cacheRead/cacheWrite/cost）+ `model` + `stopReason` | 直接读 `message.usage` |
| F6 | **`agent read` 返回纯文本，不是 JSON** | exp10：`_stdout` 是渲染后的终端文本 |
| F7 | 非 pi kind（cursor）**没有 session ref**，只能靠 pane read 收集 | exp9/exp10：`agent_session: null` |

### 1.2 状态与等待

| # | 结论 | 证据 |
| --- | --- | --- |
| F8 | **`agent wait` 等待到 turn 结束**（不是提前返回） | exp5-C：长 turn 中调用 wait，23.5s 后返回，正好等到 turn 完成 |
| F9 | 状态取值：`idle` / `working` / `done` / `blocked` / `unknown` / `GONE`（退出后） | 全程观测 |
| F10 | **steering 可用**：working 时提交 prompt，0.3s 接受，排队后 agent 切换任务 | exp5-B：agent 放弃原任务，回复 `STEERED` |

### 1.3 生命周期与回收

| # | 结论 | 证据 |
| --- | --- | --- |
| F11 | **退出用 `ctrl+d`，不是 `ctrl+c`** | exp2：`ctrl+c` 后 agent 仍存活；`ctrl+d`×2 后 `GONE` |
| F12 | **pane close 会杀死 agent，但 session 文件存活且可 resume** | exp2/exp4：mid-turn kill 后 0 torn，resume 拿到 `KIWI9`/`PINE99` |
| F13 | **父 pane 死，子 agent 继续跑并完成任务** | exp8-B：杀掉 orchestrator tab，child 仍 `working` → `done`，输出 `CHILD_FINISHED` |
| F14 | **迟到接管可行**：`agent list` 可重新发现孤儿 child + session 路径 | exp8-C |
| F15 | **`tab close` 原子化回收**：0.12s 清空该 tab 所有 agent + pane | exp3-Q3 |
| F16 | **名字在退出后释放，可复用**；存活期间 `agent_name_taken` | exp10-A |
| F17 | 名字规则：`[a-z][a-z0-9_-]{0,31}`（小写、无空格、≤32 字符） | exp6-C 全部按预期拒绝 |
| F18 | 热 pane 复用（ctrl+d 后重启）约 3.0s，冷 pane 约 3.9s | exp2-Q1/Q2：收益约 0.9s，**不值得做池化** |

### 1.4 并发与失败

| # | 结论 | 证据 |
| --- | --- | --- |
| F19 | **并行 start 有 `agent_pane_busy` 竞态**：无延迟时 2/6 失败 | exp7-H1 |
| F20 | **重试可完全消除竞态**（backoff 0.15s+0.05s×i） | exp8-A：6/6 成功，墙钟 4.8s |
| F21 | **错误 JSON 走 stderr，不是 stdout** | exp7：`stdout=''`, `stderr='{"error":...}'` |
| F22 | **缺失的二进制不报明确错误，而是 15s 超时**；pane 里才有 `command not found` | exp10-C：claude/gemini 均 timeout |

### 1.5 隔离（重要限制）

| # | 结论 | 证据 |
| --- | --- | --- |
| F23 | **herdr 无隔离**：子 agent 能 `pane read` 任意 pane，读到别人内容 | exp10 越权测试：成功读到 `TOP_SECRET_TOKEN` |
| F24 | **`HERDR_SOCKET_PATH` 是保留变量，`--env` 覆盖不了** | 传 `/tmp/FAKE.sock`，实际仍是默认 socket |
| F25 | 唯一真隔离是命名 session（独立 socket + server），但会脱离主 session | `herdr --session X status` 显示独立 socket |

**结论：隔离必须靠「纪律 + 审计」，不能靠 herdr 强制。**

### 1.6 成败判定（关键）

| # | 结论 | 证据 |
| --- | --- | --- |
| F26 | **`agent_status` 无法区分成功与失败**：正常成功、模型报错、被强杀，三者都是 `done` | exp12：三种场景 `agent_status` 全为 `done` |
| F27 | **`agent get` 没有任何 error 字段**；agent 退出后直接 `agent_not_found` | exp12-D2：字段仅 status/labels/tokens 等 |
| F28 | 权威枚举：`stopReason: "stop" \| "length" \| "toolUse" \| "error" \| "aborted"` | pi 官方文档 `session-format.md:88` |
| F29 | **`stopReason: "aborted"` 实际上从不写入 session**：优雅中断（esc）写 `error` + `"This operation was aborted"`；强杀则**完全没有 assistant 消息** | exp12-3 / exp13-G6 |
| F30 | **工具错误是 per-turn 的，不代表任务失败**：turn1 里 bash `exit 7`（`toolResult.isError: true`）该 turn 仍以 `stop` 结束 | exp13-G2：turn1 有 toolErrors 但 stop=`stop` |
| F31 | **只有最后一轮的 assistant 决定成败** | exp13-G4：turn2 干净则整体成功 |
| F32 | **agent 自述失败无法从执行层看出**：回复 `"FAILED: ..."` 的 agent，`stopReason` 是 `stop`、状态是 `done` | exp12-5 |
| F33 | **子 agent 能稳定输出机器可读 verdict**：`{"ok": false, "reason": "..."}` 可被 `json.loads` 解析 | exp12-E |

**结论：成败必须从 session jsonl 推导，不能依赖 herdr 的 agent 状态。**

### 1.7 诊断能力对比

| 诊断信号 | pane 提供 | session jsonl 提供 |
| --- | --- | --- |
| 模型错误信息 | ✗ | ✓ `assistant.errorMessage` |
| 失败原因（stopReason） | ✗ | ✓ |
| 中途被杀的判定 | ✗ | ✓（缺 assistant 消息） |
| 工具错误计数 | ✗ | ✓ `toolResult.isError` |
| 进程 working/idle 状态 | ✗（`pane process-info` 实测 diff 为空） | ✓（jsonl 静默 + 消息计数） |
| 人的现场阅读 | ✓ | ✗（需解析） |

**结论：程序化诊断全部走 session jsonl；`pane read` 只适合给人看。**

---

## 2. 架构

```text
┌─ 定义层 ───────────────────────────────────────────────┐
│ agents/*.md frontmatter（对齐 pi-subagents 规范）        │
│   + herdr 专有字段（kind/placement/worktree/steer/...） │
│ settings.json → subagents 段（模型优先级、scope、预算）  │
└────────────────────────────────────────────────────────┘
┌─ 调度层 (pi extension, registerTool "subagent") ────────┐
│ 生命周期：launching→working→awaiting→retired/exited     │
│ 执行结果：deriveOutcome(session) → success/failed/...   │
│ 动作：launch/continue/steer/resume/retire/status/collect│
│ 树：lineage + ownership + resource（run.json）           │
└────────────────────────────────────────────────────────┘
┌─ 执行层 (herdr 原语) ──────────────────────────────────┐
│ tab create → pane split → agent start（带重试）          │
│ agent prompt（多轮/steer） / agent wait                  │
│ session jsonl（结果+usage+进度） / pane read（诊断）      │
│ tab close（原子回收）                                    │
└────────────────────────────────────────────────────────┘
```

**核心原则：调度层不持有进程，只持有句柄。** 进程归 herdr server，这是父死子活的前提（F13）。

**数据流：**

```text
launch ──→ herdr pane ──→ session jsonl ──→ deriveOutcome ──→ run.json
   │                          │                    │
   └── 重试/预创建             └── 唯一结果来源       └── 成败落盘
                                                         │
                              retire ──→ pane close ─────┘
                              （信息不丢：已在 run.json）
```

---

## 3. 状态机

**生命周期与执行结果是两个正交的维度**，必须分开建模（否则回收后会丢失失败信息）。

### 3.1 生命周期（state）

```ts
type TaskState =
  | "launching"   // pane 已建，agent 启动中（含重试）
  | "working"     // 本轮进行中
  | "awaiting"    // 本轮完成，等调度者决策  ← 核心状态
  | "blocked"     // 请求审批（有误判率，需超时兜底）
  | "retired"     // 已回收，session 按 retention 保留
  | "exited"      // 进程已退出，可 resume
```

### 3.2 执行结果（execution.status）—— 从 session 推导

```ts
type ExecutionStatus =
  | "success"     // 末轮 stopReason === "stop"
  | "failed"      // stopReason === "error"（非 abort）
  | "aborted"     // 末轮无 assistant 消息，或 errorMessage 含 "aborted"
  | "truncated"   // stopReason === "length"
  | "running"     // 尚未结束
```

**两者正交**：一个 agent 可以是 `state: retired` + `execution.status: failed`。

### 3.3 关键：`done ≠ 结束`

这是与 pi-subagents 最大的模型差异。

```text
launch → working → awaiting ─┬─ continue ─→ working → awaiting ...
                             ├─ steer（working 时直接注入，F10）
                             ├─ retire ──→ retired
                             └─ 超时未决 ─→ exited（session 保留，可 resume）
```

**`awaiting` 不保留 pane**（按用户决策）：pane 关掉，session 文件保留。续跑时用 resume
重建 pane —— 实测上下文完整保留（F12）。

### 3.3.1 判定 turn 结束的算法

```ts
async function waitTurnEnd(name, sessionFile, opts) {
  // 主信号：agent wait（F8 实测等到 turn 结束）
  // 兜底：轮询 agent_status + jsonl 行数稳定性
  const before = countAssistantMessages(sessionFile);
  await herdr.agentWait(name, { timeoutMs: opts.timeoutMs });
  // 二次确认：jsonl 静默 N 秒且 assistant 消息数增加
  await waitStable(sessionFile, { quietMs: 2500, minNew: 1 });
  return collectFromSession(sessionFile);
}
```

⚠️ 不要只靠 `agent_status === "idle"`：exp1 显示 idle 可能在 jsonl 落盘前出现。
⚠️ `agent wait` 返回后仍须读 session 才能判定**成败**（F26）。

### 3.4 成败判定算法（从 session jsonl）

```ts
function deriveOutcome(sessionFile: string): Execution {
  const turns = groupByTurn(readMessages(sessionFile));   // 按 user 消息切分
  const last = turns.at(-1);

  // 强杀：末轮 user 之后没有 assistant 消息（F29）
  if (!last || last.assistants.length === 0)
    return { status: "aborted", reason: "no assistant message for last prompt" };

  const final = last.assistants.at(-1);
  switch (final.stopReason) {
    case "stop":    return { status: "success" };
    case "length":  return { status: "truncated" };
    case "error":
      // 优雅中断（esc）也走 error，靠 errorMessage 区分（F29）
      return /abort/i.test(final.errorMessage ?? "")
        ? { status: "aborted", reason: final.errorMessage }
        : { status: "failed", reason: final.errorMessage };
    case "toolUse":
      // 末轮停在 toolUse 意味着进程在工具执行中被终止
      return { status: "aborted", reason: "terminated during tool call" };
    default:
      return { status: "failed", reason: `unknown stopReason: ${final.stopReason}` };
  }
}
```

**注意（F30/F31）**：

- 工具错误（`toolResult.isError`）**只作诊断统计，不影响 status** —— turn1 里 bash `exit 7` 的 turn 仍以 `stop` 结束
- **只有最后一轮决定成败**；前面的 turn 失败不算失败

### 3.5 自述 verdict（L2 判定，抄 pi-subagents acceptance）

`execution.status` 只能回答「它跑完了吗」，回答不了「它跑对了吗」。

实测反例（F32）：让 agent 回复 `"FAILED: could not complete the task"`，它的 `stopReason` 是 `stop`、
`agent_status` 是 `done` —— **执行层看是完美成功**。

所以需要第二层：agent 在末尾输出机器可读 verdict（F33 实测可行）：

```json
{"ok": false, "reason": "missing input file"}
```

对应 pi-subagents 的 `acceptance` 语义：

```yaml
acceptance:
  level: attested          # none | attested | verified
  role: read-only          # read-only 类 agent 自动降级为 attested
  criteria:
    - id: review-findings
      must: 返回带文件路径和严重级别的具体发现
      evidence: [review-findings, residual-risks]
      severity: required
```

| level | 含义 | 判定方式 |
| --- | --- | --- |
| `none` | 不校验 | 只看 execution.status |
| `attested` | agent 自述 | 解析末尾 verdict JSON |
| `verified` | 外部校验 | 调度者检查产物（文件存在？测试通过？） |

---

## 4. 树结构（防泄露）

### 4.1 三层树，职责分离

```jsonc
{
  "runId": "r-7f3a",
  "task": "auth-refactor",
  "herdr": {
    "workspaceId": "w7",
    "tabId": "w7:t2",            // ★ 隔离边界 + 批量回收单元
    "tabLabel": "task:auth-refactor [2/3 done]"
  },

  // ① 血缘树：防越权、防环、防无限嵌套
  "path": [                       // 抄 pi-subagents NestedPathEntry
    { "runId": "r-root", "agent": "orchestrator" },
    { "runId": "r-7f3a", "stepIndex": 0, "agent": "reviewer" }
  ],
  "depth": 2,
  "maxDepth": 4,

  // ② 所有权树：防误杀
  "children": [
    {
      "name": "reviewer-1",       // herdr agent name（全局唯一）
      "paneId": null,             // 已回收后置 null（F12：pane 不是持久载体）
      "sessionFile": ".pi-subagents/runs/r-7f3a/reviewer-1.jsonl",  // ★ resume 凭据
      "sessionId": "01a08e...",
      "ownerToken": "tok-9c2f",   // 证明是我创建的

      // 生命周期（第 3.1 节）
      "state": "retired",
      "spawnedAt": "2026-09-11T04:18:08Z",
      "retiredAt": "2026-09-11T04:25:31Z",

      // ① 执行结果：机械判定，从 session 推导（第 3.4 节）
      "execution": {
        "status": "success",      // success|failed|aborted|truncated|running
        "stopReason": "stop",
        "errorMessage": null,
        "turns": 3,
        "toolErrors": 1,          // 累计，仅诊断用（F30：不影响 status）
        "lastTurn": { "stopReason": "stop", "toolErrors": 0 },  // ★ 只有末轮定成败（F31）
        "model": "glm-5.3-flash",
        "usage": { "input": 7528, "output": 12, "cost": 0.0011 },
        "completedAt": "2026-09-11T04:25:30Z"
      },

      // ② 任务结果：语义判定，需验收（第 3.5 节）
      "acceptance": {
        "status": "accepted",     // accepted|rejected|unknown
        "level": "attested",      // none|attested|verified
        "evidence": ["review-findings", "residual-risks"],
        "reason": "read-only/reviewer-style agent"
      },

      // ③ 产物
      "artifacts": [
        { "kind": "output", "path": ".pi-subagents/runs/r-7f3a/out/reviewer-1.md" }
      ]
    }
  ],

  // ③ 资源树：防泄漏
  "budget": { "spawned": 3, "limit": 8, "granted": 0 },  // 抄 spawn-budget
  "leases": { "reviewer-1.jsonl": { "token": "...", "writerPid": 1234 } }
}
```

### 4.2 为什么扁平数组而不是嵌套对象（抄 pi-subagents）

1. **序列化友好**：可塞进环境变量传递
2. **天然防环**：长度上限（`MAX_NESTED_PATH_ENTRIES = 4`）
3. **注入安全**：`isSafeNestedPathId` 拒绝绝对路径 / `/` / `\` / `..`
4. **逐项可裁剪**：坏的丢掉不污染整条链

### 4.2.1 成败为何必须落盘到树里

实测（F27）：agent 退出后 `agent get` 直接 `agent_not_found`，**pane 也关掉了**。
所以 **retire 时必须把 `execution` 快照写进 run.json**，否则事后无法判断子任务成没成。

> **任何失败诊断都必须读 session jsonl，不能依赖 herdr 的 agent 状态。**

这意味着 `collect()` 是成败判定的**唯一入口**，不能省。

```ts
function isSafeNestedPathId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 128
    && !path.isAbsolute(v) && !v.includes("/")
    && !v.includes("\\") && !v.includes("..");
}
```

### 4.3 泄露防护：承认 herdr 不隔离（F23–F25）

**树不能阻止越权，只能检测越权。** 三层防御：

| 层 | 机制 | 作用 |
| --- | --- | --- |
| 1 | **tab 边界** | 一任务一 tab。回收时只动自己的 tab，不误杀别人（F15） |
| 2 | **孤儿审计** | 对比「tab 里实际存在的 pane」vs「树里登记的 pane」，发现未登记的即告警（exp3-Q2 验证可行） |
| 3 | **prompt 纪律 + tools 白名单** | system prompt 明确禁止操作他人 pane；不需要 bash 的 agent 直接不给 |

```ts
// 审计：每次回收前执行
const registered = new Set(tree.children.map(c => c.paneId));
const actual = herdr.paneList().filter(p => p.tabId === tree.herdr.tabId);
const orphans = actual.filter(p => !registered.has(p.paneId));
if (orphans.length) warn("发现孤儿 pane，可能有越权创建", orphans);
```

**明确不做**：命名 session 硬隔离。代价是失去「可见可介入」这一核心价值，与本设计目标冲突。
本设计定位为**可信内部工具**，不是不可信代码沙箱。

---

## 5. 回收策略（无条件回收）

### 5.1 为什么没有 cleanup 策略选项

早期设计曾考虑 `cleanup: keep | on-success | always`，其唯一理由是「**pane 里有失败现场**，值得留着看一眼」。
但既然续跑走 resume，这个理由不成立：

| 需求 | pane | session jsonl |
| --- | --- | --- |
| 失败诊断（错误信息、stopReason） | ✗ | ✓（F28，更全） |
| 中途被杀判定 | ✗ | ✓（F29） |
| 续跑（上下文） | ✗（resume 不需要 pane） | ✓（F12） |
| 工具错误统计 | ✗ | ✓（F30） |

**结论：pane 关了之后没有任何信息丢失。** 诊断信息全在 session jsonl 里，且比 pane 更结构化、更完整。

所以回收是**无条件的**，不需要策略配置。

### 5.2 执行顺序（严格遵守）

```text
1. 任务进入终态（awaiting / retired / failed / aborted）
   ⚠️ blocked 除外 —— 那不是终态，agent 还活着等回复，pane 必须保留
2. 孤儿审计（对比 tab 内实际 pane vs 树登记）
3. 逐个 children 回收：
     - 有 ownerToken 且 pane 存在 → 可回收
     - 无 ownerToken 或不在树里 → 跳过 + 告警
4. 先 collect() 推导 execution（必须！否则回收后无法判定成败，F27）
5. 优雅退出尝试：ctrl+d ×2（不是 ctrl+c！F11），等 2s
6. 若仍存活 → pane close（F12 实测安全，session 已落盘）
7. tab close 批量兜底（F15：0.12s 清空）
8. run.json 标记 retired + 写入 execution 快照；session 按 retention 保留
```

**步骤 4 是硬性要求**：`agent get` 退出后直接 `agent_not_found`（F27），
不先 collect 就回收 = 永久丢失成败信息。

### 5.3 blocked 是唯一例外

`blocked` 不是终态：agent 还活着等审批回复，pane 必须保留。

但这**是状态机的事，不是 cleanup 策略的事**，不应混在一个配置项里。

```yaml
onBlocked: forward        # forward | auto-approve | notify
```

| 值 | 行为 |
| --- | --- |
| `forward` | 转发给父 agent 决策 |
| `auto-approve` | 按白名单自动放行 |
| `notify` | 只通知用户（`herdr notification show --sound request`），等人来 |

⚠️ `blocked` 依赖屏幕检测，有误判率，**必须配超时兜底**，不能作为唯一真相。

### 5.4 关键约束

- **session 文件必须落盘到 run 目录，绝不放 `/tmp`** —— 它是 resume 唯一凭据
- **预创建空 session 文件**（F4），关闭「start 后无 turn 则文件不存在」的数据丢失窗口
- **pane 永远可以关**，因为 session 是更持久的载体（这是用户方案的核心洞察）
- **回收前必须 collect**（步骤 4），否则成败信息丢失

---

## 6. 配置规范（抄 pi-subagents）

### 6.1 Agent 定义 `agents/*.md`

```yaml
---
name: reviewer
description: 代码审查，只读，返回可执行发现

# ── 模型（抄 pi-subagents 优先级）──
model: cb/glm-5.3-flash
fallbackModels: cb/claude-sonnet-5
thinking: high

# ── 能力边界 ──
tools: read, grep, find, ls, bash
skills: safe-bash, review-checklist
skillPath: ./skills
systemPromptMode: replace          # replace | append
inheritProjectContext: true
inheritSkills: false
extensions: []
subagentOnlyExtensions: []

# ── 行为 ──
output: .pi-subagents/out/reviewer.md
defaultReads: context.md, plan.md
defaultProgress: true
async: true
timeoutMs: 900000
toolTimeoutMs: 600000
acceptance:                  # 第 3.5 节：L2 语义判定
  level: attested            # none | attested | verified
  role: read-only
  criteria:
    - id: review-findings
      must: 返回带文件路径和严重级别的具体发现
      evidence: [review-findings, residual-risks]
      severity: required
completionGuard: true
maxSubagentDepth: 1
allowNestedSubagents: false
toolBudget: {...}
turnBudget: {...}
permissions: {...}
memory: {...}
disabled: false

# ── herdr 专有 ──
kind: pi                    # pi | cursor | claude | codex | gemini | ...
placement: split-down       # split-down | split-right | new-tab
worktree: false             # true = 用 herdr worktree create 做写隔离
steer: true                 # 允许父 agent 中途插话
onBlocked: forward          # forward | auto-approve | notify
# 注：无 cleanup 字段 —— 回收是无条件的（第 5.1 节）
---

（system prompt body）
```

### 6.2 模型优先级（原样抄 pi-subagents）

```text
per-run override
  → provider 作用域 override（agentOverridesByProvider.<provider>.<name>）
  → agentOverrides.<name>.model
  → agent frontmatter model
  → subagents.defaultModel
  → 父会话模型（读 $PI_PROVIDER / $PI_MODEL）
```

特殊值：

- `model: "inherit"` = 显式继承父会话模型
- `modelScope.enforce` + `allow` 白名单：显式指定违规 = error，继承来的 = warn

### 6.3 全局配置 `settings.json`

```json
{
  "subagents": {
    "defaultModel": "cb/glm-5.3-flash",
    "defaultProvider": "cb",
    "agentOverrides": { "oracle": { "model": "cb/claude-opus-5" } },
    "agentOverridesByProvider": { "cb": { "worker": { "model": "cb/glm-5.3-flash" } } },
    "modelScope": { "enforce": true, "allow": ["cb/*"] },
    "disableBuiltins": false,
    "disableThinking": false,
    "maxSubagentSpawnsPerSession": 8,
    "herdr": {
      "defaultPlacement": "split-down",
      "maxConcurrentAgents": 6,
      "startRetries": 40,
      "startRetryBackoffMs": 150,
      "sessionRetentionDays": 7,
      "sessionRetentionMaxBytesPerRun": 52428800
    }
  }
}
```

---

## 7. 借鉴 pi-subagents：三类处理

**不要整体抄。** pi-subagents 的 `src/` 有 14 个子目录、4000+ 行，其中大量基础设施在 herdr 下是重复造轮子。

| 类别 | 内容 | 处理 |
| --- | --- | --- |
| **A. 直接抄**（规范层） | frontmatter 字段名、模型优先级、settings 结构、`NestedPathEntry`、`isSafeNestedPathId`、spawn-budget 思路 | ✅ 抄 |
| **B. 借鉴重写** | 状态机（改成 herdr 多轮模型）、artifact 布局、acceptance 校验、`session-lease`（防写冲突） | ⚠️ 按 herdr 模型重写 |
| **C. 不要抄**（herdr 已覆盖） | detached runner 进程池、steer 文件信箱+ack、`contact_supervisor`、worktree 管理、inspector pane、后台任务追踪 | ❌ 会重复造轮子 |

### C 类对照表

| pi-subagents 自建（~700 行） | herdr 原生 |
| --- | --- |
| detached runner 进程池 | pane 就是常驻进程（F13） |
| steer 文件信箱 + ack 目录 | `agent prompt` 直接注入（F10） |
| `contact_supervisor` 协调工具 | `agent wait --until blocked` |
| worktree 管理 | `herdr worktree create` |
| inspector pane | `pane read` / `pane report-metadata` |
| 后台任务追踪 | `agent list` / `agent_status` |

### B 类值得借鉴的两个具体设计

**1. `session-lease.ts`（防写冲突）**

记录 `token + pid + hostname + writerState(none|spawning|running)`，防止两个 agent 同时写同一 session 文件。
在本设计中用于：resume 时确保没有其他 agent 正在写同一个 session。

**2. `spawn-budget.ts`（防失控）**

```text
used / configuredLimit / granted / remaining / grantHistory
```

每 session 的 spawn 配额，可运行时 grant 追加。本设计直接采用，默认 `maxSubagentSpawnsPerSession: 8`。

---

## 8. Tab 组织策略

### 8.1 层级映射

```text
workspace  = 项目/仓库边界（跟 cwd 走）
  tab      = 一个「任务」
    pane   = 一个 subagent
```

### 8.2 为什么 tab 是关键

1. **原子回收**：`tab close` 一次清空该任务所有资源（F15，0.12s）
2. **隔离边界**：herdr 无进程隔离，tab 是唯一可用的资源边界（F23）
3. **孤儿检测**：对比 tab 内 pane vs 树登记，可发现越权创建（exp3-Q2）
4. **人的心智模型**：按 tab 切换任务，一眼看到该任务有几个 agent
5. **状态板**：tab rename 仅 19ms（F12），可高频更新标签

### 8.3 布局决策表

| 任务规模 | 布局 | 理由 |
| --- | --- | --- |
| 单个 subagent、短任务 | 当前 tab split | 零开销 |
| 2–4 个并行、相关 | 当前 tab 多 split | 同屏对比 |
| 多阶段任务（chain） | **独立 tab** | 生命周期长，独立回收 |
| 多个不相关任务并行 | **每任务一个 tab** | 隔离 + 批量回收 |

```yaml
placement: split-down     # split-down | split-right | new-tab
```

### 8.4 编排面板（herdr 独有，spawn 做不到）

```bash
# 子 agent 启动后上报元数据
herdr pane report-metadata <pane> --source subagent \
  --display-agent "reviewer" --token model=glm-5.3 --token phase=review
```

```toml
# ~/.config/herdr/config.toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "$model", "state_text"]]
```

配合 `herdr agent view set --source subagent` 定义「只看 subagent」的过滤视图。

---

## 9. 启动流程（含重试，关键）

```ts
async function launch(def: AgentDef, task: string): Promise<Handle> {
  // 1. 预创建 session 文件（F4：关闭数据丢失窗口）
  const sessionFile = path.join(runDir, `${name}.jsonl`);
  fs.writeFileSync(sessionFile, "", { mode: 0o600 });

  // 2. 建 tab（若 placement = new-tab）或 split 当前 pane
  const paneId = def.placement === "new-tab"
    ? (await herdr.tabCreate({ cwd, label: `task:${taskId}` })).rootPaneId
    : (await herdr.paneSplit({ direction, cwd })).paneId;

  // 3. 启动 agent，带 agent_pane_busy 重试（F19/F20）
  const args = buildPiArgs(def, { sessionFile, task });
  let started = false;
  for (let i = 0; i < maxTries; i++) {
    const r = await herdr.agentStart(name, def.kind, paneId, args);
    if (r.ok) { started = true; break; }
    if (r.error.code !== "agent_pane_busy") {
      // 真错误：区分「二进制缺失」（表现为 timeout，F22）
      throw new LaunchError(r.error, await diagnose(paneId));
    }
    await sleep(150 + i * 50);
  }
  if (!started) throw new LaunchError("retries_exhausted");

  // 4. 登记到树
  tree.children.push({ name, paneId, sessionFile, ownerToken, state: "launched" });
  await persist(tree);

  return { name, paneId, sessionFile };
}
```

### 错误处理要点

- **错误 JSON 在 stderr**（F21）—— 必须同时解析 stdout 和 stderr
- **缺失二进制 = 15s timeout**（F22）—— 启动前用 `which <bin>` 预检，或超时后读 pane 内容诊断
- **`agent_not_ready`**：名字不会被占用，pane 仍可用 `agent read` 查看

### 名字生成

```ts
// F17：必须匹配 [a-z][a-z0-9_-]{0,31}
function makeName(agent: string, index: number): string {
  const base = agent.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z]+/, "");
  return `${base || "agent"}-${index}`.slice(0, 32);
}
```

---

## 10. 收集流程（成败判定的唯一入口）

> ⚠️ `collect()` 是**成败判定的唯一入口**（F26/F27）。不能省、不能延迟到回收之后。

```ts
async function collect(handle: Handle, opts): Promise<Result> {
  // 主通道：session jsonl（pi kind，F1/F2/F5）
  if (def.kind === "pi") {
    await waitTurnEnd(handle.name, handle.sessionFile, opts);   // F8
    const execution = deriveOutcome(handle.sessionFile);        // 第 3.4 节
    const acceptance = await verifyAcceptance(execution, handle); // 第 3.5 节
    return { ...parseSession(handle.sessionFile), execution, acceptance };
  }
  // 兜底通道：pane read（非 pi kind，F7）
  // ⚠️ 无 session → 无 stopReason → 只能报 unknown
  const text = await herdr.paneRead(handle.paneId, { source: "recent-unwrapped", lines: 200 });
  return {
    output: text, usage: null, model: null,
    execution: { status: "unknown", reason: "non-pi kind: no session file" },
    acceptance: { status: "unknown", level: "none" },
  };
}
```

### 非 pi kind 的能力降级

| 能力 | pi kind | cursor / claude / ... |
| --- | --- | --- |
| session jsonl | ✓ | ✗（F7） |
| usage / cost | ✓ | ✗ |
| 成败判定 | ✓ stopReason | ✗ 只能 `unknown` |
| 续跑（resume） | ✓ `--session` | ⚠️ 依赖各自 CLI 能力 |

**建议**：需要可靠成败判定和续跑能力的 agent 用 pi kind；
非 pi kind 只用于「跑完就行、不需精确判定」的场景。

### session 解析

```ts
function parseSession(file: string) {
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let model = null, stopReason = null, finalOutput = "";
  for (const line of readLines(file)) {
    const e = safeJsonParse(line);           // F12：容忍 torn line
    if (e?.type !== "message") continue;
    const m = e.message;
    if (m.role !== "assistant") continue;
    const u = m.usage ?? {};
    usage.input += u.input ?? 0; usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0; usage.cacheWrite += u.cacheWrite ?? 0;
    usage.cost += u.cost?.total ?? 0;
    model = m.model ?? model;
    stopReason = m.stopReason ?? stopReason;
    for (const p of m.content ?? []) if (p.type === "text") finalOutput = p.text;
  }
  return { output: finalOutput, usage, model, stopReason };
}
```

### 工具错误统计（仅诊断，不影响成败）

```ts
// F30：toolResult.isError 是 per-turn 的，不计入 execution.status
// 实测形状（exp12-4）：
// {"role":"toolResult","toolName":"bash","isError":true,
//  "content":[{"type":"text","text":"(no output)\n\nCommand exited with code 1"}]}
function countToolErrors(turn: Turn): number {
  return turn.toolResults.filter(r => r.isError === true).length;
}
```

**为什么只统计不判定**：exp13 实测 turn1 里 bash `exit 7` 产生 `isError: true`，
但该 turn 仍以 `stop` 正常结束、agent 正确汇报了错误 —— 这是**预期行为**，不是任务失败。

---

## 11. Tool 接口

```ts
subagent({
  action?: "launch" | "continue" | "steer" | "resume" | "retire"
         | "status" | "collect" | "list",     // 默认 launch

  // launch
  agent?: string, task?: string,
  tasks?: Array<{ agent: string; task: string }>,   // 并行
  chain?: Array<{ agent: string; task: string }>,   // 串行
  async?: boolean,          // 默认 true
  model?: string, cwd?: string, placement?: string,

  // 续跑 / 控制
  name?: string,            // handle 名，如 "reviewer-1"
  message?: string,         // steer / continue 的内容
})
```

### 动作语义

| action | 用途 | 底层 |
| --- | --- | --- |
| `launch` | 启动新 agent | tab/pane + agent start |
| `continue` | **本轮完成后继续**（上下文保留） | `agent prompt`（若还活着）或 resume |
| `steer` | **运行中插话改方向**（F10） | `agent prompt`（不等） |
| `resume` | **已退出后恢复**（F12） | 新 pane + `--session <file>` |
| `retire` | 回收 | ctrl+d / pane close / tab close |
| `status` / `collect` / `list` | 查询 | `agent get` / jsonl / `agent list` |

### `continue` vs `steer` vs `resume`

| 场景 | 用哪个 |
| --- | --- |
| 还在跑，想改方向 | `steer` |
| 跑完了（awaiting），要它接着做 | `continue` |
| 已退出 / pane 没了，要接着做 | `resume` |
| 彻底不要了 | `retire` |

### `retire` 的隐含语义（重要）

```ts
// retire 必须先 collect，再回收 —— 顺序不可颠倒（F27）
async function retire(name) {
  const child = tree.children.find(c => c.name === name);

  // 1. 先抓 execution（agent 退出后就拿不到了）
  if (child.state !== "retired" && child.sessionFile) {
    child.execution = deriveOutcome(child.sessionFile);
  }

  // 2. 再回收 pane
  await gracefulExit(name);        // ctrl+d ×2
  if (await stillAlive(name)) await herdr.paneClose(child.paneId);

  // 3. 落盘
  child.state = "retired";
  child.paneId = null;
  child.retiredAt = now();
  await persist(tree);
}
```

---

## 12. 持久化布局

```text
<project>/.pi-subagents/
  runs/<run-id>/
    run.json                    # 树 + 生命周期 + execution + acceptance
    <agent>-<n>.jsonl           # ★ session（resume 凭据，必须持久）
    out/<agent>-<n>.md          # 交付物
    logs/<agent>-<n>.log        # pane read 快照（人的现场，可轮转）
```

**双写状态**：herdr 侧（tab label + pane metadata，给人看）与磁盘侧（run.json + session，给机器读）互为备份。

- herdr server 重启 → 从 `run.json` 恢复
- 文件系统丢失 → 从 `agent list` 恢复
- **成败信息只在 run.json**（F27：agent 退出后无法重查），所以 run.json 是权威

---

## 13. 实施计划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **P1 MVP** | single + parallel；pi kind；split pane；start 重试；`deriveOutcome` 成败判定；无条件回收 | 3 个 reviewer 并行跑完，拿到结构化结果 + usage + **准确的 success/failed 判定**；无 pane 泄漏 |
| **P2 编排** | chain；`continue`/`steer`/`resume`；tab 布局；孤儿审计；blocked 转发；acceptance 校验 | 中途纠正跑偏 worker；awaiting 后 continue 上下文保留；agent 自述失败能被识别 |
| **P3 成熟** | 多 kind（cursor/claude/codex）；async 后台；worktree 隔离；modelScope；tool/turn budget；agent view 面板 | 侧边栏一眼看到全部 subagent 状态 |
| **P4 产品化** | 打成 pi package；文档；单测 | `pi install npm:...` 一键可用 |

### P1 必须处理的坑（全部实测确认）

1. ✅ 启动重试（F19/F20）
2. ✅ stderr 解析（F21）
3. ✅ 预创建 session（F4）
4. ✅ 二进制预检（F22）
5. ✅ 名字规范化（F17）
6. ✅ torn line 容忍（F12）
7. ✅ `ctrl+d` 而非 `ctrl+c`（F11）
8. ✅ tab close 兜底（F15）
9. ✅ **`deriveOutcome` 从 session 推导成败**（F26–F31）—— 不能用 `agent_status`
10. ✅ **回收前先 collect**（F27）—— 否则成败信息永久丢失

### P1 验收测试用例（直接来自实验）

| 用例 | 预期 execution.status |
| --- | --- |
| 正常完成 | `success` |
| 模型报错（bad model） | `failed` + errorMessage |
| esc 优雅中断 | `aborted` |
| pane close 强杀 | `aborted`（缺 assistant 消息） |
| turn1 工具报错、turn2 成功 | `success`（只算末轮） |
| agent 自述 "FAILED: ..." | `success` + acceptance 应报 rejected |

---

## 14. 已知限制（明确接受）

| 限制 | 影响 | 缓解 |
| --- | --- | --- |
| **无进程隔离**（F23–F25） | 子 agent 可读任意 pane | tab 边界 + 孤儿审计 + prompt 纪律 + tools 白名单 |
| **`agent_status` 无成败语义**（F26） | 不能靠 herdr 判断成败 | 必须读 session jsonl（第 3.4 节） |
| **`agent get` 无 error 字段**（F27） | 退出后信息全失 | 回收前 collect，快照进 run.json |
| **非 pi kind 无 usage / 无成败判定**（F7） | cursor/claude 只能报 `unknown` | 只用于「跑完就行」的场景；关键任务用 pi kind |
| **agent 自述失败不可信**（F32） | 说“我失败了”但 stopReason 是 `stop` | 靠 acceptance L2 自述 verdict / L3 外部校验 |
| **`agent wait` 语义依赖屏幕检测** | blocked 有误判率 | 超时兜底，不作为唯一真相 |
| **`pane process-info` 无法判状态** | 测不出 working/idle（diff 为空） | 用 jsonl 静默 + 消息计数代替 |
| **pane 是稀缺资源** | 大量并行受屏幕限制 | `maxConcurrentAgents` 限流 |
| **herdr 版本耦合** | API 变更风险 | 启动时检查版本，缺失方法明确报错 |
| **`split` 需要 `HERDR_PANE_ID`**（F34） | headless/脚本环境里 split 直接失败 | 无当前 pane 时自动降级为 `new-tab`（见下） |

---

## 15. 交付验证（F34–F36：只有真机/容器才能暴露）

以下三条不是设计推导出来的，是**把插件放进隔离容器跑真实 pi 才暴露**的。它们全部属于
"单元测试与集成测试都绿，但用户装上就是不能用"的类型。

### F34 — `pane split --current` 依赖 `HERDR_PANE_ID`

```text
$ herdr pane split --current --direction down --no-focus
--current requires HERDR_PANE_ID
```

`--current` 由 herdr 从 `HERDR_PANE_ID` 解析，而该变量只在 **pi 自己跑在 herdr pane 里**时存在。
于是 headless 场景（脚本、CI、`pi -p`、容器）里**默认的 `split-down` 必然失败**：

```text
✗ scout: HERDR_ERROR: pane split failed: --current requires HERDR_PANE_ID
```

**修法**：placement 感知环境。有 `HERDR_PANE_ID` 才 split，否则降级为 `new-tab`。
tab 本来就是更好的隔离单元（F15），降级不损失能力。

### F35 — `tab create` 也必须传 `--env`，否则血缘丢失

herdr 的 `tab create` 支持 `--env`（和 `pane split` 一样），但**我最初没传**。
后果：一旦 F34 的降级生效，子 agent 拿不到 `PI_SUBAGENT_PARENT_PATH` / `PI_SUBAGENT_MAX_DEPTH`，
**嵌套深度上限直接失效**——一个纯安全边界被静默绕过。

这个 bug 是被一条**早已存在的测试**抓到的：该测试断言 split 命令里有血缘 env，
它在开发机（`HERDR_PANE_ID` 恰好存在）一直是绿的，直到在干净环境里跑才失败。
**教训：测试若依赖环境变量才能通过，就不是回归测试。**

### F36 — 包自带的 `agents/` 不在 pi 的包资源约定里

pi 的包资源约定只有 `extensions/` `skills/` `prompts/` `themes/`。
`agents/` **不在其中**，写进 `package.json` 的 `pi` manifest 会被静默忽略。
所以插件自带的 5 个角色定义，在真实安装后一个都加载不到：

```text
$ subagent action=list
No agents found. Add definitions to ~/.pi/agent/agents/*.md
$ subagent action=launch agent=scout
✗ unknown agent "scout". Available: none
```

**修法**：用 `import.meta.url` 把包自身的 `agents/` 锚定出来（不能靠 `~/.pi/agent`），
作为**最低优先级**的 builtin 层并入 discovery；再提供
`PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` 供 Nix/只读安装注入角色目录。
优先级：`builtin` < `extra dirs` < `user` < `project`。

### 验证矩阵（隔离容器：独立 herdr server + 独立 pi home + 真实 LLM）

| 项 | 结果 |
| --- | --- |
| typecheck | clean (exit 0) |
| unit | 170 pass / 0 fail |
| integration | 41 pass / 0 fail（含 14 个 bug 回归） |
| live（真 herdr + 真 pi 子进程） | 3 pass / 0 fail |
| 端到端（真实 pi 调 `subagent` 工具） | launch→collect `execution=success`, output `FINAL_OK` |
| 自带角色加载 | 5/5 以 `[builtin]` 出现 |
| headless launch | 自动降级 `new-tab`，`execution=success` |

复现脚本：`/tmp/herdr-sandbox/`（Dockerfile + verify.sh + final2.sh）。

### F37 — 开发机的 `node_modules` 是手工 symlink，克隆后 typecheck 必崩

我在开发机上把 peer 依赖做成了指向全局 pi 安装的 **symlink**（从未进 git）。
于是 `npm run typecheck` 在开发机一直绿，但**全新 `git clone` 后必然失败**：

```text
index.ts(131,4): error TS7006: Parameter 'onUpdate' implicitly has an 'any' type.
index.ts(132,4): error TS7006: Parameter 'signal' implicitly has an 'any' type.
```

根因有两层：

1. `peerDependenciesMeta` 把**全部** peer 标成 `optional`，npm 因此不安装它们。
2. 类型定义实际来自开发机的手工 symlink，而非任何可复现的安装步骤。

**修法**：`peerDependencies` 保留（pi 官方要求用 `"*"` 声明并由 pi 提供），
但把真正参与编译的包同时列为 **devDependencies**（`pi-agent-core`、
`pi-coding-agent`、`typebox`），使 `npm install` 后即可 typecheck。

**教训（与 F35 同源）**：**“在我机器上能跑”的等价物是“在我的 node_modules 上能编译”。**
验证可交付性必须从一个干净克隆开始，而不是在开发工作区里跑测试。
这条同样是“测试全绿但用户装不上”的类别。

---

## 附录：实验脚本

- `/tmp/exp1.py` — turn 完成判定信号
- `/tmp/exp2.py` — pane 回收经济学
- `/tmp/exp3.py` — tab 隔离 + 孤儿检测 + 批量回收
- `/tmp/exp4.py` — pane-close-mid-turn 安全性
- `/tmp/exp5.py` — session 预创建 / steering / wait 语义
- `/tmp/exp6.py` — 预创建验证 / 并发 / 名字冲突
- `/tmp/exp7.py` — 并行启动竞态根因
- `/tmp/exp8.py` — 重试修复 + 父死子活 + 迟到接管
- `/tmp/exp9.py` — 多 kind + 资源上限
- `/tmp/exp10.py` — 名字生命周期 + 非 pi 收集 + 失败模式
- `/tmp/exp11.py` — pane 诊断能力 + 失败信号
- `/tmp/exp12.py` — 成败判定信号全场景枚举
- `/tmp/exp13.py` — 多轮成败 / 工具错误 / abort 语义
