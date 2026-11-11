Status: APPROVED_FOR_IMPLEMENTATION
Task Type: Reliability Hardening
Target Branch: a9-63-fail-loud
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d
Win7-Validation: NOT_PERFORMED

# A9-63 Fail-Loud Batch 1

本批次只处理 A9 Robustness Audit R1 的 F-002、F-013、F-014、F-015、F-017、F-018、F-021、F-024。

- F-002：`wmic` 与 `taskkill` 作为内部清理辅助命令各使用默认 10 秒期限；期限到达后终止辅助进程并返回无法证明清理完成的结构化事实。用户命令期限不变。
- F-013：A8 表探测只把明确的缺表结果视为 false；锁定、损坏或权限错误进入 `A9_SQLITE_PROBE_FAILED` 诊断。
- F-014：WAL 设置失败保留 ready 判定，同时记录实际 journal mode 与 `A9_SQLITE_WAL_UNAVAILABLE` 事实。
- F-015：safeParse 保持首参数兼容，新增可选诊断上下文参数。调用点直接传入本实例缓冲、表名及真实行标识；记录有界损坏计数与首个位置，不记录持久化内容。
- F-017/F-018/F-024：Git 投影通过新增可选 diagnostics 字段区分非仓库、启动失败、超时、退出码非零和配置不可读；既有投影字段保持兼容。
- F-021：RecoveryManifestStore 在 A9 产品路径可达。ENOENT 继续返回 undefined；其他读取或解析错误返回 `A9_RECOVERY_MANIFEST_UNREADABLE` 并锁定恢复协调器。

开发机回归使用真实 SQLite、真实 Git 仓库和真实辅助子进程。临时目录使用系统临时目录的 `a9-63-*` 前缀并在清理钩子中删除。Win7、打包、推送和发布均未执行。

## 2026-11-11 返修范围与影响

负责人明确授权本轮四项返修。实际分支为 `a9-63-fail-loud`，返修基线为
`698b1b5792c57231a6557aa12adfe048f05f6340`，工作树为 `/private/tmp/a9-63-fail-loud`。
开始时该工作树干净。只修改原允许源码及直接测试、本任务书；原分支追加本地提交。
主工作区、权限/审批语义、SQLite schema、持久化格式和公开 IPC schema 不变。
不修改任务索引、DECISIONS 或 STATUS；不推送、打包或连接 Win7。

- 清理：默认常量改为 `DEFAULT_INTERNAL_CLEANUP_COMMAND_TIMEOUT_MS = 10_000`。
  测试从 Windows 清理入口注入 750ms，真实辅助进程不退出时须在有界时间返回且 PID 已消失。
  用户命令不增加期限。**10 秒是待 Win7 实测校准的初值**，不是已测得的目标环境阈值。
- JSON：删除模块级 activeSafeParseContext、setSafeParseContext 和位置设置方法。
  safeParse 的第二参数只作用于本次调用，缓冲仍按实例归属；计数上限与首错保留规则不变。
  只补充查询返回的事件 id，不改变 SQL 筛选或排序。
- A8 严格校验：a8TablesPresentStrict 完整恢复 d5b99b62 的原函数，直接探测表并调用 assertA8WorkspaceSchema。
  原始校验错误原样传播，不再包装 A9_SQLITE_PROBE_FAILED。
  a8TablesPresent 的底层探测诊断不变。
- 恢复：读取及 JSON 解析失败的 A9_RECOVERY_MANIFEST_UNREADABLE 信息包含清单路径。
  不拼接底层异常或文件内容，ENOENT 仍返回 undefined，协调器仍锁定。
  **已知限制：锁定后没有界面内的解锁出口。**

最短开发链路为真实辅助子进程 → 到期终止 → PID 复核；真实 SQLite 损坏行 → 实例读取 → 诊断归属与位置；
真实 A8 不匹配物理库 → open 的原始错误；真实恢复清单读取/解析失败 → 含路径错误与恢复锁。
本轮不修改原生组件或依赖，不把开发机结果提升为 Win7 PASS。

## safeParse 调用点逐项核对

基线与返修源码均有 21 处 safeParse 文本匹配，实际为 **20 个调用点和 1 个函数定义**。
下列 20 个调用均直接传入 `this.diagnosticBuffer`。没有依赖内容提取或虚构的行标识。

| 序号 | 所在方法及载荷 | 表名 | 真实行标识来源 |
|---|---|---|---|
| 1 | getConversationMetadata / metadata_json | a9_sessions | 查询 WHERE 的 sessionId 主键 |
| 2 | getTaskRecovery / 工具事件 | a9_events | 查询返回 e.id |
| 3 | getTaskRecovery / checkpoint | a9_checkpoints | 查询 WHERE 的 turn.turn_id 主键 |
| 4 | getTaskRecovery / request | a9_events | 查询新增返回 request.id |
| 5 | getTaskRecovery / answeredQuestionRow | a9_events | 查询新增返回 answeredQuestionRow.id |
| 6 | getTaskRecovery / answerRow | a9_events | 查询新增返回 answerRow.id |
| 7 | getCheckpoint / payload_json | a9_checkpoints | 查询返回 row.turn_id |
| 8 | listConversationFacts / request | a9_events | 查询新增返回 row.id |
| 9 | listConversationFacts / checkpoint | a9_checkpoints | 查询返回 row.turn_id |
| 10 | listConversationFactPage / request_payload | a9_events | page 查询返回 row.request_id，绑定 e.id |
| 11 | listConversationFactPage / checkpoint_payload | a9_checkpoints | page 查询返回 row.turn_id，绑定 c.turn_id |
| 12 | isContinuationTurn / outcome_json | a9_turns | 两个调用入口显式传入关联 row.turn_id |
| 13 | recordQuestionPending / duplicate | a9_events | duplicate 查询返回 id |
| 14 | getPendingQuestion / payload_json | a9_events | 查询返回 row.id |
| 15 | resolveQuestion / existingRow | a9_events | 查询新增返回 existingRow.id |
| 16 | resolveQuestion / pendingRow | a9_events | 查询新增返回 pendingRow.id |
| 17 | getManagedProcessOwnership / payload_json | a9_events | 查询新增返回 row.id |
| 18 | getManagedProcessDisposition / payload_json | a9_events | 查询返回 row.id |
| 19 | recordToolEvent / previous output | a9_events | 查询新增返回 row.id |
| 20 | listSessionEvents / payload_json | a9_events | 查询返回 row.id |

分页 LEFT JOIN 无关联行时没有真实行标识；该情况仍解析默认的合法 `{}`，不产生损坏诊断。
isContinuationTurn 在没有关联 Turn 时同样读取默认 `{}`。存在实际持久化载荷的路径均绑定真实主键。
函数定义的可选第二参数不构成第 21 个调用点。

## 本轮开发机验证记录

运行时直接核对为 Node 20.17.0 / ABI 115，真实 better-sqlite3 返回 SQLite 3.43.1。
原始日志保存在候选外 `/private/tmp/a9-63-revision-evidence-fxckrbkj`，该目录是明确保留的证据，不是测试沙箱。
测试沙箱在系统临时目录，清理放在 finally 或 afterEach。

共同命令前缀：`env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node`。
定向命令均在对应 `src/<module>` 执行：
`node_modules/jest/bin/jest.js --runInBand --runTestsByPath <测试路径>`。
红色运行使用 698b1b57 的产品源码与本轮回归；绿色运行使用返修源码与相同回归。
Runner 最终红色验证使用原提交的完整 process-cleanup.ts，就地暂换后在 finally 逐字节还原并核对 SHA-256。

| 返修项 | 测试名 | 基线红色证据 | 返修绿色证据 |
|---|---|---|---|
| 期限 | defaults internal helper deadlines to ten seconds pending Win7 calibration；times out a non-exiting WMIC helper and leaves no helper process；times out a non-exiting taskkill helper and leaves no helper process | runner-red-final.log：3 FAIL，基线忽略注入期限 | runner-green-final.log：3 PASS |
| JSON 位置和实例归属 | keeps corrupt row diagnostics and real row identities in each manager；keeps diagnostic buffers isolated during reentrant reads of real corrupt rows | state-red.log：2 FAIL，分别为 unknown 位置和缓冲串写 | state-green.log：2 PASS |
| A8 原始错误 | preserves the original strict A8 schema error without a probe code | state-red.log：1 FAIL，错误被加探测码前缀 | state-green.log：1 PASS |
| 恢复清单路径 | returns undefined only for a missing recovery manifest and locks on corruption；includes the manifest path on read errors without leaking content | workspace-red.log：2 FAIL，错误缺少路径 | workspace-green.log：2 PASS |

Runner 首轮 200ms 夹具导致辅助进程未写出 PID 就到期；保留 runner-green.log 的首失败。
改为 750ms 后重新在原提交上运行相同回归，未放宽进程必须消失的判据，也未等待默认 10 秒。

四模块日常集合已直接执行。共同前缀额外设置
`PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`，
以确保 npm 的子进程使用相同 Node。

```sh
node scripts/verify_integration.mjs --daily --module runner --module state --module git-adapter --module workspace
# 严格 A8 函数最终恢复为原基线完整函数后，仅复跑受影响的 State：
node scripts/verify_integration.mjs --daily --module state
node scripts/check_docs.mjs
git diff --check
```

| 检查 | 开发机结果 | 证据 |
|---|---|---|
| 四模块当前输出编译及安全静态门 | PASS，4 个模块构建退出码均为 0 | daily.log |
| Runner 日常集合 | PASS，12 suites / 274 tests | daily.log |
| State 日常集合 | PASS，29 suites / 414 tests；最终源码复跑同数 | daily.log、state-daily-final.log |
| Git Adapter 日常集合 | PASS，5 suites / 59 tests | daily.log |
| Workspace 日常集合 | PASS，23 suites / 258 tests | daily.log |
| safeParse AST 核对 | PASS，20 个调用均有本实例缓冲/表名/行标识，无模块级上下文 | call-sites.json |
| 严格 A8 基线对照 | PASS，函数字节与 d5b99b62 原函数相同 | call-sites.json |
| 文档检查 | FAIL，仅既有 task-index 与 task-lifecycle 两项；本轮禁止改 tasks/README.md | docs-check.log |
| 差异空白检查 | PASS | git diff --check |
| 临时目录复核 | PASS，本轮新增测试沙箱零残留，辅助 PID 消失由回归直接断言 | temp-residue.json、runner-green-final.log |

Workspace 日常集合按原规则未执行 a9-19-baseline-yield.test.ts（NOT_PERFORMED），未改扫描行为。
定向及日常集合均执行真实 SQLite、真实文件和真实子进程；Runner 只替换不可用 Windows 命令的可执行路径，
不模拟 execFile/kill 的进程行为。重入用例只在真实 SQLite 返回载荷的访问边界触发另一个真实实例读取。

文档检查失败与上一轮相同。负责人若要关闭该失败，须另行允许添加任务索引和生命周期表项；本轮无新增取舍。
最终提交为本分支在 698b1b57 之后的追加提交，未改写历史。
源码/测试哈希、提交及命令绑定保存在上述证据目录的 final-binding.json。
Win7 实机、Win10 验收机、Electron 产品链路、打包、正式门 A/B、推送与发布为 NOT_PERFORMED。
