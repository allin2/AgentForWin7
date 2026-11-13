# A9-64 — 工作区搜索与列目录响应性

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: a9-64-search-list-responsive
Source Baseline: 4dfabf18f41b4f75dd3c910fd0149d1995c5ac93
Phase-Gate: A9_64_REVIEW_P1_BLOCKED
Win7-Validation: NOT_PERFORMED
```

## 1. 授权与交付

授权来源是负责人 2026-11-11 回复“写批次 2、4 提示词”。交付范围是工作区 `list` 与 `search` 在大目录扫描期间分片让出事件循环、接受并传播取消信号，并把目录/文件跳过事实作为工具结果返回。主工作区的既有 dirty/untracked 内容不属于本任务；本任务在基线提交上建立独立分支，不推送、不连接 Win7、不打包。

改动位置限定为：

- `src/workspace/src/a9-workspace-service.ts`：异步目录读取、原生排序与可让出的扫描、取消、稳定目录错误码、list/search 跳过和截断结果字段。
- `src/workspace/src/types.ts`：新增 `DIRECTORY_READ_FAILED` 工作区错误码。
- `src/core/src/a9-agent-loop.ts`：将当前 Turn 的 `AbortSignal` 传给 list/search。
- `src/workspace/tests/unit/a9-64-search-list-responsive.test.ts`：等价、取消和失败路径回归。
- `src/core/tests/a9-01-regression.test.ts`：工具分发 signal 传播回归。

未修改 `read`、`write`、`edit`、`copy`、`move`、`delete`、`checkpoint-manager.ts`、忽略规则、上限常量、`src/shell/product/a9-agent-runtime.js` 的三个直接 `list` 调用，也未修改 `docs/tasks/README.md`、`docs/DECISIONS.md`、`docs/STATUS.md`。

## 2. 行为合同

`list` 增加可选 `signal`。目录读取保持异步，逐项扫描使用现有 25 ms 时间片让出；第四轮已删除存在 P0 缺陷的自写排序，改回原生 `dirents.sort((a, b) => a.name.localeCompare(b.name))`，排序前后检查取消，排序期间不让出事件循环。递归仍为深度优先、每层排序、最多 10 层，并在同一位置执行 `maxEntries` 截断。根目录读取失败抛出 `WorkspaceError`，错误码为 `DIRECTORY_READ_FAILED`；递归子目录读取失败继续扫描，结果新增字段为：

- `skipped`：最多 50 项，格式为 `{ path, reason: "directory_unreadable" }`。
- `skippedTotal`：全部跳过目录的总数，不受 50 项详情上限限制。

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
| 等价（历史，更正见第四轮） | `npm --prefix src/workspace test -- --runInBand tests/unit/a9-64-search-list-responsive.test.ts` | 当时的定向集合 7/7 通过，但夹具太小，未覆盖自写排序缺陷；该结果不能证明一般目录下的 list 等价。第四轮以最小复现和 200 个随机目录重新验证。 |
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

### 第四轮：修复独立审核发现的排序 P0 与两条 P2

实际基线为 `9ab87046661ef6ec94e9b9bad3b6e4e1ecb1735b`，分支 `a9-64-search-list-responsive`，开始时 HEAD 匹配且工作区干净。负责人明确决定删除自写排序、恢复原生排序，并授权跳过列表有界及搜索行循环开销修复。本轮只修改工作区服务、对应测试和本任务书；本地提交，不推送、不连接 Win7、不打包。产品 JS/类型与测试变化，无新增依赖、原生组件、权限或上限常量变化。

P0 由独立审核发现：仅有 `File.txt` 和 `a_b.txt` 的目录返回 4 项，`a_b.txt` 出现 3 次；审核随机 150 个目录有 147 个结果不一致。根因是自写归并排序将会被推进的 `right` 同时当作左段边界，右段先耗尽后把额外元素拷入结果。负责人决定采用原生排序，本轮完整删除 `sortDirentsWithYields`，不修补保留；恢复与基线完全相同的 `dirents.sort((a, b) => a.name.localeCompare(b.name))`，前后各检查取消。目录读取保持异步，逐项扫描的让出不变。

此前“list 等价通过”的结论不充分：原定向夹具太小，未覆盖这个缺陷。原日志保留为历史事实，不能作为一般等价证明。本轮新增独立同步参照：原生排序、基线递归顺序、深度上限和截断位置，不调用产品辅助函数。200 个固定种子的随机树各含 0～300 个文件/目录，覆盖空树、300 项树、嵌套树和平铺树；名字混合大小写、数字、下划线、连字符、中文、空格和长名字，以唯一编号避免大小写不敏感文件系统冲突，生成名称不命中忽略规则。每树验证递归/非递归及 `maxEntries=1、7、500、总项数+501`，共 1600 组逐项对照；另保留两文件最小复现。

P2 跳过列表：list 两处子目录失败入口统一计数，`skipped` 详情最多 50 项，新增 `skippedTotal` 记录全部数量。100 个不可读子目录用真实目录配合 `readdir` 权限失败替身验证，返回详情 50 项、总数 100。P2 搜索开销：行循环在行索引为 0、256、512 等时执行让出及取消检查，文件之间的检查保持不变。结果语义、取消文字、第三轮的上限判定位置保持不变，无固定超时。

下表 `NODE20` 使用第三轮给出的完整运行前缀；所有证据层级均为开发机 Node 20，父进程和 npm 子进程均为 `v20.17.0`。

| 项 | 命令/证据 | 第四轮结果 |
|---|---|---|
| 红绿 | 在 `src/workspace` 执行 `NODE20 node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/unit/a9-64-search-list-responsive.test.ts --json --outputFile ../../outputs/a9-64/red-r4-9ab87046.json`；当时产品源码仍为 `9ab87046` | 随机树旧代码 186 失败、14 通过；加最小复现的等价组共 187 失败、14 通过，返修后 201/201 通过。含跳过有界测试的整个集合旧代码 188 失败、25 通过，返修后 213/213 通过。日志 `red-r4-9ab87046.log` 保留。 |
| 最小复现 | `NODE20 scripts/verify_integration.mjs --module workspace --test-file tests/unit/a9-64-search-list-responsive.test.ts` | 恰好 2 项，顺序为 `a_b.txt`、`File.txt`；`totalEntries=2`、`truncated=false`。 |
| 定向 | 同上；`outputs/a9-64/targeted-r4.log` | build、静态门及 213/213 测试通过，包含 1600 组随机目录对照和 100 个不可读子目录的有界报告。 |
| 日常 | `NODE20 scripts/verify_integration.mjs --daily --module workspace`；`outputs/a9-64/daily-workspace-r4.log` | 25/25 套件、484/484 测试通过，上一轮为 282；daily 依原规则不执行 A9-19 慢测试。 |
| 原探针 | `NODE20 outputs/a9-64/probe.mjs > outputs/a9-64/probe-fixed-r4.json` | list 100000 文件：总耗时 93.73 ms、最大定时器间隔 30.23 ms、最长阻塞 20.23 ms；search 20000 文件：总耗时 475.47 ms、间隔 11.52 ms、阻塞 1.52 ms。均低于 200 ms。 |
| 短行搜索三版本对比 | `NODE20 outputs/a9-64/r4-perf-probe.cjs > outputs/a9-64/perf-fixed-r4.json` | 同一批 200 文件，每文件 1048572 字节、每行 6 字节，共 174762 行。各版本预热 3 文件，再轮换顺序测 3 轮，中位数：基线 4dfabf18 为 1158.27 ms、9ab87046 为 4882.71 ms、返修后为 1297.85 ms；返修后/基线为 1.12，满足 ≤1.3。返修后三轮最长阻塞最大 24.09 ms。 |
| 100000 文件取消 | 同一性能探针，在 readdir 完成后、原生排序前安排取消定时器 | 从调用开始到结束 63.05 ms，实际触发 abort 后 1.18 ms；错误文字严格为“目录读取已取消”，均低于 200 ms。 |
| 范围与清理 | `git diff --check`；提交后 `git diff --name-only 9ab87046 HEAD`；临时目录与运行前快照对照 | 差异检查通过，仅三个允许文件；新增临时目录残留 0。探针在 finally 删除本轮夹具；保留其他会话的既有目录，证据 `outputs/a9-64/temp-check-r4.json`。 |

性能参照加载方式：`r4-perf-probe.cjs` 用 `git show` 取得两个历史 service 的原始 TypeScript，以既有 TypeScript 5.3.3 转译并内存加载，依赖解析到当前构建中未变化的运行依赖。基线至当前的 workspace 源码差异仅为 service 与 types，types 的变更仅新增错误码类型联合，其余运行依赖源码未变。返修后加载当前 `dist/a9-workspace-service.js`。JSON 记录源码及转译/构建哈希。全程不改写被测产品文件、不创建或修改主工作区。原探针的总耗时包含 25 ms 定时器收尾；短行性能探针的总耗时不包含该收尾，三版本口径一致。

### 第五轮：本次审核问题修复核验报告

结论：执行代理确认 P0-1、P1-1 与 P2-2 在提交 `923bf875043b6c48924445a4ca46a55ada47a70b` 已修复，开发机定向复测通过。P2-1 的性能提示已有同字节修复证据。本节不是独立审核签发，也不改变原审核对 `9ab87046661ef6ec94e9b9bad3b6e4e1ecb1735b` 的 FAIL。

本次负责人要求修复所附审核问题。执行代理进入指定工作树 `/Users/qlyf/Developer/a9-64-search-list-responsive` 时，实际分支为 `a9-64-search-list-responsive`，HEAD 已是上述修复提交，工作区干净。该提交是被审提交的直接后继；本次保留已有修复，不重复实现，也不改写历史提交。本次新增变更只有本任务书的核验记录，未提交、未推送。原审核的 500 个目录与 600 组场景统计不作为本轮实测数字。

| 问题 | 实际修复及核验 | 结论与证据层级 |
|---|---|---|
| P0-1 排序重复膨胀 | 既有修复删除自写归并，使用基线原生 `localeCompare` 排序。两文件目录仅返回 `a_b.txt`、`File.txt`，总数 2、不截断。 | 开发机直接复测 PASS。原生排序中途不能取消，限制继续保留。 |
| P1-1 等价夹具漏检 | 常驻测试包含两文件反例、200 个固定种子随机树。每树递归/非递归各检查四个上限，逐项比较完整 entries、truncated、totalEntries，共 1600 组，无 mismatch。 | 开发机直接复测 PASS。旧源码在同一测试集有 186 个随机树用例及最小反例失败。 |
| P2-1 搜索耗时提示 | 既有修复把行循环 checkpoint 改为每 256 行检查，保留文件间检查。第四轮短行搜索三轮中位数为基线 1158.27 ms、修复 1297.85 ms，比值 1.12；不能与原审核不同夹具的 1.60 直接比较。 | `INHERITED_EVIDENCE`，开发机 Node 20。当前源码和重新构建 JS 的 SHA-256 均与原性能 JSON 完全相同；本轮未重跑性能探针。 |
| P2-2 list 跳过总数缺失 | 既有修复新增 `skippedTotal`。真实 100 个子目录配合 readdir 的 EACCES 替身，详情恰 50 项、总数 100。 | 开发机直接复测 PASS。此项证明计数与详情上限，不构成目标平台 ACL 证据。 |

本轮直接验证使用 Node `v20.17.0`。沿用第三轮 `NODE20` 前缀，补齐 PATH 指向该 Node 的 bin，确保 npm 子进程也使用相同运行时。

| 检查 | 命令/证据 | 本轮结果 |
|---|---|---|
| 当前构建与定向回归 | `NODE20 scripts/verify_integration.mjs --module workspace --test-file tests/unit/a9-64-search-list-responsive.test.ts`；`outputs/a9-64/recheck-923bf875-targeted.log` | workspace 编译通过；213/213 测试通过。 |
| 同一测试的旧源码反证 | `NODE20 outputs/a9-64/recheck-923bf875-red.cjs`；同前缀 `-red.log`、`-red.json`、`-red-summary.json` | 旧源码 188 项失败、25 项通过。失败包括两文件反例、186 个随机树用例及 list 总量测试。 |
| 身份与原性能证据适用性 | `outputs/a9-64/recheck-923bf875-identity.json`；`outputs/a9-64/perf-fixed-r4.json` | 产品源码与 HEAD 一致；源码 SHA-256 为 `91a86e7c6032cc7d668fa9e865d9f0328587e9b4144f63825a43065ae070177a`，构建 JS 为 `6a5e919868fe3c145c96f686cf1686920a739c87a4e1a6d0f32c6b8cd148fe65`。两者均匹配原性能证据。 |
| 历史日常回归 | `outputs/a9-64/daily-workspace-r4.log` | 第四轮原始日志为 25/25 套件、484/484 测试通过。本轮未重复执行，不计入本轮直接证据。 |
| 差异与清理 | `git diff --check`；`outputs/a9-64/recheck-923bf875-temp-check.json` | 差异检查通过；反证运行新增临时目录残留 0，既有目录保留。 |

旧源码反证脚本以 `git show` 读取准确的被审 service，用现有 TypeScript 转译到系统临时目录。仅将相对运行依赖解析到当前 workspace dist，并通过 Jest moduleNameMapper 替换测试的 service 入口。当前测试文件保持不变，产品源码及当前 dist 均不回退；临时夹具、转译文件和 Jest cache 在 finally 删除。反证只证明该测试集能发现原缺陷，不作为旧版本兼容性或完整回归结论。

本次未重跑全部十七项独立审核。性能探针、完整 workspace/core 回归及开发机 Electron 22.3.27 内置 Node 16.17.1 运行均非本轮直接证据。Win7 实机、打包、正式门 A/B、合入主工作区和推送均为 `NOT_PERFORMED`。本轮无产品变化，无新增依赖、权限或候选；后续独立审核可直接使用现有修复提交与本轮红绿证据。

## 4. 已知限制与边界

- 单个文件的读取仍是同步的，上限 1 MiB；时间片让出发生在文件之间和文本行扫描期间。
- 用户正则在超长行上的回溯无法中止；正则本身仍由 JavaScript RegExp 执行。
- 原生排序期间不让出事件循环，也不能在排序中途取消。对混合名称的真实 Dirent 作固定种子洗牌后测三轮纯排序：100000 项为 50.38 ms 中位数、52.86 ms 最大值；20000 项为 8.05 ms 中位数、23.71 ms 最大值。复制数组和读取目录不计入纯排序耗时；这些开发机数据不代表 Win7 阈值。
- Win7 机械盘上的阈值未校准；本轮仅有开发机 Node 20 证据。
- 本轮未连接 Win7、未打包、未执行正式 Gate A/B、未推送；这些均为 `NOT_PERFORMED`。
- `check_docs` 对任务未登记 `docs/tasks/README.md` 的失败是预期结果；索引登记由负责人会话在合入时完成。

## 2026-11-12 收口登记

负责人要求推进A9-64/A9-65收口并索取A9-64独立审查提示词。本轮只将任务书登记到主线，产品修复仍固定在独立分支923bf875…，最终独立审查待回执；不能将执行代理复测当成独立审查签发。提示词在主仓库outputs/a9-64-dev-r3/FINAL_INDEPENDENT_REVIEW_PROMPT_20261113.md。
主线的文档登记不代表产品合入或Win7通过。原排序审核FAIL、同步原生排序及单文件读取限制保持。

## 2026-11-13 独立审查阻断

负责人返回独立报告：a9-64-search-list-responsive工作树outputs/a9-64/review-20261113T015456Z-9b89e3b2/REVIEW.md，准确源923bf875…，开发机结论不建议合入。P1-1为异步扫描期间目录替换导致外部文件沿用outsideWorkspace=false；P2-1为任务书add/add冲突。原审核FAIL保留，产品继续阻断合入。
执行代理在既有收口范围内于原分支实施最小修复和红绿验证；原分支补记与main收口登记全部保留。主线不加载该产品补丁，不将分支自查提升为独立复审或Win7证据。后继修复和准确输入见分支任务书及outputs/a9-64/p1-revision-20261113。

## 2026-11-13 独立审查阻断与范围内返修

独立报告为outputs/a9-64/review-20261113T015456Z-9b89e3b2/REVIEW.md，绑定923bf875…，结论不建议合入main。P1-1为异步扫描期间根或子目录被替换，旧outsideWorkspace标记仍用于外部目标；P2-1为任务书add/add集成冲突。原排序P0修复的通过证据及新P1阻断并存，不互相抵销。报告和原FAIL不改判。
负责人在既有“推进64、65收口”任务中返回本报告；本轮在原批准范围内修复已复现竞态，并协调保留任务书两侧记录。实际分支a9-64-search-list-responsive，开始HEAD923bf875…；main为641a0a3…，产品不合入main。仅修改Workspace service、直接回归和本任务书；主线只补真实状态和任务记录，不改变权限、公开schema、持久化、依赖、原生、系统配置、排序或容量上限，不连接目标机、不打包、不推送。
原分支未提交的第五轮补记已逐字节保存到p1-revision-20261113/TASK_BEFORE.md。main任务书完整包含该补记，因此先以完整main文本协调分支任务书，再追加本节；原FAIL、第五轮核验及main收口登记全部保留。此为文档协调，不代表已经执行产品合并。
返修前同一新增13项回归全部FAIL，原213项仍PASS。反例覆盖原生事件循环根替换、readdir边界根/子目录替换、同名新目录、外部符号链接、子realpath等待、行扫描让出以及文件替换为外部链接。返修后226/226通过。首轮回归补强记录保留，准确证据集中在outputs/a9-64/p1-revision-20261113。
实现先在首次await前绑定canonical目标、dev/ino与birthtime，在真实I/O前后、实际让出后及返回前复核根与当前目录。漂移或身份无法确认返回既有DIRECTORY_READ_FAILED；不返回沿用旧归属的扫描结果，不将身份错误吞为普通read_failed。搜索对旧Dirent指向的文件重新lstat，只读取仍为普通文件的目标；新链接按stat_failed明确跳过。新调用对已有外部目标仍允许并正确标为outsideWorkspace=true。
上述检查用于异步边界的一致性，不能声明为对抗任意跨进程ABA替换的原子文件系统沙箱。Win7的目录身份字段及实际Reparse Point行为仍NOT_PERFORMED。当前开发机修复完成不解除独立复审阻断；后继最终记录及准确输入在本目录追加。

### 开发机返修结果与复审输入

产品及直接回归已本地提交为382e002…，父提交923bf875…。后继任务书提交不改产品字节。当前状态仍为A9_64_REVIEW_P1_BLOCKED：执行代理确认反例关闭，不代替独立复审签发。

| 检查 | 本轮直接结果 | 证据 |
|---|---|---|
| 相同回归红绿 | 旧源13 FAIL、213 PASS；新源226/226 PASS | red-final.log、green.log |
| Workspace/Core实际消费者 | 25套件497 PASS；40套件924 PASS，六模块当前输出构建通过 | daily-workspace-core.log |
| 6000文件基线 | 3/3 PASS | baseline-6000.log |
| 原报告根替换反例 | Node20、Electron22/Node16各4种场景均DIRECTORY_READ_FAILED，不返回结果 | race-node20.json、race-node16.json |
| 根/子目录、原生新目录及符号链接 | 两运行时各8/8 PASS | directory-identities-node20.json、directory-identities-node16.json |
| 原消费者探针 | 两运行时各12/12 PASS，含真实Core→Workspace及取消 | consumer-node20.json、consumer-node16.json |
| 同口径性能 | 三轮轮换，中位耗时为基线1.10倍；10万项取消总58.36ms，实际abort后0.24ms | performance.json |
| 大目录响应性 | 10万目录项最长停顿估计15.05ms；2万文件搜索2.05ms，精确文件边界未截断 | large-probe.json |

原消费者探针仅把文件metadata错误注入位置由statSync改为新消费者的lstatSync，全部原断言保留；来源与SHA见PROBE_PROVENANCE.json。原报告脚本未改，原审查证据未覆盖。本轮性能重新测量，不再把旧服务同字节性能记录继承给新服务。最长停顿是10ms定时器间隔减10ms的估计；开发机数值不构成Win7承诺。
P2以协调后的完整任务书同步到两条分支；保留第五轮补记、main收口登记、新审查及本轮返修。准确两侧文档提交及只读合并预演写入DOC_COORDINATION.json，不为解决文档冲突合入产品。
最终准确源码/构建/脚本哈希、保护与清理结果见本目录RESULT_FINAL.json。原独审P1仍待独立复核；main产品、Win7、Win10、完整GUI链路、打包、门A/B、推送与发布均NOT_PERFORMED。
