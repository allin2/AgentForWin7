# A9-62 — 诊断落盘与进程级兜底（主进程）

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: a9-62-diagnostics
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d
Phase-Gate: A9_62_IMPLEMENTATION_AUTHORIZED
Win7-Validation: NOT_PERFORMED
```

## 1. 授权、工作位置与结果边界

负责人于 2026-11-11 回复“批准 A9-62”。范围是本任务主进程诊断、必要测试和本文档。
负责人随后批准更新 `a9-startup-window.test.ts` 的外设夹具和等待方式。原产品断言保持。
工作树是 `/tmp/a9-62-diagnostics`。从准确基线新建分支，不修改主工作区已有差异。
依赖用符号链接共享。编译输出在工作树内从基线源码生成，不链接主工作区的 dist。

允许修改 `src/shell/product/main.js`，新增 `a9-diagnostics-log.js` 及测试。
不改 IPC schema、Runtime、Renderer、Workspace、Core。IPC 计时只在 main 注册入口包裹。
不新增依赖、原生模块、Worker、系统配置或命令固定超时。
只做开发机检查和本地分支提交。不推送、不打包、不连接 Win7，不申请候选号或门 A/B。
按本轮明确指令不修改任务索引、STATUS 和 DECISIONS，不编号 ADR。

## 2. 可观察行为

日志目录是 `userData/diagnostics`。每行是 UTF-8 无 BOM、LF 的 JSON，带 `schemaVersion: 1`。
普通文件是 `main.jsonl` 和 `main.previous.jsonl`。致命路径使用独立的 `main.fatal.jsonl`。
每个文件最多 2 MiB，三文件总量最多 6 MiB。每行最多 4096 字节，截断后仍为有效 JSON。
普通写入使用异步追加。队列最多 256 条，包括正在写的记录。队列满丢弃并计数，写失败只计数。
计数是当前进程计数，不是读取历史文件后计算的总行数。
诊断返回新增 `diagnosticLog`，含目录、尝试数、成功数、丢弃数、失败数、截断数和队列长度。
已有字段和值保持，直接返回的诊断对象没有需要变更的 IPC schema。

记录启动/版本、启动阶段开始/结束/耗时、已知 IPC action 开始/结束/耗时和失败码。
记录主进程未捕获异常、未处理拒绝、Renderer 消失、窗口无响应/恢复、超过 1 秒的心跳间隔和未完成操作。
普通耗时不会取消操作。心跳只做观测，不给 Agent 工具或命令设置 deadline。
产品主动退出先做有界日志收尾。启动失败先记录，再在普通模式显示错误码和日志目录，然后退出 1。
冒烟与验收模式不新增错误框，保留原报告与退出码。

开始记录最多等待 50ms 的诊断 I/O 预算。该预算不是产品操作超时。
可写且队列未满时，在重型工作执行前等待开始记录完成；磁盘失效、队列满或 I/O 挂起时继续产品操作。
此时强杀记录无法保证存在，丢弃/失败计数如实反映已知情况。
每个进程只允许一次小型同步应急写入；后续错误继续走有界异步路径。
独立应急文件避免与异步轮转竞争。普通日志两文件轮转，应急文件到上限后从头写入本次记录。

## 3. Runtime Profile 与安全边界

复用 Electron 22.3.27 / Node 16.17.1 和开发机 Node 20.17.0。
只使用既有 Node fs/path、单调时钟、定时器及 Electron 事件/原生错误框，不新增 Win32 API。
普通用户对 userData 的已有写权限足够。缺权限或磁盘故障时诊断降级，不能导致产品异常。
Win7 直接行为为 NOT_PERFORMED。开发机证据不签目标平台结论。

日志不接收请求载荷、提示词、文件内容、命令、环境变量、凭据或工作区路径。
action 只从已知动作常量匹配。未知动作写 `unknown`，不复制原字符串。
Runtime 的已知秘密脱敏函数没有公开给 main；现有验收报告正则不足以保证任意错误消息安全。
因此按授权的保守分支省略错误消息。错误类只允许标准类名；错误码只允许固定列表，其余归类。
堆栈仅取前 5 帧中已知产品文件的文件名、行和列，不保留函数名、目录或首行错误消息。

## 4. 验证计划与结果

除明确标注外，结果均为开发机，绑定本分支提交 `739ced9`。

| 检查 | 命令/入口 | 结果 | 证据 |
|---|---|---|---|
| 诊断日志单元 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /usr/local/bin/node src/shell/node_modules/jest/bin/jest.js --config src/shell/jest.config.js --runInBand --runTestsByPath src/shell/tests/product/a9-diagnostics-log.test.ts src/shell/tests/product/a9-startup-window.test.ts` | `PASS`，22/22 | 两个 Jest 套件均通过；覆盖轮转、总量、截断、队列满、写失败、假密钥、中文空格路径、阶段顺序和心跳 |
| Shell 编译/静态/诊断测试 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --module shell --test-file tests/product/a9-diagnostics-log.test.ts` | `PASS` | 编译依赖闭包、Shell lint/build、11/11 诊断测试 |
| 启动顺序回归 | 同上，`--test-file tests/product/a9-startup-window.test.ts` | `PASS`，11/11 | 已批准更新现有测试夹具与等待条件 |
| Electron 22.3.27 入口 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/tmp/a9-62-diagnostics/outputs/a9-62/entry-first` | `PASS`，8/8 | [RESULT.json](/tmp/a9-62-diagnostics/outputs/a9-62/entry-first/RESULT.json)：冒烟、启动失败、3 秒阶段/IPC 停顿、阶段/IPC 强杀、拒绝、窗口事件 |
| 非冒烟启动错误框 | 同一入口 `--case=native-startup`，经 CUA 关闭错误框 | `PASS`，退出码 1 | [RESULT.json](/tmp/a9-62-diagnostics/outputs/a9-62/entry-native-startup/RESULT.json)，错误码 `ENOSPC` 和 diagnostics 路径可见 |
| 未捕获异常语义 | 同一入口 `--case=native-uncaught`，经 CUA 关闭错误框 | `PASS`，退出码 0 | [RESULT.json](/tmp/a9-62-diagnostics/outputs/a9-62/entry-native-only/RESULT.json)，错误码 `EIO` 可见，关闭后进程继续并退出 |
| Electron 原有行为基线 | Electron 22.3.27 临时入口，未安装处理器 | `PASS`，原生错误框阻塞；关闭后继续 | 观察到原始未捕获异常错误框；未处理拒绝警告后继续。探针在 `/tmp` 创建并清理 |
| 语义区分度 | 临时副本移除 `startup-stage-begin`，运行同一阶段检查；恢复当前模块后再跑 | `PASS` | 移除版 `RC=1`（`stage begin marker missing`）；恢复版 `RC=0` |
| Shell 日常集合 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module shell` | `FAIL`，既有基线失败 | 72 套件通过、3 套件失败、1604 测试通过、12 跳过、6 失败；Office Lite 缺少 `docx/jszip/exceljs` 可选依赖，非 A9-62 路径 |
| 文档检查 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/check_docs.mjs` | `FAIL`，授权边界导致 | 新任务书未加入 `docs/tasks/README.md`；负责人明确禁止修改该索引，故保持 `NOT_PERFORMED` |
| 差异/临时目录 | `git diff --check`；精确清理本轮测试目录后 `find` 核对 | `PASS` | 无 diff whitespace；`/tmp` 和测试临时根无 `a9-62-*`/`win7-verify-*` 残留 |

Win7 实机、Win10 验收机、打包、候选冻结、门 A/B、推送和发布均为 `NOT_PERFORMED`。
本地 Electron 结果是开发机 `DEVELOPER_ELECTRON` 证据，不形成 Win7 PASS。

## 5. ADR 草案

建议后续 ADR 登记版本化诊断 JSONL 格式、6 MiB 总量上限和字段白名单。
普通日志是故障定位辅助，不是审计权威、不作为 checkpoint 或恢复事实，也不产生执行权限。
轮转允许丢弃旧诊断，不删除业务数据。文件内容不用于自动恢复或自动重放。
采用异步有界队列、50ms 开始记录等待和一次同步应急写入的可用性取舍。
错误消息默认不落盘，固定错误码和有界位置帧用于定位。扩大字段或脱敏范围须另行评估。
该节是草案说明，不创建编号、不改 Accepted ADR，不代替后续发布或正式验收决策。
