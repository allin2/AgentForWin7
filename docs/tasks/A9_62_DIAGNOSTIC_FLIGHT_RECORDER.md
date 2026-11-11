# A9-62 — 诊断落盘与进程级兜底（主进程）

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: a9-62-diagnostics
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d
Phase-Gate: A9_62_DEVELOPER_VERIFIED
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
IPC 普通日志为 `main.jsonl`，上限 1 MiB，达到上限重新写入。
关键事件独立写入 `critical.jsonl`，轮转为 `critical.previous.jsonl`，各 2 MiB。
同步退出使用独立 `main.fatal.jsonl`，上限 1 MiB。全部文件总量不超过 6 MiB。
每行最多 4096 字节，截断后仍为有效 JSON。已有旧格式 main.previous 在初始化时迁入关键历史或按轮转保留策略移除。
普通写入使用异步追加。普通和关键队列分别最多 256 条，包括正在写的记录。队列满丢弃并计数，写失败只计数。
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
正常退出不阻止 will-quit，不调用第二次 app.quit。exit-begin 与 exit-end 使用小型同步应急记录，失败只计数。
目录和初始文件大小只在异步初始化时读取一次，后续大小在内存累计。
独立应急文件避免与异步轮转竞争。未初始化成功时同步记录只计失败，不同步创建目录。
错误框期间暂停心跳观测，恢复后重置采样时刻，并记录 main-thread-blocked / error-dialog。
第二实例结束 app-ready 操作，记录 second-instance-exit，保持退出码 2。

## 3. Runtime Profile 与安全边界

复用 Electron 22.3.27 / Node 16.17.1 和开发机 Node 20.17.0。
只使用既有 Node fs/path、单调时钟、定时器及 Electron 事件/原生错误框，不新增 Win32 API。
普通用户对 userData 的已有写权限足够。缺权限或磁盘故障时诊断降级，不能导致产品异常。
Win7 直接行为为 NOT_PERFORMED。开发机证据不签目标平台结论。

日志不接收请求载荷、提示词、文件内容、命令、环境变量、凭据或工作区路径。
action 只从已知动作常量匹配。未知动作写 `unknown`，不复制原字符串。
Runtime 的已知秘密脱敏函数没有公开给 main；现有验收报告正则不足以保证任意错误消息安全。
因此按授权的保守分支省略错误消息。错误类只允许标准类名；字符串错误码匹配 `^[A-Z][A-Z0-9_]{2,63}$` 时原样记录，其余归类。
堆栈仅取前 5 帧中已知产品文件的文件名、行和列，不保留函数名、目录或首行错误消息。

## 4. 验证计划与结果

以下首轮结果属于历史提交 `fc3653f`。本轮返修结果见 §6；不改判历史运行。

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
| Shell 日常集合 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module shell` | `FAIL`，工作树依赖链接遗漏 | 72 套件通过、3 套件失败、1604 测试通过、12 跳过、6 失败；执行代理遗漏 office-lite/node_modules 链接，不能称为既有基线失败；本轮补链接后通过 |
| 文档检查 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/check_docs.mjs` | `FAIL`，授权边界导致 | 新任务书未加入 `docs/tasks/README.md`；负责人明确禁止修改该索引，故保持 `NOT_PERFORMED` |
| 差异/临时目录 | `git diff --check`；精确清理本轮测试目录后 `find` 核对 | `PASS` | 无 diff whitespace；`/tmp` 和测试临时根无 `a9-62-*`/`win7-verify-*` 残留 |

Win7 实机、Win10 验收机、打包、候选冻结、门 A/B、推送和发布均为 `NOT_PERFORMED`。
本地 Electron 结果是开发机 `DEVELOPER_ELECTRON` 证据，不形成 Win7 PASS。

## 5. ADR 草案

建议后续 ADR 登记版本化诊断 JSONL 格式、6 MiB 总量上限和字段白名单。
普通日志是故障定位辅助，不是审计权威、不作为 checkpoint 或恢复事实，也不产生执行权限。
轮转允许丢弃旧诊断，不删除业务数据。文件内容不用于自动恢复或自动重放。
采用独立关键事件保留、异步有界队列、50ms 开始记录等待和小型同步退出追加。
错误消息默认不落盘，符合格式的错误码和有界位置帧用于定位。扩大字段或脱敏范围须另行评估。
该节是草案说明，不创建编号、不改 Accepted ADR，不代替后续发布或正式验收决策。


## 6. 2026-11-11 返修

负责人批准在 fc3653f 后追加提交。原实现范围和目标平台边界保持，不改历史提交。
先补工作树 office-lite/node_modules 链接。返修前 Shell 日常集合直接 PASS：75 套件、1618 通过、12 跳过。
首轮失败是执行代理漏链接造成的环境准备错误，§4 已纠正。完整原始结果保留，不改判当次 FAIL。

| 返修 | 改动 | 同一回归在 fc3653f | 修复后 |
|---|---|---|---|
| R1 | errorFacts 移除固定码列表，按完整字符串格式校验 | 三个有效码均被错误归类 | R1 preserves all syntactically valid error codes… PASS |
| R2 | will-quit 不阻止退出；单次资源释放；exit-end 小型同步追加 | R2 normal quit… FAIL，原路径依赖 preventDefault 并触发二次退出 | R2 normal quit… PASS；同步写失败只计数测试 PASS |
| R3 | IPC、关键事件分文件；总计 6 MiB；初始化一次和内存大小 | 20000 IPC 后停顿记录丢失 | R3 retains one stall through 20000 IPC records… PASS |
| R4 | 错误框 heartbeat 暂停并重置，独立标记 error-dialog | 3 秒框等待被误报 stall | R4 excludes native error-dialog blocking time… PASS |
| R5 | 锁失败结束 app-ready，记 second-instance-exit | app-ready 无 end | R5 second-instance exit… PASS |

红测用 git show 取准确 fc3653f 的 main/logger 到系统临时目录，测试通过 A9_62_REVIEW_MAIN / A9_62_REVIEW_LOGGER 指向副本。
原模块未改字节，其他模块使用当前工作树。基线运行 27 项中 8 FAIL、19 PASS；五个 R1～R5 各失败。
绿测同一测试集 27/27 PASS。日志副本在 outputs/a9-62/r2-evidence；基线临时副本用完清理。

最终命令（cwd=/tmp/a9-62-diagnostics，全部为开发机证据）：

```sh
# Node 20.17.0；先编译依赖，再跑 Shell 日常集合
 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module shell
# 单元：日志与 main 真实源码/受控外设
 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/node_modules/jest/bin/jest.js --config src/shell/jest.config.js --runInBand --runTestsByPath src/shell/tests/product/a9-diagnostics-log.test.ts src/shell/tests/product/a9-startup-window.test.ts
# 基线红测：相同命令增加两个变量
# A9_62_REVIEW_MAIN=<mkdtemp>/main.js A9_62_REVIEW_LOGGER=<mkdtemp>/a9-diagnostics-log.js
# 真实 Electron 22.3.27 / Node 16.17.1；原 8 场景 + 正常退出 + 两分钟普通 IPC
 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/tmp/a9-62-diagnostics/outputs/a9-62/r2-final --case=smoke,startup-failure,stall-stage,stall-ipc,kill-stage,kill-ipc,rejection,window-events,normal-exit,steady-2m
 git diff --check
```

两分钟操作限真实 Renderer/preload/main 的工作区目录读取和产品正常初始化/轮询；无已选工作区、无模型请求、无文件写入。
该负载不代表整理文档或全功能用户操作。驱动记录实际进入 IPC 注册处理器的调用次数，不把两条日志算成两次 IPC。
关键事件与 IPC 窗口事件仍有异步队列丢弃/失败边界；文件可写时的直接证据见 RESULT.json。
Jest 退出句柄提示如实保留；不使用 forceExit 或删断言消除提示。
正式 Win7、Win10、打包、门 A/B、推送、发布保持 NOT_PERFORMED。


### 6.1 最终结果

- Shell 日常集合：75/75 套件，1623 PASS、12 跳过、0 FAIL，Node 20.17.0，入口退出码 0。
- Node 20 同一五项回归 27 PASS；fc3653f 精确副本 8 FAIL、19 PASS。Electron-as-Node 16.17.1 同一 27 项 PASS。
- 原 8 场景：7 项见 r2-final/RESULT.json；window-events 单独复验见 r2-window-events-drained/RESULT.json。
- 正常退出：code 0；beforeQuit=1、willQuit=1、dispose=1；exit-begin/end 各一条，exit-end code=0。
- 两分钟：120.004 秒，120 次真实 IPC，平均 59.998 次/分钟；第 1/2 分钟各 60 次。
- 日志总量 44895 字节；两分钟新增 42177 字节。第 1/2 分钟分别新增 21175 / 21002 字节。
- 运行前日志 2718 字节；不把初始化之前的记录计入两分钟新增量。
- 摘要：outputs/a9-62/R2_RESULT.json；逐分钟原始值见 r2-final/steady-2m/steady.json。

首次 r2-entry 的 window-events 因退出过快缺失 exit-begin，修复正常退出开始记录为同步追加后复验通过。
最终 r2-final 的 window-events 又观察到尚未排空的 window-responsive 丢失。两次原始 FAIL 全部保留。
共同根因是测试将异步日志写入与瞬时退出混在同一个断言。停止整批重试，仅修夹具让事件检查等待实际队列排空。
不再改产品退出流程。改后单场景 PASS；异步队列尚未排空即退出仍可能丢最后记录，作为已知限制。
窗口无响应/恢复通过明确派发事件验证接线，不宣称 OS 自动探测实测。Renderer 崩溃使用真实 forcefullyCrashRenderer。

文档索引检查未重复：本轮继续禁止 tasks/README 修改；既有 check_docs 的两项索引失败不改判。
临时基线、Jest 和 Electron 沙箱已清理，源码工作树和 outputs 证据保留。
