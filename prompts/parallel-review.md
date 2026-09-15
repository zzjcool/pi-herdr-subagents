---
description: 并行对抗式审查：3 个只读 reviewer 从正确性/测试/简洁性三个角度交叉审查
---
请对下述改动做对抗式审查。派 3 个并行 pi reviewer，每个全新会话、角度不同；全部收回后你汇总裁决。不要自己顺便修代码——先给用户一份汇总。

改动范围：

```text
<在这里粘贴 diff、分支名或文件清单>
```

背景（可选）：

```text
<规格/任务背景，可留空>
```

## 派发方式

用 `subagent` 工具一次下发三个 reviewer（默认 async）。不要逐个 wait，也不要让 reviewer 回头 prompt 父 pane：

```text
subagent({ tasks: [
  { agent: "reviewer", task: "<正确性任务卡>" },
  { agent: "reviewer", task: "<测试覆盖任务卡>" },
  { agent: "reviewer", task: "<简洁性任务卡>" },
] })
```

然后把控制权交回。插件会在输入框旁显示运行状态；每个 reviewer 结束后会唤醒本会话并自动回收 pane。

## 三个角度（缺一不可）

1. **reviewer-correctness（正确性/回归）**：边界条件、错误处理、与调用方契约冲突、并发与竞态。
2. **reviewer-tests（测试覆盖）**：规格用例是否都有对应测试？happy-path-only 一票指认；断言强度是否够。
3. **reviewer-simplicity（简洁性）**：重复造轮子、过度抽象、死代码、可以删的行数。

每个 reviewer 的任务卡必须包含：只读约束（不给 edit/write）、输出格式（每条发现带 `文件:行号` + 严重级别 + 具体修法）。
**不要**写「完成后 `herdr agent prompt orchestrator ...`」——插件会在子 agent 结束时把结果注入本会话并唤醒你，输入框旁能看到运行状态。

## 汇总与回收

- 按严重级别合并去重，critical/major 逐条给出「采纳/不采纳」判断
- 汇总表格呈现给用户；产出物落盘到 `reports/`
- 插件会在每个 reviewer 结束后自动回收 pane；不要用 ctrl+c，也不要自己 retire。
