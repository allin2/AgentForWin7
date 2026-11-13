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

## 审核问题修复（2026-11-12）

负责人本轮要求修复审核表中的五项问题。实际基线为本工作树分支 `a9-65-visible-waits`，
HEAD `ea6dc13e14adb1cebf05c8121bd043ee9541a8c1`。开始时生产文件无修改，
仅有既存 `src/shell/office-lite/node_modules` 未跟踪链接，保持原样。main 工作区只读。
本轮只修改关闭等待、策略缓存与对应测试；无原生、依赖、IPC schema、系统权限或打包变化。
README、DECISIONS、STATUS 仍由负责人保留，不改既有审核 FAIL。

交付行为：等待报告说明清理仍在继续，成功后自动关闭；同次尝试只报告一次，
已有并发等待者共享该报告，报告后的调用立即返回 false。日志记录实际累计清理等待时间。
Runtime 对缓存结果绑定规范化的 stopManaged；不同策略返回 A9_SHUTDOWN_POLICY_CONFLICT，
不复用不同策略结果、不启动并发清理。原尝试仍继续，未确认清理时不释放锁。
无负载关闭同步释放锁，不写六对空阶段记录。

最短链路：定向红绿测试 → 当前依赖编译与 Shell 日常回归 → Electron 22 关闭卡住与正常退出。
定向测试新增真实 Registry.close → Runtime.shutdown → Registry.shutdown 冲突检查，
使用真实 SQLite 锁和受控 manager.dispose 等待。它补足旧测试未覆盖的跨入口策略冲突。
Electron 关闭场景检查真实错误框参数、重复关闭只有一条报告、晚到完成自动关闭。
原生日志夹具按产品启动流程初始化日志，不再依赖无负载关闭顺带创建日志。
直接验证为开发机；Win7、Win10、打包、门 A/B、提交、推送与发布均 NOT_PERFORMED。
如出现实现范围外缺陷或安全/完整性失败，停止依赖动作并保留首失败。

本轮结果绑定上述 HEAD 加本轮未提交修改；生产文件 SHA-256 见
`outputs/a9-65/review-fix/FINAL.json`。验证日志均在同一目录，未覆盖前轮证据。

| 检查 | 本轮结果 | 证据 |
|---|---|---|
| 定向红绿 | 旧实现首次 6 FAIL / 34 PASS；修复后含真实 Registry 双向场景 41 PASS | red-bounded.log、green-r2.log |
| 反向验证 | 仅换回被审 main：3 FAIL / 38 PASS；仅换回 runtime：5 FAIL / 36 PASS；两者换回：8 FAIL / 33 PASS | old-main.log、old-runtime.log、old-both.log、reversal.json |
| 依赖编译与 Shell 日常集合 | 78 套件、1708 PASS、12 跳过、0 FAIL；Node 20.17.0 | daily.log |
| 实际 Electron 22.3.27 / Node 16.17.1 | shutdown-stall、renderer-wait、normal-exit 三场景均 PASS，退出码 0 | electron/RESULT.json |
| 文档检查 | FAIL；仅既有 task-index、task-lifecycle 两项，负责人保留的索引未登记 A9-65 | docs.log |
| 差异及清理 | git diff --check PASS；定向、反转及 Electron 沙箱残留 0 | FINAL.json |

首次红色运行的策略冲突等待触及 Jest 期限，已改为测试自身的有界等待并在 finally 释放外设；
red-bounded.log 保留正确症状。首次绿色运行的三项夹具 FAIL 为无负载关闭不再创建日志目录，
green.log 保留原事实；夹具改为真实启动事件初始化日志，秘密扫描断言未减少。
反转只在系统临时目录替换两个文件，共享只读依赖；finally 删除沙箱。
反转前后生产文件 SHA-256 一致，未在生产树就地回退。
既存未跟踪链接保持；原 main 工作区无本轮写入。Win7 实机仍为 NOT_PERFORMED。

## 2026-11-12 收口授权与独立证据绑定

负责人要求“推进64，65收口”，批准本轮同范围本地收口、提交和整合；A9-64由负责人转交独立审查，产品修复不随本轮A9-65合入。公开推送、Win7新窗口、打包、正式门A/B及发布不在本轮范围。
本轮开始时main为4dfabf18…；本工作树HEAD为ea6dc13e…，四份产品/测试文件及本任务书未提交。主工作区38项既有修改与未跟踪文件已在候选外核SHA并备份，所有无关内容保留。
独立复核报告为outputs/a9-65/review-fix/independent-verification-20261112/RESULT.json。当前四份产品/测试文件SHA与该报告逐项相同；本任务书追加本段前的SHA也相同。41项定向、1708项Shell日常及3项Electron场景仅按准确字节记INHERITED_EVIDENCE，不宣称本轮重跑。旧实现3/5/8条反向失败及原索引检查FAIL保持。
本轮无新产品、原生、依赖或夹具变化。先完成本地提交与干净树整合，再以实际合并源码执行最短Electron消费者和受影响回归；README登记及ADR补记在集成端完成。最终绑定、直接验证和保护核对统一保存在主仓库outputs/a9-65-closeout-20261113。

## 2026-11-12 主线直接验证与收口结果

产品返修已在6ba877d…提交，随后连同ea6dc13e…的完整特性合入本地main。ADR-0329登记既有接口取舍；任务索引补齐，不再存在本任务原来的两项文档登记缺失。A9-64只登记任务书和独审提示词，产品不随本轮合入。

| 本轮检查 | 直接结果 | 边界与证据 |
|---|---|---|
| 七模块依赖闭包编译与Shell静态门 | PASS | Node20.17.0；实际main源码加原dirty，shell-daily.log |
| Shell日常集合 | 78套件，1710 PASS、12项按日常规则省略 | 包含本任务41项；不是全量产品或目标平台结论 |
| 必需字段慢检查 | 12/12 PASS | 单独按名称选择，required-fields.log；未选择项不冒充本轮直接执行 |
| 6000文件基线 | 3/3 PASS | 当前构建Workspace，workspace-baseline-6000.log |
| 真实Electron22/Node16 | 关闭等待、正常退出PASS；等待提示修正版单场景PASS | capture原生框、受控清理外设；非Win7，非真实Office清理 |
| 文档检查 | PASS | 主线原dirty保持；准确最终检查见RESULT_FINAL.json |

首轮Electron等待提示FAIL保留在electron/RESULT.json，退出码7、断言hidden仍为true。夹具固定等待8300ms没有观察业务状态；候选外受控时序用准确生产Preload证明首次定时回调7999ms时仍为null，8999ms下次采样才报告，见WAIT_FIXTURE_MIN_REPRO.json。该受控时序不冒充首轮真实回调计时。
后继仅修改两份Electron夹具为最多10秒的状态轮询，并断言真实显示不得早于8秒、显示已等待秒数至少8、诊断目录正确、原请求返回后隐藏以及诊断抽屉可读。不是简单增加固定sleep；产品8秒观察阈值、1秒采样及请求结果保持不变。两夹具已通过Electron22内置Node16语法检查。准确main产品加载、修正版夹具的renderer-wait场景PASS，实际观察8366ms，记录在electron-renderer-r2。
本轮未改产品，无新增依赖、权限、原生或模型调用。继承的原独立41项、1708项和三场景报告与首次FAIL均保留，不将后继夹具冒充独立复审。当前结果绑定main提交加原dirty及准确产品、夹具SHA；driver里的sourceBaseline字段是原任务基线4dfabf18…，本轮实际输入以RESULT_FINAL.json及其加载哈希为准。
主线保护快照、反向重构校验和恢复stash保留；分支及已有证据均不删除。当前开发机收口完成；Win7、Win10、打包、门A/B、公开推送和发布仍为NOT_PERFORMED。
