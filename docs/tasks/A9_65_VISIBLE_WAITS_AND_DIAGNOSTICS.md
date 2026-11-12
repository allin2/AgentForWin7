# A9-65 — 可见等待与诊断接线

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: a9-65-visible-waits
Source Baseline: 4dfabf18f41b4f75dd3c910fd0149d1995c5ac93
Phase-Gate: A9_65_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

## 授权与范围

授权来源是负责人 2026-11-11 回复“写批次 2、4 提示词”，以及本轮完整 A9-65 执行指令。
工作树 `/Users/qlyf/Developer/a9-65-visible-waits` 位于主仓库之外。主工作区只读。
仅处理审计 F-003、F-016 和既有诊断接线。允许本地提交，不推送、不连 Win7、不打包。
不改 Core、Workspace、State、Runner、Gateway 源码。探测参数、分类表达式及紧邻错误显示不变。
负责人明确保留索引登记和 ADR 裁决；本任务不修改 README、DECISIONS、STATUS。

## 行为与位置

- `product/a9-agent-runtime.js`：六个固定关闭等待阶段、单次释放、持久化诊断投影、凭据验证原因。
- `product/main.js`：同一退出尝试缓存、30 秒报告与晚到完成、阶段日志接线。
- `product/preload.js`：公共请求入口仅观测等待；不取消、不重试、不改变请求结果。
- `product/renderer/a9-workbench.js`、`a9-agent-panel.js`、`workbench.html`：既有行结构显示诊断和无响应提示。
- `tests/product/a9-visible-waits.test.ts`、诊断 Electron 入口及驱动：红绿和实际运行时验证。

阶段为 `checkpoint_recovery`、`active_task_cancel`、`office_close`、`state_operations`、`managed_process_stop`、`background_manager_dispose`。
阶段记录仅用 ADR-0328 白名单中的 stage、operationId、durationMs、errorCode、errorName。
30 秒只报告，保留窗口与锁；同次尝试继续。再次关闭复用它，晚到成功继续原关闭或退出。
保持既有活动任务取消的 10 秒期限。不给工具、用户命令或模型请求增加期限。

## 返回字段

下表区分新增字段与基线已有字段。未新增 IPC 通道，未变更请求 schema 或关闭结果结构。
合入时由负责人依据此清单决定是否新增 ADR。

| 入口 | 字段 | 本次变化 |
|---|---|---|
| Runtime 快照 | `persistenceDiagnostics` | 新增数组，最多 20 条；缺诊断时为空数组 |
| 同上 | `persistenceDiagnostics[].code` | 新增投影字段，仅复制既有错误码 |
| 同上 | `persistenceDiagnostics[].detail` | 新增投影字段，既有说明文字经当前秘密脱敏器处理；不复制 count/table/rowId |
| `product:get-diagnostics` | `diagnosticLog.directory` | 基线已返回；接到诊断面板和等待提示 |
| 同上 | `diagnosticLog.writeFailureCount` | 基线已返回；非零才显示 |
| 同上 | `diagnosticLog.droppedCount` | 基线已返回；非零才显示 |
| 同上 | `diagnosticLog.suppressedCount` | 基线已返回；非零才显示 |
| 同上 | `diagnosticLog.ipcWaitSuspended` | 基线已返回；true 才显示熔断中 |
| Git 状态 | `projection.diagnostics`、`[].code`、`[].operation`、`[].detail` | 基线已通过既有脱敏投影返回；本次两处 UI 显示 code/detail，不丢弃诊断 |
| Provider 快照 | `provider.diagnostics.code`、`.detail` | 字段已存在；新增错误码 A9_PROVIDER_SECRET_VERIFY_FAILED；detail 仅为三种固定原因 |

主进程内新增 Runtime 方法 `getShutdownStage(): string | null`，不经 IPC 暴露执行能力。
受限 Runtime 同样提供该方法，返回 null。新增组合参数 `shutdownStageRecorder(stage)` 仅用于 main 诊断接线。
Preload 新增本地订阅 `onRequestWait(callback)`，返回取消订阅函数；回调值为 null 或
`{ elapsedSeconds, directory }`。这两个回调字段是 Renderer 桥新增字段，不是新增 IPC 返回。
shutdown() 的 stopped、leftToSystem、unresolved 保持原结构与含义。

新事件为 shutdown-stage-begin、shutdown-stage-end、shutdown-wait-reported。
开始/结束通过 A9-62 Flight Recorder 写入。仅使用现有白名单，不复制工作区、请求或错误消息。

## 长等待排除

公共入口为 preload 的 request、a8Request、a9Request、getDiagnostics，全部经过同一观察器。
只按精确 channel/action 排除，不整条排除共享通道。下列 12 项逐项有排除测试。

| 通道 | action | 排除理由 |
|---|---|---|
| product:a9-request | a9.provider.configure | 等待真实 Provider 能力探测，外部网络耗时不是主线程失联 |
| product:a9-request | a9.provider.probe | 等待真实模型探测，不给模型请求加 deadline |
| product:a9-request | a9.shell.configure | 显式 Shell 配置可等待原生可执行文件选择框 |
| product:a9-request | a9.workdir.link | 等待用户选择关联目录，随后等待原工作区关闭 |
| product:a9-request | a9.turn.submit | 原 action 等待完整 Agent Turn，包括模型、工具与用户命令 |
| product:a9-request | a9.task.continue | 继续中断任务后等待模型与工具整轮结束 |
| product:a9-request | a9.turn.resumeApproval | 批准后等待原任务继续执行；拒绝路径也使用同一 action |
| product:a9-request | a9.question.reply | 回答后可继续模型与工具；取消路径也使用同一 action |
| product:a9-request | a9.turn.stop | 无活动 Turn 时可等待托管进程实际停止及审计 |
| product:a9-request | a9.workspace.close | 等待工作区完整关闭与状态收尾，不按 8 秒判主进程失联 |
| product:a9-request | a9.workdir.rename | 目录更名前等待 Runtime 关闭，可能包含长状态收尾 |
| desktop:request | workspace.select | 原生目录选择框等待用户操作 |

已核对 desktop 的 task.submit、task.approve、task.reject：任务在后台派发，IPC 返回受理结果。
session.close 只归档空闲会话；task.cancel 返回取消受理。均保留观察。
product:a8-request 的 Review 动作返回同步投影或派发结果，没有设计为等待整轮任务的 action，均保留观察。
a9.workdir.start 使用 acceptOnly 返回受理结果，保留观察。文件、Git、快照、历史与诊断读取也保留观察。
不自动重试，不取消请求，不记录请求内容；每秒更新最老未完成请求的已等待秒数。

## 验证

证据目录 `outputs/a9-65/` 被 Git 忽略。
命令均在工作树根目录执行。为便于复现，下列 n20 是实际命令前缀的等价简写。

```sh
n20() { env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE PATH=/Users/qlyf/.nvm/versions/node/v20.17.0/bin:$PATH /Users/qlyf/.nvm/versions/node/v20.17.0/bin/node "$@"; }
# T：同一组 35 项新增测试
n20 src/shell/node_modules/jest/bin/jest.js --config src/shell/jest.config.js --runInBand --runTestsByPath src/shell/tests/product/a9-visible-waits.test.ts
# R：准确基线副本，sha256 逐文件记录，finally 删除系统临时沙箱
 env -u NODE_OPTIONS -u ELECTRON_RUN_AS_NODE python3 outputs/a9-65/run-red.py
# D：依赖闭包构建、Shell 静态检查、日常集合
n20 scripts/verify_integration.mjs --daily --module shell
# E：原有 19 项，加关闭卡住场景
n20 src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/Users/qlyf/Developer/a9-65-visible-waits/outputs/a9-65/electron-full --dialog-mode=capture --case=smoke,startup-failure,stall-stage,stall-ipc,kill-stage,kill-ipc,rejection,window-events,normal-exit,ipc-failure,fifo-exit,slow-startup,early-exit,early-quit,cancel-quit-stop,cancel-quit-leave,slow-uncaught,steady-2m,uncaught-flood,shutdown-stall
# U：真实 Renderer 等待提示、返回后消失、点击诊断抽屉
n20 src/shell/tests/product/run-a9-diagnostics-electron.cjs --electron=/Users/qlyf/.cache/w7-electron-22.3.27/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --out=/Users/qlyf/Developer/a9-65-visible-waits/outputs/a9-65/electron-renderer-final --dialog-mode=capture --case=renderer-wait
n20 scripts/check_docs.mjs
 git diff --check
```

| 项 | 实际命令 | 结果和数值 | 证据层级 | 原始证据 |
|---|---|---|---|---|
| 1 关闭卡住 | T；E 的 shutdown-stall | 6 个生产关闭闭包阶段反例通过；另 1 条真实 Runtime/SQLite/JSONL 测试证明锁仍在、begin 存在而 end 不在；报告期限注入为 15ms，Electron 为 60ms | 开发机 Node 20；开发机 Electron 22.3.27 | green-final.log；electron-full/shutdown-stall/ |
| 2 关闭重试 | T；E 的 shutdown-stall | stopManaged true/false 各 1 条，加窗口关闭/应用退出共享 1 条；同次释放调用为 1，晚到完成关闭；真实 Runtime 重复 shutdown 返回同一 Promise | 开发机 Node 20；开发机 Electron 22.3.27 | green-final.log；electron-full/shutdown-stall/shutdown-stall.json |
| 3 正常关闭 | T；D；E 的 normal-exit 与 cancel-quit 两项 | 正常/空闲 2 条通过；原返回对象相同、空闲同步释放、管理器完成前不释放；既有关闭/生命周期测试通过。Electron 正常退出 beforeQuit=1、willQuit=1、dispose=1 | 开发机 Node 20；开发机 Electron 22.3.27 | daily-final.log；electron-full/normal-exit/lifecycle.json |
| 4 诊断面板 | T；U | 4 条诊断投影/DOM 测试通过；非零计数、持久化项、两处 Git 码、空项回退；真实抽屉目录行通过 | 开发机 Node 20；开发机 Electron 22.3.27 | green-final.log；electron-renderer-final/renderer-wait/renderer-wait.json |
| 5 无响应提示 | T；U | 1 条观察器测试加 12 条逐 action 排除测试通过；9 秒时回调、请求结束清除。真实 Renderer 在 8 秒显示，响应后隐藏 | 开发机 Node 20；开发机 Electron 22.3.27 | green-final.log；electron-renderer-final/RESULT.json |
| 6 密钥校验 | T | 三种原因各有生产函数反例和公开 configureProvider 入口测试，共 6 条；唯一标记不在诊断、响应、日志或快照 | 开发机 Node 20 | green-final.log |
| 7 红绿 | R；T | 同一 35 条：准确基线 34 FAIL、1 PASS；当前 35 PASS。1 条基线即通过的是空闲同步释放守卫 | 开发机 Node 20 | red-final.log、red-final-command.json、green-final.log |
| 8 Shell 日常集合 | D | 78 套件、1702 PASS、12 跳过、0 FAIL；基线 77 套件、1667 PASS、12 跳过，新增 35 条 | 开发机 Node 20 | daily-final.log |
| 9 Electron 入口 | E；U | 原 19/19，加关闭卡住 1/1；额外 Renderer 场景 1/1。两分钟场景 120 次真实 IPC。全部退出码 0 | 开发机 Electron 22.3.27 | electron-full/RESULT.json；electron-renderer-final/RESULT.json |
| 10 差异和沙箱 | git diff --check；运行前后系统临时目录清单比对 | whitespace 0；本轮新增测试沙箱残留 0 | 开发机 Node 20 | final-integrity.json、test-sandbox-cleanup.json |

T 的六阶段测试执行真实 shutdown 函数闭包，外围 Promise、管理器和锁释放受控。
真实 Runtime 测试使用当前构建 State/Workspace/Runner、真实 SQLite 与真实日志；只扣住管理器释放边界。
E 的关闭场景使用真实 main/Registry/Preload/Renderer/日志，Runtime 释放为受控外设；不宣称真实 Office 或进程停止已验证。
原生错误框用 capture 模式读取实际调用参数；未进行人工点击验证。
U 使用真实 DOM 显示与抽屉点击，主进程处理器被挂起，未伪称 CPU 完全卡死。

首轮失败全部保留。daily-first.log 的 Office 失败源于执行代理漏建嵌套 office-lite/node_modules 链接；
其他失败来自旧 VM 缺定时器、截取函数缺外层变量、受限 Runtime 接口缺 getShutdownStage。
补依赖链接、补夹具外围和受限方法后闭环，未删除既有断言。
新 Electron 首轮因夹具从错误配置层取 recorder 而失败，修复为捕获实际 Flight Recorder 后单场景通过。
定向测试追加真实入口时的字段名和日志尚未初始化断言错误也保留在 targeted-r3/r4.log。
首轮遗留测试沙箱逐项确认无进程使用后清理，原始失败日志保留在证据目录。

文档检查只报预期的 task-index、task-lifecycle 两项，均指向负责人保留的 tasks/README.md。
本任务不通过修改索引消除此预期失败。

所有 Node 命令使用 Node 20.17.0，清除 NODE_OPTIONS 和 ELECTRON_RUN_AS_NODE。
测试沙箱使用系统临时目录 a9-65- 前缀，由清理钩子或 finally 删除。

## 已知限制

30 秒和 8 秒两个数值未经 Win7 校准。
主进程完全卡死时，关闭提示本身也弹不出来，只能依靠 A9-62 的停顿记录事后诊断。
8 秒表示最老未完成的非排除请求等待时间，不证明整个主进程停止响应。
目录依赖一次成功的既有 getDiagnostics 返回；首次获取也挂起时只能显示“尚未取得诊断日志目录”。
诊断日志沿用 A9-62 有界异步队列；磁盘失败、队列满、瞬时退出仍有丢失边界，计数如实显示。
关闭继续时不恢复新任务准入；仍遵守 registry closingAll 和 Runtime shutdownRequested。
超时之后晚到成功会继续原关闭；窗口关闭升级为应用退出时采用已明确请求的应用退出。
开发机验证不签 Win7 结论。Win7、打包、正式门 A/B、推送和发布为 NOT_PERFORMED。
