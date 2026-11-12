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

第二轮返修（基于提交 `4c1a0f623737e1a5347be31d0c587686906fd70e`）统一了搜索取消文字“搜索已被用户取消”和列目录取消文字“目录读取已取消”；二进制或编码有歧义的文件计入 `skippedTotal` 和 `skipped`，但不计入 `skippedFiles`。当时采用的“只有发现后续文件时才标记 files”判定在第三轮被撤回，当前停止条件见下文。搜索根路径为文件时抛出“搜索路径不是目录”，基线在该情况下返回空结果。

本轮实际修改仅限 `src/workspace/src/a9-workspace-service.ts`、`src/workspace/tests/unit/a9-64-search-list-responsive.test.ts` 与本任务书。

## 3. 验证表

证据层级统一为：开发机 Node 20（`/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node`），不构成 Win7 通过。

| 项 | 命令/证据 | 结果 |
|---|---|---|
| 基线对照 | `A9_64_REPO_ROOT=/tmp/a9-64-probe-baseline-20261111 ... node outputs/a9-64/probe.mjs`；修复后 `node outputs/a9-64/probe.mjs` | 上一轮基线 list 100000 文件最长单次阻塞实测 `53 ms`；差别主要来自 search。上一轮修复后 search 20000 文件最长单次阻塞 `12.05 ms`。本轮重跑结果见 `outputs/a9-64/probe-fixed-r2.json`，并确认 20000 文件边界 `truncated=false`。 |
| 取消 | `node outputs/a9-64/cancel-probe.mjs` | list `25.51 ms`、search `26.38 ms` 均以原取消错误结束，≤200 ms；原始 JSON 在 `outputs/a9-64/cancel-probe.json`。 |
| 等价 | `npm --prefix src/workspace test -- --runInBand tests/unit/a9-64-search-list-responsive.test.ts` | list 非递归、递归和截断逐项对照旧同步算法，7/7 通过。 |
| 失败路径 | 同上定向测试 | 根目录不可读、递归子目录不可读、文件过大、二进制/歧义、读文件失败均有回归，7/7 通过。 |
| 红绿 | 基线工作树同一测试；修复工作树同一测试 | 基线 5 项行为测试失败、2 项兼容行为通过；修复后 7/7 通过。Core signal 回归基线 1 项失败；修复后 14/14 通过。原始红测日志在 `outputs/a9-64/red-workspace-baseline.log`、`red-core-baseline.log`。 |
| 回归 | `node scripts/verify_integration.mjs --daily --module workspace`；`node scripts/verify_integration.mjs --daily --module core` | 修复后 workspace：25/25 suites、278/278 tests，build 通过；core：40/40 suites、924/924 tests，build 通过（依赖 workspace/state/runner/git-adapter/gateway 同步 build）。同一 Node 20 基线工作树 workspace：25/25、278/278；core：40/40、924/924；通过数无回归。原始日志在 `outputs/a9-64/daily-workspace.log`、`daily-core.log`、`daily-baseline-workspace.log`、`daily-baseline-core.log`。 |
| diff 检查 | `git diff --check` | 通过。 |
| 临时目录 | `find /tmp -maxdepth 1 -type d -name 'a9-64-*' -print` | 0 个残留。 |

本轮返修验证结果（证据层级均为开发机 Node 20）：

| 项 | 命令/证据 | 结果 |
|---|---|---|
| 红绿 | 基线 `4c1a0f62` 与返修后定向测试 | 基线新增/修改行为测试失败 `3` 条、通过 `7` 条；返修后 `10/10` 通过。 |
| 定向测试 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --module workspace --test-file tests/unit/a9-64-search-list-responsive.test.ts` | `10/10` 通过。 |
| workspace 日常 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module workspace` | 上一轮 `25` 套件、`278` 条通过；本轮 `25` 套件、`281` 条通过；结果写入 `outputs/a9-64/daily-workspace-r2.log`。 |
| 探针 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node outputs/a9-64/probe.mjs` | 输出另存为 `outputs/a9-64/probe-fixed-r2.json`；list `maxBlockingMs=22.78`、search `maxBlockingMs=1.25`，均 ≤200 ms；20000 文件 `filesScanned=20000`、`truncated=false`、`truncationReasons=[]`。 |
| diff | `git diff --check`；`git diff --name-only 4c1a0f62 HEAD` | 均通过；文件清单仅为本轮允许的三个文件。 |
| 临时目录 | `find /tmp -maxdepth 1 -type d -name 'a9-64-*' -print` | 新增残留 `0`。 |

### 第三轮：恢复达到上限后的停止遍历

负责人本轮明确授权在 `a9-64-search-list-responsive` 分支的 `f229bc3c198646b5e99c88c2ded76a784037364d` 上追加修复；开始时 HEAD 匹配、工作区干净。只修改本任务书、工作区服务和对应测试，不修改主工作区、不推送、不连 Win7、不打包。

回归原因：第二轮将文件数上限检查移到 `filesScanned` 自增之前，外层队列和内层目录项循环不再检查文件上限。目录 `a` 含 20001 文件、另有 300 个子目录各含 3 文件时，旧代码虽只扫描 20000 文件，仍读取了剩余目录，共调用 `readdir` 302 次。本轮将两处检查恢复为基线的位置与条件：外层循环顶部和内层循环顶部（忽略规则之前）在匹配数或文件数达到上限时标记截断并退出；分别记录实际触发的 `matches`、`files`，两者同时触发则都记录。删除自增前检查。取消文字和 `skippedFiles` 修复保持不变，无新增依赖或上限常量变化。

恰好 20000 文件且队列、目录项均耗尽时仍返回 `truncated=false`、`truncationReasons=[]`。若还有排队目录或下一目录项，则循环顶部标记截断并停止，不再读取新目录；这一点与“必须再发现一个文件”的第二轮行为不同。新增测试检查真实目录读取次数，能发现旧有文件总数和截断布尔断言未覆盖的额外遍历。

以下命令均使用 `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node`（下表记为 `NODE20`）。直接证据层级均为开发机 Node 20；父进程和 npm 子进程均核对为 `v20.17.0`。前两轮表格保留为历史结果。

| 项 | 命令/证据 | 本轮结果 |
|---|---|---|
| 文件上限停止 | `NODE20 scripts/verify_integration.mjs --module workspace --test-file tests/unit/a9-64-search-list-responsive.test.ts`；`outputs/a9-64/targeted-r3-final.log` | 20001 文件及 300 个排队子目录夹具：`readdir=2`，路径恰为根目录和 `a`；`filesScanned=20000`、`truncated=true`、原因 `files`。 |
| 精确边界 | 同一定向命令 | 20000 文件且无后续目录项：`filesScanned=20000`、`truncated=false`、原因空。 |
| 匹配上限停止 | 同一定向命令、同一多目录夹具，`maxMatches=1` | `readdir=2`、`filesScanned=1`、匹配数 `1`、`truncated=true`、原因 `matches`。 |
| 红绿 | `git show f229bc3c:src/workspace/src/a9-workspace-service.ts` 临时还原产品文件后，在 `src/workspace` 执行 `NODE20 node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/unit/a9-64-search-list-responsive.test.ts`，finally 逐字节恢复返修源码；`outputs/a9-64/red-r3-f229bc3c-final.log` | 同一最终测试：旧代码 `readdir=302`，`1` 条失败、`10` 条通过；返修后 `11/11` 通过。首次绿测暴露 `/var` 与 `/private/var` 路径别名差异，已改为按服务真实路径比较；原失败日志保留。 |
| 定向与日常 | 上述定向命令；`NODE20 scripts/verify_integration.mjs --daily --module workspace`；`outputs/a9-64/daily-workspace-r3.log` | build、静态门通过；定向 `11/11`；日常 `25/25` 套件、`282/282` 测试（上一轮 `281`）。新增上限测试定向耗时 `2434 ms`。daily 按原规则跳过 A9-19 慢测试。 |
| 响应性探针 | `NODE20 outputs/a9-64/probe.mjs > outputs/a9-64/probe-fixed-r3.json` | list 100000 文件：总耗时 `111.46 ms`、最大定时器间隔 `31.16 ms`、最长阻塞 `21.16 ms`；search 20000 文件：总耗时 `437.21 ms`、间隔 `11.08 ms`、阻塞 `1.08 ms`；均低于 200 ms。搜索精确边界仍不截断。 |
| 范围与清理 | `git diff --check`；提交后 `git diff --name-only f229bc3c HEAD`；系统临时目录核对 | 差异检查通过；仅包含三个允许文件。本轮测试与探针夹具新增残留 `0`；失败验证留下的空运行目录已移除，其他会话的 `a9-64-man-*` 目录及旧日志保留。 |

## 4. 已知限制与边界

- 单个文件的读取仍是同步的，上限 1 MiB；时间片让出发生在文件之间和文本行扫描期间。
- 用户正则在超长行上的回溯无法中止；正则本身仍由 JavaScript RegExp 执行。
- Win7 机械盘上的阈值未校准；本轮仅有开发机 Node 20 证据。
- 本轮未连接 Win7、未打包、未执行正式 Gate A/B、未推送；这些均为 `NOT_PERFORMED`。
- `check_docs` 对任务未登记 `docs/tasks/README.md` 的失败是预期结果；索引登记由负责人会话在合入时完成。
