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

三个 reviewer 全部**先下发任务（不带 --wait）再统一等结果**，严禁逐个 `--wait` 串行化：

```bash
herdr pane split --current --direction down --cwd "$PWD" --no-focus
# 从返回 JSON 取 .result.pane.pane_id
herdr agent start reviewer-correctness --kind pi --pane <pane-id>
herdr agent start reviewer-tests      --kind pi --pane <pane-id>
herdr agent start reviewer-simplicity --kind pi --pane <pane-id>
herdr agent prompt reviewer-correctness "<任务A>" 
herdr agent prompt reviewer-tests "<任务B>"
herdr agent prompt reviewer-simplicity "<任务C>"
herdr agent wait reviewer-correctness --timeout 900000
herdr agent wait reviewer-tests      --timeout 900000
herdr agent wait reviewer-simplicity --timeout 900000
```

## 三个角度（缺一不可）

1. **reviewer-correctness（正确性/回归）**：边界条件、错误处理、与调用方契约冲突、并发与竞态。
2. **reviewer-tests（测试覆盖）**：规格用例是否都有对应测试？happy-path-only 一票指认；断言强度是否够。
3. **reviewer-simplicity（简洁性）**：重复造轮子、过度抽象、死代码、可以删的行数。

每个 reviewer 的任务卡必须包含：只读约束（不给 edit/write）、输出格式（每条发现带 `文件:行号` + 严重级别 + 具体修法）、
以及收尾指令：完成后执行
`herdr agent prompt orchestrator "<一句话总结> 报告:<路径>"`。

## 汇总与回收

- 按严重级别合并去重，critical/major 逐条给出「采纳/不采纳」判断
- 汇总表格呈现给用户；产出物落盘到 `reports/`
- 收尾回收：对每个 reviewer `herdr agent send-keys <name> ctrl+d`（不是 ctrl+c），
  确认回到 shell 后
  `herdr tab close`/`herdr pane close <pane-id>` 只清自己创建的 pane；`herdr agent list` 验证已不在列表
