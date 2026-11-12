# A9-64 — 工作区搜索与列目录响应性

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: a9-64-search-list-responsive
Source Baseline: 4dfabf18f41b4f75dd3c910fd0149d1995c5ac93
Phase-Gate: A9_64_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

## 1. 授权与交付

授权来源是负责人 2026-11-11 回复“写批次 2、4 提示词”。交付范围是工作区 `list` 与 `search` 在大目录扫描期间分片让出事件循环、接受并传播取消信号，并把目录/文件跳过事实作为工具结果返回。主工作区的既有 dirty/untracked 内容不属于本任务；本任务在基线提交上建立独立分支，不推送、不连接 Win7、不打包。

改动位置限定为：

- `src/workspace/src/a9-workspace-service.ts`：异步目录读取、可让出的排序与扫描、取消、稳定目录错误码、list/search 跳过和截断结果字段。
- `src/workspace/src/types.ts`：新增 `DIRECTORY_READ_FAILED` 工作区错误码。
- `src/core/src/a9-agent-loop.ts`：将当前 Turn 的 `AbortSignal` 传给 list/search。
- `src/workspace/tests/unit/a9-64-search-list-responsive.test.ts`：等价、取消和失败路径回归。
- `src/core/tests/a9-01-regression.test.ts`：工具分发 signal 传播回归。

未修改 `read`、`write`、`edit`、`copy`、`move`、`delete`、`checkpoint-manager.ts`、忽略规则、上限常量、`src/shell/product/a9-agent-runtime.js` 的三个直接 `list` 调用，也未修改 `docs/tasks/README.md`、`docs/DECISIONS.md`、`docs/STATUS.md`。

## 2. 行为合同

`list` 增加可选 `signal`。目录读取和 Dirent 排序使用现有 25 ms 时间片让出；排序仍使用旧的 `name.localeCompare` 规则，递归仍为深度优先、每层排序、最多 10 层，并在同一位置执行 `maxEntries` 截断。根目录读取失败抛出 `WorkspaceError`，错误码为 `DIRECTORY_READ_FAILED`；递归子目录读取失败继续扫描并返回 `skipped: [{ path, reason: "directory_unreadable" }]`。

`search` 增加可让出的扫描和可选 `signal`，保留取消文字“搜索已被用户取消”。结果新增：

- `skipped`：最多 50 项，路径为工作区相对路径，原因固定为 `directory_unreadable`、`stat_failed`、`too_large`、`binary_or_ambiguous`、`read_failed`。
- `skippedTotal`：全部跳过项总数；既有 `skippedFiles` 仍表示跳过文件数。
- `truncationReasons`：`matches` 和/或 `files`，分别表示达到匹配数上限或文件数上限。

搜索根目录读取失败同样抛出 `DIRECTORY_READ_FAILED`。跳过路径只在工具结果中返回，不写入诊断日志。未传新参数的旧调用方继续使用原默认行为。

## 3. 验证表

证据层级统一为：开发机 Node 20（`/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node`），不构成 Win7 通过。

| 项 | 命令/证据 | 结果 |
|---|---|---|
| 基线对照 | `A9_64_REPO_ROOT=/tmp/a9-64-probe-baseline-20261111 ... node outputs/a9-64/probe.mjs`；修复后 `node outputs/a9-64/probe.mjs` | 基线 list 100000 文件：`maxTimerGapMs=63.40`、`durationMs=88.61`；基线 search 20000 文件：`maxTimerGapMs=436.93`、`durationMs=462.55`。修复后 list：`maxTimerGapMs=29.82`、`durationMs=115.63`；search：`maxTimerGapMs=12.05`、`durationMs=434.61`，结果 `files=20000` 且 `truncationReasons=["files"]`。最长单次阻塞均 ≤200 ms。原始 JSON 在 `outputs/a9-64/probe-baseline.json`、`probe-fixed.json`。 |
| 取消 | `node outputs/a9-64/cancel-probe.mjs` | list `25.51 ms`、search `26.38 ms` 均以原取消错误结束，≤200 ms；原始 JSON 在 `outputs/a9-64/cancel-probe.json`。 |
| 等价 | `npm --prefix src/workspace test -- --runInBand tests/unit/a9-64-search-list-responsive.test.ts` | list 非递归、递归和截断逐项对照旧同步算法，7/7 通过。 |
| 失败路径 | 同上定向测试 | 根目录不可读、递归子目录不可读、文件过大、二进制/歧义、读文件失败均有回归，7/7 通过。 |
| 红绿 | 基线工作树同一测试；修复工作树同一测试 | 基线 5 项行为测试失败、2 项兼容行为通过；修复后 7/7 通过。Core signal 回归基线 1 项失败；修复后 14/14 通过。原始红测日志在 `outputs/a9-64/red-workspace-baseline.log`、`red-core-baseline.log`。 |
| 回归 | `node scripts/verify_integration.mjs --daily --module workspace`；`node scripts/verify_integration.mjs --daily --module core` | 修复后 workspace：25/25 suites、278/278 tests，build 通过；core：40/40 suites、924/924 tests，build 通过（依赖 workspace/state/runner/git-adapter/gateway 同步 build）。同一 Node 20 基线工作树 workspace：25/25、278/278；core：40/40、924/924；通过数无回归。原始日志在 `outputs/a9-64/daily-workspace.log`、`daily-core.log`、`daily-baseline-workspace.log`、`daily-baseline-core.log`。 |
| diff 检查 | `git diff --check` | 通过。 |
| 临时目录 | `find /tmp -maxdepth 1 -type d -name 'a9-64-*' -print` | 0 个残留。 |

## 4. 已知限制与边界

- 单个文件的读取仍是同步的，上限 1 MiB；时间片让出发生在文件之间和文本行扫描期间。
- 用户正则在超长行上的回溯无法中止；正则本身仍由 JavaScript RegExp 执行。
- Win7 机械盘上的阈值未校准；本轮仅有开发机 Node 20 证据。
- 本轮未连接 Win7、未打包、未执行正式 Gate A/B、未推送；这些均为 `NOT_PERFORMED`。
- `check_docs` 对任务未登记 `docs/tasks/README.md` 的失败是预期结果；索引登记由负责人会话在合入时完成。

