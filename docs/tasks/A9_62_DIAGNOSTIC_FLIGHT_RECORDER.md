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
产品主动退出先做有界日志收尾。启动失败先同步记录，再在普通模式显示错误码和日志目录，然后退出 1。
冒烟与验收模式不新增错误框，保留原报告与退出码。

开始记录最多等待 50ms 的诊断 I/O 预算。该预算不是产品操作超时。
可写且队列未满时，在重型工作执行前等待开始记录完成；磁盘失效、队列满或 I/O 挂起时继续产品操作。
此时强杀记录无法保证存在，丢弃/失败计数如实反映已知情况。
正常退出不阻止 will-quit，不调用第二次 app.quit。before-quit 每次异步记录 exit-requested；确定退出后同步记录 exit-end。取消退出不写 exit-begin/end，失败只计数。
目录和初始文件大小只在异步初始化时读取一次，后续大小在内存累计。
独立应急文件避免与异步轮转竞争。目录未初始化时同步路径自行创建目录；每次同步写入先 lstat，目标只允许不存在或普通文件，其他类型拒绝并计数。
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
因此按授权的保守分支省略错误消息。错误类只允许标准类名；字符串错误码须属于 A9_/A8_ 家族或 Node 系统码、总长不超过 48 且不含至少 6 位连续数字，才原样记录，其余归类。规则细节及边界见 §7。
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
采用独立关键事件保留、异步有界队列、带熔断的 50ms IPC 开始记录等待和小型同步致命/退出追加。
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


## 7. 2026-11-11 独立审核后的七项返修

负责人明确要求在 `3fbc40911022661a0c2269a8a6c189b2b38746e1` 后追加提交。
实际分支仍为 a9-62-diagnostics，工作树仍为 /tmp/a9-62-diagnostics。
本轮授权只覆盖 main、诊断模块、对应测试和本文档；未修改主工作区、IPC schema、Runtime、Core 或 Renderer。
Office Lite 依赖已核对为指向主仓库的符号链接，不纳入提交。§4 和 §6 的历史结果不改判。

### 7.1 当前行为和同步写入规则

1. 错误码只接受 `^(?:A[89]_[A-Z0-9_]+|E[A-Z0-9]{2,15}|ERR_[A-Z0-9_]{2,44})$`，
   同时要求总长不超过 48、不含 6 位及以上连续数字；非字符串也使用兜底码。
   本规则防意外泄漏，不防产品代码主动把秘密写进 code。错误消息、请求载荷、命令与凭据仍不入日志。
2. 同步写入只用于致命记录和退出记录；单条不超过 4 KiB，目标必须是普通文件，失败只计数。
   目标不存在时允许创建普通文件；每次写入前都 lstat，不打开 FIFO、符号链接、目录或其他特殊目标。
   本检查是写入前的类型检查，不宣称对抗恶意并发替换的文件系统隔离。
3. startup-failed、uncaught-exception 直接同步写 main.fatal.jsonl，不再依赖异步队列 50ms 内排空。
   仍保留 6 MiB 总量、4 KiB 单行上限和写失败不抛异常。普通 IPC 不使用同步写入。
4. 同步路径在异步初始化未完成时自行 mkdir。退出完成后，晚到的 ready 回调不再开始初始化，
   不为尚未建立消费者的首帧 Promise 制造退出拒绝。正常/冒烟的进程去留和退出码保留。
5. IPC 开始记录第一次等待超时后，后续开始记录只入队、不再等待；任一次写入成功后恢复等待。
   只熔断诊断等待，不中止 IPC、工具或命令。50ms 是定时器预算，不是主线程调度延迟的硬上限。
6. before-quit 每次异步记录 exit-requested；取消后仍可再次记录。确定退出才同步记录 exit-end，
   不再写含义不确定的 exit-begin。后台进程退出选择与 Runtime 的清理接口不变。
7. 无错误但耗时严格大于 1000ms 的 ipc-end 进入 critical.jsonl，不受日常 IPC 轮转影响。

同步普通文件 I/O 的实际耗时仍依赖文件系统；这不是可中断 I/O 或安全沙箱。
目录初始化和普通追加仍为异步有界队列；正常异步诊断在瞬时退出时仍可能来不及完成。

### 7.2 红绿回归

同一 34 项 Jest 回归在准确 3fbc4091 的 main/logger 临时副本上运行，副本以 git show 提取，其他模块与环境相同。
临时路径通过 A9_62_REVIEW_MAIN / A9_62_REVIEW_LOGGER 注入，finally 删除，未改写产品源码或历史。
基线结果：8 FAIL、26 PASS。S1～S7 各自变红；另外旧 R2 退出断言按新 exit-requested 合同更新后变红。
当前 Node 20.17.0 结果见 §7.3。

| 项 | 测试名 | 基线失败表现 | 修复后判据 |
|---|---|---|---|
| S1 | rejects accidental secrets while retaining approved code families | AUDIT_SECRET、长连续数字及无前缀码被写入 | 四种批准码原样写入；全部拒绝值为兜底码 |
| S2 | rejects nonregular emergency targets before synchronous open | 非普通目标仍调用 writeFileSync | 各特殊类型均不打开，writeFailureCount 增加 |
| S3 | startup failure and uncaught exception use the synchronous emergency path | 致命记录是异步调用 | main 两个真实处理器均同步记录 |
| S4 | emergency exit creates its directory before async initialization completes | criticalSync 返回 false | mkdir 永不完成时仍可读 exit-end |
| S5 | times out only the first IPC wait and recovers after a successful write | 第二次仍等约 50ms | 后续 19 次每次小于 5ms；写成功后再次等待实际落盘 |
| S6 | cancelled quit records every request and only confirmed quit records exit-end | 取消时遗留 exit-begin | 每次 exit-requested，确认前无 exit-end，确认后仅一条 |
| S7 | keeps successful slow IPC completion in critical.jsonl | 1100ms 成功结束记录在普通文件 | critical.jsonl 中可读 action 和 durationMs |

红测原始输出：outputs/a9-62/r3-evidence/red-final.txt；首轮红测也保留为 red.txt。

### 7.3 命令与开发机直接结果

所有 cwd 均为 /tmp/a9-62-diagnostics；下列命令前统一使用：

```sh
env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE
```

Node 20.17.0 路径为 `/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node`。
Electron 路径为 `/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`。

```sh
# 当前 34 项回归；红测同一命令仅增加上述两个临时副本变量
/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/node_modules/jest/bin/jest.js --config src/shell/jest.config.js --runInBand --runTestsByPath src/shell/tests/product/a9-diagnostics-log.test.ts src/shell/tests/product/a9-startup-window.test.ts
# 构建依赖后测试实际消费者；PATH 使用相同 Node 20.17.0 目录
/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module shell
# 真实 Electron 入口；--out 为本次新的绝对证据路径
/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/tmp/a9-62-diagnostics/outputs/a9-62/r3-complete --case=smoke,startup-failure,stall-stage,stall-ipc,kill-stage,kill-ipc,rejection,window-events,normal-exit,ipc-failure,fifo-exit,slow-startup,early-exit,early-quit,cancel-quit-stop,cancel-quit-leave,slow-uncaught,steady-2m
# 错误框调用捕获；明确不把它计作原生 UI 点击验证
/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/tmp/a9-62-diagnostics/outputs/a9-62/r3-dialog-capture-final --dialog-mode=capture --case=native-startup,native-uncaught,baseline-uncaught,baseline-rejection
```

- Node 20.17.0 单元与 Shell 日常集合：最终数字见下方补记和 R3_RESULT.json。
- 真实 Electron/Node 16.17.1：原 8 场景、正常退出、两分钟运行和新增故障场景见 r3-complete/RESULT.json。
- fifo-exit：用无读取端的真实命名管道占据应急文件；app.quit 后 code 0，before-quit/will-quit/dispose 各一次，写失败计数增加。
- slow-startup：每次异步追加实际延迟 200ms；startup-failed / ENOSPC 在应急文件可读，code 1。
- early-exit：Electron ready 后加载 main，异步 mkdir 永不完成，同一调用栈 app.exit(0)；只有一个 exit-end。
- early-quit：ready 前加载 main 后立即 app.quit，异步 mkdir 永不完成；只有一个 exit-end，code 0。
- cancel-quit-stop/leave：真实 Electron main、真实 Registry 与真实空闲 Node 子进程；测试注入 Runtime 的托管摘要/清理回执以及原生选择框返回值。
  首次取消时子进程存活、仅有 exit-requested；再次确认后 exit-end 一条，will-quit/dispose 各一次。
  before-quit 共三次是原后台退出选择逻辑取消、重试、确认后 app.quit 的结果，不是重复资源释放。
  这不是原生按钮点击或完整产品 Runner 清理验收。
- Node 16.17.1 独立无 Jest/VM 的临时探针：`ELECTRON_RUN_AS_NODE=1 <Electron> <临时 probe.cjs>`，退出码 0。
  直接调用当前日志模块，覆盖错误码、真实符号链接拒绝、早期建目录、20 次 IPC checkpoint 熔断/恢复和 1100ms 成功 IPC 关键记录。
  首次等待 52.430ms，后续 19 次最大 0.073ms。输出在 r3-evidence/node16-direct.txt，探针和数据已在 finally 删除。

### 7.4 首失败、限制与未执行项

- r3-final 的 window-events 因全队列瞬时清空断言受无关 IPC 写入影响，退出码 7；三个必需窗口事件当时均已落盘。
  夹具改为等待三个具体事件实际可读，同时继续拒绝写失败；单项复验通过，没有弱化事件判据。
- r3-final 的 ipc-failure 调用了不存在的 preload.setProvider，退出码 7。夹具改用 configureProvider，断言真实失败码与日志一致。
- ready 前直接 app.exit 不派发 Electron quit 或 Node process exit。最小独立 Electron 探针证据为 r3-evidence/early-lifecycle-probe.json。
  该无事件强制退出不保证 exit-end；不通过包装 app.exit 或改 Electron 原生退出语义绕过。
- 初次 early-quit 和 ready 后 early-exit 暴露晚到 ready 回调继续启动的缺口。已按 S4 修复，旧失败及重复 exit-end 原始记录保留，
  新场景明确断言只一条 exit-end、code 0 且没有晚到 startup-failed。
- Electron-as-Node Jest 首轮以 SIGTRAP 退出且无输出；禁用 JIT 和真实 Electron 内运行 Jest 两种诊断入口均输出 34/34 断言通过，
  但运行器退出阶段仍 SIGTRAP。诊断报告指向 V8 BackingStore 清理；精确根因 UNKNOWN。
  不将此运行器判 PASS；停止同类整批重试，采用上面的无 VM 最小探针和真实产品入口验证当前逻辑。
  三次运行原始输出 green-node16.txt、green-node16-jitless.txt、green-electron-jest.txt 保留。
- 原生错误框的实际呈现/关闭复验未完成：CUA 按 bundle 绑定到已有的另一 Electron 实例，不能定位测试进程。
  r3-native 中一次 deadline 和两次测试子进程终止均保留为 FAIL；只结束了本轮创建的测试组，没有操作已有 Electron。
  显式 --dialog-mode=capture 的四场景验证 main 调用参数、日志和继续/退出语义，不代表实际原生点击 PASS。
- Win7、Win10 实机，完整后台进程 Runtime/Runner 清理、原生选择框点击、打包、冻结、门 A/B、推送和发布均 NOT_PERFORMED。
  无新增范围、依赖、系统配置或负责人待裁决的技术取舍；上述开发机验证缺口不提升为正式验收结论。


### 7.5 最终结果与收尾

- 七项红绿：准确 3fbc4091 上 S1～S7 全部失败；当前两套件 34 项均通过（包含在 Shell 日常集合中）。
- Shell 日常最终运行：75 套件、1630 PASS、12 跳过、0 FAIL；退出码 0；36.547 秒。原始输出 r3-evidence/shell-daily-final.txt。
- Electron 22.3.27 / Node 16.17.1：r3-complete 18/18 PASS，入口退出码 0；强杀场景按要求为 SIGKILL，启动失败场景 code 1。
- 提示调用捕获：r3-dialog-capture-final 4/4 PASS，入口退出码 0；dialogMode=capture，不作为实际原生点击通过。
- 两分钟：120.002 秒、120 次 IPC，每分钟各 60 次；两分钟新增 41,936 字节，最终日志 44,636 字节。
  第 1/2 分钟分别新增 21,054 / 20,882 字节。未请求模型、未执行真实用户文档整理。
- Node 16 独立日志 API 探针 code 0；Jest 运行器退出 SIGTRAP 的原始失败保留，精确根因 UNKNOWN。
- git diff --check PASS。/private/tmp 与本会话 TMPDIR 中本轮测试前缀目录残留 0；工作树和 outputs 证据不属于临时沙箱。
- 仅七个授权文件追加提交；主工作区 HEAD 仍为 d5b99b62abb8c7fe1a52875272811a1b01f8bc5d，主工作区暂存区为空。
  未暂存 Office Lite 依赖链接，未推送。准确提交及产品/测试/任务书哈希见 outputs/a9-62/R3_RESULT.json。

## 8. 2026-11-11 独立复审返修（R4）

负责人要求在 `5042e04dea1a6de5645fd53b9e3f20d5a529c1ee` 上追加两项返修，并登记以下已知限制；主工作区、IPC schema、Runtime、Core、Renderer、远端和 Win7 均未触碰。Office Lite 依赖链接保持为 `/Users/qlyf/Developer/win7-coding-Agent/src/shell/office-lite/node_modules`，不纳入提交。

### 8.1 改动位置和行为

1. `src/shell/product/a9-diagnostics-log.js`：应急同步日志拆为 `main.fatal.jsonl` 与 `main.fatal.previous.jsonl`，每段默认上限 512 KiB。轮转时同步删除旧 `previous`、同步改名当前文件，再写入新当前文件；初始化同时按上限处理两段。两段与普通/关键日志的容量总和保持不超过 6 MiB。
   `uncaught-exception` 每进程最多同步落盘 32 条，超出部分只计入 `snapshot().suppressedCount`；`exit-end` 同步记录该数值，`startup-failed` 不受上限影响。现有 `main.js` 的未捕获异常与启动失败入口继续使用 `criticalSync`，本轮无需改动调用点。
2. `src/shell/product/a9-diagnostics-log.js`：异步队列项增加入队单调时间，仅当该项从入队到写完严格少于 50ms 时解除 IPC 等待熔断；同步写成功不再解除熔断。
3. `src/shell/tests/product/a9-diagnostics-log.test.ts`：新增以下红绿回归。

| 项 | 测试名 | `5042e04d` 基线红测 | 修复后绿测 |
|---|---|---|---|
| R4-1 | `retains the first uncaught exception, caps synchronous records, and reports suppressedCount on exit` | FAIL：无 `suppressedCount`，5000 条均写入 | PASS：首条仍可读，`uncaught-exception` 恰好 32 条，`suppressedCount=4968`，`startup-failed` 与 `exit-end` 可写 |
| R4-1 | `rotates a nearly full emergency file into previous synchronously` | FAIL：旧 `previous` 未被替换 | PASS：旧当前文件进入 `previous`，新记录在当前文件，两段均不超过 512 KiB |
| R4-1 | `keeps both emergency segments and all diagnostic files under 6 MiB` | PASS（旧实现已有总量上限，但只有单应急段） | PASS：双应急段存在且总量不超过 6 MiB |
| R4-2 | `suspends IPC waits after a slow async write and recovers only after a fast queued write` | FAIL：20 次慢写会重复等待约 50ms | PASS：第 1 次等待，后 19 次各小于 5ms；延迟撤掉后第 2 次等待并确认 `ipc-begin` 已落盘 |

4. `src/shell/tests/product/a9-diagnostics-entry.cjs`、`run-a9-diagnostics-electron.cjs`：增加 Electron `uncaught-flood` 夹具和断言，真实触发 5000 次未捕获异常并核对 32 条记录、`suppressedCount=4968`。

### 8.2 本轮检查和证据

| 检查 | 命令/证据 | 结果 | 证据层级 |
|---|---|---|---|
| R4 基线红测 | `A9_62_REVIEW_LOGGER=<git show 5042e04d 的临时副本> env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/node_modules/jest/bin/jest.js --config src/shell/jest.config.js --runInBand --runTestsByPath src/shell/tests/product/a9-diagnostics-log.test.ts`；原始输出 `outputs/a9-62/r4-red-final.txt` | 22 项中 19 PASS、3 FAIL（R4-1 上限、R4-1 轮转、R4-2 熔断） | 开发机 Node 20.17.0，准确基线副本 |
| R4 定向绿测 | 同一 Jest 命令，使用当前工作树 logger；原始输出保留于本轮终端 | 22/22 PASS | 开发机 Node 20.17.0 |
| Shell 日常集合 | `env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node scripts/verify_integration.mjs --daily --module shell` | 75/75 套件，1634 PASS、12 跳过、0 FAIL；构建、lint、测试均退出 0 | 开发机 Node 20.17.0；当前工作树构建输出 |
| Electron 既有入口与新增场景 | `/Users/qlyf/.nvm/versions/node/v20.17.0/bin/node src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/tmp/a9-62-diagnostics/outputs/a9-62/r4-complete --dialog-mode=capture --case=smoke,startup-failure,stall-stage,stall-ipc,kill-stage,kill-ipc,rejection,window-events,normal-exit,ipc-failure,fifo-exit,slow-startup,early-exit,early-quit,cancel-quit-stop,cancel-quit-leave,slow-uncaught,steady-2m,uncaught-flood` | 19/19 场景 PASS；`steady-2m` 为 120 次真实 IPC；新增 `uncaught-flood` PASS | 开发机 Electron 22.3.27 / Node 16.17.1，`DEVELOPER_ELECTRON` |
| 差异与临时目录 | `git diff --check`；测试钩子清理系统临时目录，运行后按项目前缀核对 | PASS；本轮测试沙箱零残留 | 开发机工作树 |

### 8.3 已知限制和未执行项

- 诊断目录按“当前用户独占”设计。同一用户的其他进程把日志文件替换为命名管道或符号链接，不在防护范围内：异步日志文件被替换时进程退出可能卡住；同步写入的 `lstat` 检查与写入之间存在替换窗口。触发前提是攻击者已能写入 `userData`；Win7 NTFS 没有这种管道文件，创建符号链接默认需要管理员权限；Node 16/Win7 没有可用的 `O_NOFOLLOW` 与 `O_NONBLOCK` 路径。现有 `lstat` 检查保留，不加码。
- 原生错误框的实际点击尚未验证，留到 Win7 开发通道；`dialogMode=capture` 只验证调用、日志和继续/退出语义。
- Node 16 的 Jest 运行器退出时 `SIGTRAP` 与基线相同，精确根因 `UNKNOWN`；本轮以无 VM Node 16 探针和真实 Electron 入口作为替代证据。
- Win7/Win10 实机、完整后台 Runtime/Runner 清理、原生错误框点击、打包、候选冻结、门 A/B、推送和发布均为 `NOT_PERFORMED`。本轮只产生开发机证据，不提升为 Win7 PASS 或正式候选结论。

本轮没有新增需要负责人裁决的技术取舍；以上命名管道/符号链接边界、原生错误框点击和 Node 16 Jest `SIGTRAP` 均按负责人已裁决的已知限制登记，不改代码绕过。
