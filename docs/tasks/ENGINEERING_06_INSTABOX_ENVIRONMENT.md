# ENGINEERING_06 — InstaBox 开发环境接入

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: ENGINEERING_TOOLING
Target Branch: main
Source Baseline: bd69a4b
Phase-Gate: ENGINEERING_06_WORKFLOW_DEVELOPER_VERIFIED
Win10-Validation: NOT_PERFORMED
Win7-Validation: NOT_PERFORMED
```

## 1. 已确认范围

负责人本轮明确要求“现在我们配置环境”，并提供 czl、CI、chai2、chai521 四组接入凭据。
执行代理按 AGENTS.md C14 登记本轮账号接入范围。
未来工作流设计见本机 `outputs/future-workflow/FUTURE_WORKFLOW_DESIGN_r4.md`；r3 保留为前一版。

本轮交付为 Mac 上可复用的账号检查入口、钥匙串凭据引用和脱敏检查报告。
执行代理读取各凭据的身份、工作区、配额与机器清单，核对是否存在同一工作区的重复凭据。
密钥只交给 InstaBox HTTPS 接口和 Mac 钥匙串，不进入源码、普通配置、报告或记忆。
聊天中出现过的密钥在长期使用前需要轮换。

允许本地编写接入工具、保存不含密钥的本机账号配置、调用 InstaBox 只读接口、将本轮凭据写入独立的 Mac 钥匙串项目。
不修改既有钥匙串项目；发现同名项目时先核对引用，不直接覆盖。
后继授权：负责人明确指示“这些机器现在都可以删除，你来进行配置，先跑通我们的 workflow”。
执行代理删除已盘点的两台暂停机器，并在四个工作区按需创建、配置和回收本轮试点 Box。
准确旧机清单：czl 的 `m_agqxw7lisgmmodix5nzfuo4t4e` / `aitest`；chai521 的 `m_agqxl2dl4yjmnhcosoxdwgssju` / `agent-browser-8vbm`。
删除前逐台重读身份和状态；不扩大到后续出现的未知机器。
本轮编写统一 Linux 准备入口，固定模板与 Node，核对依赖指纹，记录磁盘与测试结果。
试点包括执行代理和不同 agent 的独立审核，允许工作包在私有 staging 仓库的新分支提交和推送。
允许将现有基线提交同步至私有 staging；不向公开 origin 推送。
凭据按原边界隔离；模型凭据只按既有授权的可用方式注入，不复制无关个人配置或凭据。
本轮不注册账号、不订阅付费计划、不修改既有派单或 MODES.md，不修改产品权限或冻结候选。
本轮不连接 Win10 或 Win7；Windows 构建和实机链路不计入本轮 Linux 工作包试点。
本地 main 不提交；试点交付保留准确分支、提交与报告，集成前核对差异。

负责人后继指示：“先不着急，先模拟流程跑通，配置环境，登录agent账号”。
执行代理先完成当前 Box 的环境配置、官方账号登录与无产品改动的模拟流程。
本轮不进入 Linux 问题修复，不派真实产品工作包。
负责人在供应商官方页面完成登录授权；执行代理不复制 Mac 的个人登录材料。

2026-10-31 后继范围：负责人要求不同环境各登录一个 agy 账号，先处理 czl。
负责人明确 agy 指 Google Antigravity。
执行代理在 czl 新建一台独立 Box，安装官方 Antigravity CLI 并完成账号登录。
新机不设置自动删除期限；保留平台的空闲暂停和最长运行规则，避免自动销毁登录环境。
本阶段先登录 czl，不将账号凭据复制到其他环境，不运行模型工作包。
CLI 来源为官方安装页与其发布清单；本轮锁定 `1.4.12` 和清单 SHA-512。
来源、准确摘要和资源回执保留在 `outputs/instabox-agy-czl-r1/`。

### 1.1 T3 后端安装范围（2026-10-31）

负责人明确要求“帮我在所有的box上安装t3后端”。
执行代理在 main 为四个已配置账号盘点现有 Box，并在身份匹配的现有 Box 安装官方 Linux x64 后端。
本轮盘点为 czl 的 `eng06-czl-agy` 与 ci 的 `eng06-ci-worker`；chai2、chai521 当前无 Box。
本轮不为无机器账号新建 Box，不改既有机器删除期限，不覆盖其他会话的登录、源码或运行进程。
安装使用用户目录和独立版本目录；必要启动验证仅监听回环地址，不开放公网无认证端口。
验证包括工件 SHA-256、CLI 版本、后端健康状态、认证边界及可供 SSH 接入的启动入口。

开发机工具 Profile：T3 CLI `0.1.6-nightly.20261031.3956`，与当前 Mac T3 一致。
官方来源为 `pingdotgg/t3code` 的同名 GitHub Release；源码提交 `d92c437baa19409f99416a44f748f148f4317c65`。
Linux x64 工件为 `t3-0.1.6-nightly.20261031.3956-linux-x64.tar.gz`，SHA-256 为
`454c7856a083fa707732ea70fcec6e98e0636750a6728f2529bf6cf3821d6a62`，许可证 MIT，随包许可证和依赖闭包沿用官方发行包。
工具仅在 Linux 开发机运行，不进入产品候选或 Win7/Win10 运行时；不改产品 Node 20.17.0。
版本目录允许旁路回滚；身份、哈希、认证或启动失败时停止该台的后续接入，其余机器继续。
本轮不提交、推送或发布产品，不发起真实模型请求；原 Linux FAIL 保留。
安装证据保留于 `outputs/instabox-t3-backend-r1/`。

### 1.2 czl 单机母机与私有镜像（2026-10-31 后继指示）

负责人明确要求：“先用czl一台创建基础镜像：登录codex，agy，claude，t3后端”。
执行代理先在现有 czl `eng06-czl-agy` 完成三个 CLI 的官方登录和 T3 后端配置。
本次交付为 czl 账号内的私有恢复镜像，包含这台母机的登录状态。
该范围取代此前本轮“不将登录状态存入镜像”的默认处理。
它不授权向其他账号分享镜像，也不授权复制 Mac 或 ci 的登录材料。
从该私有镜像恢复的实例会继承相同账号身份；跨账号统一环境仍使用安装脚本与版本锁。
执行代理先删除一次性输入和原始登录日志，再保存镜像。
镜像不包含 InstaBox API Key、个人 GitHub token、Win7 私钥或临时部署私钥。
本轮不运行模型工作包，不提交本地 main，不推送公开 origin。
操作与脱敏验证证据保留于 `outputs/instabox-czl-base-r1/`。

母机只包含开发机工具，不包含项目源码与九处项目依赖。
模板 Node 为 `22.23.3`；项目开发 Node `20.17.0` 准备入口仍按 §3 的 ci 证据另行使用。
执行代理在母机配置 systemd 用户服务、回环监听、工具 PATH 和钥匙串启动解锁。
该配置只用于本次明确要求保留登录状态的私有恢复镜像；不改变产品安全语义。

| 开发机组件 | 锁定版本、来源与完整性 | 边界与回滚 |
|---|---|---|
| Antigravity CLI | `1.4.12`；官方安装页与 manifest；工件 SHA-512 和二进制 SHA-256 见 `outputs/instabox-agy-czl-r1/`，二进制 SHA-256 `1edfb304…`；沿用供应商服务条款与发行包 | 位于用户目录；不进入产品候选。移除本轮二进制可回滚 |
| GNOME Keyring | Debian 13 软件源的 `gnome-keyring 48.0-1`；APT 使用默认签名校验；许可证标识和包日志保留于本轮证据；包含 GPL/LGPL、BSD、MPL 及包内对应声明 | 本机随机生成的解锁材料仅保存在母机 0600 文件；官方守护进程从标准输入读取。删除本轮用户服务 drop-in 可回滚 |
| T3 relay | `cloudflared 2026.10.4`；来源为 T3 固定源码 `d92c437b…` 的内置官方工件表；GitHub `cloudflare/cloudflared` 同版本 linux-amd64 工件，SHA-256 `ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42`，与安装结果一致；沿用 Apache-2.0 发行许可 | 由官方 T3 安装器管理；本机已完成 T3 Connect 授权并启用远端接入。使用官方 `connect unlink` 停止接入；删除托管版本可回滚 relay 安装 |

### 1.3 czl 项目环境与单机工作流试跑（2026-10-31 后继指示）

负责人要求“现在尝试在czl这台机器上测试我们的工作流，现在的box作为本项目开发的快照的话还缺什么”。
执行代理先核对母机现状，再补齐独立项目目录、固定 Node 与九处依赖。
本次使用已批准的私有 staging 交换流程，在新分支试跑环境准备、日常检查、报告提交及 Mac 回收。
产品源码基线为 `bd69a4b6…`；环境入口沿用已回收的模拟提交 `b5572f9d…`。
只在试跑分支提交环境报告，不修改产品逻辑，不修复既有 Linux 红灯。
临时 deploy key 只授权 staging；回收后撤销并删除母机上的临时私钥。
母机、现有登录状态与其他会话进程继续保留，不重启或恢复另一台相同身份的实例。
本轮不改写旧快照，不提交本地 main，不推送公开 origin，不连接 Win10 或 Win7。
证据目录为 `outputs/instabox-czl-workflow-r1/`；模型实际工作包及独立审核按本次实际覆盖分别记录。

### 1.4 czl 登录快照克隆验证（2026-10-31 后继指示）

负责人批准从 czl 私有快照建 2 台机器，验证"一次登录、按需建机"是否可行。
负责人指定由 Codex（GPT-6.1、high、非 fast）作为子进程执行并交付结果。
范围：从 `sn_agqzcjtcjpqyjt5xxcfn3cdwam` 依次建 2 台，各设 `deleteAfterSeconds` 兜底。
每台建好后立即停用 T3 服务，避免同一 T3 身份并行运行。
两台同时各发 1 次 Codex、1 次 Claude Code 最短请求，共 4 次模型请求。
请求前后只记录凭据文件的 SHA-256、大小、权限和修改时间，不读取或输出内容。
完成后删除这 2 台，核对账号内只剩母机。
母机 `m_agqzbybbovx2docbd6ckgqd63q` 保持暂停，不唤醒、不执行命令。
禁止在克隆机上执行任何登出、`connect unlink` 或撤销操作，它们会影响共享身份。
不创建或删除快照，不连接其他账号，不修改仓库已跟踪文件，不提交或推送。
证据目录为 `outputs/instabox-snapshot-clone-r1/`。

第一次执行于 UTC `13:14:48Z` 在前置检查停止：母机为 running，不满足暂停条件。
未建机，模型请求为 0，无残留；结论 `snapshotLoginReusable=UNKNOWN`。
母机于 `12:52:55Z` 恢复，起因是执行代理在其上执行的一次只读 `claude --help`。
UTC `13:28Z` 前后起，母机有一个 SSH 终端会话（`instabox-term attach --name main`），归属 UNKNOWN，母机因此持续活跃。
执行代理未暂停母机，等待负责人决定；重跑时证据另存 `outputs/instabox-snapshot-clone-r2/`。
负责人选择乙：执行代理通过接口暂停母机一次，然后重派 Codex 子进程。验证结束后母机保持暂停。
执行代理于 `13:49:57Z` 暂停母机，回执见 r1 目录的 `mother-suspend-r1.json`。

第二次执行（`13:52:02Z`～`13:54:28Z`，证据 `outputs/instabox-snapshot-clone-r2/`）结论仍为 UNKNOWN，证据层级为开发机。
| 项目 | 直接结果 |
|---|---|
| 从快照建 2 台 | PASS；两台均 succeeded，随后均已删除 |
| 克隆开机时的 T3 | 两台首次检查均为 active，即开机即以共享身份上线；停用后 inactive，cloudflared 不存在 |
| 克隆上的登录状态 | 两台 Claude Code 2.1.288 loggedIn=true、pro；Codex 0.160.0 显示 ChatGPT 登录；凭据文件与快照逐字节相同。状态命令不证明模型请求有效 |
| Codex 两次请求 | UNKNOWN；两台均已后台启动，轮询时 Mac 到 InstaBox 发生传输错误。子进程未先对账就删机，结果不可恢复。保守计为已发送 2 次 |
| Claude Code 两次请求 | NOT_PERFORMED |
| 令牌刷新与并发安全 | UNKNOWN |
| 清理 | PASS；只剩母机，母机六次检查均为 suspended；Mac 无新增临时残留 |

子进程自报一项偏差：读取失败后没有先对账结果目录就删机，违反任务说明。
若克隆上的 Codex 请求触发了令牌刷新并轮换，母机的 Codex 登录可能受影响；母机下次使用前需核对，现为 UNKNOWN。
Claude Code 请求同样可能刷新令牌，对母机的 Claude 登录有同类风险。

第三次执行（负责人于 2026-10-31 选择甲，证据 `outputs/instabox-snapshot-clone-r3/`）沿用第二次的范围与禁止项，预算重新计：最多 2 台新机、4 次模型请求。
加上第二次已发送的 2 次，当日模型请求累计最多 6 次。母机继续保持暂停，不唤醒、不执行命令，不检查母机登录状态。
第三次相对第二次只改三处：
1. 读结果的命令只读，不删除结果目录。结果存到 Mac 并校验后，才另发清理命令。
2. 读结果的命令遇到传输错误时，最多重试 6 次，间隔 5～30 秒。建机、删机和模型请求遇到传输错误仍先对账、不重发。
3. 任一请求的结果读不到时不删机：等 10 分钟再读；仍读不到则停止，保留两台，报告机器 ID，由执行代理与负责人决定。`deleteAfterSeconds=7200` 作为兜底。

第三次执行（`14:43:15Z`～`14:46:14Z`，证据 `outputs/instabox-snapshot-clone-r3/`）结论为 `snapshotLoginReusable=PASS`，证据层级为开发机，绑定快照 `sn_agqzcjtc…` 与基线 `bd69a4b6…`。
Codex 子进程执行；父代理独立复核了结果文件、账号机器列表与 Mac 临时目录。派单后该子进程被中断两次，其间没有建机或模型请求，第三个运行从零开始执行。
| 项目 | 直接结果 |
|---|---|
| 从快照建 2 台 | PASS；均 succeeded，随后均已删除 |
| 克隆开机时的 T3 | 两台首次检查均为 active（共享身份在线）；停用后 inactive，cloudflared 不存在 |
| Codex 两次请求 | PASS；A、B 同时启动（起始相差小于 1 毫秒）、重叠约 5.3 秒，退出码均为 0，回复均为 `OK` |
| Claude Code 两次请求 | PASS；A、B 同时启动、重叠约 5.2 秒，退出码均为 0，`is_error=false`，回复均为 `OK` |
| 读结果重试 | 0 次；结果落盘并校验后才删结果目录 |
| 凭据文件前后差异 | 4 个检查点均无 SHA-256、字节数、权限、mtime 变化 |
| 母机 | 9 次检查均为 suspended；全程未唤醒、未执行命令 |
| 清理 | PASS；账号内只剩暂停的母机，Mac 无新增临时残留，仓库已跟踪文件无新增改动 |
| 模型请求累计 | 本次 4 次；加第二次已发送的 2 次，当日累计 6 次，达到上限 |

结论的适用范围：快照保存约 6 小时后，两台克隆同时使用同一份 Codex 与 Claude Code 登录，各完成 1 次最短请求。
凭据文件没有被改写，两个工具在本次都没有触发令牌刷新。
因此“刷新轮换时多副本并发是否安全”仍为 UNKNOWN，母机登录是否受影响也仍为 UNKNOWN（本次未触发刷新，风险未被验证也未被排除）。
长期复用、快照老化后的行为、agy 登录、T3 身份并存和更大并发均为 NOT_PERFORMED。
Codex 在克隆上报告找不到系统 `bubblewrap`，改用其自带版本，不影响请求结果。

### 1.5 workflow r4 的 P0 本地实现范围（2026-10-31 后继指示）

负责人批准 r4 的 D8 甲与 D9 甲，并指示“直接登记甲”，即登记并开始 P0 本地实现。设计依据为 `outputs/future-workflow/FUTURE_WORKFLOW_DESIGN_r4.md`（实现前版本 SHA-256 `79cf64ec…`；实现后追加 §18）。
实际分支为 main 工作树，所有改动保持未提交；本地 main 不提交，不推送公开 origin。
交付结果：
1. `scripts/instabox/cloud.py` 扩展：从快照建机、wake、活动租约、disk、processes、读结果的有限重试。现有子命令的行为不变。
2. `scripts/instabox/box-job.sh`：后台作业的 start、status、collect，按 r4 §4.1。
3. `scripts/instabox/wp.py`：工作包的 open、run、poll、close、receive，按 r4 §4.2 与 §6.2。
4. `scripts/verify_integration.mjs`：D9。在大小写敏感文件系统上，日常集合省略 workspace 的 `normalizes Windows separators and rejects case-folded duplicates and sensitive paths`，打印 NOT_PERFORMED；`npm test` 与 `--test-file` 运行仍保留该用例。
5. 上述各项的离线测试。

行为边界：
- 本范围只做本地实现与离线验证。不建机、不删机、不唤醒母机、不创建或删除快照、不发模型请求、不调用 GitHub 写接口、不创建或撤销部署密钥。
- `wp.py` 与 `cloud.py` 的远端调用在测试中全部用桩替代。
- 不连接 Win10 或 Win7，不修改 `MODES.md`、ADR 与产品源码；已跟踪文件只改 `scripts/verify_integration.mjs`。
- 实现与 r4 不一致时，先改 r4 并记录差异，再改代码。
- 测试临时目录建在系统临时目录、名称带 `win7-eng06-` 前缀，在清理钩子中删除，跑完核对无残留。

必要验证：
- Python 工具：`py_compile` 与离线单元测试，覆盖重试规则（读命令可重试，建机、删机、启动员工不重发）、结果未读回不删机、删机前核对名字。
- `box-job.sh`：在本机临时目录中跑 start、status、collect，覆盖正常结束、被杀、超时，核对 `result.json` 原子写入与 TMPDIR 清理。
- D9：Mac 上 `node scripts/verify_integration.mjs --daily --module workspace` 通过且不打印省略行；在大小写敏感的临时磁盘映像上运行同一命令，打印省略行且通过；删除映像。
- `npm run docs:check`。

停止条件：
- 任一步需要远端写操作或模型请求时停止，另行登记范围。
- 需要修改 `verify_integration.mjs` 以外的已跟踪文件时停止。
- 需要偏离 r4 的 D7、D8、D9 裁决时停止，等待负责人决定。

实现结果（2026-10-31，证据层级开发机，基线 `bd69a4b6…`，改动未提交）：
| 交付项 | 结果 |
|---|---|
| `cloud.py` 扩展 | PASS；`test_cloud.py` 15 项（原 7 项加 8 项） |
| `box-job.sh`、`box_job.py` | PASS；`test_box_job.py` 9 项，含超时杀进程组、监督进程被杀、分块回收、临时目录清理 |
| `wp.py` | PASS；`test_wp.py` 23 项，API 与 GitHub 为桩，`box_job.py` 与 git 真实运行 |
| D9 `verify_integration.mjs` | PASS；Mac 默认通过且无省略行；大小写敏感磁盘映像上通过并打印省略行；不带 `--daily` 时该用例仍执行。首次在终端默认的 Node 22.23.1 下运行，随后用 `.nvmrc` 固定的 20.17.0 复验，结果相同 |
| 临时目录与进程 | 三组测试各自在清理钩子中删除夹具；跑完 `win7-eng06-*` 为 0，无残留 `box_job.py` 进程；磁盘映像已卸载并删除 |
| 已跟踪文件改动 | 仅 `scripts/verify_integration.mjs`（其余已跟踪文件的改动来自本任务文档或其他会话） |
测试中发现并修复一处缺陷：作业刚启动时 `status` 可能误报 `DEAD_WITHOUT_RESULT`，现于 `start` 返回前写入监督进程号，并有回归用例。
与 r4 正文的差异和 NOT_PERFORMED 项记于 r4 §18。Linux 上运行 `box_job.py`、真实 InstaBox 与 GitHub 调用、`codex exec` 与 `claude -p` 写入类组合均为 NOT_PERFORMED。

不在本范围：P0 的远端验证（czl 上干净工作目录 G0、人为中断一次 exec 后取回结果）、密钥轮换、核对母机登录、Win10 `192.168.1.13` 只读核对。它们各需单独授权，其中前两项会建机。

### 1.6 workflow r4 的远端验证：先 P0、后 P1（2026-10-31 后继指示）

负责人在“现在工作流通吗”之后选择“先甲后乙”：先做 P0 远端验证，通过后再做一个极小的真实工作包。
本节取代 §1.5 末段“不在本范围”中的远端验证一项；密钥轮换、核对母机登录、Win10 `192.168.1.13` 只读核对仍不在范围内。
实际分支为 main 工作树，所有本地改动保持未提交；远端分支只推送到私有 staging。

阶段甲（P0 远端验证，模型请求为 0）：
- 在 czl 用 `sn_agqzcjtc…` 建机，任务号 `p0a`，名称 `wp-p0a`，`deleteAfterSeconds=14400`。最多建 2 台：第 2 台只用于第一台失败后的重试。
- 基线为 staging 分支 `eng06/environment-simulation-r1` 的提交 `b5572f9d…`。
- 经 `wp.py open` 完成建机、停 T3、读密钥取码与撤销、准备、指纹。
- 在该机上核对：作业内 `node --version` 为 `v20.17.0`；一份校验值被改错的 `prepare-linux.sh` 副本拒绝安装；人为让一次 exec 的回执中断后，能从作业文件取回结果。
- 用不调用模型的作业代替员工：应用 D9 补丁并提交，随后 `wp.py close` 运行 `--module workspace` 的 G0，在 Linux 上直接验证 D9。
- 经 `wp.py close` 用一次性写入密钥推送分支 `box/p0a`，撤销密钥，核对后删机；再经 `wp.py receive` 在 Mac 上做 G1。

阶段乙（P1，仅在阶段甲的必需项全部 PASS 后进行）：
- 先实现审核包模式 `wp.py run --mode review`（Codex `--sandbox read-only`，Claude Code `--permission-mode plan`；审核机不发写入密钥、不推送）并补离线测试。
- 执行包：Codex 在 `scripts/instabox/P1_PROBE.md` 写入一行说明并提交，任务号 `p1a`；审核包：Claude Code 审核该提交，任务号 `p1b`，基线为 `box/p1a` 的提交。
- 员工 CLI 调用最多 2 次（执行 1、审核 1），每次时限 15 分钟。每次调用内部的模型请求数由事件输出记录，不预先设定。
- 阶段乙最多再建 2 台，两个阶段合计不超过 4 台；两台串行存在，不并行。
- 不创建或删除快照。凭据文件变化时停在 `CREDENTIALS_HOLD`，不自行存新快照。

两个阶段共同的行为边界：
- 母机 `m_agqzbybbovx2docbd6ckgqd63q` 保持暂停，不唤醒、不执行命令，不检查其登录。
- 只用 czl 账号；GitHub 只操作 `allin2/win7-coding-agent-staging`：创建与撤销部署密钥、推送 `box/p0a`、`box/p1a`。不推送公开 origin，不提交本地 main。
- 不读取、输出或记录任何凭据内容；凭据文件只记录 SHA-256、字节数、权限与 mtime。
- 不连接 Win10 或 Win7，不修改 ADR、`MODES.md` 与产品源码；D9 补丁只出现在 staging 分支 `box/p0a` 上。
- 临时目录规则同 §1.5；机器用完即删，每个阶段结束后核对账号内只剩母机、GitHub 无遗留部署密钥。

停止条件：
- 母机不是 suspended、身份不符、疑似凭据泄露、需要超出上述范围的远端写操作。
- 阶段甲有必需项 FAIL 且根因 UNKNOWN：不进入阶段乙，报告负责人。
- 员工启动返回认证错误（`BLOCKED_LOGIN`）：停止，不重试。
- 删机或撤销密钥失败：先报告，不自行换方式删除。

必要验证：每个阶段的回执在 `outputs/wp/<任务号>/`；甲的驱动与逐步证据在 `outputs/wp-p0-r1/`，乙在 `outputs/wp-p1-r1/`。阶段结束后执行 `npm run docs:check`。

阶段甲结果（2026-10-31，执行代理，证据层级开发机）：必需项全部 PASS。
远端基线为 `b5572f9d…`，交付提交为 `f693c415…`，位于私有 staging 的 `box/p0a`。
执行代理只建 1 台工作机，模型请求为 0。未集成本地 main。

| 必需项 | 直接结果与原始证据 |
|---|---|
| open 与环境准备 | PASS；同机恢复后 OPENED，准备 29.165 秒。Node `20.17.0`，九处依赖及 SQLite 完成；`resume-result.json`、`outputs/wp/p0a/collected/prep-p0a/` |
| 作业内 Node | PASS；版本 `v20.17.0`，路径为 `/data/home/.local/opt/node-v20.17.0-linux-x64/bin/node`；`checks.json` |
| 错误 SHA 反例 | PASS；副本使用全零校验值，安装退出 1，未安装 Node，下载临时目录残留 0。未保留内部校验错误文本；`checks.json`、`collected/negsha-p0a/` |
| exec 回执中断恢复 | PASS；人为丢弃一次已执行启动的响应，按作业文件恢复且未重发，输出 `slow-done`、退出 0；`checks.json`、`collected/slow-p0a/` |
| Linux G0 与 D9 | PASS；workspace 编译和日常集合退出 0，耗时 7.092 秒。慢测试及大小写用例明确为 NOT_PERFORMED；`collected/g0-p0a/` |
| 私有推送、密钥撤销、删机 | PASS；`box/p0a` 绑定 `f693c415…`，工作机已删除；`close-result.json` |
| Mac G1 | PASS；引用、父链、路径、秘密扫描、指纹、文档及 workspace 检查全部满足；`receive-result.json` |
| 收尾 | PASS；只剩准确母机且 suspended，staging 部署密钥为空，Mac 本轮临时目录为空；`verify-final.json` |

执行代理保留本轮传输失败，不把失败日志改成 PASS。
open 曾停在 `JOB_START_UNKNOWN`，工作机保留。执行代理确认作业 MISSING、旧读密钥撤销后，在原机恢复。
Mac 首次 G1 因引用读取失败停止，后续只读核对成功，再次 G1 PASS。
收尾清单读取也曾失败，最终直接只读核对并保存完整回执。
诊断捕获 TLS EOF 与 timeout，具体网络根因仍为 UNKNOWN。
这些传输失败未造成必需验证项 FAIL；甲的最终逐项结果和收尾均有直接证据。

本轮工具回归为 `test_cloud.py` 17 项、`test_wp.py` 26 项 PASS。
G1 现运行路径影响模块与任务指定模块的并集，避免仅改验证脚本时漏跑 workspace。
此前 §1.5、§3.4 的 NOT_PERFORMED 与 FAIL 保留为历史，本轮结果仅覆盖上述准确运行。
执行代理按已批准顺序进入阶段乙。审核模式先补离线测试，再运行两次已授权员工 CLI。

阶段乙本地准备（2026-10-31，执行代理，开发机，基线 `bd69a4b6…`，改动未提交）：
- `test_wp.py` 33 项 PASS，包含 7 项审核模式检查；新增 Git 元数据目录检查后，审核组 8 项 PASS。
- 审核包不运行 G0、不生成写入密钥、不推送；凭据变化保留机器。执行与审核均显式限时 900 秒。
- Codex 执行模式只增加本工作包 `staging.git` 写入目录，支持 linked worktree 本地提交；审核模式不增加写入目录。设计先记录于 r4 §20。
- `py_compile` PASS；上述测试结束后，Mac `win7-eng06-*` 临时目录为 0。
- p1a 已 OPENED，基线 `b5572f9d…`，指纹 `af2b312e…`。快照旧版 CLI 帮助已核对，不发模型请求。

阶段乙结果（2026-10-31，执行代理，开发机）：p1a 执行任务 FAIL，整体工作流未跑通。
基线仍为 `b5572f9d…`，没有新提交。原始证据在 `outputs/wp-p1-r1/` 与 `outputs/wp/p1a/`。

| 项目 | 直接结果 |
|---|---|
| 机器与模型预算 | 乙建 1 台；Codex CLI 调用 1 次，33.382 秒；Claude Code 调用 0 次。甲乙合计建 2 台 |
| CLI 与运行时 | Codex `0.160.0`，Node `20.17.0`。CLI 退出 0，未超时；该结果不代表任务完成 |
| 探针文件 | 指定文件 106 字节，UTF-8 无 BOM、单行 LF。精确字节检查与 `git diff --check` PASS |
| 本地提交 | FAIL；`git add` 无法创建 `staging.git/worktrees/work/index.lock`，错误为 Read-only file system。HEAD 保持基线，文件未跟踪 |
| 生效参数 | 实际作业已使用 `workspace-write`，并给 `--add-dir` 传入准确的包内 `staging.git`；这未解决本次拒绝 |
| 最小诊断 | 同一目录在员工沙箱外为属主可写。失败定位在 Codex 沙箱内，具体策略原因 UNKNOWN。无新增模型请求；两次 sandbox 帮助/策略探针分别退出 101、2，未取得有效挂载证据 |
| 用量 | 事件只有 1 个 `turn.started` 与 1 个 `turn.completed`；供应商内部模型请求数 UNKNOWN。输入 121870 token，其中缓存 91648；输出 930 token。完整 usage 保留于 `p1a-employee-result.json` |
| 凭据与回收 | 凭据 SHA-256、字节数、权限与 mtime 均无变化。stdout/stderr、最终报告及探针已落到 Mac 并逐项核对 SHA-256 |
| 下游 | G0、推送、Mac G1 与 p1b 审核均为 NOT_PERFORMED；执行代理不代员工提交，也不重发执行调用 |

首次结果回收在 Client 的 `GET me` 遇到传输错误。执行代理保留失败日志，重读原作业成功；未重复启动员工。
执行调用额度已用完；剩余审核调用不能改作第二次执行。
执行代理已在完整证据回收后删除 p1a 工作机。UTC `16:39:32Z` 最终只读核对 PASS：账号只剩准确的 suspended 母机，staging 部署密钥为空，Mac 本轮临时目录为空，见 `p1a-verify.json`。
四个作业均完整回收，且各自 `tmpdirRemoved=true`；删机前 Box 的 `win7-job-*` 残留为 0。
本次只使用一把读密钥，存在约 46 秒；未生成写入密钥。
Mac `docs:check` 核对 396 份文档、66 份任务书 PASS；`git diff --check` PASS。
本轮未提交本地 main，未向公开 origin 推送，未连接 Win10 或 Win7。
后续重试须先解决 Git 元数据写入限制，并取得新的执行调用预算；本次失败记录保留。

### 1.7 后继目标与本地修复准备（2026-10-31）

负责人通过 `/goal` 要求：“首先跑通工作流，然后按照工作流为项目增加暗色主题的开发；需要裁决的按照grilling推荐”。
执行代理先处理 §1.6 的提交阻断，再进入暗色主题开发。
该目标不改写旧试验预算、失败结果和安全边界。
本地准备沿用 main 工作树，所有改动保持未提交。

执行代理已准备尚未启用的包装器提交候选。
材料为 `outputs/wp-p1-r2-preparation/PROPOSAL.md`；状态为 DRAFT_READY_FOR_REVIEW。
它建议员工保留 `workspace-write`，退出后由包装器核对准确字节并提交。
提交职责变化和后继模型执行预算尚未裁决。
执行代理未接入 `wp.py`，未启动新工作机或模型调用。

后继原因分析：Codex 官方文档声明 `.git` 及其指针目标受只读保护。
固定 `rust-v0.160.0` 的 permissions.rs 包含对应默认只读规则和指针解析。
该分析与 p1a 错误一致，但未取得旧运行的实际挂载表。
旧 `FINAL_RESULT.json` 的 policyRootCause=UNKNOWN 保留。
官方链接、准确源码范围和摘要见本地准备材料。

| 项目 | 执行代理的开发机结果 |
|---|---|
| 绑定 | 产品基线 `bd69a4b6…`；候选脚本未提交，尚未远端执行 |
| 真实 Git 检查 | 第三次 10 项 PASS；bare clone 与 linked worktree 实际运行 |
| 既有工具与文档 | `test_wp.py` 完整 34 项 PASS；文档检查核对 396 份文档、66 份任务书 PASS；差异格式检查 PASS |
| 覆盖 | 精确文件与模式、额外路径拒绝、基线与分支绑定、重复提交拒绝、符号链接拒绝、暂存 blob 字节核对 |
| 旧失败 | 首次夹具使用本机不支持的 `--orphan`；第二次过滤器夹具范围错误。两次原日志保留 |
| 临时目录 | 三次测试均无新增 `win7-eng06-*` 残留；清理使用 addCleanup |
| 远端完整链路 | NOT_PERFORMED；后继预算建议为串行两台、执行与审核各一次、各限时 900 秒 |
| 暗色主题 | 尚未进入 Demo、实现或构建；产品行为待登记 |

执行代理已保留任务书和 r4 设计稿的原字节备份。
旧任务书摘要在历史 FINAL_RESULT 中的绑定继续指向该备份字节。
本节只登记后继目标与准备事实，不将推荐写成负责人批准。
本轮未连接 Win10 或 Win7，未推送公开 origin。

### 1.8 包装器提交与有界重跑（2026-10-31 负责人确认）

负责人通过两项选择明确确认甲：采用包装器提交，并批准有界重跑。
本节后继范围为 APPROVED_FOR_IMPLEMENTATION；替代 §1.6 对后继任务的提交职责和额度限制。
旧 p1a 的 FAIL 与全部旧预算消耗保留。

交付结果为一次完整执行、包装器提交、G0、私有推送、Mac G1、独立审核与资源回收。
实际本地分支为 main 工作树，所有改动保持未提交。
只用 czl，最多串行新建两台；任务号为 p1r2a、p1r2b。
Codex 执行与 Claude Code 审核各调用一次，各限时 900 秒。
只向私有 staging 的 `box/p1r2a` 推送；审核包不提交或推送。
环境基线为 `b5572f9d…`；执行单只写原定 106 字节探针。

Codex 保留 workspace-write，不自行暂存或提交。
包装器在回收员工报告、核对准确路径、字节哈希、基线及凭据元数据后创建提交。
包装器先持久化提交计划；回执丢失时只读核对原作业与 HEAD，不重发提交。
工具实现为 `wp.py commit --manifest` 与 `commit_files.py`。
执行代理移除已证实无效的 Git 元数据 add-dir 参数。
既有 close、G0、短命密钥推送、receive 与 G1 继续适用。
必要验证为真实 Git 检查、受影响工具回归、无模型远端检查和一次真实执行/审核闭环。
G0/G1 指定 state；Mac G1 保留文档、指纹、路径与引用检查。

母机保持 suspended，不唤醒、不执行命令、不检查登录。
凭据只记录 SHA-256、字节数、权限与 mtime。
不创建、更新或删除快照；凭据变化进入 CREDENTIALS_HOLD。
认证错误进入 BLOCKED_LOGIN，不重试。
结果未回收核验不删机；撤销密钥或删机失败立即停止并报告。
新试验失败不自动重建机器或追加模型调用。
不提交本地 main，不推送公开 origin，不连接 Win10 或 Win7。
不修改 ADR、MODES.md 或产品源码；暗色主题在工作流通过后另登记范围。
驱动与逐步证据写入 `outputs/wp-p1-r2/`；包回执写入 `outputs/wp/<任务号>/`。

#### 1.8.1 有界重跑结果（执行 2026-10-31 UTC，收尾 2026-11-01 UTC）

执行代理完成执行链路；完整工作流停在 BLOCKED_LOGIN。
证据层级为开发机，基线 `b5572f9d…`，交付提交 `b9ecdb7c…`。
独立审核未取得内容结论；不将 P0/P1 数量填零。

| 项目 | 执行代理直接取得的结果 | 证据位置 |
|---|---|---|
| Linux 提交机制检查 | PASS；真实 linked worktree 提交、重复提交拒绝、系统临时目录删除；模型调用 0 次 | `outputs/wp-p1-r2/p1r2a-mechanism.json` |
| Codex 执行 | PASS；一次 CLI，17.559 秒，保持 workspace-write；只写准确 106 字节探针，没有暂存或提交 | 同目录 `p1r2a-employee-result.json`、`p1r2a-precommit-proof.json` |
| 包装器提交 | PASS；唯一父节点为基线；路径、字节哈希、模式及提交后干净状态均匹配 | 同目录 `p1r2a-commit.json` |
| Box G0 | PASS；state 模块 25 组、391 项测试通过 | `outputs/wp/p1r2a/collected/g0-p1r2a/` |
| 私有推送与 Mac G1 | PASS；仅推 `box/p1r2a`；G1 八项检查通过，包含 state、文档和指纹检查 | `outputs/wp-p1-r2/p1r2a-close.json`、`p1r2a-receive.json` |
| Claude Code 独立审核 | BLOCKED_LOGIN；一次 CLI，1.756 秒，退出 1；错误为 OAuth 会话过期且刷新失败；内容审核 NOT_PERFORMED | 同目录 `p1r2b-employee-result.json` |
| 审核工作区 | PASS；HEAD 等于交付提交，dirty=false，新增提交数为 0；不运行 G0、不生成写密钥、不推送 | `outputs/wp/p1r2b/0012-review-evidence.json` |
| 凭据与回收 | PASS；两包凭据元数据均无变化；全部作业 stdout/stderr 字节数与 SHA-256 核对完成；两台工作机均已删除 | 两包回执；`outputs/wp-p1-r2/p1r2b-collected-check.json` |
| 最终资源 | PASS；只剩准确 suspended 母机，部署密钥为空，Mac 本次临时目录为空 | 同目录 `p1r2b-verify.json` |

Codex 版本为 `0.160.0`；Claude Code 为 `2.1.288`；作业内 Node 为 `20.17.0`。
本轮两台机器串行存在，执行与审核各调用一次；两项调用额度均已消耗。
Claude 事件记录 duration_api_ms=0、modelUsage 为空、token 用量为 0；供应商内部请求数保持 UNKNOWN。
认证失败后执行代理没有重试，没有唤醒母机，没有更新快照。

审核回收驱动先在 `drive.py:153` 断言失败。
原认证字符串检测漏了 `authentication_failed` 与 `Failed to authenticate`。
执行代理从原作业回收准确错误并登记 BLOCKED_LOGIN，没有再次调用审核。
原始日志和断言失败记录保留；运行驱动原字节未改写。
审核包 close 的资源收尾状态为 FAILED，内容结论仍为 NOT_PERFORMED。

提前全局收尾检查为 FAIL；该检查与 Mac G1 重叠。
当时没有记录组合断言各项值，准确失败条件和根因均为 UNKNOWN。
后续串行检查为 PASS；执行代理没有人工删除目录。
见 `outputs/wp-p1-r2/early-cleanup-check.json`。

总结果见 `outputs/wp-p1-r2/FINAL_RESULT.json`。
旧 p1a FAIL 与 UNKNOWN 保留，不用本轮执行成功改判。
本地 main 未提交，公开 origin 未推送；Win10 与 Win7 为 NOT_PERFORMED。
暗色主题尚未进入 Demo、产品实现或构建；后继登录修复与重试需新范围和额度。

### 1.9 仅补独立审核与官方登录恢复（2026-11-01 负责人确认）

负责人在 Q1 选择“甲：批准仅补审核（推荐）”。
准确提案为 `outputs/wp-p1-r3-preparation/PROPOSAL.md`，SHA-256 `536857d6…`。
批准回执为 `outputs/wp-p1-r3/OWNER_APPROVAL.json`。
本后继范围为 APPROVED_FOR_IMPLEMENTATION；不改判 §1.8.1 的 BLOCKED_LOGIN。
实际本地分支为 main，全部本地改动保持未提交。

交付结果为补齐准确提交 `b9ecdb7c…` 的独立审核与资源回收。
只用 czl，从原批准快照最多新建 1 台；任务号 p1r3b，机器名 wp-p1r3b。
只操作私有仓库 allin2/win7-coding-agent-staging 的短命只读部署密钥。
取码后立即撤销密钥；不创建写密钥、不提交、不推送。
已有 Codex 执行、包装器提交、G0、Mac G1 不重跑。

官方登录命令为 `claude auth login --claudeai`，启动 1 次、限时 900 秒。
负责人完成官方网页授权；需要一次性授权码时通过私密输入工具传入。
允许本审核机的 Claude 登录凭据发生预期更新；保留登录前后的元数据记录。
登录成功后保存审核使用的新凭据元数据基线，旧基线保留。
Codex 凭据不得变化；审核后的凭据变化仍进入 CREDENTIALS_HOLD。
不复制 Mac 登录材料；不打印或记录 token 内容。
原始 PTY 登录输出只留机上私有目录，交互完成或超时后删除，不纳入证据。

独立审核仍由 Claude Code 执行；只调用 1 次、plan 模式、900 秒。
只读比较准确提交的单父 diff，报告具体 P0/P1；无问题时明确 P0=0、P1=0。
执行代理核对内容结论，不能只看 CLI 退出码。
必要验证为准确 HEAD、工作区干净、零新增提交、凭据元数据比较、日志字节数及 SHA-256 核验、资源回收。
全部核验后才删除准确审核机，再核对只剩暂停母机、无部署密钥与本次临时残留。
母机保持 suspended，不唤醒、不执行命令、不检查登录；不创建、更新或删除快照。

登录失败或超时后停止，不重启登录、不调用审核。
审核认证失败进入 BLOCKED_LOGIN，不重试；发现 P0/P1 不自动追加调用。
身份不符、异常凭据变化、疑似泄露或范围外写入时停止。
日志未完整核验不删机；撤销密钥或删机失败立即报告，不换方式删除。
本地 main 不提交，公开 origin 不推送，Win10 与 Win7 为 NOT_PERFORMED。
本节不授权暗色主题实现或产品机器预算；工作流通过后再准备 Demo 与后继范围。

#### 1.9.1 后继审核与组合工作流结果（2026-11-01 UTC）

执行代理补齐独立审核及资源回收，组合工作流为开发机 PASS。
绑定提交为 `b9ecdb7c…`，唯一父节点为 `b5572f9d…`。
执行、包装器提交、G0、私有推送与 G1 沿用 §1.8.1 的准确提交证据，未重跑。
独立审核为本轮直接证据；旧 p1a FAIL 和 p1r2 BLOCKED_LOGIN 保留。
总结果为 `outputs/wp-p1-r3/FINAL_RESULT.json`。

| 项目 | 执行代理核对的直接结果 | 证据位置 |
|---|---|---|
| 官方登录 | PASS；仅启动一次，139.631 秒；负责人完成官方网页授权，原始登录日志及一次性输入已删除 | `outputs/wp-p1-r3/login-completed.json` |
| 凭据 | Claude 凭据按批准更新；Codex 元数据未变；审核后两份凭据与新基线一致 | 同目录登录回执及 `outputs/wp/p1r3b/` 审核回收回执 |
| 独立审核 | PASS；Claude Code 一次、16.659 秒，P0=0、P1=0；准确核对提交、唯一父节点和单一探针路径 | 同目录 `employee-result.json`、`CONTENT_VERDICT.json` |
| 任务单偏差 | 审核在 `git show` 后使用只读 `od -c`、`head -20` 检查字节，超出任务单 Bash 命令清单；未观察到写入、凭据读取、网络工具或委派。不宣称命令清单完全合规 | `CONTENT_VERDICT.json` 中完整命令及原始事件 |
| 工作区 | PASS；HEAD 等于准确提交，dirty=false，新增提交为 0；未运行 G0、未生成写密钥、未推送 | `outputs/wp/p1r3b/state.json` |
| 日志 | PASS；本机五个作业 stdout/stderr 字节数、SHA-256、临时目录清理全部核对；连同前轮共 17 个作业核验 | 同目录总结果 jobs |
| 资源 | PASS；准确审核机已删除，只剩 suspended 母机；部署密钥、本次 Mac 临时目录为空；私有 refs 未变 | 同目录 `close.json`、`verify.json` |

本轮唯一新审核机为 `m_agqzjhyh4iknm3qcbyehyilisu`，名称 wp-p1r3b。
首次 open 后台被误设的一秒时限终止；只读对账证明未创建机器，再继续获批 open。
该中断和本地日志校验器首次读取嵌套字段错误均保留在总结果，不作为产品失败。
本轮额度已消耗：一台新机、一次官方登录、一次审核；未追加模型探活。
供应商内部请求数 UNKNOWN；事件 usage 原样保留，不以 num_turns 换算请求数。

本结论只证明单行探针经过完整工作流。
它不证明产品暗色主题或 Windows 运行通过，也不证明长期登录快照复用。
母机始终暂停，快照未更新；本地 main 未提交，公开 origin 未推送。
Win10 与 Win7 均为 NOT_PERFORMED。
执行代理下一步准备暗色主题 Demo 与产品行为裁决；产品实现和新远端预算仍待后继范围。

### 1.10 暗色主题 Demo 与后继草案（2026-11-01 UTC）

执行代理完成暗色主题 Demo，证据层级为开发机。
Renderer 基线为 `bd69a4b6…`；后继工作流提交为 `b9ecdb7c…`。
产品源码未修改；主题只保存在演示内存。
第二版 Demo 为本机 `outputs/a9-dark-theme-demo-r2/index.html`。
十场景、浅暗切换和窄窗导航共 12 项检查 PASS，页面错误 0。
执行代理关闭浏览器并删除本次 profile，无新增临时残留。
首版恢复记录遮挡消息，第二版将该夹具限定在恢复场景。
代码场景按需加载与窄窗抽屉检查顺序的问题均在 Demo 中修正。
首版及本轮首次失败记录保留，不改写产品布局或历史结论。

后继范围见 [A9-44](A9_44_WORKBENCH_DARK_THEME.md)。
该任务状态为 DRAFT_READY_FOR_REVIEW。
配色、默认值、持久化、入口与新增远端预算均为提案。
负责人尚未确认；执行代理没有启动产品实现或新机器。
Win10 与 Win7 均为 NOT_PERFORMED。
本地 main 未提交，公开 origin 未推送。

### 1.11 Claude 员工认证改用长期令牌（2026-11-02 负责人确认）

负责人在暗色主题工作流复盘后选择 B，并要求执行四步。
本节为 APPROVED_FOR_IMPLEMENTATION，实际分支为 main 工作区。
起因是快照内 Claude 登录约 15 小时后无法刷新（§1.8.1）。
暗色主题审核因此三次建机、三次官方登录，见 A9-44 §8.2、§9.1、§9.2。
官方依据为 code.claude.com 的 Authentication 与 Legal and compliance 页，2026-11-01 读取。
`claude setup-token` 生成一年期令牌，用于无浏览器的脚本环境。

| 项目 | 范围 |
|---|---|
| 令牌生成 | 负责人在 Mac 自己的终端运行 `claude setup-token` 并完成网页授权；令牌不进入会话记录 |
| 令牌存放 | 执行代理经私密输入取得，存入 Mac 钥匙串服务 `win7-coding-agent.claude-oauth`，账户 `czl-claude`；读回一致后删除私密输入文件 |
| 工具改动 | `accounts.py` 支持该钥匙串服务；`wp.py run` 在 Claude 员工启动前上传 0600 令牌文件；作业脚本读入 `CLAUDE_CODE_OAUTH_TOKEN` 后立即删除该文件；收尾扫描本包本机文件不含令牌 |
| 离线验证 | `test_wp.py`、`test_cloud.py`、`test_box_job.py` 全部通过；系统临时目录无新增残留 |
| 远端验证 | 仅 czl；一台工作机 `wp-tok1`，从现有登录快照建出；一次 Claude Code 只读最短请求，限时 300 秒 |
| 凭据 | 快照内 Claude、Codex 凭据文件元数据须不变；变化即 CREDENTIALS_HOLD |
| 停止 | 令牌格式不符、钥匙串读回不符、认证失败、令牌出现在回收文件、日志未核验时停止；不重试模型请求，不追加机器 |
| 排除 | 唤醒母机、更新或删除快照、Codex 认证、Win10、Win7、提交、推送、PR 与发布 |

本节新增的令牌泄漏扫描抓住的失败：现有秘密扫描只查提交差异，查不到回收日志。
设计稿 r4 的对应变化记在 r4 §22。
快照继续提供 CLI 与 Codex 登录；Claude 员工不再依赖快照内登录。

#### 1.11.1 四步结果（2026-11-02 UTC）

执行代理完成四步，结果为开发机 PASS。
准确结果见本机 `outputs/eng06-claude-token-r1/FINAL_RESULT.json`。

| 步骤 | 直接结果 |
|---|---|
| 令牌生成 | 负责人在 Mac 自己的终端完成 `claude setup-token` 与网页授权 |
| 令牌存放 | 首次存入被格式检查拒绝：粘贴值含 2 个终端换行空格；去掉空格后 108 字节，钥匙串读回一致；私密输入文件已删除 |
| 本机识别 | `claude auth status` 识别为 `oauth_token`，未发模型请求；是否经服务器校验为 UNKNOWN |
| 工具改动 | `accounts.py` `4ebb87d6…`、`wp.py` `b554965e…`、`test_wp.py` `9c932fc4…`；负责人后继批准后，连同其余 8 个工作流工具文件本地提交为 `b82f9456…`，未推送 |
| 离线验证 | `test_wp` 42 项、`test_cloud` 17 项、`test_box_job` 9 项 PASS；临时目录无残留 |
| 远端验证 | `wp-tok1` 从快照 `sn_agqzc…` 建出，基线 `7e45ee5c…`；Claude Code 2.1.288 plan 模式一次请求返回 `OK`，1 轮、0 次工具调用、作业 7.655 秒 |
| 凭据与工作区 | 快照内 Claude、Codex 凭据元数据未变；HEAD 未变、工作区干净、新增提交 0 |
| 令牌扫描 | 本包本机文件、本轮证据目录、任务书与工具目录均不含令牌 |
| 收尾 | 工作机已删；czl 只剩暂停母机；staging 部署密钥为 0，引用未变 |

认证来源为推断，不是服务器侧证明。
依据有三条：快照内 Claude 凭据与 p1r2b 刷新失败的为同一文件 `96bcadf2…`。
官方认证顺序中令牌高于 `/login`；请求前后该凭据文件未变。
执行模式的 Claude 工作包、令牌撤销入口与 Codex 长期登录均为 NOT_PERFORMED 或 UNKNOWN。
母机、快照、Win10、Win7、提交、推送、PR 与发布均未触碰。

### 1.12 任务书内嵌与 G0 移到审核机（2026-11-02 负责人确认）

负责人审阅一份外部移交建议后选择 A。
本节为 APPROVED_FOR_IMPLEMENTATION，实际分支为 main 工作区，只做本机实现与离线验证。

| 建议 | 处置 |
|---|---|
| 任务书全文内嵌任务单 | 现在实现 |
| G1 不再重跑测试 | 改为 G0 在新建审核机上运行；G1 只保留 `docs:check`（D7）与平台差异模块（D9 的 workspace） |
| Electron 与界面检查移交 Box | 以后单独探测一次，本节不实现 |
| 开发构建移交 Box | 不做：ZIP 105.4 MiB 须回 Mac，Box 文件接口实测约 25 分钟，GitHub raw 单文件上限 100 MiB |

实现范围：

- `wp run --embed 路径[:起-止]` 把本机文件或行段原文附进任务单，记录源文件与摘录 SHA-256。
- `wp run --require-read 路径` 列出须在检出中读取的原件；AGENTS.md 恒在列。开包检出缺少该文件时拒绝启动员工。
- 任务单超过 1 MiB，或含秘密模式、Claude 令牌时，拒绝上传。
- 审核收尾从员工日志提取工具与命令记录，逐个原件记录是否被引用，并提取 `ORIGINALS_READ` 声明。该记录不阻断删机。
- `wp close --defer-g0` 让执行包跳过 G0 并照常推送。`wp run --mode review --g0` 让审核包在审核员工退出后运行 G0。
- `wp receive --g0-from 审核任务` 要求审核包已关闭、已删机、基线等于执行提交、指纹一致、G0 PASS、G0 后工作区干净。
- 此时 G1 的模块测试只跑平台差异模块。G0 推迟而未给 `--g0-from` 时拒绝 G1。

各项抓住的失败：

- 内嵌与必读检查：暗色主题审核读不到未入库任务书，原始约束读取证据为 NOT_VERIFIED。
- 审核机 G0：执行机的环境由员工控制过；新建审核机未经员工写入。
- 未带 `--g0-from` 时，现有行为不变。

验证：`test_wp.py`、`test_cloud.py`、`test_box_job.py` 全部通过；系统临时目录无新增残留。
排除：新建机器、模型请求、快照、Win10、Win7、推送、PR 与发布。提交需负责人另行确认。

#### 1.12.1 本机实现结果（2026-11-02 UTC）

执行代理完成本机实现，结果为开发机 PASS，未触碰任何远端。
`wp.py` 为 `812077a2…`，`test_wp.py` 为 `893e0caf…`，均未提交。
设计稿对应变化见 r4 §23。

| 检查 | 直接结果 |
|---|---|
| 离线测试 | `test_wp` 54 项、`test_cloud` 17 项、`test_box_job` 9 项 PASS；临时目录与字节码缓存无残留 |
| 真实文档组装 | A9-44 任务书全文与 ADR-0312（DECISIONS.md 第 5399～5407 行）组成 48,299 字节任务单，未触发秘密模式 |
| 历史日志回放 | dark1a 的 Codex 执行日志引用 AGENTS.md、WIN7_CONSTRAINTS 与 A9 总合同，记 REFERENCED；dark1r2b 的 Claude 审核日志一项未引用，记 NOT_VERIFIED，与 A9-44 §9.3 人工结论一致 |

回放只读取既有日志，不改写 A9-44 的原结论。
审核机 G0 与新门顺序的真实远端运行为 NOT_PERFORMED，须在下一个获批工作包中直接取得。

### 1.13 暗色主题加入 InstaBox CI 的真实串跑（2026-11-02）

负责人原话：“请你重新跑一遍暗色主题的全流程，跑一趟加入ci之后的全工作流（按需跑，主要是为了串流程）”。
本节为 APPROVED_FOR_IMPLEMENTATION。执行代理在本地 main 工作区登记与回收；不改写已有脏文件。
远端执行分支为私有 staging 的 `box/theme-ci-r1`，审核包为 `theme-ci-r1b`。
基线为暗色主题产品提交 `7e45ee5c353152ed255b7e829a981dac9e4d220b`。

交付结果是一次绑定准确提交的执行、包装器提交、私有推送、独立审核、审核机 G0、InstaBox CI 和 Mac G1 串联。
不重新实现暗色主题。执行员工只新增 `.github/workflows/instabox-theme.yml`，运行最窄主题测试。
原产品字节不变时，构建与 Win7 产品证据可按准确哈希继承，并明确标注继承。

| 项目 | 本轮边界 |
|---|---|
| 工作机 | czl 现有快照最多新建两台，执行与审核串行；母机保持 suspended；不更新快照 |
| 模型 | Codex 执行一次、Claude 独审一次，各上限 900 秒；Claude 使用 §1.11 已批准钥匙串令牌；认证失败不重试 |
| Git | 员工不暂存、不提交、不推送；主对话检查准确文件后由包装器提交到私有工作分支，随后私有推送；不提交本地 main、不推送公开 origin |
| 原始约束 | 完整内嵌 ENGINEERING_06 与 A9-44 本地任务书；员工必须读取检出中的 AGENTS、WIN7_CONSTRAINTS、A9 总合同与 scripts/README |
| G0/G1 | 执行包 close --defer-g0；新审核机独审后运行 shell G0；Mac G1 核路径、父链、引用、秘密、指纹与文档，不重复 shell G0 |
| CI | 使用现有 GitHub App 与 instabox-medium，在私有工作分支 push 触发；不新增 App 权限、系统配置或 secrets；contents: read，checkout 不持久化凭据，不引用 secrets |
| 产品运行 | 按需核对准确历史 Electron、ZIP 和 Win7 DEV_CHANNEL 证据；新目标运行受既有有效准入限制，不继承旧容量或锁例外 |
| 停止 | 认证失败、P0/P1、源码绑定不符、秘密命中、异常凭据变化、准入不足即停止依赖阶段；App 未覆盖私有仓库时不擅自改权限或推送公开产品 |
| 回收 | 日志字节数与 SHA 核验完成后删除本轮工作机；撤销本轮 deploy keys，核对母机与本次临时目录；不删历史证据 |

执行与审核的真实串联验证能发现 §1.12 离线检查无法覆盖的远端任务书缺失、审核机 G0 绑定错误和 CI runner 不可调度。
本轮证据写入 `outputs/eng06-theme-ci-r1/` 与 `outputs/wp/theme-ci-r1{,b}/`。
本轮不包括正式验收签发、发布、公开产品推送或无关脏文件提交。

#### 1.13.1 真实串跑结果：CI 调度 BLOCKED

执行代理完成一次真实执行、包装器提交、私有推送、新机独审、审核机 G0 与 Mac G1。
证据层级为开发机，准确提交为 `6f4f070c…`，唯一父节点为 `7e45ee5c…`。
只新增 31 行 `.github/workflows/instabox-theme.yml`，产品源码字节未变。
包含 CI 的全工作流为 BLOCKED；不因其余阶段 PASS 改判。

| 阶段 | 本轮直接结果 |
|---|---|
| Codex 执行 | 一次，150.250 秒，workspace-write；只写批准的 CI 文件，未暂存、提交或推送 |
| 任务书下发 | 两份完整任务书内嵌；四份必读检出原件有工具命令引用；员工和独审均声明读取；原始日志保留，不把声明等同阅读真实性认证 |
| 包装器提交与私有推送 | PASS；准确 manifest，提交 `6f4f070c…`，只新增私有分支 `box/theme-ci-r1`；归属行符合本轮要求 |
| 独立审核 | Claude Code 一次，115.882 秒；原主题差异与 CI 配置 P0=0、P1=0；主对话核对内容；工作区未变 |
| 审核机 G0 | PASS；新机独审后运行 shell；63 组、1429 PASS、12 省略，共 1441 项；七模块依赖编译、shell lint 与测试退出码均为 0；约 43 秒 |
| Mac G1 | 九项 PASS；新审核机 G0 绑定、准确提交、父链、引用、范围、秘密扫描、输入指纹、文档与模块覆盖均核对；shell 由新机 G0 覆盖，本机没有重复运行 |
| CI | BLOCKED；准确提交 push 创建 run `41449669106`；instabox-medium 等待超过 240 秒仍无 runner，执行代理取消；最终 completed/cancelled，runner_id=0，steps=[]，主题测试 NOT_PERFORMED |
| 产品证据 | 继承准确源码 `7e45ee5c…`、包 `da7cbc74…`、Win7 DEV_CHANNEL run `3b726a4b…`；本地只读复核 28 项、11 文件、四图既有回执 PASS；本轮新构建、Electron/Win7 运行 NOT_PERFORMED |
| 凭据与回收 | 两包快照凭据元数据均未变；11 个作业 stdout/stderr 字节数与 SHA 逐项一致，作业临时目录均已删除；本包及本轮回收文件无 Claude 令牌命中 |
| 资源 | 两台工作机均已删除；czl 只剩原 suspended 母机；staging 部署密钥为空，本次 Mac 临时目录无残留；母机、快照、既有 ci/test 机器未改动 |

CI 排队根因为 UNKNOWN。现有 gh 身份不能查询 GitHub App 的安装授权范围；查询返回 401/403 不证明 App 未安装。
InstaBox 官方说明，CI 页或 `instabox ci` 可显示 waiting/refused 原因，API Key 不支持 CI installations/jobs 入口。
本机未发现 instabox 可执行入口；本轮未安装 CLI、申请新登录、扩大 App 权限或新增 secrets。
下一步先使用已有 InstaBox 登录会话读取该 job 的等待或拒绝原因，再决定准确修复。
官方参考为 https://instabox.sh/docs/ci.md 。

公开仓库与私有 staging 的 Actions secrets 名称列表均为空，本轮没有读取 secret 值。
CI 文件不引用 secrets，checkout 使用只读 GITHUB_TOKEN，且 persist-credentials=false。
这不是零凭据或完整秘密审计结论；CI 从未获分配执行机。
独审另提示既有 prepare-linux 的指纹步骤依赖 claude/codex CLI，实际 CI 镜像 PATH 仍为 UNKNOWN。
按官方每 job 新建并删除机器的模式，不引入持久 runner 缓存修复。
workflow_dispatch 须默认分支含文件；本轮使用 push 已触发，不为手动入口改默认分支。

本地 CI 对账首次遇到只读 API 查询失败；执行代理保留错误，退避后恢复读取，没有重复提交或重发 CI。
开发包、历史失败与已签结论均未改变。本地 main 未新建提交，公开 origin、PR、发布与正式验收均未执行。
当前 CI 配置仅在私有工作分支，未宣称主分支 CI 已落地。
准确回执见本机 `outputs/eng06-theme-ci-r1/`，重点为 `CONTENT_VERDICT.json`、`theme-ci-r1-receive.json`、`CI_RESULT.json`、`CI_DIAGNOSIS.json` 与 `COLLECTION_VERIFICATION.json`。

## 2. 验证与停止条件

- 开发机直接核对四组凭据的只读接口结果；写权限不以读取成功推断。
- 按实际工作区 ID 计算名额，不能把同一工作区的多个 Key 当成多个账号。
- 本地配置和报告不得包含密钥值；工具错误仅输出限长错误类别与所需权限。
- 身份无法核对或凭据无效时，停止该凭据的后续配置，其余凭据继续。
- 不绕过 TLS 验证；不跟随携带鉴权头的跨地址重定向。
- 执行接入工具检查、环境准备和试点工作包的定向测试。
- 使用 `test:local` 核对 Linux 开发机基线，保留失败及明确省略项。
- 本轮不运行完整发布组，不将 Linux 结果写成 Win10 或 Win7 结论。

## 3. 当前结果

执行代理已完成本阶段的环境配置、官方账号登录和文件流转模拟。
证据层级为开发机；源码基线为 `bd69a4b6…`，模拟提交为 `b5572f9d…`。
本任务保持 APPROVED_FOR_IMPLEMENTATION；本阶段完成不表示真实模型工作包或完整工作流通过。

| 项目 | 执行代理直接取得的结果 | 证据 |
|---|---|---|
| 四账号接入 | czl、ci、chai2、chai521 的工作区身份均匹配；只读检查 PASS。四组密钥已存入 Mac 钥匙串并回读核对 | `outputs/instabox-setup-r1/accounts-final-check.json` |
| 旧机回收 | §1 两台准确旧机的删除操作均 succeeded；未删除未知机器 | 同目录 `delete-czl-aitest.json`、`delete-chai521-old.json` |
| 当前 Box 环境 | ci 的一台 Box 完成准备；固定模板 agent-browser `2026-10-29.18`、开发用 Node `20.17.0`，九处 `npm ci` 完成，SQLite 内存查询成功 | 同目录 `prepare-ci-worker.json`、`final-environment-ci.json` |
| Claude Code 登录 | 官方 claude.ai 登录完成；状态命令确认 loggedIn=true、firstParty、pro；CLI `2.1.288` | 同目录 `agent-login-status-r1.json` |
| Codex 登录 | 官方设备授权完成；状态命令确认 loggedIn=true、ChatGPT；CLI `0.160.0` | 同目录 `agent-login-status-r1.json` |
| 登录材料处置 | 两个凭据文件均为 0600；执行代理已删除原始登录日志和一次性输入文件；未复制 Mac 登录材料，未创建含凭据快照 | 同目录 `final-environment-ci.json` |
| 文件流转模拟 | Box 提交并推送私有分支；Mac fetch 后核对四个文件的 SHA-256 和输入指纹一致；产品文件改动为 0 | 同目录 `simulation-push.json`、`mac-receipt.json` |
| 临时仓库写入凭据 | 模拟回传完成后，执行代理撤销 GitHub deploy key `168274459`，并核对登记已不存在 | 同目录 `deploy-key-ci-revoked.json` |

模拟分支为私有 staging 的 `eng06/environment-simulation-r1`。
模拟交付仅含环境入口、准备脚本、指纹脚本和模拟报告。
完整提交与最终指纹见 `mac-receipt.json`；最终指纹为 `af2b312e…`。
执行代理未向公开 origin 推送；未提交本地 main；未将模拟提交集成到 main。

### 3.1 基线检查与未执行项

执行代理在开发机层级对 `bd69a4b6…` 运行了 Linux 日常集合，整体结果为 FAIL。
七模块编译通过；workspace 测试失败，其余六模块测试退出码为 0。
失败位置为 `review-staging.test.ts` 的 Windows 路径大小写用例。
该用例预期重复路径错误；Linux 实际先返回目标文件不存在。
执行代理按负责人后继范围保留该失败，本轮未修复。
日常集合的两项既有省略保持 NOT_PERFORMED，不计为完整回归。

Box 的 `docs:check` 为 FAIL。
干净 staging 源码缺少 `latest-validation.json` 所引用的历史提交对象 `8b032772…`。
执行代理未修改该历史记录，也未为此推送额外历史。
原始结果见 `baseline-test-ci-worker.json`；本次失败保留的沙箱已删除，见 `baseline-diagnostic-cleanup.json`。

Mac 收尾检查：`docs:check` PASS，核对 396 份文档和 66 份任务书。
`verify:tools` 三个命令 PASS，回执为 `mac-tools-check.json`；本次临时目录已删除。
Mac 工具组使用 Node `22.23.1`，不加载产品原生模块；Box 开发环境仍使用固定 Node `20.17.0`。
Python 与 Bash 语法检查、`git diff --check` 均 PASS。
这些本地结果不改变上述 Box 的两项 FAIL。

| 项目 | 本轮范围与结果 |
|---|---|
| 真实模型请求 | 0；模型执行 NOT_PERFORMED |
| 独立模型审核 | NOT_PERFORMED；执行代理只核对模拟交付的范围、哈希和指纹 |
| 其余三账号建机与环境复验 | NOT_PERFORMED；四账号身份核对不替代四机环境复验 |
| Win10 验收机 | NOT_PERFORMED |
| Win7 实机 | NOT_PERFORMED |

### 3.2 当前资源与期限

执行代理于 UTC `2026-10-31T07:22:56Z` 直接核对当前 Box。
机器为 ci 的 `eng06-ci-worker`，ID `m_agqzboircdw7bvgzhpg5pv2zra`。
当时状态为 running，runtime.ready=true。
准确资源回执见 `outputs/instabox-setup-r1/resource-closeout-ci.json`。

自动删除时间为 UTC `2026-10-31T10:50:10.064056Z`。
暂停不会取消该期限；执行代理未修改期限、未创建快照或 fork。
两个 agent 的登录材料仅留在当前 Box，不能据此承诺长期保留。
其他三个账号的最终机器清单为空，绑定 `accounts-final-check.json` 的检查时间。

### 3.3 czl 母机配置与私有镜像前置

负责人将本阶段明确为 czl 单机母机与私有恢复镜像。
执行代理在 `eng06-czl-agy` 完成下列开发机检查。
机器 ID 为 `m_agqzbybbovx2docbd6ckgqd63q`；源码工具基线仍为 `bd69a4b6…`。
证据目录为 `outputs/instabox-czl-base-r1/`。
本机尚未安装项目源码与九处依赖，不能继承 ci 的项目环境结论。

| 项目 | 执行代理直接取得的结果 | 证据 |
|---|---|---|
| Claude Code | `2.1.288`；loggedIn=true、claude.ai、firstParty、pro；凭据文件 0600 | `preimage-health.json`、`final-agent-login-state.json` |
| Codex | `0.160.0`；官方 ChatGPT 登录保留；凭据文件 0600 | 同上 |
| Antigravity CLI | `1.4.12`；Google OAuth 完成，首次配置完成；Google AI Pro 主界面在重新启动与钥匙串守护进程重启后均可进入；凭据文件 0600 | `agy-final-settings.json`、`final-agent-login-state.json` |
| agy 遥测 | 官方 `/config` 面板显示 Enable Telemetry=off；不据此扩张为供应商全部数据处理结论 | `agy-final-settings.json` |
| T3 后端 | `0.1.6-nightly.20261031.3956`；systemd 用户服务 active/enabled；首页 HTTP200、匿名会话 authenticated=false、匿名 WebSocket ticket HTTP401 | `preimage-health-r3.json` |
| 后端启动环境 | 只监听 `127.0.0.1:3773`；服务 PATH 包含四工具；DBus 使用本用户会话总线 | 同上 |
| 钥匙串恢复 | 官方 GNOME Keyring 用户服务启动时读取本机 0600 解锁文件；守护进程重启后 Locked=false。早先辅助入口解锁失败已保留，不进入最终配置 | `persistent-services-r2.json`、`final-agent-login-state.json` |
| 登录材料处置 | 已结束全部 agy 登录会话；原始 PTY 登录日志、一次性 input、Codex 登录日志与 agy 自建登录日志均已删除。有效账号状态与钥匙串保留 | `final-cleanup.json` |
| T3 Connect | 负责人完成新一轮官方网页授权；CLI 退出码为 0。执行代理重启用户服务后核对 Authorization=stored credential、Environment link=provisioned、通道可达；原始授权日志已删除。首次十分钟超时事实保留 | `t3-connect-ready.json` |
| 私有镜像 | 执行代理保存完整在线快照；UTC `2026-10-31T08:49:34.279875Z` 创建，随后直接核对 status=ready。保存 root 与 `/data`；有效范围为 czl 私有恢复 | `snapshot-create-receipt.json`、`snapshot-status-01.json`、`IMAGE_MANIFEST.json` |
| 保存后母机 | 母机保持 running、runtime.ready=true；T3 与钥匙串服务 active，T3 Connect 可达；匿名会话未认证、匿名 ticket HTTP401 | `post-snapshot-health.json`、`post-snapshot-machine.json` |

执行代理发现并记录一项操作偏差。
执行代理原想打开 agy `/config`，但将 Esc 与命令同批送入 PTY。
agy 实际收到 `config`，触发一次模型生成，并请求批准 `ls -la`。
执行代理未批准该命令，随后终止会话；专用空工作区文件数为 0。
实际提交轮次为 1；供应商内部模型请求数为 `UNKNOWN`，不能再写本阶段真实模型请求为 0。
该偏差不构成产品工作包或独立审核，证据为 `agy-login-and-deviation.json`。
后续通过分步输入官方命令菜单完成设置检查，未再次触发模型生成。
§3.1 的零请求仅指此前已收尾的 ci 模拟阶段，历史事实保留。

执行代理已完成 czl 私有镜像保存与源母机检查。
证据层级为开发机；工具脚本基线为 `bd69a4b6…`。
本阶段不关闭整个 ENGINEERING_06，其他账号环境与真实工作包仍按原范围另行开展。

| 镜像属性 | 直接回执与解释 |
|---|---|
| 名称 | `eng06-czl-base-r1-20261031` |
| 镜像 ID | `sn_agqzcjtcjpqyjt5xxcfn3cdwam` |
| 工作区 | czl，`org_a4f4249fb159445d90676094ebfde8fd` |
| 来源母机 | `m_agqzbybbovx2docbd6ckgqd63q` / `eng06-czl-agy` |
| 状态与可见性 | status=ready；接口未返回 visibility，按官方 schema 的缺省规则判为 private，仅本工作区成员可用 |
| 保存范围 | `rootOnly=false`；root 与 `/data`，包含本机账号登录和 T3 身份；不保存内存与运行进程 |
| 逻辑容量 | root 16 GiB、`/data` 20 GiB；这是恢复磁盘容量，不是镜像实际存储占用；实际占用 UNKNOWN |
| 模板 | agent-browser `2026-10-29.18`，digest `bd882c53…`；Debian 13，模板 Node `22.23.3` |
| 保存方式 | 在线磁盘快照；执行代理保存前完成文件同步。母机有归属未确认的交互进程，本轮未停机或终止这些进程 |
| 交付清单 | `outputs/instabox-czl-base-r1/IMAGE_MANIFEST.json`；包含四工具摘要、relay 摘要、用户服务配置和脱敏证据索引 |

执行代理在保存前后均确认一次性输入和原始登录日志无残留。
T3 启动日志检查未匹配设备授权链接及字面 token 赋值；不将该检查表述为完整秘密扫描。
有效账号凭据按 §1.2 保留；本机未注入 InstaBox API Key、个人 GitHub token 或 Win7 私钥。

镜像恢复实例会继承相同模型账号和 T3 身份。
本轮未新建恢复实例，避免同时运行同一 T3 身份；恢复验证为 `NOT_PERFORMED`。
母机重启验证也为 `NOT_PERFORMED`；已执行的是钥匙串守护进程重启及 agy 登录恢复检查。
恢复时先停止原实例，再核对四工具登录与 T3 接入；不将同一身份并行用作多台 Worker。
T3 内 Antigravity ACP Provider 使用独立认证；本轮只完成 agy CLI 登录，ACP 认证为 `NOT_PERFORMED`。
Mac 客户端环境列表显示、真实产品工作包、独立模型审核、Win10 与 Win7 均为 `NOT_PERFORMED`。
母机继续保留且没有自动删除期限；本轮未提交 main、推送公开 origin 或发布产品。

### 3.4 czl 项目环境与工作流试跑

执行代理按 §1.3 在 czl 完成项目环境准备、日常检查和私有报告交换。
证据层级为开发机；产品基线 `bd69a4b6…`，环境入口提交 `b5572f9d…`。
报告提交为 `3e87a552…`，位于私有 staging 的 `eng06/czl-workflow-r1`。
该提交仅新增试跑报告，未修改产品文件，未合入 main。
准确身份与回收清单见 `outputs/instabox-czl-workflow-r1/mac-receipt.json`。

| 检查 | 执行代理直接结果 |
|---|---|
| 项目准备 | PASS；独立目录 `/data/home/projects/win7-coding-agent`；并排安装 Node `20.17.0` / npm `10.8.2`；九处 `npm ci` 和 SQLite 内存查询完成；耗时 34.91 秒 |
| 输入指纹 | PASS；`af2b312e…`，Mac 与 Box 的环境脚本、`.nvmrc` 和九份锁文件逐项相同 |
| 七模块构建 | PASS；workspace、state、runner、git-adapter、gateway、core、shell 及 shell lint 的命令退出码为 0 |
| 日常集合 | FAIL；104.711 秒，workspace 的一个路径大小写用例失败，其余六模块测试退出 0；已有两类日常省略为 NOT_PERFORMED |
| 文档检查 | FAIL；staging 缺历史对象 `8b032772…`，未改写历史记录或补推额外历史 |
| 原始证据回收 | PASS；五文件回收至 Mac，字节数与 SHA-256 逐项一致 |
| Git 报告交换 | PASS；Box 提交、私有推送、Mac fetch 和报告 SHA 校验完成；产品文件改动为 0 |
| T3 项目登记 | PASS；官方 CLI 添加项目，指向本次工作区 |
| T3 模型派单 | BLOCKED；Mac 的 Settings → Labs → Linked environments 关闭，跨机器能力查询返回 `capability_denied`；执行代理未修改设置或改用其他模型入口 |
| ACP 状态 | 官方托管工件和独立凭据文件存在，权限 0600；T3 已启用该 provider。实际账号访问和模型调用为 NOT_VERIFIED |
| 临时凭据与沙箱 | staging deploy key `168291374` 已撤销并核对不存在；本次私钥、公钥、专用 known_hosts 已删除；`/data/home/tmp` 最终为空 |

日常集合运行时，Mac 的 API 回执中断。
执行代理未重复启动测试，直接回收远端完整日志。
日志包含结束汇总、各命令退出状态及 workspace 的具体失败，可以判定日常集合 FAIL。
顶层进程退出码仍为 UNKNOWN，不能把接口中断写成收到退出码。
执行代理确认没有进程使用本次沙箱后，将原始日志复制到证据目录，再删除沙箱。
随后单独执行文档检查，直接收到退出码 1。

本次 workspace 仍预期 `Duplicate Windows path`，实际先返回 `MODIFY target does not exist: SRC/file.ts`。
本轮不修复该 Linux 用例，不改变旧 FAIL。

当前母机的 Claude Code 为 `2.1.316`，Codex 为 `0.166.0`。
T3 服务实际为 `0.1.6-nightly.20261031.3977`，命令入口仍显示 `.3956`。
ACP releaseId 为 `2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384`。
上述后继状态不能回写为旧快照内容。

母机已具备源码、固定 Node、九处依赖和 T3 项目登记。
默认工具 Node 仍为 `22.23.3`；项目命令须先执行 `source scripts/instabox/env.sh`。
T3 harness 自动选用项目 Node 为 NOT_VERIFIED。
本次没有保存新快照，旧快照不含本次补齐的项目环境。
完整重启、镜像恢复、真实模型工作包、独立模型审核、完整发布组、完整 `npm test`、Win10 与 Win7 均为 NOT_PERFORMED。
最终母机仍 running、runtime.ready=true，无 OOM，T3 和钥匙串服务 active。
`/data` 可用空间为 10,546,630,656 字节；本轮不将该瞬时值当作正式资源预算。
母机继续保留，原有登录和其他会话进程未终止。

更正（2026-10-31）：上表的 BLOCKED 只针对 T3 跨机器派单。
设计中的员工启动路径是 InstaBox exec 加无头 CLI，不经过该开关；本次没有尝试，模型工作包为 NOT_PERFORMED。
`mac-receipt.json` 原写为 BLOCKED，执行代理已改为 NOT_PERFORMED，原值保留在其 `corrections` 字段。

### 3.5 工作流 r4 设计与 D7 裁决

负责人对 czl 试跑暴露的问题选择方案甲：Box 的 G0 不再运行 `docs:check`，改在 Mac 的 G1 运行。
执行代理据此写出 `outputs/future-workflow/FUTURE_WORKFLOW_DESIGN_r4.md`，记录为 D7。
r4 原稿另提出 D8（每账号一台常驻 Worker）与 D9（Linux 大小写用例走现有省略机制）。
登录快照克隆验证 PASS 后，负责人于 2026-10-31 选 D8 甲：改为“每账号一份登录快照，工作包按需建机、用完删机”，原“常驻 Worker”撤回；并授权执行代理处理 D9，采用推荐项甲（Linux 上省略该用例，Mac 的 G1 执行）。
r4 已按此改写（SHA-256 `79cf64ec…`），原稿备份 SHA-256 `0299f1ed…`。D9 的代码改动未开始，须先按 C14 登记范围。
r4 是设计稿，不授权实现；`box-job.sh`、`wp.py` 与 `verify_integration.mjs` 修改须先登记范围。

#### 1.13.2 CI 复验：fingerprint 降级修复后全链路通过（2026-11-02 后继）

§1.13.1 的 BLOCKED 保留不改判。后续真实串跑发现标准 runner 镜像（instabox-medium）PATH 无 `claude`/`codex`，
`prepare-linux.sh` 的 `fingerprint.py` 以 `subprocess.run(check=True)` 观测这两个 CLI 版本，`FileNotFoundError` 使准备阶段整体失败。
三方裁决（Pi / DeepSeek xhigh / Gemini）一致：安装 CLI 不必要，推荐对缺失 CLI 降级记录 `null`，保留严格 `inputs` 指纹。

修复提交 `41f7301…`（唯一父节点 `6f4f070c…`）仅改 `scripts/instabox/fingerprint.py`：
`version()` 捕获 `FileNotFoundError`/`CalledProcessError`/`TimeoutExpired` 返回 `null`；`node`/`npm`/`git` 保持严格 `check=True`。

复验 run `41554855640`（分支 `box/theme-ci-r2`）conclusion=success：runner_id=3、`gh-job-125651142359`；
`"claude": null, "codex": null`，`inputs.sha256=062e3ff5…` 与本机一致；主题测试 `a9-appearance-theme.test.ts` 1 套 23 项 PASS。
本地 `test_wp.py` 54 项 PASS。证据在本机 `outputs/eng06-theme-ci-r1/`（`CI_R2_RESULT.json`、`CI_R2_LOG.txt`）。

仍不新增 App 权限、系统配置或 secrets；不提交本地 main、不推送公开 origin；主分支 CI 未落地，属后续单独授权范围。

#### 1.13.3 主分支 CI 落地（2026-11-02 授权后继）

负责人批准后，本地 main 新增提交 `79388ea`（仅两个文件）：
- `.github/workflows/instabox-theme.yml`：与 r2 验证版一致，push 触发分支改为 `main`，`workflow_dispatch` 保留；
- `scripts/instabox/fingerprint.py`：与 `41f7301` 修复版逐字节一致（缺失 CLI 降级 `null`）。

推送仅到私有 staging main（`41aae71 → 79388ea`）；公开 origin main 未动（仍 `d82899f`）。
staging 主分支 CI run #5 `41566811568` conclusion=success：job `125690208645`，node `v20.17.0`，
`inputs.sha256=062e3ff5…` 与 r2/本机一致，`claude: null`、`codex: null`，主题测试 23/23 PASS。
证据在本机 `outputs/eng06-theme-ci-r1/CI_MAIN_RESULT.json`、`CI_MAIN_LOG.txt`、`CI_MAIN_LOG.zip`。

仍不新增 App 权限、系统配置或 secrets；公开 origin 同步与后续主分支改动为独立授权范围。
