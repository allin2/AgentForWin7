# A9-49 — 受限运行时与 HTTP 错误接收加固

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: RELIABILITY_HARDENING
Target Branch: main
Source Baseline: 6b4a86cccf050b21d3f0c6401aaadc4cc0bad2c8
Phase-Gate: A9_49_DEVELOPER_VERIFIED_CI_BLOCKED
Win7-Validation: NOT_PERFORMED
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
