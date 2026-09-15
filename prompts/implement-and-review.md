---
description: 实现+审查闭环：worker 实现，3 个并行 reviewer 审查，修复后交付
---
请完成一轮「实现 → 对抗审查 → 修复」闭环。先实现，再并行审查，最后把确认的发现修掉并交付。

任务：

```text
<在这里粘贴你的任务>
```

## 阶段 1 — 实现

按计划实现（若有冻结计划严格遵守；没有计划则先自己列一个简短计划再动手）：

- 只碰任务授权的文件
- 每轮改动结束前跑 `npm run typecheck && npm test`（或项目等价命令），失败修复或回滚
- 完成后把改动摘要与验证输出写进 `reports/impl.md`

## 阶段 2 — 并行对抗审查

派 3 个全新会话的 pi reviewer（正确性/测试覆盖/简洁性三个角度），纪律同 `parallel-review.md`。
用 `subagent({ tasks: [...] })` 一次下发，默认 async，不要自己 split pane。

## 阶段 3 — 修复与交付

- 对每条 critical/major 发现做「采纳/不采纳」判断；采纳的立即修复
- 修复后重跑 `npm run typecheck && npm test`，全绿才算完成
- minor 项汇总列出，不强求本轮修
- 最终报告 `reports/impl-review.md`：改动摘要 / 审查发现与处置 / 最终验证输出

## 收尾

向用户交付：两份报告路径 + 遗留风险清单。子 agent 结束后插件会自动回收 pane，不要再 `retire`。
