# `/subagents-summary` 实现报告

## 做了什么

- 新增 `src/extension/summary.ts`：RunStore 记录聚合、session JSONL usage/turn fallback、role/outcome/agent-time 统计、Markdown 七列表格、child 详情格式化，以及 `/subagents-summary` 注册、`--all`/name 参数和 child-name 补全。
- 在 `index.ts` 接线 `registerSummaryCommand(pi)`。
- 导出 `sendSlashText` 并在 `src/api.ts` 暴露 summary 聚合器、格式化器和相关类型。
- 新增 `test/unit/summary.test.ts`，用 `mkdtempSync` + `RunStore` fixture 覆盖格式化、execution/session precedence、running/awaiting/non-pi usage、详情、空态、命令注册和补全。
- README 补充 `/subagents-summary` 用法。

## 测试覆盖

- 新增 6 个 unit tests；全量 unit tests：508 个，0 failed，0 skipped。
- `npm run typecheck` 通过。

## 验证输出

```text
$ npm run typecheck
npm notice run @zzjcool/pi-herdr-subagents@0.8.1 typecheck
npm notice run tsc --noEmit

$ npm test
1..508
# tests 508
# pass 508
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Smoke 输出

临时脚本直接读取仓库 `.pi-subagents/runs/` 中的 `r-2a095ce8`、`r-5d88fcbe`，解析各自的 `reviewer-0.jsonl`，调用默认视图格式化函数：

```text
Subagents session summary — 2 runs · 2 children · 00:39–12:27

| role | n | outcome | turns | tokens in/out/cache | cost | agent-time |
|---|---|---|---|---|---|---|
| reviewer | 2 | 2 success | 2 | 50K / 12K / 650.8K | $0.53 | 10m35s |

**Totals**: 2 success · 50K in / 12K out / 650.8K cache · $0.53 · 10m35s agent-time
```

## MR / PR

https://github.com/zzjcool/pi-herdr-subagents/pull/1

## 未尽事项

- 未在真实 Pi TUI 中交互调用 slash command；纯 formatter smoke 和注册层 unit test 已通过。
- 本任务未接入 prune 或时间窗口过滤（按冻结设计保留）。
