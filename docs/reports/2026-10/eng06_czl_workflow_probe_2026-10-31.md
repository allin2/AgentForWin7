# czl 单机开发工作流试跑

执行代理已在 czl 完成项目环境准备和检查。
环境准备为开发机 PASS；日常集合与文档检查为开发机 FAIL。
T3 跨机器模型派单为 BLOCKED，完整模型工作流未完成。

## 1. 绑定范围

| 项目 | 本次身份 |
|---|---|
| 证据层级 | 开发机，不含 Win10 或 Win7 结论 |
| 产品源码基线 | `bd69a4b6a6f942b417f0d44606a003836073aceb` |
| 环境入口提交 | `b5572f9d144840291eb608125d89115b1a71a27a`；仅比产品基线增加三份环境脚本和前次模拟报告 |
| 私有分支 | `eng06/czl-workflow-r1`，仅新增本报告 |
| 账号与机器 | czl / `eng06-czl-agy` / `m_agqzbybbovx2docbd6ckgqd63q` |
| 工作区 | `/data/home/projects/win7-coding-agent` |
| 输入指纹 | `af2b312efa1528c2b88f4ab078779b73bc6c865ee5487a4f5d8c3660e99ccd25`；Mac 与 Box 逐项一致 |
| 本地原始证据 | Mac 的 `outputs/instabox-czl-workflow-r1/`；提交报告不替代原始日志 |

本次不修改产品逻辑，不修复既有 Linux 红灯。
执行代理只在私有 staging 新分支提交和回传本报告。
本次不提交本地 main，不推送公开 origin，不连接 Windows 目标机。

## 2. 开发机直接结果

| 检查 | 结果与边界 |
|---|---|
| Node 与依赖 | PASS；并排安装 Node `20.17.0` / npm `10.8.2`；根目录加八个子模块的九处 `npm ci` 完成；SQLite 内存查询成功；准备耗时 34.91 秒 |
| 输入一致 | PASS；准备脚本、指纹脚本、环境入口、`.nvmrc` 和九份锁文件逐项哈希一致 |
| 七模块构建 | PASS；workspace、state、runner、git-adapter、gateway、core、shell 均退出 0；shell lint 退出 0 |
| 日常测试 | FAIL；104.711 秒。workspace 的一个大小写路径用例失败；其余六模块测试退出 0。已有两类日常省略仍为 NOT_PERFORMED |
| 文档检查 | FAIL；staging 缺少 `docs/status/latest-validation.json` 引用的历史提交对象 `8b032772e0c632ec990cc6dfa75fbce4d5f2bb1c` |
| 原始日志回收 | PASS；准备、日常测试、文档检查及恢复记录五文件回收至 Mac，逐项 SHA-256 相同 |
| T3 项目登记 | PASS；使用官方 CLI 添加项目 `4bfee569-5ede-4c07-b2fb-efa3e34c04d2`，指向本次工作区 |
| T3 跨机器派单 | BLOCKED；Mac 返回 `capability_denied`，原因为 Settings → Labs 的 Linked environments 关闭；执行代理未修改该设置，也未改用其他入口启动模型 |
| CLI 登录状态 | Claude Code 状态显示已登录；Codex 状态显示使用 ChatGPT 登录。状态查询不证明实际模型调用 |
| Antigravity ACP | T3 已启用该 provider，官方托管工件存在，独立 `acp_token.json` 存在且权限 0600；本次不读取凭据值。账号访问和实际模型调用均为 NOT_VERIFIED |
| 测试沙箱清理 | PASS；本次目录已删除，`/data/home/tmp` 最终为空；环境准备未新增临时残留 |
| 产品差异 | 检查后 tracked/untracked 差异为空；本报告是本分支唯一新增文件 |

workspace 的具体失败为：预期 `Duplicate Windows path`，实际先收到 `MODIFY target does not exist: SRC/file.ts`。
这与此前 ci 的 Linux 失败相同，本次没有修改断言或产品实现。

长时间 exec 的 Mac API 回执中断。
执行代理未重复启动日常集合。
远端完整日志包含结束汇总与各命令退出状态，因此可判定日常集合为 FAIL。
顶层进程退出码为 UNKNOWN，不能从接口中断补写为已收到退出码。
执行代理先核对没有进程使用本次沙箱，再回收日志并删除该目录。
随后单独执行文档检查，直接收到退出码 1。

## 3. 母机与旧快照的差异

旧快照为 `eng06-czl-base-r1-20261031`，ID `sn_agqzcjtcjpqyjt5xxcfn3cdwam`。
执行代理本次没有覆盖或新建快照。

| 项目 | 旧快照记录 | 当前母机直接记录 |
|---|---|---|
| 项目源码、固定 Node、九处依赖 | 没有 | 本次已补齐 |
| T3 项目 | 没有本项目 | 本次已登记 |
| Claude Code | `2.1.288` | `2.1.316` |
| Codex | `0.160.0` 启动器；另有未完整哈希的 app-server | `0.166.0` |
| T3 后端 | `0.1.6-nightly.20261031.3956` | 服务实际版本 `0.1.6-nightly.20261031.3977`；命令入口仍显示 `.3956` |
| Antigravity ACP | 认证 NOT_PERFORMED | 官方工件和独立凭据存在；可用性 NOT_VERIFIED |

ACP 工件 releaseId 为 `2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384`。
T3 和钥匙串服务保持 active。
本次没有重启服务、停止母机或终止其他会话进程。

## 4. 作为项目开发快照的剩余缺口

| 缺口 | 当前判断与下一步 |
|---|---|
| 日常检查可用基线 | 需要按获批范围处理 Linux 大小写用例；旧 FAIL 保留。文档检查需另行确定历史 Git 对象的最小供给范围 |
| T3 模型入口 | 需要由负责人启用 Mac 的 Linked environments，并完成环境关联与最短实际调用；ACP 凭据存在不能替代调用结果 |
| 项目运行入口 | 每个工作包需先执行 `source scripts/instabox/env.sh`。默认工具 Node 仍为 `22.23.3`；T3 harness 自动选用项目 Node 为 NOT_VERIFIED |
| 快照内容落后 | 当前源码、项目 Node、依赖和 ACP 后继状态不在旧快照中；本次没有保存新快照 |
| 恢复验证 | 完整重启、从快照恢复、恢复后登录及模型调用均为 NOT_PERFORMED；恢复前须停止原母机，避免同一 T3 身份并行运行 |
| 完整工作流 | 真实模型工作包、不同 agent 的独立审核及 Mac 集成均为 NOT_PERFORMED；当前只覆盖环境、检查、证据回收与私有报告交换 |

快照是环境缓存，源码基线和依赖指纹仍以 Git 与锁文件为准。
未来工作包继续使用只限 staging 的临时部署凭据。
项目快照不应保留本次临时部署私钥。
旧快照仅限 czl 私有恢复，不能用于跨账号分享或同一身份的并行 Worker。

## 5. 未执行项

本次模型工作包、独立模型审核、完整发布组、完整 `npm test`、Win10 和 Win7 为 NOT_PERFORMED。
快照保存、完整重启和恢复验证为 NOT_PERFORMED。
最终报告提交、Mac Git 回收及部署密钥撤销结果以本地 `mac-receipt.json` 与 `CLOSEOUT.json` 为准。
