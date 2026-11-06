# A9-46 — 工作台最小增量与可读性（UX 建议 r2 ① 批）

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main
Source Baseline: 836a96fe…
Phase-Gate: A9_46_DEVELOPER_VERIFIED
Win7-Validation: DEV_CHANNEL
```

> 2026-11-04 负责人批准，使用 instabox 工作流实现（DRAFT 记录见文件尾部）。
> 依据：`outputs/ux-workmode-recommendation-r1/UX_WORKMODE_RECOMMENDATION_r2.md` §2.1。
> 范围：r2 ① 批 7 项（A–G）。全部为本地渲染层/小数据字段改动，不碰安全边界、权限、会话并发模型。
> 实现方式：instabox 工作包（`wp.py`），执行代理 = Box 上 Codex（`workspace-write`），Mac 整合 + 验证。
> 基线：main `836a96fe…`（准确提交实现前登记）；工作区未提交改动保留，不纳入工作包。

## 1. 任务清单（7 项，按依赖与风险排序）

### A. 对话切换收尾：每行原因提示 + "排队中的对话"分组

**目标**：让用户知道置灰对话行**为什么**不能切换，并提供"任务结束后可继续"的可见分组。

**现状（已实现）**：
- `a9-workbench.js:1820-1821` 对话行 `button.disabled = !canSwitch`
- `:1887` 目录底部 `已锁定：${reason}`
- `:1880` 新建按钮禁用
- 后端 `a9-agent-runtime.js:2689-2692` 暴露 `canSwitch/reason/maxActive`

**新增**：
1. 每行置灰时，`title` 与 `aria-label` 补原因（如"当前任务执行中，完成后可切换"）。
2. 新增可折叠"排队中的对话"分组：列出"任务结束后可继续"的对话（借用 Claude Needs-Input 的**真实含义**——等待用户处理，非排队执行）。

**约束**：纯渲染层，零运行时改动；不改变 `assertConversationSwitchAllowed` 语义。

---

### B. 轮次耗时标题（从已持久化事件推算）

**目标**：历史轮次显示"耗时 N 秒"，让翻历史时每轮成本可见。

**现状**：
- `turnStartAt`（`a9-workbench.js:1445`）仅当前进程实时条用（1483），不持久化。
- 轮次块只有 `createdAt/updatedAt`（1184,1381），**无终态耗时字段**。
- 重启后历史轮次**算不出耗时**。

**新增**：
1. 按已执行工作包约定，从同一轮次已持久化的开始/终态事件时间戳推算耗时；不增加字段或修改 schema。
2. 渲染层轮次块标题/元数据显示"耗时 N 秒"。

**约束**：不改后端与持久化格式；事件缺失、时间无效或倒序时不显示推测耗时。

---

### C. Git 状态动作文案（基于结构化投影）

**目标**：让用户扫一眼 Git 状态就知道"要不要做点什么"。

**现状（已修正 r1 误解）**：
- `a9-workbench.js:2933-2942` 已是结构化中文渲染：`branch · clean/「N 处变更」· 外部机制`
- 后端 `a9-agent-runtime.js:2878-2880` 返回 `projection`（`branch/clean/entries/externalMechanisms`）
- `src/git-adapter/src/trusted-projection.ts:31-40` 有 `ahead/behind/clean`

**新增**：基于 `projection` 字段补一句动作文案：
- clean → "工作区干净，无需审阅 Diff"（不能由本地 clean 推断远端最新）
- 有 entries → "有 N 处变更，可审阅 Diff"
- ahead/behind → "本地领先/落后 N 提交，考虑推送/拉取"

**约束**：零运行时改动，只改渲染层文案。

---

### D. 设置来源标注补全（Provider 全局说明）

**目标**：让用户知道 Provider 是**全局配置**，不是按工作区。

**现状（已修正 r1 误解）**：
- Provider 存 `dataRoot/a9-provider-config.v1.json`（`a9-agent-runtime.js:384-385`），**全局**。
- 按工作区保存的是权限模式与 Shell 设置。
- Shell 来源标注已实现：`a9-workbench.js:2017-2020`（`workspace_explicit/automatic`）。

**新增**：设置面板 Provider 区补一句"此配置全局共用，所有工作区生效"（来源标注）。

**约束**：零运行时改动。

---

### E. 会话正文内查找

**目标**：长对话正文支持查找。

**现状**：对话目录有标题搜索（Ctrl+K），检查器有文件内查找，**对话正文无查找**。

**新增**（`#conversation` 区）：
1. 查找框（可 Ctrl+F 唤起）。
2. 上一处 / 下一处导航。
3. 匹配数显示。
4. 关闭后焦点回到输入框。
5. 明确"仅搜索已加载记录"（避免把局部无匹配当成历史不存在）。

**借鉴**：Claude 桌面 FindInPage（C §6.1/§8.1）。

**约束**：原生 DOM 实现，Chromium 108 可行；不引入跨完整历史检索。

---

### F. 错误/空态文案规范（操作—原因—下一步）

**目标**：区分"尚未读取 / 读取失败 / 确实为空"三态。

**现状**：已有 `showGlobalError(message, recoveryLabel, recovery)`（`a9-workbench.js:168`）；部分面板（文件/改动/活动）三态混显。

**新增**：
1. 统一三态文案格式：操作 + 原因 + 下一步。
2. 尚未读取 → "尚未读取，点击刷新"；读取失败 → "读取失败：<原因>，可重试"；确实为空 → "没有 N 项"。

**约束**：零运行时改动，复用 `showGlobalError` 结构。

---

### G. 工具阶段文案（准备/正在/已读取）

**目标**：让"Agent 正在做什么"看得见，过程与结果分离。

**现状**：`timelineEntryLabel()`（`a9-workbench.js:687`）已有 `tool_start`/`tool_end`/`已拒绝`/`失败` 标签；运行中工具项显示已运行时长（817-845）。

**新增**：
1. 工具活动分阶段表达：准备 / 正在（含耗时）/ 已读取。
2. 失败/拒绝/停止/结果未确认：**另用不同表达**，不混入"已完成"。
3. 计划步骤不能因工具失败标成"完成"。

**约束**：文案 + class 映射；只投影后端已有事实，不虚构状态（ADR-0114 口径）。

---

## 2. 与现有任务的关系

| 任务 | 关系 |
|---|---|
| A9-41（UI 打磨） | A/C/D/G 是增量收尾，不重复已做部分 |
| A9-19（实时进度/布局） | B 基于其时间线；G 基于其工具活动 |
| A9-15（进度反馈） | G 是其深化 |
| 本任务 | 不打开 A9-32/40 等历史授权，不修改会话/工作区/审批模型 |

## 3. 必要验证

1. 使用真实工作台 HTML/CSS/JS + 显式桩数据制作自包含演示（标注"演示，非验收证据"、日期、基线）。
2. 开发机加载实际渲染入口，完成：A 置灰行原因、B 历史轮次耗时、C Git 动作文案、
   D Provider 来源、E 会话查找、F 三态文案、G 工具阶段。
3. 检查 1366×768、125% 等效可视区、800–1199px 抽屉布局及必要窄窗口边界。
4. 运行最窄工作台合同与行为测试。
5. 执行 docs:check 与 git diff --check。

开发机 Renderer 桩验证不证明真实 main/preload/IPC、打包运行时或目标机行为。
打包、Win10/Win7、正式门 A/B、真实模型与发布均为 NOT_PERFORMED。

## 4. 边界

- 不改变 `assertConversationSwitchAllowed`、`canLeaveWorkspace`、审批/提问绑定、写锁、CSP。
- 不引入依赖、外部字体、远程资源或新系统 API。
- B 复用既有持久化事件，不增加持久化字段或修改 schema。
- 不连接 Win10/Win7、不提交、不推送、不发布；本地编辑 + 必要构建 + 验证。

## 5. 2026-11-04 修复收口记录

负责人在复核反复修复的原因后指示继续，由主代理在当前 `main` 直接诊断、修复并验证，不再新增执行代理。

- 实际基线：`836a96fe5e499e919c3f34d23238c5384b26d49d`；原 dirty/untracked 保留，执行前状态与哈希保存在 `outputs/a9-46-workbench-r1/recovery-r1/`。
- 旧工作包基线：`79388ea0c2da4af73c01d2869dd32ebd7319aa5a`；只整合 `c29e4a5` / `df18284` 的三个渲染文件差异，不合并旧分支的无关历史。原 `/private/tmp/a9-46-fix3` 未提交修改另存 patch，原工作树保留。
- 共同根因：G0b 的 63 套件中 62 PASS，两个失败来自 VM 切片漏载 `OUTCOME_LABELS` / `errorMessage`；文案断言失配被首个异常遮挡。修复测试加载及符合 G 项的新文案断言，保留排序、去重、会话隔离和恢复检查。
- 产品修正：过程记录失败使用含原因与重试指引的固定文案，不回显原始异常；Git clean 只说明工作区干净，不推断远端同步。
- 最短真实链路：实际工作台 HTML/CSS/JS 经 Electron 22 的 preload/Schema IPC 加载，运行时数据显式使用夹具；检查 A–G、查找导航/焦点、窄窗和错误恢复。此证据不证明真实后端、产品 main、打包或 Win7。
- 后续检查：先编译依赖，再做定向工作台检查与受影响 Shell 回归、docs:check / diff 检查；历史失败保留。新 InstaBox G0 未执行，不以 Mac 本地结果补签。
- 授权边界：本地实现与必要检查；无新机器、模型请求、提交、推送、发布、目标 Win10/Win7 或正式门 A/B。

### 5.1 本地验证结果

2026-11-04，当前 `main` 基线 `836a96fe…` 加本轮未提交改动；开发机 macOS。

| 项目 | 直接结果与证据 |
|---|---|
| 原 22 个 G0 失败归因 | 18 个为 VM 缺少 MutationObserver 或绑定中断后的级联失败；2 个为 VM 切片漏依赖；2 个为运行中/历史错误文案断言。逐项清单在 `outputs/a9-46-workbench-r1/recovery-r1/RESULT.json`。不能归结为 G 项单一产品缺陷。 |
| 当前基线定向复现 | 编译依赖后 66 PASS / 2 FAIL；首失败保留在 `before-focused.log`，不改判。 |
| 修复后定向检查 | 3 套件 / 68 PASS / 0 FAIL，Node 20.17.0；`after-focused.log`。 |
| Shell 完整回归 | 63 套件 / 1442 PASS / 0 FAIL / 0 skipped，Node 20.17.0；`shell-regression.log`。包含日常集合移出的 12 项。不是全项目或 Win7 验收。 |
| 实际 Renderer / preload / Schema IPC | Electron 22.3.27 / Chromium 108.0.5359.215 / Node 16.17.1，8 组 PASS；运行时为显式内存夹具。最终 `electron-r6/RESULT.json` 绑定实际加载文件及驱动哈希，并确认 Electron 退出后的临时目录清理。 |
| A–G 交互 | 置灰原因与零切换派发、历史耗时重载及缺失/倒序隐藏、Git 事实文案、Provider 全局说明、Ctrl+F/上一处/下一处/新增历史自动更新/关闭焦点、不可信文本、失败保留历史与重试、工具终态及计划不自动完成均已检查。 |
| 视口 | `electron-r6` 直接确认 1366×768、1093×614（125% 等效可视区）、1079×540、900×650、800×650、780×640；请求与实际 CSS 视口宽高逐项相等。横向边界、查找入口与发送区、关闭查找后的焦点均 PASS。已检查动画结束后的 780px 截图。等效可视区不证明 Windows DPI 行为。 |
| 演示 | `outputs/a9-46-workbench-r1/recovery-r1/demo/workbench.html`，标注“演示，非验收证据”、日期与基线；完整产品渲染 JS/CSS 原字节 + 明确内存桩。 |
| 文档与差异 | docs:check、JS 语法与 git diff --check PASS；最终源码身份及附属产物在同目录清单。 |

原生夹具的 `electron-r1` 因错误的重试按钮选择器失败；`electron-r2` 因修改了会被终态事件覆盖的结果字段而未触发预期文本变化失败。
分别修正为实际 `#error-banner button` 和加载一条新的历史事实后，`electron-r3` 功能检查通过；均只修改夹具，不改产品判据，不延长等待。旧日志与结果保留。
进程退出后的盘点发现前三次原生夹具的 userData 又被 Electron 收尾写回，早先报告中的即时移除检查不足以证明无残留。
现改由 Node 父进程在 Electron 完全退出后统一 finally 清理，`electron-r4` 的 8 组功能检查及进程退出后清理均 PASS；父进程失败反例也确认无新残留。
前三次本轮临时目录及首轮定向失败的临时验证目录，均在确认进程结束、无占用后逐项清理；原始日志和首失败保留在证据目录。最终系统临时目录中 `win7-a9-46-ui-*` 残留为 0。

可复用的本地入口（使用上述已准备的 Electron 22 输入，不安装或下载）：

```sh
node src/shell/tests/product/a9-46-workbench-entry.cjs \
  --electron=/absolute/path/to/Electron.app/Contents/MacOS/Electron \
  --output=/absolute/new/evidence/directory
```

### 5.2 证据边界与后续

- 旧 InstaBox 三个工作包均已记录 `machineDeleted=true`；本轮未申请新机器或追加模型调用。
- 新源码的 InstaBox G0、产品 main/真实运行时、SQLite 持久化链路、打包、真实模型、Win10/Win7、正式门 A/B、提交/推送/发布均为 NOT_PERFORMED。
- 本地修复结果不是 `A9_46_DEVELOPER_VERIFIED` 或远端 G0 PASS。补齐原 InstaBox 流程需新的验证输入与纯计算机器，并解决 §4 的提交/推送授权边界；旧 G0 FAIL 仍保留。

### 5.3 中断恢复后的证据复核

2026-11-04，主代理直接完成，无新增执行代理、机器或模型请求。

- 恢复时，8 个源码清单条目及 35 个附属文件的 SHA-256 均与上轮清单一致。
- 复核发现 `electron-r4` 的三个实际视口与请求不符：1079×540 实际为 1079×592，800×650 实际为 860×650，780×640 实际为 860×640。旧夹具继承了产品窗口最小尺寸，且未断言请求与实际宽高相等；旧结果不能证明这三个请求尺寸。
- 仅修正开发夹具：创建窗口时明确设置测试最小尺寸为 1×1，保留原 preload 与安全策略；新增请求/实际宽高相等断言。产品窗口最小尺寸和产品源码未改。
- `electron-r5` 的 8 组检查及六个准确视口通过；其 780px 截图捕获了抽屉收起动画。夹具随后改为等待实际视口与动画状态，不靠延长固定等待。
- 最终 `electron-r6/RESULT.json` 的 8 组检查全部通过，六个准确视口通过，780px 稳态截图已核对。Electron 完全退出后临时目录清理通过，系统临时目录无新增残留。
- 原 `electron-r4`、`electron-r5` 报告及对应驱动副本保留。旧源码和附属清单保存在 `SOURCE_MANIFEST-before-viewport-fix.json`、`ARTIFACTS-before-viewport-fix.json`；当前清单及 `delivery.patch` 同步刷新。
- 本轮只改夹具与记录。产品字节未变，沿用 §5.1 已通过的定向和 Shell 回归，不重复运行完整回归。新 InstaBox G0 与 §5.2 的其余未执行项保持 NOT_PERFORMED。

### 5.4 继续执行 InstaBox G0

负责人再次指示“继续执行”。主代理沿用原“批准，使用 instabox 工作流实现”的 Box 包装提交与验证范围，执行纯计算 G0，无新增模型或子代理。

- 仅使用 czl 账号的一台新临时 Box，任务号 `a9-46-g0c`；沿用已就绪的登录快照。机器与输入前检在 `outputs/a9-46-workbench-r1/g0-r1/PREFLIGHT.json`。
- 当前源基线仍为 `836a96fe5e499e919c3f34d23238c5384b26d49d`。当前 origin 为 `https://github.com/allin2/AgentForWin7.git`；只读取得准确基线。私有 staging/main 仍为旧 `79388ea0…`，不作为当前源码替代。
- G0 输入仅含三个 Renderer 文件、工作台合同测试和开发机 Electron 夹具，共五个代码路径。补丁已在系统临时目录重放并逐一匹配 SHA-256，沙箱已删除。准确输入见同目录 `SOURCE_INPUTS.json`、`source.patch`、`PATCH_REPLAY.json`。
- Box 内创建一次验证输入提交，核对父提交、文件清单、文件哈希、树身份与干净工作区后再运行 G0。这个包装提交只存在临时 Box；不提交 Mac main，不推送，不改远端引用，不新增 GitHub 部署密钥。
- 使用既有 box-job 生命周期与标准 `npm run test:local -- --module shell`。先编译依赖，再运行 Shell lint/build/test。G0 的 TMPDIR 保持在该 job 的专用目录内，由 supervisor 在退出后统一清理。
- G0 预算上限一小时；首失败先回收日志并归因。身份、凭据、完整性或生命周期未知时停止下游，不盲目重试。
- 回收 stdout/stderr/result 并核对 SHA-256，复核测试后源码、凭据元数据、临时目录及远端引用。全部结果回收且生命周期明确后，按既有工作包流程回收这台准确实例。
- Box 输入的准确提交、树、原始 commit 对象、补丁与文件哈希保存在本机，支持机器回收后恢复。这不是 Mac 产品提交、私有推送、独立模型审核或正式 `wp receive`，不补签其结果。

本节是当前继续执行范围。§5.2 的“本轮无新机器”和新 G0 未执行状态保留为当时记录；本节直接结果在执行完成后补录。产品 main、真实后端、打包、Win10/Win7 与正式门 A/B 继续为 NOT_PERFORMED。

### 5.5 InstaBox G0 直接结果与开发机收口

2026-11-04，开发机证据。当前状态为 `A9_46_DEVELOPER_VERIFIED`，不含 Windows 或发布结论。

| 项目 | 直接结果与绑定 |
|---|---|
| 准确输入 | 基线 `836a96fe5e499e919c3f34d23238c5384b26d49d`；Box 临时提交 `2d0d59a360eb8e10314a38325cb6aab6da039cb2`，树 `a4da9d6518e1cd34327d243cc4763175d465ca96`。只含 §5.4 的五个代码路径，均与 Mac 当前文件 SHA-256 相同。源码完整身份和原始 commit 对象在 `g0-r1/SOURCE_IDENTITY.json`。 |
| 环境与指纹 | czl，`wp-a9-46-g0c`，Linux x86_64、Node 20.17.0、npm 10.8.2；13 个锁定输入的指纹与 Mac 相同，为 `062e3ff51c4665017441c77bdf58a556cafb56ecb70bf5ec55e4d7c24db6f6da`。 |
| 标准 Shell G0 | `npm run test:local -- --module shell`，七模块依赖构建、Shell lint/build/test 全部退出 0；63 套件、1430 PASS、12 skipped，共 1442 项。作业 `g0-a9-46-g0c`，46.376 秒。 |
| 12 项省略 | 属于日常集合排除的 `required fields reject absence and wrong types before comparison`，本次 Linux 为 NOT_PERFORMED；§5.1 的 Mac 完整回归已直接覆盖这 12 项，不能写成 Linux 1442 PASS。 |
| 原始回执 | `outputs/wp/a9-46-g0c/collected/` 的 fetch、stage、prep、fingerprint、g0 共五个作业，stdout/stderr 共十份日志逐一核对 SHA-256，五份退出及临时目录清理回执通过。 |
| 收尾 | G0 后源码提交、树和五文件哈希未变，工作区干净；凭据元数据未变，staging 引用未变，`/data/home/tmp` 名称清单与运行前相同。测试及缓存均在 supervisor 的 job 临时目录内，退出后清理通过。准确机器 `m_agq2oqtnnwvgc7a7t3kl7q73ui` 已回收并确认不存在。 |
| 成本与权限 | 新增一台临时计算机，零执行代理/产品模型请求，零新子代理。仅在该 Box 创建一次验证输入提交；Mac HEAD 不变，无 Mac 产品提交或远端推送。 |

摘要在 `outputs/a9-46-workbench-r1/g0-r1/RESULT.json`；原始工作包回执在 `outputs/wp/a9-46-g0c/`。
旧 `c29e4a5` 与 `df18284` 的 G0 FAIL 保留，不改判；本次新源码的 G0 为直接 PASS。
Mac 的 63 套件 / 1442 PASS 和最终 Electron 22 的 8 组 / 六个准确视口证据继续绑定未变代码字节。

当前仍为 NOT_PERFORMED：Mac 产品提交、私有/公开推送、独立模型审核、标准 `wp receive`、产品 main/真实后端、SQLite 真实持久化链路、打包、Win10/Win7、正式门 A/B 与发布。
本次完成开发机实现及 G0；不把纯计算包装提交记为完整 Git 交付工作流完成，也不把开发证据写成 Win7 可试用包。

### 5.6 本地真实产品链路补证

负责人在 G0 收口后指示“推进”，随后要求继续。主代理继续本地必要验证。
当前 main/HEAD 与 §5.5 相同；原 dirty/untracked 保留。
执行前清单在 `outputs/a9-46-workbench-r1/product-main-r1/PREFLIGHT.json`。

- 本轮补证检查显式内存夹具未覆盖的 main 启动、真实运行时事件和 SQLite 重启集成。
- 先编译既有七模块，再使用已准备的 Electron 22.3.27 darwin-arm64。
  经真实产品 main/preload/Schema IPC 完成只读轮次与应用重启。
- Provider 使用本机回环 HTTP/SSE 夹具，不访问外部模型、不使用个人密钥。
  工作区、用户数据和数据库均在系统临时目录，进程退出后由父进程 finally 清理。
- 已有 better-sqlite3 8.7.0 模块对应 Node 20。
  本轮仅用已有源码、node-gyp 10.1.0 与本机 Electron 22.3.27 头文件，
  在临时目录编译 darwin-arm64 ABI 110 测试副本。
  无新依赖或下载，不替换仓库 Node 模块，不进入 Windows 包或改写 D-014 的 Windows 证据。
- 原生测试输入、驱动和结果保存在 `outputs/a9-46-workbench-r1/product-main-r1/`。
  原 G0 与 Renderer 证据保持原字节；未变化产品检查按 §5.5 继承，不重复完整 Shell 回归。
- 只修复本轮夹具或已授权 A–G 的局部问题。
  身份、完整性、安全或未知生命周期失败时停止依赖动作；同类失败两次未解释时停止整批重试。
- 不提交、不推送、不连接 Win10/Win7，不打包、不签发正式门，不增加 Box 或执行代理。

#### 直接结果

2026-11-04（开发机本地日期），实际基线仍为 `836a96fe…` 加 A9-46 未提交改动。
产品代码未改；原 G0 输入中的五个代码文件 SHA-256 均保持一致。

| 项目 | 直接结果与证据 |
|---|---|
| 当前构建 | `npm run verify:quick` PASS；七模块按依赖顺序编译，Shell lint/build 通过。Node 20.17.0，总耗时 5823ms。 |
| 原生测试副本 | better-sqlite3 8.7.0 在隔离目录编译成功。Electron 22.3.27 实际加载 ABI 110，SQLite 3.43.1；仓库原 Node 模块 SHA-256 未变。构建沙箱已移除，`NATIVE_BUILD.json` 保留输入和输出。 |
| 真实产品入口 | `run-r4/RESULT.json` PASS。两个独立 Electron 进程共 11 组检查，真实 main、preload、Schema IPC、A9 runtime、SQLite 均参与；没有替换运行时或 IPC handler。每个进程记录实际加载的 215 个模块和产品入口 SHA-256。 |
| 首进程 | 从中文空格工作区发起只读任务。真实活动轮次下对话行置灰并说明原因，后端返回 `A9_CONVERSATION_BUSY`；任务完成后可切换。真实 read 工具卡精确显示 `已读取` / `success`，与同轮持久化 tool_end 绑定。 |
| 耗时与查找 | 首进程及完整重启后，耗时均匹配同轮 SQLite 开始/终态事件。正文查找均有三处匹配，关闭后焦点回输入框；范围提示仍为仅搜索已加载记录。 |
| 恢复与收尾 | 第二进程无工作区参数，恢复同一活动工作区、对话、Read Only、Provider 配置及历史。总共仅 3 次回环请求：1 probe、1 read 响应、1 final；重启未重放。SQLite integrity_check=ok，active task/turn/run 均为 0，只读工作区样本 SHA-256 未变。 |
| 清理 | 父进程等 Electron 完全退出后 finally 清理。成功运行和两次失败运行的临时目录均已移除；运行后未观察到本轮 Electron/驱动残留进程。 |

前两次失败均来自本轮开发夹具，原结果不改判。
`run-r1` 错把 macOS `/var` 与 `/private/var` 两个路径字符串视为不同工作区；改为创建沙箱后取得真实路径。
`run-r2` 错把持久化事件信封当成 snapshot 投影；改为读取真实 `payload.type` 与 `createdAt`。
同时核对现有耗时语义为向下取整。
`run-r3` 的 11 组检查通过；复核发现工具终态检查可能命中最终回复中的同名文案。
夹具改为精确核对同轮 read 工具卡及持久化 tool_end，最终 `run-r4` 再次 11 组通过。
以上仅修正夹具，未改产品、延长等待或弱化要求；失败日志与各版驱动均保留。

开发机 main/真实 runtime/SQLite 只读轮次与重启恢复现为直接 PASS。
原 §5.5 的未执行项是当时事实；本节只补齐上述本地链路。
真实外部模型、Windows DPAPI、Shell/原生 Runner、打包、Win10/Win7、正式门 A/B、
独立模型审核、标准 `wp receive`、Mac 提交、推送和发布仍为 NOT_PERFORMED。
本次没有新增 Box、子代理或外部模型费用。

### 5.7 局域网回收与 Win7 开发级补证（2026-11-05）

负责人指示“现在本机已回到局域网，请你继续推进任务”，随后对准确材料回复“批”。
此节为 §4、§5.6 不连接 Windows 限制的本次范围例外；不授权提交、推送、发布或正式门 A/B。

- 交付结果：补齐 A–G 的 Win7 开发级交互证据，以及真实产品 main/preload/Schema IPC/A9 runtime/SQLite 的只读轮次、完整重启与无重放。显式桩数据的 Git/三态/异常工具终态单独标注。
- 本机实际基线仍为 `main / 836a96fe5e499e919c3f34d23238c5384b26d49d` 加原 dirty/untracked；其他任务修改保留。Windows 包绑定构建机提交 `cf47a0fd218402b7da1b369bdbf477b5397bb127`，ZIP `dde21d574decb13949b6bb4ee90f401cc7286872aaaa50fc23fe302536edc2e3`，manifest `6b09111a24ab1df43c71a1fe13562c098e44690541b7d6b851aa1c49c3394d58`；不重绑为本机 HEAD 的干净提交。
- 只读回收：通过既有开发通道回收 `a946smoke3`、`a946smoke4` 的报告、普通用户 SID/Session、退出码与 stderr，两端大小和 SHA-256 一致。原 ZIP、manifest、A9 runtime 描述符直接核验一致；回收索引在 `outputs/a9-46-workbench-r1/win7-r1/RECOVERED.json`。旧报告仅证明启动、安全基线和活动工作区恢复；不补签 A–G 或 SQLite。
- 装配判断：包内 `a9-runtime.json` 已声明 ABI 110 的 A9 SQLite 根；旧 smoke 的 RC/in-memory 说明不能代表 A9 的加载结果。本轮直接检查实际 A9 绑定，不新增或重编原生模块。
- 改动仅为候选外驱动与运行材料。`product-drive.cjs` 复用本机真实产品驱动，`renderer-fixture.cjs` 复用原 A–G 夹具；未修改产品或冻结包。新驱动在本机 Electron 22.3.27 / Node 16.17.1 下完成真实产品 11 组和 Renderer 桩 8 组检查，临时目录已清理；新抽屉检查覆盖打开/关闭和焦点恢复。此结果仍只是 Mac 开发证据。
- 准确授权：`DCCS-CHAIZL-PC / 192.168.1.9 / Win7 SP1 x64 7601`，holder `a946lanrx`，普通用户 agent；run `a67fab44-9785-480e-a0cb-d213e5e1dbd1`，目录 `C:\A9-DEV\run\a67fab44`。从首次写入起 30 分钟、最多 2 次有界运行，最后 5 分钟不开始新场景；外部模型请求为 0，回环 SSE 预期 3 次。开发根保持 20 GB 上限、最低剩余 50 GB，不接管其他锁、不删除历史。
- 最短真实链路：原包只读复制到本 run 的 `p`，全 manifest 物理文件校验后，以包内 Electron 和 SQLite 通过产品入口完成只读 read、任务执行中切换拒绝、完成解锁、历史耗时/查找，再完整重启核验恢复与零重放。测试工作区、Provider 配置、数据库及进程级 TEMP/TMP 均限定在本 run；不读取既有用户凭据或 Provider 配置。
- 原生/产品字节不变，继承原 Mac/G0 开发结果；本轮 Windows 结果另行直接记录。身份、完整性、安全或生命周期未知时停止下游；普通夹具失败先保留原结果、定位后才在同范围和窗口内有界重试。

准确请求、驱动与配置哈希在 `outputs/a9-46-workbench-r1/win7-r1/ready/REQUEST.json`，批准记录在同目录 `APPROVAL.json`；运行流水与实际窗口在 `win7-r1/TARGET_RUN.json`。
本节登记时目标补证正在执行，不预签结果。正式门 A/B、真实外部模型、发布、Mac 提交与推送仍为 NOT_PERFORMED。

#### 首次运行与同窗口第二次运行

- 首次写入窗口为 `2026-11-05T17:58:56.530Z` 至 `18:28:56.530Z`。第一次运行的普通用户 SID 尾号为 1001，Session 为 1。
- 首次运行未进入候选外 GUI 驱动。`resources/app` 使 Windows 包内 Electron 优先启动默认产品，显式传入的脚本未执行；65 秒原有上限到期，回环请求为 0。父驱动原始结果与任务双流保留，`TARGET_RUN.json` 为 FAIL，不改判。
- 失败后的两次只读状态均确认根内进程 0、任务 0、解包生命周期已知、锁 token 未激活。没有扩大停止范围或接管锁。
- 第二次运行仍在原窗口、原 run 根与两次预算内。只把锁定 Electron ZIP 的 73 个运行时文件复制到该 run 的 `r`，不放置会遮蔽显式脚本的 `resources/app`。73 文件共 230,673,075 字节，逐一与锁定 ZIP 及原包 manifest 相同；不安装或引入新运行时。候选外驱动随后加载未改的包内产品 main，产品/SQLite 仍来自 `p`。
- 新配置、启动器、运行时文件清单与准备脚本保存在 `win7-r1/ready-r2/`；实际驱动字节不变。第二次运行只改启动装配，不延长等待、不减少断言，也不重建产品。其直接结果另行补录。

#### 第二次运行直接结果

本轮 Win7 开发级补证完成，类别为 `DEV_CHANNEL`。
任务阶段保持 `A9_46_DEVELOPER_VERIFIED`；不签发正式 Win7 PASS。
摘要为 `outputs/a9-46-workbench-r1/win7-r1/RESULT.json`。
原始产品报告为 `outputs/win7-dev/a9-46-a67fab44-r2/RESULT.json`。

| 项目 | 直接结果与证据边界 |
|---|---|
| 包与运行时 | 原 ZIP、manifest 和关键产品文件在运行后仍匹配原 SHA-256。产品副本启动前校验 3,257 个 manifest 文件条目。候选外运行时的 73 个文件与锁定 Electron ZIP 及包内文件逐一匹配。原包未修改，未重编产品或原生模块。 |
| 实际身份 | DCCS-CHAIZL-PC、Win7 SP1 x64 7601；普通用户 agent，SID `S-1-5-21-1708701742-428676696-1831205153-1001`，Session 1。任务退出码 0；身份与双流保存在 `outputs/win7-dev/runs/a67fab44-a946r2/`。 |
| 真实产品链路 | 候选外 Electron 加载未改的包内 main/preload/Schema IPC/A9 runtime/SQLite。两个独立产品进程共 11 组检查通过。实际 Electron 22.3.27、Node 16.17.1、Chromium 108.0.5359.215、ABI 110；加载的 Windows SQLite 绑定 SHA 为 `7138aa23…`，SQLite 3.43.1。此链路不是默认打包启动器的再次验收；默认启动器仍以已回收的 smoke3/4 为独立证据。 |
| A/B/E/G 真实事实 | 活动轮次下对话行置灰并说明原因，后端返回 `A9_CONVERSATION_BUSY`；完成后可切换。耗时与同轮 SQLite 事件一致，完整重启后保持一致。本次真实轮次不足 1 秒，按现行取整规则显示 0 秒；非零及缺失/倒序反例由桩夹具补充。正文查找为 3 处匹配，关闭后焦点回输入框。read 工具卡精确匹配同轮持久化 tool_end，显示“已读取”。 |
| SQLite 与重启 | integrity_check=ok，活动 task/turn/run 均为 0；Read Only 工作区样本字节未变。无工作区参数重启恢复同一工作区、对话、模式和历史；重启未重放请求。 |
| A–G 桩交互 | 同一 Win7/Electron 上 8 组通过，使用实际包内 Renderer/preload/Schema IPC 加显式内存运行时。包括等待分组、耗时恢复与异常时间隐藏、Git 结构化文案、Provider 全局说明、Ctrl+F/双向导航/新增历史/焦点、三态重试和历史保留、工具成功/拒绝/失败/停止/未确认区分。C 的真实 Git、F 的真实后端失败、G 的真实异常终态未执行，不能由桩升级。 |
| 视口与 DPI | 六个实际 CSS 视口逐项等于请求：1366×768、1093×614、1079×540、900×650、800×650、780×640。800–1199px 抽屉打开/关闭和焦点恢复通过。1366 与 780 截图已人工核对。当前显示器 1366×768、工作区 1366×728、scaleFactor=1；1093×614 是 125% 等效可视区，未修改或验证 Windows 原生 125% DPI。 |
| 请求与收尾 | 仅 3 次本机回环 SSE 请求，分别为 probe/read/final；外部模型为 0。后检根内进程 0、任务 0、锁 token 未激活，开发根 11,585,641,458 字节。父进程退出后测试临时目录已移除，最终只读确认本 run 的 `w/tmp` 条目为 0。 |
| 回收与窗口 | 9 个产品报告、日志和截图均经开发通道大小/SHA 校验，Mac 再次逐一复算一致。窗口开始 17:58:56.530Z，产品与回收后检于 18:09:51.331Z 完成，早于 18:28:56.530Z 截止；两次预算已用完，不再开始新场景。 |

旧首轮 FAIL、旧 Mac/G0 证据和此前 smoke 报告保留。
本轮只新增候选外材料及任务/状态记录，Mac HEAD 与产品字节不变。
运行目录的 `p/r/t/e` 保留为本次可复核输入与证据，测试临时数据已清除。
正式门 A/B、原生 125% Windows DPI、真实外部模型、真实 Git/后端异常终态、
Win10 A–G 交互、Mac 提交、推送和发布仍为 NOT_PERFORMED。

### 5.8 GPT 重置模式：真实 Git 与异常链路本地补证准备（2026-11-05）

负责人要求主对话作为经理推进，只保留必要性与投入决策，并确认 GPT 重置模式；
额度约在确认后 20 小时重置。确认记录为 UTC `2026-11-06T00:40:31Z`，
近似重置时间为 `2026-11-06T20:40:31Z`，不声称这是供应商精确时间。

- 范围：沿用 A9-46，准备 C 的真实 Git 与 F/G 的后端失败、工具异常终态的候选外驱动；
  在本地真实产品 main/preload/Schema IPC/A9 runtime/SQLite 上执行最窄有效验证，
  生成可复核的 Win7 输入材料与剩余限制。不将显式桩升级为真实后端证据。
- 基线：main `836a96fe5e499e919c3f34d23238c5384b26d49d` 加现有 dirty/untracked。
  保留所有其他任务修改及旧输入、FAIL 与 PASS。优先复用现有 Electron 22.3.27、ABI 110 SQLite 和原产品字节；
  本轮不新增依赖、不重编原生模块、不顺带重构产品。
- 最短真实链路：临时中文空格工作区内准备真实 Git 状态，经产品 IPC 读取并核对动作文案；
  用回环 Provider 请求受控失败工具，核对 UI 与同轮 SQLite 事件/终态，再验证正常退出、恢复与零重放。
  控制输入允许使用回环响应或可恢复的文件条件；不替换产品运行时、IPC handler 或状态层。
- 工具与材料：新增候选外目录 `outputs/a9-46-workbench-r1/negative-r1/`，旧驱动不覆盖。
  新驱动先检查 Electron/Node16 能力，测试沙箱只建于系统临时目录，finally 在真实子进程退出后删除；
  证据明确复制到候选外目录，原沙箱不保留。
- 停止条件：身份、完整性、安全或生命周期未知时停止依赖动作；同类失败连续两轮未解释时先最小诊断。
  不通过降低断言、延长等待或虚构故障结果取得通过。无法安全触发的终态列为 NOT_PERFORMED。
- 边界：本次仅本地准备和定向验证，不复用已关闭 Win7 时间窗口；
  Win7 目标运行、原生 125% DPI 系统修改、正式门 A/B、提交、推送与发布均未授权。
  外部模型请求为 0；经理与员工的算力消耗另按模式记录，不计入产品模型请求。
- 调度：本轮最多一名员工；本地 REA 对话不能将员工改绑至另一项目，
  材料导航由经理接手，员工限只读分析/验证，所有文件由经理整合。
  模式记录沿用 `/Users/qlyf/.agents/dispatch-modes/state/c91155c7-7e8b-4ba7-8321-c29c684f2225.md`。

本节登记时本地补证正在准备，不预签结果；Win7 证据仍以 §5.7 为准。

#### 本地直接结果与局部修复

本轮 Mac 开发级补证已完成。准确结果在
`outputs/a9-46-workbench-r1/negative-r1/RESULT.json`。
当前源码仍是 main `836a96fe…` 加 dirty；没有提交或改绑旧包。

真实产品复现了两处工具卡误报。`read` 的 ENOENT 异常持久化为 JSON `result.error`，
原 UI 显示“已读取”。取消 `ask_user` 的事件包含顶层 `cancelled:true`，
原 UI 显示“执行成功”。完整重启后仍会恢复错误标签。
修复仅增加已有事件格式的识别，不改 Core、IPC、Schema、持久化或权限模型。
结果截断到 1000 字符时仍识别标准异常信封；成功读取的用户文本含 error/cancelled 字样时保持成功。

| 直接检查 | Mac 开发机结果与证据 |
|---|---|
| 当前依赖与合同 | 七模块按依赖顺序编译，Shell lint/build 通过；定向工作台合同 49/49 通过。新增反例在修复前真实失败。日志为 `negative-r1/targeted-tests.log`。 |
| C 真实 Git | 临时中文空格仓库经实际 Git Adapter 与 IPC 返回 clean、dirty、ahead=1/behind=1；UI 文案与投影一致。分歧引用只在临时仓库建立，未 fetch/push 或更改项目仓库。 |
| F 真实后端失败 | 在 Files 页以真实 desktop session 读取空目录；暂移目录触发 PATH_NOT_DIRECTORY，恢复后点击“重试”返回空态。没有替换 IPC handler 或运行时。未读取初态仍仅有原夹具/静态证据。 |
| G 真实终态 | 读取不存在文件显示“失败”；问询取消显示“已停止”，同批后续 read 未执行；含 error 字样的正常文件仍显示“已读取”。 |
| G 真实拒绝 | 仅临时 profile 切到 Full Access，请求对临时样本的永久删除后只点击“拒绝”。真实事件 `denied:true/sideEffects:0`，无 tool_start，文件 SHA 未变，工具卡显示“已拒绝”。随后恢复 Read Only。没有执行删除或 Shell。 |
| 重启与 SQLite | 两个独立 Electron 22.3.27 / Node16.17.1 / ABI110 进程共 9 组通过。四类工具卡在完整重启后保持正确；SQLite 3.43.1 integrity_check=ok，active task/turn/run 均为 0，重启未增加请求。SQLite 副本单独回收到 `run-after-r1/a9-state.db`。 |
| 请求与收尾 | 共 8 次回环请求，外部模型为 0。驱动、Electron 已退出；`win7-a9-46-negative-*` 沙箱无残留。定向反例失败后由测试入口遗留的本轮空目录已删除，见 `TEST_CLEANUP.json`。 |

首次本地驱动在进入文件面板前失败。smoke 参数只选工作区，没有创建 explorer session。
驱动改为调用真实 `session.create` 并打开 Files 页；未修改产品来迁就夹具。
`run-before-r1` 保留该失败，`run-before-r2` 保留两处产品误报，
`run-after-r1` 保存修复后的直接 PASS。所有运行的测试沙箱均已清理。

产品只修改 `renderer/a9-workbench.js`，测试只补充现有工作台合同反例。
本轮精确增量为 `negative-r1/delivery.patch`；原源码 SHA 与修改后 SHA 在结果中。
原 Win7 ZIP、输入与 §5.7 的报告未变；旧 PASS 不升级为本次修复的 Windows 结果。
新增产品字节需要新 Windows 开发 ZIP，当前 `windowsExecutableInputsReady=false`。
范围提交、构建与新目标窗口建议在 `negative-r1/NEXT_STEP.md`，尚未执行。
原生 125% DPI 系统修改、真实 Shell 停止、未知生命周期终态、外部模型、
正式门 A/B、提交、推送与发布保持 NOT_PERFORMED。

### 5.9 新开发包与 Win7 真实异常链路窗口（2026-11-06 UTC）

负责人对 `negative-r1/NEXT_STEP.md` 范围回复“批准”。
本节取代 §5.8 相应的不提交、不构建、不连接目标机限制。
不改变历史输入、结果或冻结候选。

- 交付结果：提交 A9-46 相关源码，形成新源码绑定的 Windows 开发 ZIP，
  在 Win7 普通用户下验证 C/F/G 的真实链路、完整重启与零重放。
- 基线：main `836a96fe…` 加已验证 A9-46 字节。只暂存本任务的代码、测试、任务书和状态段落；
  其他任务 dirty/untracked 保留。提交后登记准确 source，干净隔离目录构建。
- 构建影响：复用既有跨平台装配器和锁定的 Windows Electron、Runner、SQLite 工件。
  原生字节不变，不重编原生模块；新 ZIP 自行校验来源、闭包和包内实际加载。
- 目标：DCCS-CHAIZL-PC / 192.168.1.9 / Win7 SP1 x64 7601，普通用户 agent。
  只经局域网直连，身份、严格主机键、活动桌面、锁和容量均实际核对。
- 预算：从实际首次目标写入起 30 分钟，最多两次有界运行；最后五分钟不开始新场景。
  外部模型请求 0；开发根上限 20 GB、最低剩余磁盘 50 GB。
- 最短链路：新包完整性 → 真实 main/preload/IPC/runtime/SQLite/Git → Git 状态文案 →
  目录读取失败与重试 → 工具读取失败、问询取消、审批拒绝零执行 → 正常退出 → 重启恢复无重放。
  仅使用本 run 的隔离 workspace/profile/数据库；拒绝场景只点击拒绝，不批准删除。
- 重试与停止：普通夹具同范围局部修复以新版本记录；同类两轮仍未解释则最小诊断。
  身份、完整性、安全、审计或未知生命周期失败立即停止依赖动作。
- 边界：不接管其他锁、不删除历史，不改系统 DPI、不新增机器，
  不推送、不发布、不签正式门 A/B。真实 Shell 停止和未知终态仍不由问询取消代替。

准确输入、批准记录与后续结果在 `outputs/a9-46-workbench-r1/win7-negative-r1/`。
本节登记时尚未开始目标窗口，不预签结果。

#### 范围提交与新包准备

本地范围提交为 `bdb28e402ab5a9e7fd38d55e12d389f5edb51d8e`。
共 9 个 A9-46 文件；STATUS 和 STATUS_LOG 只提交本任务段落。
其余 24 个原工作区文件的字节均保留，暂存区已清空。

构建宿主为 Mac，使用现有跨平台装配器和原锁定 Windows 工件。
新 ZIP 为 `9022d25d3c6aa2e1e34aaea71660cc52ce40b2bd5d40ec4b63a27089c81adfdc`，
110,541,461 字节；manifest 为 `210ddb3e464025e3f6e1484b490328012ed2d2a077249e6b8863659b77d82663`。
3,257 个清单文件和 8 个 JavaScript 模块入口校验通过。
源码来自干净隔离目录，`source_dirty=false`，开发 Profile 保持 `external_acceptance_eligible=false`。
历史 alpha.2 标签只代表既有开发打包 Profile，不是新的正式版本或候选号。

与原 §5.7 包逐项比较，仅工作台 JS 和两份追溯元数据变化。
Electron、Runner、SQLite 及其他运行时文件均保持相同字节。
首次构建因旧隔离清单漏掉当前打包器的两个静态依赖而停止。
只补齐隔离材料后重新构建成功；两次构建输入和日志保留，未改产品来迁就构建。
两个构建沙箱均由 finally 清理，主工作区未改。

候选外新驱动在本地真实产品链路完成 9 组检查，并通过 Electron Node16 语法检查。
Win7 只读预检直接核对主机、7601、agent Session 1、空闲原 holder 和容量。
Git 来自现有 `C:\acceptance\mvp_mingit\cmd\git.exe`，2.46.2.windows.1，
SHA `02ed6549…`；没有安装或引入新依赖。

本轮 run 为 `a3ac3882-f6ff-42a8-a6b8-f6b3fae9088e`，
根为 `C:\A9-DEV\run\a3ac3882`，holder 复用本会话的空闲 `a946lanrx`。
预算保守地从首次目标写入调用前 UTC `2026-11-06T01:31:06.297Z` 开始，
截止 UTC `02:01:06.297Z`。准确 REQUEST、APPROVAL、驱动与通道哈希均在本轮证据目录。
此段只登记执行输入，不预签目标结果。

#### Win7 直接结果与窗口关闭

本轮完成，结果为 Win7 `DEV_CHANNEL` 开发级 PASS。
阶段保持 `A9_46_DEVELOPER_VERIFIED`，不签正式 Win7 PASS。
摘要为 `outputs/a9-46-workbench-r1/win7-negative-r1/RESULT.json`。
原始产品报告为 `outputs/win7-dev/a9-46-negative-a3ac3882/RESULT.json`。

| 项目 | 直接结果与边界 |
|---|---|
| 输入与身份 | source `bdb28e40…`、ZIP `9022d25d…`、manifest `210ddb3e…`。DCCS-CHAIZL-PC / 7601，普通用户 agent，SID 尾号 1001、Session 1，退出码 0。准确身份和双流在 `outputs/win7-dev/runs/a3ac3882-negative/`。 |
| 实际产品入口 | 候选外锁定 Electron 加载新包内真实 main/preload/Schema IPC/A9 runtime/Git/SQLite。Electron 22.3.27、Node 16.17.1、Chromium 108、ABI 110、SQLite 3.43.1。3257 个包内 manifest 条目在产品执行前校验。该链路不代替默认打包启动器的再次验收。 |
| C 真实 Git | 通过现有 Git 2.46.2 在本 run 临时仓库生成 clean、dirty、ahead=1/behind=1。真实投影与工作台文案一致。无 fetch/push，未修改现用项目或 Git 全局配置。 |
| F 真实文件失败 | 真实目录列表从空态到 PATH_NOT_DIRECTORY；恢复目录后点击“重试”返回空态。没有替换 Runtime 或 IPC。尚未读取初态仍未增加真实启动观察。 |
| G 真实失败 | 不存在文件产生持久化 ENOENT 工具结果，工具卡显示“失败”。正常文件内容含 error/cancelled 字样时仍显示“已读取”。 |
| G 真实取消 | 点击真实“取消本次问询”，同轮持久化 cancelled，工具卡显示“已停止”，轮次取消；同批后续 read 未执行。此项不是 Shell 停止。 |
| G 真实拒绝 | 仅对本 run 临时样本发起绑定审批，并只点击“拒绝”。事件 `denied:true/sideEffects:0`，没有 tool_start，样本 SHA 未变，工具卡显示“已拒绝”。完成后恢复 Read Only。 |
| 恢复与 SQLite | 两个独立产品进程共 9 组通过。完整重启后四类工具卡保持正确；SQLite integrity_check=ok，active task/turn/run 均为 0，重启未重放请求。原始 SQLite 副本已回收并复算 SHA。 |
| 请求与收尾 | 8 次回环请求，外部模型 0。6 个报告、日志和数据库经通道秘密扫描、大小/SHA 校验，Mac 再次逐一复算一致。后检进程 0、任务 0、锁 inactive、无解包未知；开发根 12,473,831,858 字节，低于 20 GB。 |
| 最后只读核对 | 新 ZIP、manifest、三份驱动输入与 73 个运行时文件共 78 项哈希不变；本 run `w/tmp` 条目为 0。测试数据由 finally 清理，产品、证据和历史输入保留；未执行 stop 或 close。 |
| 窗口 | 只用 1 次运行，第二次未使用。产品执行与回收后检在 UTC `01:39:36.851Z` 完成，距保守窗口开始 510.554 秒，早于 UTC `02:01:06.297Z` 截止。最后只读核对完成后主动关闭窗口，不再开始新场景。 |

原始驱动报告的 `sourceDirty:true` 是沿用旧本地夹具的保守常量。
该字段没有读取包的 Git 状态，不能用于判断新包源码是否干净。
本轮源码身份以干净隔离构建记录和新包 manifest 的 `source_dirty=false` 为准；
准确 source、ZIP 与文件哈希均直接核对。原报告保留，不修改该字段。

本轮没有新增员工调用，沿用前一阶段 Terra 的只读分析。
原 Win7 证据和失败记录不变；新结果只绑定本轮源码、包、run 和普通身份。
原生 125% Windows DPI、真实 Shell 停止、未知生命周期终态、真实外部模型、
同包 Win10 运行、正式门 A/B、推送和发布仍为 NOT_PERFORMED。
