# A9-49 — 受限运行时与 HTTP 错误接收加固

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: RELIABILITY_HARDENING
Target Branch: main
Source Baseline: 6b4a86cccf050b21d3f0c6401aaadc4cc0bad2c8
Phase-Gate: A9_49_DEVELOPER_VERIFIED
Win7-Validation: DEV_CHANNEL
```

## 1. 授权与结果

负责人明确要求“先做第一项，使用instabox开发测试以及ci”。
范围为上一轮建议中的两项已确认问题，依据本机 `outputs/repo-review/code_quality_audit_2026-11-04.md` CQ-08/CQ-09。
执行代理在当前 main 登记、回收和整合；开发在独立 InstaBox 工作包分支 `box/relfix1a`。
独审后的同范围局部诊断修复由主代理在 `box/relfix1c` 完成并补测，不新增模型员工调用。
既有未提交文件按准确哈希保护，不纳入工作包或提交。

交付结果：

1. SQLite 不可用及诊断运行时补齐 ready 运行时已有的公共方法，返回原受限分类，保持拒绝执行。
2. HTTP >=400 错误响应在接收阶段设置明确的字节预算，只保留有界诊断前缀。
   超限后停止接收并经统一收尾返回原 HTTP 分类，明确截断，不继续积累正文。
3. 通过真实 IPC handler 和本机 HTTP 服务验证错误分类、调用完整性、分块 UTF-8、超限与取消。
4. 私有 staging 的准确工作分支增加一次针对 gateway/shell 的 InstaBox CI；回收准确提交的结果。

## 2. 实现边界

定位为 `src/shell/product/a9-agent-runtime.js`、`src/gateway/src/provider/openai-compatible.ts`、
对应模块必要测试与 `.github/workflows/instabox-reliability.yml`。
员工不修改共享任务/状态/ADR，不重构工作台、Provider 配置、Loop 或持久化。
沿用 D-009 Electron 22.3.27 / Node 16.17.1 及开发 Node 20.17.0，无新依赖、系统 API、安装前置或权限。
补齐方法属于现有公共接口的缺陷修复，不新增 IPC action/schema，不改变持久化与权限模型。
成功 SSE 路径、TLS 默认校验、脱敏、重试分类及取消合同保持。

## 3. InstaBox 与 Git 边界

- 开发：czl r4 `sn_agq2jii7qd46ez2r4afj3gbbku` 新建 `wp-relfix1a`，Codex workspace-write。
- 审核与干净 G0：chai2 `sn_agq27fp7om7swosgvyoh5nukbe` 新建 `wp-relfix1b`，Claude plan。
- 首轮各一次 CLI、每次最多 1200 秒；普通局部修复由主代理按现有工作包完成，不盲目重发员工调用。
- 首轮两台本轮工作机串行使用；局部修复可新建一台短时补测机 `wp-relfix1c`，仍串行使用。
  不新增模型调用、并发或付费预算，每台四小时兜底删除；已有机器、母机及快照保持原状。
- 认证失败不重试，凭据异常变化进入 CREDENTIALS_HOLD；不复制 Mac 个人模型登录。
- 允许同步准确基线至私有 staging 的 `base/6b4a86cc`，推送 `box/relfix1a` 并触发其 CI。
  同范围局部修复推送 `box/relfix1c` 后通过已有 `workflow_dispatch` 手动触发其准确提交；不扩大 push 触发分支。
- 员工不暂存/提交/推送；包装器核对准确清单后提交。短命 deploy key 用完撤销。
- Mac 在 G1 后整合本次修复与文档，可作本地提交；公开 origin 推送、发布和 PR 合并待负责人决定。
- 无新订阅、扩容、App 权限、secrets、全局配置、目标 Win10/Win7 或正式门 A/B。

## 4. 验证与停止条件

执行员工先跑最窄真实测试，再由新审核机运行 gateway/shell 日常 G0。
CI 使用现有准备脚本与锁文件，`contents: read`，checkout 不持久化凭据。
工作流只对本次私有分支 push 或手动触发，不扩大公开自动触发。
Mac G1 检查引用、单父链、范围、秘密、输入指纹和 docs:check；不重复相同 Linux G0。
必要时只针对 Node16 产品兼容性做已有运行时检查，不下载新运行时。
测试沙箱位于系统临时目录，用 finally/清理钩子回收；资源及日志回收核验后删除本轮机器。

源码身份、秘密、权限、生命周期未知时停止依赖阶段；同类失败两轮先最小诊断。
CI 未分配 runner 时记录 BLOCKED 并查已有诊断，不擅改配置或转推公开产品。
Linux/Mac 为开发机证据，Win7 为 NOT_PERFORMED；历史候选、FAIL/UNKNOWN 不改判。
证据目录 `outputs/a9-49-runtime-failure-r1/` 与 `outputs/wp/relfix1{a,b,c}/`。

## 5. 开发交付结果（2026-11-06 UTC）

结论：两项产品修复已完成并整合至本地 main。开发机验证 PASS；最终准确提交的 InstaBox CI 为 BLOCKED，
GitHub 状态为 queued，尚无 runner，未执行 CI 测试。Win7 实机为 NOT_PERFORMED。

源码绑定：

- `96e21089bcce28d381052b17a9f9357dba52b12f`：两类受限运行时补齐四个已有公共方法；HTTP 错误体接收上限 64 KiB；
  完整错误、超限、中断、取消均通过统一收尾释放连接、计时器和监听器；新增精确回归与本次私有 CI。
- `a14947917c7bd75aa474eebfb19092b7e0892ce6`：独审提出的诊断边界由主代理修正；中断错误不展示正文，
  防止半截 API key 绕过完整匹配脱敏。保持 HTTP 状态、认证及重试分类，成功 SSE 路径保持。

开发机证据：

| 范围 | 绑定与结果 |
|---|---|
| 真实 IPC 专用回归 | 首提交，15/15 PASS；覆盖四种 action 与三种受限状态、原分类及初始化诊断保持 |
| HTTP 专用回归 | 最终提交，24/24 PASS；覆盖字节边界、分块 UTF-8、Content-Length、超限、取消、超时、中断及半截凭据 |
| 新审核机 G0 | 首提交，Gateway 20 套/328 项 PASS；Shell 64 套/1448 项 PASS，12 项日常慢测跳过 |
| 最终 Gateway G0 | 最终提交，20 套/329 项 PASS；构建依赖、模块构建及测试均 PASS |
| Mac 接收检查 G1 | 两次均 PASS；单父链、准确引用、变更范围、输入指纹、秘密扫描和 docs:check；最终另跑 Gateway 模块验证 PASS |
| Shell 继承 | 最终提交相对首提交的 Shell 产品及测试文件哈希不变，继承首提交的新审核机证据，不冒充最终提交直接运行 |
| 独立只读审核 | 首提交 P0=0、P1=0；具体报告 `outputs/a9-49-runtime-failure-r1/REVIEW.md`；局部修正未另启审核员工 |

首轮 Codex 沙箱拒绝 loopback 监听，该次 HTTP 用例未验证行为；普通开发作业随后暴露 Node 20 的 socket 复用收尾问题。
最小探针确认 response 结束后 socket 已脱离 response，随后显式关闭原错误响应 socket，23 项回归 PASS。
主代理局部修正首次编译因变量名错误 FAIL，修正后 24 项回归和最终模块验证 PASS；各次原始失败记录保留。
失败测试本轮创建的系统临时目录已逐项清理，清理后剩余数为 0。

首轮 `relfix1a`、独审 `relfix1b`、补测 `relfix1c` 三台机器串行使用，证据回收后均已删除。
补测无模型调用，其首个普通测试作业编译失败；主代理提交绑定后续成功的 `targeted2-relfix1c`，
通过现有 `commit_files.py` 核对准确清单，原失败记录保留，之后运行 G0。两次产品提交均仅含准确清单内文件。
短命 deploy key 已撤销，凭据元数据未变化，已有机器及既有作业保持。
本地原有 18 个修改文件在整合后校验 SHA-256 全部不变；索引仅另加本任务登记与阶段结论。

CI 事实：

- 最终运行：[42234498020](https://github.com/allin2/win7-coding-agent-staging/actions/runs/42234498020)，
  手动触发 `box/relfix1c`，HEAD 为最终提交 `a1494791…`。工作流仅 `contents: read`，无 App 权限或 secret 变更。
- 首提交的本轮运行 `42231369676` 一直 queued，在最终运行建立后取消，避免本轮重复排队；此前已有排队作业未操作。
- GitHub 尚未分配 runner；排队根因 UNKNOWN。只读查询显示 CI 账号已有一台暂停机器且上限为一台，
  该事实不能证明本次排队原因；未删除、启动或修改该机器，未修改 App 配置或扩容。
- CI 未取得 PASS，不能签发完整交付验证结论。公开 origin 未推送，无产品发布、PR 合并或正式门 A/B。

## 6. CI 后继收尾（2026-11-07 UTC）

最终提交 `a14947917c7bd75aa474eebfb19092b7e0892ce6` 的开发机 InstaBox CI 已 PASS。
§5 保留首次交付时的排队事实；本节记录同一 run 后续完成，不改判历史失败。
负责人要求保存 monster 快照、重开并推进 CI，资源操作见 ENGINEERING_06 §1.18。
执行代理先保存完整快照 ready，再删除准确旧机释放唯一名额。
平台随后执行既有 run `42234498020`；本轮未重新派发产品任务或修改源码。

- run `42234498020`：completed/success，2026-11-07T06:13:36Z 完成。
- job `127948516926`：runner_id=24，runner_name=`gh-job-127948516926`。
- 真实 checkout 和 sourceCommit 均为 `a1494791…`；输入指纹 `062e3ff5…`。
- Gateway 20 套、329 项 PASS；Shell 64 套、1448 项 PASS，12 项日常慢测跳过。
- 执行代理回收 GitHub 元数据与原始日志，并保存日志 SHA-256。

证据为开发机 Linux CI，不代表 Win7 实机 PASS。
Phase-Gate 更新为 `A9_49_DEVELOPER_VERIFIED`，Win7-Validation 保持 NOT_PERFORMED。
原本地检查和审核证据继续按 §5 的准确提交适用；本轮不重复执行。
本轮未新增模型调用、提交、推送、发布或正式门 A/B。
准确 CI 结果见本机 `outputs/instabox-ci-refresh-20261106/22-ci-reliability.json`；
日志为同目录 `23-ci-reliability.log`，汇总为 `FINAL_RESULT.json`。

## 7. 开发包与最短消费者链路（2026-11-07 UTC）

按增量验收规范，在 CI 成功后对当前 `main@ef6a692294fa4e0403b2d1e00ea188b2e79749f8` 做一次开发级装配。
本次使用既有 A9-48/A9-ALPHA5 原生输入锁和 Electron 22.3.27、D-013 helper、better-sqlite3 输入；未改写锁定输入，未创建正式候选。

| 检查 | 结果 |
|---|---|
| `npm run verify:quick` | PASS；7 个模块完成编译/静态验证，Node `20.17.0` |
| Gateway 定向消费者 | PASS；`tests/openai-compatible-http-errors.test.ts` 24/24 |
| Shell 定向消费者 | PASS；`tests/errors.test.ts` 5/5，Shell lint/build 通过 |
| 开发包装配 | PASS；`A9_48_DEVELOPER_PACKAGE_INTEGRITY_PASS` |

开发包回执为 `outputs/a9-49-dev-package-20261107/A9_48_BUILD_RESULT.json`，ZIP 为
`outputs/a9-49-dev-package-20261107/Win7CodingAgent-0.3.0-alpha.5-win7-x64.zip`，SHA-256
`dbc4f55d108af48ec44a092bf82450a2b08f95c4d3a6248d1541021e77121002`；manifest SHA-256 为
`186aa32f1755622b8ef6eedafd5f59deb28452f51a36b9b9709454195c03b80b`。
包内受影响的 `a9-agent-runtime.js` 与源码逐字节一致；Gateway 编译入口除去尾部 source-map 注释后与包内字节一致，复核记录见同目录 `31-package-entry-check.json`。
因工作区仍有与本任务无关的既有 dirty 文件，本包 `source_dirty=true`、`external_acceptance_eligible=false`，仅作开发诊断。

> 2026-11-09 注：经负责人批准，`outputs/a9-49-dev-package-20261107/` 本机原件已删除并整体加密归档至外置批次 `archive-20261109-outputs-b1`（相机盘）；上述回执与 ZIP 按该批次 README 取回（恢复密钥由负责人保管，见 EVIDENCE_ARCHIVE_RETRIEVAL.md）。本包 `source_dirty=true`、仅作开发诊断的定性不变。

本轮未执行实际 Electron/Node 16 产品入口、Win10、Win7、正式门 A/B、公开推送或发布；这些结论继续为 `NOT_PERFORMED`。
合并前的参数错误 `VERIFY_SELECTION_INVALID` 已保留为工具调用记录，随后按单模块入口完成了有效验证。

## 8. 真实运行时与 Win7 开发级验证（2026-11-07 UTC）

负责人对“完成 A9-49 可靠性修复的 Win7 开发级验证”回复“同意”。
本次范围为 APPROVED_FOR_IMPLEMENTATION，实际工作区 main `ef6a6922…`，沿用 §7 的开发包
`dbc4f55d…` / manifest `186aa32f…`。本次授权覆盖该包的真实 Electron 22.3.27 / Node 16.17.1
入口、受限运行时 IPC、HTTP 错误超限/中断/取消与收尾，以及同范围候选外驱动的局部修正。
本节按负责人后继明确授权取代 §3 对本次 Win7 开发运行的排除；不开放正式门 A/B 或发布。

- 复用原生字节和已有编译输出，不重建产品；先验证新驱动能在实际 Electron 运行时加载包内入口。
- Win7 沿用 r2 的准确目标、主机键、普通 agent 活动桌面和 `C:\A9-DEV\` 边界。
  仅本次允许从当前 main 执行；目标写入起最多 60 分钟、最多两个新 run，最后 10 分钟不开新场景。
  真实模型 0 次，每 run 回环 HTTP 请求上限 40 次；原始证据写在包外。
- 默认开发根上限 20,000,000,000 字节、最低剩余 50,000,000,000 字节；不增加容量、不接管其他 holder。
  既有进程、任务、profile、候选与证据保留；未知身份、完整性、审计或生命周期立即停止依赖阶段。
  本次不得结束既有实例、执行 close 删根、修改系统设置、读取个人凭据或新增依赖。
- 最短真实链路：隔离 profile 启动包内 main/preload/IPC，验证结构化拒绝和 HTTP 可见终态，正常退出后核对连接、进程与任务。
  新增检查专门发现 Node 20 开发测试未覆盖的 Electron/Node 16 实际收尾与 IPC 加载差异。
- 当前包是 `source_dirty=true` 的开发诊断包；结果只记开发机或 Win7 `DEV_CHANNEL`。
  Win10、正式候选、门 A/B、提交、推送与发布均不在本次执行范围。

本轮材料与原始结果位于本机 `outputs/a9-49-win7-dev-20261107/`，后继结果追加于本节。

### 8.1 holder 交接与本地准入

只读预检确认 Win7 主机 DCCS-CHAIZL-PC / 7601、agent 会话 1，开发根 15,262,515,048 字节，
剩余 865,709,858,816 字节。原 holder `a946lanrx` inactive；原 alpha.5 实例位于
`C:\A9-DEV\run\2061ce92\p\electron.exe`，PID 9232 及其三个子进程保留，无临时任务或解包未知。
负责人后继明确回复：“允许沿用 holder，保留旧实例并运行隔离验证（推荐）”。
本轮只沿用该 inactive holder，不使用 `--steal`；新 run 为 `bcd96c89-dfe3-450b-b99a-1c0ac0e5afdc`。
准确授权和保留进程集合见同目录 `CHANNEL_HANDOFF.json`，执行材料见 `ready/REQUEST.json`。

开发机已物理核对开发包 3275 个 manifest 文件。Mac Electron 22.3.27 / Node 16.17.1 / ABI 110
加载包内 JS，使用准确哈希的 Mac 同 ABI SQLite 输入，17 组 HTTP 和 17 项真实产品 IPC 检查通过，
回环请求 25 次、外部模型 0 次。三种受限状态、正常入口、SQLite 完整性和正常退出均直接通过。
本地沙箱全部删除，结果为开发机 PASS，不能替代 Win7 结果。准确结果见 `LOCAL_RESULT-r2.json`。
首轮候选外驱动未识别真实 Provider probe，导致 `UNEXPECTED_UI_REQUEST`；原日志和输入保留。
主代理仅修正夹具路由及活动状态判据，r2 全部通过；产品与开发包未改动。

### 8.2 Win7 开发级运行结果与收尾

本轮 Win7 `DEV_CHANNEL` 结果为 PASS，正式 Win7 验收仍为 NOT_PERFORMED。
执行代理沿用 §7 的 main `ef6a6922…`、开发 ZIP `dbc4f55d…` 和 manifest `186aa32f…`。
本次未重建或修改产品。该包仍为 `source_dirty=true`、`external_acceptance_eligible=false`。

目标为 DCCS-CHAIZL-PC / Windows 7 SP1 x64 build 7601。
普通 agent 的 SID 为 `S-1-5-21-1708701742-428676696-1831205153-1001`，活动 Session 为 1。
run `bcd96c89-dfe3-450b-b99a-1c0ac0e5afdc` 的目标写入窗口始于 UTC `2026-11-07T09:32:38.321Z`。
最终后检完成于 `09:47:48.094Z`，在 60 分钟预算内提前收尾，仅使用一个 run。
本轮没有发起第二个 run。

| 直接检查 | Win7 DEV_CHANNEL 结果 |
|---|---|
| 包身份、复制与实际加载 | ZIP / manifest 哈希一致；3275 项清单文件复制校验通过；212 个实际加载模块和 Gateway 入口哈希与清单一致 |
| 实际运行时 | Electron 22.3.27 / Node 16.17.1 / ABI 110；正常入口及三种受限状态均正常退出，退出码 0 |
| HTTP 错误接收 | 17 组 PASS；覆盖状态分类、重试、64 KiB 字节边界、分块 UTF-8、超限、中断凭据脱敏、取消及恢复 SSE |
| 真实 main/preload/IPC | 17 项 PASS；正常入口的超限与取消终态，以及 SQLite 不可用、diagnostics、schema_refused 下的五种调用均符合原分类 |
| 持久化与隔离 | SQLite integrity=`ok`、活动 task/turn/run 总数 0；Renderer 的 require/process 均不可用；四阶段无 preload 或渲染进程错误 |
| 请求与收尾 | 回环 HTTP 25 次、外部模型 0 次；连接 0、临时沙箱已删除；本轮任务已删除，无本轮映像进程残留 |
| 证据回收 | 9 个产品结果/日志及 4 个执行回执均已复算大小与 SHA-256；5 份执行材料哈希一致 |

最终 status 的进程集合与运行前一致：原 alpha.5 的 PID 9232、9756、10132、7632 全部保留。
临时任务为空，原 holder `a946lanrx` inactive，解包生命周期未知为 false。
开发根为 16,155,407,376 字节，低于 20,000,000,000 字节上限。
C: 剩余 864,567,074,816 字节，高于最低剩余空间。
本轮未调用 stop、close 或 `--steal`，未修改系统设置。

目标执行与后检原件为 `outputs/a9-49-win7-dev-20261107/TARGET_RUN.json`。
产品原件为 `outputs/win7-dev/a9-49-bcd96c89/RESULT.json`，身份回执在
`outputs/win7-dev/runs/bcd96c89-reliability/identity.json`。
中断恢复后的本地证据复核见同目录 `RESULT_REVIEW.json`；恢复后未重跑目标用例。
原 Mac 首轮驱动失败及既有历史失败继续保留。
其他 14 个既有 dirty 文件与运行前记录的哈希一致。
收尾期间 `ENGINEERING_06` 新增另一项角色机登录授权记录；执行代理保留该并发文档变更，未修改或回退。

本轮开发级验证已完成。Phase-Gate 保持 `A9_49_DEVELOPER_VERIFIED`，Win7-Validation 记为 `DEV_CHANNEL`。
开发机 CI、定向回归和 Mac 真实运行时结果沿用 §5～§8.1 的准确输入，恢复后未重复执行。
同包 Win10、外部模型、正式候选、门 A/B、提交、公开推送和发布均为 NOT_PERFORMED。
