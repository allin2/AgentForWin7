# A9-55 — 不选目录的对话：按需创建默认工作目录

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main（实现与修复分支保留在私有 staging）
Source Baseline: 0e78202398159b27803270a8b0e80ad09713cd82（A9-54 尖端，staging box/a9-54-fe2）
Phase-Gate: A9_55_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
Decision: ADR-0323（Accepted）
Revision: r1（2026-11-09 UTC，负责人回复“甲、批准”批准原稿）
```

- 来源：负责人 2026-11-08 提出的 7 条原则；同日对 D1～D5 回复“同意”（D1 我的文档、D2 维持拒绝、D3 置顶留 localStorage、D5 先 A9-54 后 A9-55）。
- 方向 Demo：本机 `outputs/a9-default-workdir-demo/index.html`（未入库，只作方向参考，不是合同）。
- 负责人 2026-11-09 回复“甲、批准”：批准本任务书 r1，授权按 §4 工作包实施；重命名按原稿本轮实现。

## 1. 交付结果

1. 新建对话时可选“不选目录，直接开始”。
2. 普通问答不创建文件夹。第一次调用读写文件或运行命令的工具前，才创建工作目录。
3. 目录名为“简短语义_月日”，例如 `告警日志分析_1109`；同名已存在或已被预留时追加 `_02`、`_03`。
4. 同一对话始终使用原目录；重启、切换、归档后恢复都继续使用。目录被人手动删除时，下次需要时按原名重建并提示。
5. 标题栏目录标签可查看路径、复制路径、在资源管理器中打开、重命名目录、改为关联已有目录。
6. 只在本对话的目录内读写；目录外路径照现行规则拒绝，提示改为关联已有目录。
7. 归档对话不删除目录及其中文件。

不包括：删除对话、单次授权访问目录外、默认目录根位置设置、跨对话共享默认目录、迁移已有对话。

## 2. 现状约束（基线 `0e782023…`）

| 事实 | 位置 | 对本任务的影响 |
|---|---|---|
| 对话必须属于工作区，`a9_sessions.workspace_path NOT NULL` | `src/state/src/a9-persistence.ts` 第 338～349 行 | 默认目录作为一个工作区，路径在首条消息时确定 |
| 注册表 `admit()` 与 Runtime 都对工作区做 `realpath`，要求目录存在 | `a9-workspace-registry.js` 第 103 行 | 需要“延迟创建根目录”的打开方式 |
| 工作区写锁存于 SQLite（`a9_workspace_locks`），不在目录内 | `a9-agent-runtime.js` 第 230 行 | 目录未创建时 Runtime 仍可持锁 |
| 工作区边界 fail-closed，`WORKSPACE_BOUNDARY_VIOLATION` | `src/workspace/src/safety.ts` 第 40～85 行 | 安全语义不变 |
| 自动标题来自首条消息，规范化后 40 字 | `a9-persistence.ts` 第 760 行 | 目录语义名复用该规范化，不额外调用模型 |
| 最多八个驻留 Runtime（ADR-0319） | `a9-workspace-registry.js` | 每个默认目录对话占一个驻留名额 |
| 带 `workspace_path` 的表：`a9_workspaces`、`a9_sessions`、`a9_workspace_conversation_state`、`a9_managed_processes`、`a9_workspace_locks` | `a9-persistence.ts` 建表语句 | 重命名与改关联只需改这些行；任务、运行、事件按对话标识关联，不需改 |
| WIN7_CONSTRAINTS 要求按传统 MAX_PATH 设计 | `docs/WIN7_CONSTRAINTS.md` 第 24 行 | 目录名设长度上限 |

## 3. 数据与接口合同

### 3.1 默认根与命名

- 默认根：`app.getPath('documents')` 下的 `Win7CodingAgent`，首次需要时创建。Win7 上为 `C:\Users\<用户>\Documents\Win7CodingAgent\`。
- 语义名：首条消息按 `normalizeConversationTitle(…, 40)` 规范化后，再做以下处理：
  1. 去掉 `< > : " / \ | ? *`，去掉结尾的点和空格；
  2. 按字符取前 12 个；
  3. 结果为空、或是 `CON`、`PRN`、`AUX`、`NUL`、`COM1`～`COM9`、`LPT1`～`LPT9`（不分大小写）时，改用“新任务”。
- 月日：预留时刻的本地日期，`MMDD` 四位。
- 判重：候选名既不能在磁盘上已存在（不分大小写），也不能已被任何 `a9_workspaces` 或 `a9_sessions` 行预留。依次试 `_02`～`_99`，用尽时返回 `A9_WORKDIR_NAME_EXHAUSTED`。
- 目录名最长 20 字符。默认根加目录名不超过约 70 字符，给目录内文件留出 MAX_PATH 余量。

### 3.2 对话与目录的绑定

- 选“不选目录”后，Renderer 只显示待发送的输入框，不创建对话。
- 用户发送首条消息时，主进程在一个动作内完成：预留路径、打开延迟根工作区、创建对话、提交首轮。
- 对话 `metadata_json.workdir` 记录 `{ version: 1, origin: 'auto' | 'linked', createdAt: ISO 或 null }`。合并写入，沿用 A9-54 修复后的 `saveSession()`。
- 不升级 `A9_SCHEMA_VERSION`，不新增表或列。

### 3.3 延迟根工作区

- 注册表新增延迟根打开方式：只对“默认根下、`origin=auto`、目录尚不存在”的路径适用。它对默认根做 `realpath`，再拼接目录名，不要求目录存在。
- Runtime 增加“确保根目录存在”：在文件、命令、Git 工具执行前，以及文件浏览与变更面板读取前调用。
  - 用非递归 `mkdir` 创建目录。目录已存在时，要求它的 `realpath` 等于预留路径，否则拒绝（`A9_WORKDIR_IDENTITY_CHANGED`），防止被联接点替换。
  - 首次创建时写 `workdir.createdAt`，并在对话中插入一条系统提示，显示完整路径。
  - 目录被手动删除后再次需要时，按原名重建，并提示“已重建”。
- 目录未创建时，文件浏览与变更面板显示为空，不报错。
- 默认根本身、或其上级目录已作为普通工作区驻留时，按 ADR-0319 的重叠规则拒绝，返回现有错误码。

### 3.4 管理动作（Schema IPC v9，沿用工作区目标绑定）

| 动作 | 行为 | 拒绝条件 |
|---|---|---|
| 查看目录信息 | 返回路径、`origin`、是否已创建 | 无 |
| 在资源管理器中打开 | 主进程打开目录 | 目录未创建 |
| 重命名目录 | 改磁盘目录名，并在一个事务内改写该工作区的 `workspace_path` 行 | 非 `origin=auto`；对话忙碌或有托管进程；新名非法或重名 |
| 改为关联已有目录 | 系统选择目录对话框；把该对话的 `workspace_path` 改到所选目录，`origin` 改为 `linked`；原默认目录与文件保留 | 对话忙碌或有托管进程；目标工作区未归档对话已达上限；目标与其他驻留工作区重叠 |

- 重命名与改关联都要求先关闭该对话所在工作区的 Runtime，完成后再打开。
- 重命名先改磁盘，再改数据库；数据库失败时把目录改回原名并返回错误。
- 复制路径在 Renderer 内完成，不经主进程。

### 3.5 Renderer

- 新建对话对话框增加“不选目录，直接开始”，放在已有工作区列表之前。
- 标题栏增加目录标签与菜单，内容见 §3.4；目录未创建时显示“未创建”，打开与重命名不可用。
- 目录外访问被拒绝时，在拒绝提示旁提供“关联已有目录…”。
- 侧栏行的工作区徽标：默认目录对话显示“默认”徽标和目录名。

## 4. 工作包

| 包 | 账号 | 员工 | 范围 |
|---|---|---|---|
| 后端 a9-55-be | czl | Codex CLI，GPT 6.1 Sol high | §3.1～§3.4：命名与判重、延迟根、确保根目录、管理动作、IPC 与 preload；对应测试 |
| 前端 a9-55-fe → a9-55-fe2 | czl | 原 Opus 包额度失败；负责人后继批准 Codex CLI，GPT 6.1 Sol high | §3.5；workbench 合同测试 |
| 后端审核 | czl | Claude Code，Opus 5.5 high，只读 | 只报 P0/P1 |
| 前端审核 | czl | 负责人后继选择 Claude Code，Opus 5.5 high，只读 | 只报 P0/P1；审核机 Shell G0 |

## 5. 必要验证

| 检查 | 范围 |
|---|---|
| 命名测试 | 非法字符、保留设备名、12 字截断、空标题、`_02` 判重（磁盘与数据库预留各一例）、`_99` 用尽 |
| 延迟根测试 | 普通问答后目录不存在；首个文件工具前创建；联接点替换被拒；手动删除后重建；重启后仍用原路径 |
| 管理动作测试 | 重命名成功与回滚；改关联后原目录保留；忙碌、重名、重叠、上限各一个拒绝例 |
| 安全测试 | 目录外路径仍为 `WORKSPACE_BOUNDARY_VIOLATION`；Renderer 只经 preload |
| Workbench 合同测试 | 新建对话选项、目录标签状态、拒绝提示中的关联入口 |
| 工作包门 | `wp.py` 的 G0、G1；`docs:check`；`git diff --check` |

原批准范围之外的界面交互检查结果见 §9.1；Win7 仍为 NOT_PERFORMED，按负责人后继批准准备分阶段计划。

## 6. 停止条件

- 需要升级数据库版本、新增依赖、原生模块或系统权限时，停止并报告。
- 需要放宽工作区边界或修改 ADR-0319 的重叠、驻留上限规则时，停止并报告。
- 发现任务、运行、事件等表也按 `workspace_path` 关联，使重命名需要改写 §2 之外的表时，停止并报告。
- 同类测试失败两轮未闭环时，先做最小诊断再继续。

## 7. 已知限制

- 每个默认目录对话占一个驻留 Runtime 名额，最多同时驻留八个；超出时沿用现有拒绝提示。
- 改关联后，对话历史里出现的旧路径不改写。
- 降级回 alpha.7 时，未创建目录的默认目录对话无法打开（旧版要求目录存在）；已创建的不受影响。

## 8. 裁决

重命名目录本轮实现，见 ADR-0323“已裁决”。

## 9. 结果记录

### 9.1 后端开发机交付与前端额度阻断（2026-11-09 UTC）

- 后端修复提交：`55cf7a9f9754f93b5512a069e9eede2d47691ebe`，位于 staging `box/a9-55-be2`，尚未合入 main。
- 独立复审 `a9-55-be2r`：P0 0、P1 0。Linux 开发机 G0：Shell 69 套件、1526 项通过、12 项跳过；State 404 项通过。Mac G1 九项 PASS。原失败与非阻断 P2 保留。
- 原始回执：本机 `outputs/wp/a9-55-be2/0020-mac-receipt.json`、`outputs/wp/a9-55-be2r/0013-review-evidence.json` 及各自 `collected/`。本轮恢复时直接核对了回执，未重跑这些检查。
- 前端 `a9-55-fe` 的 Opus 首次生成遇到五小时额度上限，运行 6.163 秒、退出码 1；工作区仍为上述后端提交，干净、零新增提交。恢复时间为 UTC `2026-11-09T10:40:00Z`（America/Los_Angeles 02:40）。日志已回收并核验 SHA，位于本机 `outputs/wp/a9-55-fe/collected/emp-a9-55-fe/`；临时目录已由作业清理。该包关闭为 FAILED，实例已回收，不记为产品 FAIL。
- 负责人明确选择“改用 GPT 6.1 Sol high 完成前端”。后继包为 `a9-55-fe2`，仅替换 §4 前端执行者，基线、交付范围、路径与停止条件不变；独立审核、G0、G1 继续执行。模型与档位以机上实际读回为准。
- 负责人已批准前后端通过后合入本地 main、推送 origin/main 与 Win7 开发通道验证；上机前先提交分阶段计划。该批准不替代正式门 A/B 或发布批准。
- 当前 main 为 `802d40a23cd28d69599c660e00b1bdce93ee52ee`，已经包含 A9-54 与测试临时目录修复；它与后端分支各有独立提交，不能直接快进。前端通过后整合时须保留两边提交和现有未提交文件。

### 9.1.1 前端实现与 Mac 真实产品交互（2026-11-09 UTC）

- `a9-55-fe2` 已由包装器提交为 `c88f607775d30bc9f8b8533fd11d03a72fed023d`，私有 staging `box/a9-55-fe2`；只改 Renderer 三文件与 workbench 合同测试，共四文件。作业退出 0、1010.063 秒，执行机已回收，临时目录已清理。
- 执行前机上配置读回 `gpt-6.1-sol` / `high`；员工自报实际模型与档位为 UNKNOWN。配置读回不冒充请求级模型证明。
- 员工 workbench 定向测试 73 PASS；batch2 690 PASS / 14 FAIL（监听及 spawn 的 EPERM），Shell 日常全集合因同类环境限制中止，汇总 UNKNOWN。环境归因须由新机 G0 核实，不能把未完成集合记为通过。原日志与准确提交清单见本机 `outputs/wp/a9-55-fe2/collected/`、`outputs/a9-55-wp/fe2-commit-manifest.json`。
- Mac 在准确提交的临时干净源码上先编译七模块，再用 Electron 22.3.27 加载真实 main/preload/IPC/Renderer/SQLite。八项交互 PASS：选项顺序、首发模式待选并保留消息、普通问答不建目录、未创建菜单、首文件工具创建目录、重命名保留文件并替换 scope、关联取消保留 scope、关联成功后禁止重命名。三张截图检查完成。结果见本机 `outputs/a9-55-wp/ui-r2/RESULT.json`；隔离数据和源码临时目录均已清理。
- 该交互使用临时 Documents 与回环模型夹具，外部模型请求为 0；不是打包、系统“我的文档”、原生目录选择器或 Win7 证据。r1 驱动仅等待 `completed` 而漏掉合法警告终态，留下 TIMEOUT；r2 按实际终态与文件副作用等待，产品字节未变，旧失败保留。
- 执行者改为 Codex 后，负责人明确选择“Opus high 审核，等额度恢复”。审核包 `a9-55-fe2r` 绑定上述准确提交，额度恢复时点 UTC 10:40 已过；完成审核后由包装器在审核机运行 Shell G0，再进行 Mac G1。

前端独立审核/G0/G1、A9-55 合入与公开推送、开发构建、Win7：NOT_PERFORMED。

### 9.1.2 Opus 审核与 P1 修复（2026-11-09 UTC）

`a9-55-fe2r` 的实际请求模型为 `claude-opus-5-5`，临时机配置读回 `effortLevel=high`；审核者自报档位 UNKNOWN。393.22 秒静态审核发现 P0 0 / P1 1：普通工作区没有默认目录元数据，却也被投影为 `workdir.origin=linked`，导致前端暴露目录迁移菜单并改变普通文件浏览路径。旧提交不能因测试通过而整合。

原提交 `c88f6077…` 的新审核机 G0 为 Shell 69 文件、1541 PASS / 12 跳过；Mac 工作包 G1 九项 PASS。员工 EPERM 失败没有在新机复现。审核机已回收、工作区与凭据未变。原审核的 Win7 约束和部分源码仅部分读取，完整原件读取为 NOT_VERIFIED；下一轮复审明确补齐。

主代理直接修复为 `3f443369d85c4c896f7e5c1b8455da7d4dd45f00`（父 `c88f6077…`），仅三文件：

- `getWorkdirInfo` 仅接受对话自身 `metadata.workdir.version=1` 且来源为 auto/linked；普通对话结构化拒绝为 `A9_WORKDIR_NOT_AUTO`。
- 普通对话快照省略 `workdir`，所以沿用原 Renderer/A8 浏览入口；默认目录关联后的版本化元数据仍保留，目录菜单继续可用。目录获取、打开、重命名、关联都在 picker/磁盘/数据库迁移前拒绝普通对话。
- 补普通快照、列表、真实 IPC 拒绝与 Renderer 隐藏回归。Mac 两文件 90/90 PASS；Electron 22 真实产品交互九项 PASS，含普通工作区无目录菜单。新结果见本机 `outputs/a9-55-wp/p1-fix-r2/`、`outputs/a9-55-wp/ui-r3/`。首轮 TMPDIR 的 `/var` 与 `/private/var` 别名失败保留，运行入口规范化后复验，断言未弱化；本轮源码和数据沙箱均已清理。

修复只推私有 staging `box/a9-55-mainfix`。新 Opus 定向复审 `a9-55-mainfixr` 及新提交 G0/G1 待完成；main 与公开 origin 尚未整合本次 A9-55。

### 9.1.3 main 调用修复与最终定向复审（2026-11-09 UTC）

`3f443369…` 的 Opus 复审关闭原 P1，但发现主代理修复遗漏了 main 的两个内部调用：普通工作区激活和启动恢复仍调用现在会拒绝普通对话的 `getWorkdirInfo()`。该提交 G0 为 1543 PASS / 12 跳过，仍因内容 P1 不可整合。约束原件本轮全文读取；原报告保留于本机 `outputs/a9-55-wp/mainfix-review-report.md`。

主代理修复提交 `933c0d504e9cbc300fe21b74aa5347689769b4d8`：main 两处改读 `getSnapshot({conversationPage:true}).workdir?.origin`；启动夹具实现真实的普通目录管理拒绝，并新增 main 选择路径和启动恢复回归。三文件定向集合 101/101 PASS，实际只修改 main 和启动测试两个文件。Mac Electron 22 十项真实产品交互 PASS，包含经真实 main 激活普通工作区；临时源码与数据已清理。回执在本机 `outputs/a9-55-wp/main-callers-fix/`、`outputs/a9-55-wp/ui-r4/`。

新机 `a9-55-mainfix2r` 的实际模型为 `claude-opus-5-5`；high 配置已读回，审核者自报实际档位 UNKNOWN。139.837 秒定向复审为 P0 0 / P1 0，两轮 P1 均关闭，未发现其余 `getWorkdirInfo` 产品调用遗漏。约束原件全文读取；静态复审不冒充测试。原报告在本机 `outputs/a9-55-wp/mainfix2-review-report.md`。该准确提交的审核机 G0 与 Mac G1 完成前，不整合 main。

### 9.2 Win7 分阶段计划准备边界

前端开发机检查完成后，再绑定准确整合源码、开发 ZIP 和驱动 SHA，提交上机计划；当前不创建候选、不连接目标机。

1. 开发机：单次开发构建；直接检查包身份、闭包和实际入口。未变化原生组件仅按精确字节分析继承适用性。
2. 目标前检：常设 r2 至 UTC `2026-11-28T00:00:00Z`；当前本地 `win7-dev.mjs` 与 `remote/common.ps1` 已使用该日期，本轮未修改。执行前核对准确工具字节、普通 agent 桌面、主机键、锁、账本与容量。
3. 最短真实链路：不选目录发消息、普通问答不建目录、首个文件工具按需创建、切换与重启继续原路径。随后覆盖重命名、关联取消/成功、目录外拒绝、身份变化提示及 A9-54 受影响侧栏。
4. 收尾：正常退出、SQLite 与进程/任务/锁检查；回收原始证据并逐文件核验大小/SHA。仅记录 DEV_CHANNEL，不签 Win7 PASS。

必须在上机计划中单列默认目录写入范围：产品默认根位于普通 agent 的“我的文档”下，可能不在 `C:\A9-DEV\`。常设授权禁止根外写入，通用的上机批准不自行扩大该范围；确认实际目标与批准例外后才能执行真实默认根场景。若使用开发根内替代 Documents，只能记替代条件证据，不能证明系统“我的文档”默认路径。

### 9.3 开发机交付与本地整合（2026-11-09 UTC）

最终实现与修复尖端为 `933c0d504e9cbc300fe21b74aa5347689769b4d8`；Opus 独立复审 P0 0 / P1 0。准确新提交的 Linux 审核机 G0：Shell 69 文件、1545 PASS / 12 跳过；Mac G1 九项 PASS，主代理直接修复的核验记录明确为 `DIRECT_PRIMARY_FIX_VALIDATION_NOT_EMPLOYEE_PACKAGE`，不冒充云端员工包。审核机已回收，前后工作区与凭据未变。

Mac 直接证据为定向测试 101/101 和 Electron 22 真实产品交互十项 PASS；Windows、系统 Documents、原生系统选择器与外部模型未由这些结果证明。后端 State 404/404 仍绑定 `55cf7a9f…`，后继未改 State 源码，沿用为 INHERITED_EVIDENCE。

负责人已批准的本地整合于合并提交 `35997fe6f19fd70253dd80f1ce507d5b8fd141b6` 完成。它保留 `802d40a…` 的测试临时目录修复和 A9-54 历史。原有 29 个未提交文件在合并前后逐一核 SHA，内容不变；暂存区合入前为空。合并后的产品与 State 源码与已审尖端逐项相同；交汇的 batch2/package-runtime 两文件 758/758 PASS，包含日常集合原省略的 12 项慢检查。临时源码和测试沙箱均已清理。

准确回执在本机 `outputs/a9-55-wp/primary-fix-g1.json`、`outputs/wp/a9-55-mainfix2r/`、`outputs/a9-55-wp/integration-before.json`、`outputs/a9-55-wp/merge-check/`。原额度失败、EPERM、P1 审核与驱动失败均保留，不改判。

已知非阻断限制保留：关联或重命名后旧 A8 视图与文件树可能需重新进入或刷新；被替换的默认目录在重启恢复阶段仍 fail-closed；待发送的新默认对话草稿切换后不保留；新建列表仍列出不能再次新建对话的默认目录工作区；其余 P2 原文见本机独审回报。本轮不扩展这些行为。

开发构建、公开 origin 推送、Win7 与正式门 A/B 的结果由后继记录给出；本节不把批准或开发机检查写成已上机。

### 9.4 单次开发构建（2026-11-09 UTC）

从干净提交 `4c9adbccbd3709c5b93bc38f5213035059e8d1c8` 单次构建。ZIP `6f3578f44ccf73a4db6738fca346466e4227974809f798e3b7fff0381799b603`，110579879 字节；manifest `2fce50f17ed705ed99b5d8081dab20cc53a95d67c74dc350a21a1d9d4067db3b`，3261 个清单文件全部校验通过。八个包内 JavaScript 入口可加载；九个受影响产品文件逐项匹配源码，Electron/helper/SQLite 输入与现有开发锁一致。构建和检查沙箱已清理。

包位于本机 `outputs/a9-55-wp/dev-1/Win7CodingAgent-0.3.0-alpha.2-win7-x64.zip`，完整回执同目录 `RESULT.json`。本包沿用 A9-32 alpha.2 开发 Profile，external_acceptance_eligible=false，无候选号。未生成新发布版本，不是正式验收或 Win7 PASS。

### 9.5 Win7 只读前检与准确窗口提案（待负责人确认）

既有 Win7 批准范围内的只读 status 已确认：DCCS-CHAIZL-PC / Win7 SP1 x64 build7601、普通桌面 Session1、开发通道进程/任务均为0、解包无UNKNOWN、holder `a946lanrx` inactive。严格主机键保持。只读前检回执为本机 `outputs/a9-55-wp/target-status.json`，未上传或执行产品。

开发根当前21265475529字节（21.265GB），已超过默认20000000000字节；C:剩余857399635968字节。目标写入当前为 BLOCKED，不能借历史容量例外继续。

请求一次60分钟开发窗口，run `3fd90770-47ee-4235-a0b1-54617c45447b`，复用已确认inactive的历史holder `a946lanrx`；状态变化即停止，不steal。仅本run、本窗口将开发根上限临时设为23000000000字节，最低剩余50000000000字节不变；按新ZIP、展开包、独立运行时及300MB余量计算，上界22180797150字节。不清理历史材料。

另请求产品仅在 `C:\Users\agent\Documents\Win7CodingAgent` 下创建名称前缀 `A9553fd90770` 的本run新目录、写入标记文件并重命名；既有内容不改，关联后保留该新目录。实际系统Documents或规范父路径不同则写入前停止。此项是验证真实默认根的准确例外，不放宽工作区边界。

阶段为：重新准入和同ZIP部署 → 普通问答不建目录/首文件工具创建/目录管理与普通工作区切换 → 正常退出和同profile恢复、A9-54受影响侧栏 → 原始证据回收与真实收尾。外部模型0次；回环夹具每次最多40、窗口总计80；最多2次开发尝试，总计60分钟内，结束前10分钟停止新场景。身份、完整性、安全、审计或未知生命周期立即停止。r2至2026-11-28的截止及其他边界保持，正式门A/B、发布和历史删除未授权。

准确提案为本机 `outputs/a9-55-wp/WIN7_PLAN.md` 与 `WIN7_PROPOSAL.json`。本次仅提交可审阅方案；窗口及两项例外未确认，Win7产品验证保持 NOT_PERFORMED。
