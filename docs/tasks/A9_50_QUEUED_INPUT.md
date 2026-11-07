# A9-50 — Composer 状态入口与显式排队输入

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main
Source Baseline: ef6a692294fa4e0403b2d1e00ea188b2e79749f8
Phase-Gate: A9_50_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

负责人在状态与接口整理、排队输入的建议后回复“去做吧，使用instabox”。
本轮在 main 连续实现并验证；已有 19 份修改保留。

## 1. 交付与边界

- 分离运行事实、按对话草稿和待发送队列；提供稳定行为入口供测试调用。
- 运行中仍可起草。用户显式加入队列后，当前轮正常完成才按顺序发送；未入队草稿不自动发送。
- 每个对话最多 8 条，每条最多 8000 字符。队列可暂停、移除和显式继续；单轮执行，无转向或并行。
- 停止、失败、取消、切换、关闭或重启使队列暂停。审批和问询继续使用原目标绑定入口，未解决时不发送下一条。
- 草稿与队列复用当前用户 DPAPI 密文存储；引入版本化 Composer 信封，兼容旧草稿。
  无加密能力时仅内存并明示。重启恢复内容但不恢复自动发送授权。
- 新增窄 Schema IPC；不更改权限模式、Runner、原生模块、CSP、模型协议或依赖。
- 既有历史浏览和多窗口行为不在本轮改变范围。

## 2. Instabox 与执行范围

使用 cw 的独立现有开发实例 `m_agq3lbhvcxosaxppo5plbw6riy`，先确认无其他任务。
只在本轮独立目录上传精确源码并准备锁定 Node/依赖，主代理直接操作，不启动模型子代理。
不占用 ci/monster、不操作 czl/chai2/chai521、不删除实例、快照、历史或登录。
模型请求仅本机回环夹具，外部请求 0；无提交、推送、发布或正式门 A/B。
开发检查与结果回收后保留现有实例和登录，释放本轮租约。
证据沿用 `outputs/a9-50-queue-r1/`。

## 3. 必要验证与停止条件

先构建七模块依赖闭包，再跑 Composer、Runtime、IPC、Preload 的定向合同及 Shell 静态门。
最短真实链路：实际 main/preload/IPC/runtime/SQLite → 回环请求挂起 → 入队 → 完成后 FIFO 单次发送。
覆盖队列与草稿隔离、重复点击、停止、失败、审批/问询阻断、错对话、恢复不重放与保存失败。
检查受影响输入、队列和停止在窄窗/低高度可达；不以 DOM 桩证明真实产品链。
测试沙箱由 finally 清理。完成 docs:check 与 diff 检查，核对原 dirty。
同类两轮失败先最小诊断；身份、完整性、安全或未知生命周期失败停止依赖动作。
Linux/Mac 结果仅开发机；Win10、Win7 和正式候选均 NOT_PERFORMED。

## 4. 开发交付结果（2026-11-07 UTC）

执行代理在 main `ef6a6922…` 加本轮未提交补丁完成开发交付。
阶段为 `A9_50_DEVELOPER_VERIFIED`，证据层级为 Mac / Linux 开发机。
准确源码 SHA、结果与日志索引见本机 `outputs/a9-50-queue-r1/RESULT.json` 和 `CHANGE_MANIFEST.json`。

### 4.1 实现

main 的 `a9-composer-state.js` 持有按对话草稿、版本化密文信封与队列。
Renderer 的 `a9-composer-controller.js` 提供可直接调用的编辑、发送和入队条件。
运行时通过现有 Agent Loop 串行消费；每条先从密文队列移除，再创建实际任务。
未入队草稿保持独立，自动发送不清空草稿；停止和关闭不依赖草稿数据库读取。
Schema IPC v8 只增加绑定对话的队列动作；旧 Preload 动作继续使用 v7，v6/v7 请求兼容保留。
队列可加入、暂停、继续和逐条移除；最多 8 条，每条 8000 字符。
审批和问询不被队列绕过，拒绝或取消后暂停。

### 4.2 直接检查与继承

| 检查 | 结果及边界 |
|---|---|
| Mac Shell 日常集合 | 66 个文件，1465 PASS / 12 NOT_PERFORMED；七模块依赖编译、Shell 静态门通过。绑定 Stop 最后修正前源码 |
| Instabox Shell 集合 | cw 的 `a9-50-shell-r3`，同样 66 个文件、1465 PASS / 12 NOT_PERFORMED，退出 0；Node 20.17.0，耗时 43.970 秒 |
| 最后 Stop/存储修正 | Mac 与 cw `a9-50-storage-r4` 各 4 个文件、142 PASS，直接覆盖当前模块、FIFO、审批、问询、取消、关闭及草稿持久化；其余未变组沿用上一行，标 INHERITED_EVIDENCE |
| 实际 Electron 产品 | `product-final/RESULT.json`，Electron 22.3.27 / Node 16.17.1 / ABI 110；两进程共 6 组 PASS，加载当前 main/preload/IPC/runtime/SQLite 与新 Composer 模块 |
| 产品交互 | 双击只入队一次；两条 FIFO 各发送一次；未入队草稿不进入模型或账本；停止保留、移除、失败后显式继续及重启不重放通过 |
| UI | 1366×768、900×540、780×540 准确 CSS 视口；输入、加入队列、暂停与停止均可命中，无横向溢出。窄窗截图已查看 |
| 存储与恢复 | 实际 Mac 仅内存，重启不恢复且不发请求。版本化密文队列恢复后暂停，由 Runtime + SQLite + 合成 safeStorage 检查；不冒充真实 Windows DPAPI |
| 完整性与收尾 | cw 最终 17 个任务源码/测试 SHA 与 Mac 一致；本轮任务进程 0、四个作业临时目录已删除；日志逐文件 SHA/大小回收核对 |

12 项未执行沿用日常集合的慢速判定器规则；本轮另外直接运行完整 batch2 合同和历史加载测试，712 项通过。
本轮只修改 Composer 相关产品和测试，未改 Core、State 数据库表、Runner、原生组件或依赖锁。
Win10、Win7、正式候选、门 A/B、提交、推送与发布均为 NOT_PERFORMED。

### 4.3 首失败与恢复

首次广回归的旧 VM 夹具没有加载新 Composer 模块；新 Preload 版本还影响旧断言。
执行代理给夹具加载真实依赖，并让旧动作保持 v7、新队列使用 v8，没有放宽输入拒绝规则。
第二次历史加载夹具仍漏了另一入口，最小诊断读取首个错误条定位后补齐；没有继续盲目整批重试。
初次产品驱动在 Renderer 刷新前点击禁用发送按钮，导致等待超时；改为等待真实发送条件后通过。
cw 首次集合使用初次上传残留的旧 Preload 测试断言；同步准确测试字节后新作业通过。
所有失败保留，不覆盖改判。最终 Stop 修正前后作业按不同源码哈希记录。
Mac 广回归出现过 Jest 延迟退出提示，命令最终退出 0；产品进程与 cw 本轮作业已直接核对结束。

### 4.4 资源和保留

cw 原实例 `m_agq3lbhvcxosaxppo5plbw6riy` 与登录保留，未新建、删除实例或快照。
执行代理只使用 `/data/home/a9-50-queue-20261107/` 和本轮作业目录，已释放 `a9-50-queue` 租约。
ci/monster、czl、chai2、chai521 未操作。外部模型请求为 0。
原 19 份 dirty 中，ADR、索引和 STATUS 只追加本轮记录，其余 15 份文件 SHA 未变，HEAD 未变。
本轮源码、回收日志和证据保留；测试沙箱已清理。后续 Win7 开发运行和发版由负责人另行确定。
