# A9-69 — alpha.8 集成整合与发布准备

```text
Status: COMPLETE
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: d12f840bb5fff8bcb83a87e220ae8b3e8d753c83
Target Version: 0.3.0-alpha.8
Candidate: WIN7-62
Phase-Gate: A9_69_WIN7_62_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 当前范围

负责人在 A9-68 Win7 开发级验证（`a968w`、`DEV_CHANNEL` 13/13 PASS）后要求“开始推动合并，发版”，并明确同意以下范围与路径（2026-11-16 UTC）：

1. 本地整合：从 `ci/windows-tests` 提取 Windows CI（`windows-2022` 运行 `runner`/`workspace`/`git-adapter`）与 `scripts/verify_integration.mjs` Win32 `npm-cli.js` 适配，保留 `main` 现有测试临时目录清理逻辑；合入 `staging/eng06/czl-workflow-r1` 的探针报告、收入 `A9_60` 任务书与 `t3_sidebar_ux_mapping_proposal_2026-11-08.md`；移除 `common.ps1` 与 `win7-dev.mjs` 中已过期的 A9-68 临时容量窗口块；`scripts/dashboard/` 保持未跟踪。
2. 发版身份：建立 `0.3.0-alpha.8` / `WIN7-62` 独立发版 Profile 与输入锁 `release/win7-product-v3/a9-alpha8-input-lock.json`（`A9-ALPHA8-INPUTS-D013-V26-MANAGED`），复用既有 Electron 22.3.27、SQLite 3.43.1/ABI 110 与 D-013 v26 managed 精确原生输入；保留既有 `A9-59` 开发锁 `A9-ALPHA8-DEVELOPER-INPUTS-D013-V26-MANAGED` 不改义（ADR-0333）。
3. 验收路径：沿用 ADR-0320 限定接受路径，包含全量本地检查（`npm test`、`npm run verify:tools`、`npm run verify:release`、`npm run docs:check`）、一轮增量只读独立审核（覆盖 `alpha.7` 后的增量变动，重点覆盖 `A9-Settings`、`A9-68` 与 `ci/windows-tests` 移植）、干净源码单次打包 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`、开发机包内实测，以及新 Win7 验证窗口材料准备。
4. 边界：新 Win7 实机窗口执行、负责人限定接受、更新 `README.md` 下载指向、`origin/main` 与标签推送、以及公开 GitHub Release 发布，均在本阶段输出准确源码与包哈希后逐次报负责人批准执行；未授权新增系统权限、修改产品权限边界或超预算消耗。

## 2. 顺序与 Gate

1. 完成本地整合修改与 `A9-ALPHA8-INPUTS-D013-V26-MANAGED` 身份登记。
2. 在开发机运行 `npm run verify:tools`、`npm run verify:release`、`npm run docs:check`、`npm test` 与 `scripts/win7-dev/test/channel.test.mjs`。
3. 对合并后的 `main` 增量进行一轮只读独立审核，闭环任一确认问题后形成干净本地提交。
4. 从干净提交构建 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`，核对 manifest、3283 文件闭包、原生输入与 Mac Electron 22 包内主链路。
5. 准备 `WIN7-62` 同包 Win7 `DEV_CHANNEL` 运行载荷与空间方案，提交负责人批准新目标窗口。
6. 获批后完成 Win7 `DEV_CHANNEL` 验证；取得负责人按 ADR-0333 / ADR-0320 的限定接受与推送发布授权后，更新 `README.md`、推送 `main` 与标签并回下载核验全部发布附件。

## 3. 已知保留边界

- 继承 `alpha.7`（`22b575cc…`）之后的全部开发机与局部 Win7 诊断：A9-54～A9-59、A9-61～A9-68 及 A9-Settings；各前置历史已知限制（如 `alpha.7` 与 WIN7-61 的已知限制、Win10 同包 `NOT_PERFORMED`、原生 125% DPI、完整 Review/batch2 `NOT_PERFORMED`、正式门 A/B `NOT_PERFORMED`）保持记录，不以开发机验证替代 Win7 实机证据。
- `outputs/a9-69-alpha8/` 用作本轮发布材料与核验汇总目录。

## 4. 增量独立审核与本地修复记录（2026-11-16 UTC）

- **首轮增量只读独立审核（`codex/gpt-6.1-sol`，`reasoningEffort: high`）**：覆盖 `453c54a5..HEAD` 及本地整合与 `alpha.8` 身份增量。结论：`P0=0`、`P1=2`、`P2=2`（开发机源码与内存探针）：
  1. `P1`：128K 上限仅放宽界面输入框，Runtime `submitTurn`（`slice(0, 8000)`）、Composer `saveDraft`（`32000` 截断）、IPC `QUEUE_UPDATE` 与 `WORKDIR_START`（`8000`）未统一且缺乏超限错误反馈。
  2. `P1`：`a9-product-ipc.js:228` 对 `a9.snapshot.get` 等待 `runtime.whenReady()`，阻塞重启对账期间打开即用。
  3. `P2`：`a9-workbench.js` 切回 `auto` 无法清除已保存 `thinkingEnabled` / `reasoningEffort`，且错误将非 DeepSeek 模型的显式 `false` 回填为 `auto`。
  4. `P2`：`providerValues()` 静默省略越界 `contextBudgetChars` / `composerMaxChars`，绕过配置校验。
- **二轮修复后复审**：首轮修复后首次复审（`codex/gpt-6.1-sol`）在确认原 4 项关闭的同时发现 2 项遗留：`P1`（调低 `composerMaxChars` 后旧队列项在 `take()` 先移出保存再被 `submitTurn` 拒绝导致丢失）与 `P2`（数字框 `validity.badInput=true` 且 `.value=''` 如 `'1e'` 时仍被静默省略）。
- **最终修复与二轮复审 PASS**：
  - `a9-composer-state.js` `take()` 在移出和落盘前先按 `maxText()` 校验并保留原队列项与密文；`a9-agent-runtime.js` `scheduleQueue()` 与 `updateQueue('resume')` 同步拦截并提示 `A9_PROMPT_TOO_LONG`。
  - `a9-workbench.js` `providerValues()` 显式捕获 `validity.badInput` 为非法哨兵交由 `applyProvider()` 与 Runtime 拒绝，同时保留主动留空语义。
  - 二次只读复审（`codex/gpt-6.1-sol`）结论：**PASS，P0=0、P1=0、P2=0**。
  - 新增/更新回归测试：`a9-68-checkpoint-recovery-pending.test.ts`（IPC `a9.snapshot.get` 非阻塞）、`a9-26-context-budget-config.test.ts`（128K 全链路、队列缩容保留、`null` 清除）、`a9-composer-state.test.ts`（缩容 `take()` 保留）、`a9-workbench-contract.test.ts`（`auto` 清除/回填、越界与 `badInput` 拒绝）。

## 5. 干净构建、开发机复验与 Win7 DEV_CHANNEL 结果（2026-11-16 UTC）

- **全量检查与干净打包（开发机）**：绑定提交 `585ea92b…`（未含未跟踪 `scripts/dashboard/`）。`npm run docs:check`（426/93）、`npm run verify:tools`、`channel.test.mjs`（46/46）、`npm test`（228 套件 / 4,378 项）、`npm run verify:release`（413 PASS / 0 FAIL / 16 `NOT_PERFORMED`）均 PASS。按 `A9-ALPHA8-INPUTS-D013-V26-MANAGED` 单次构建 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`（`111,281,027` 字节、ZIP SHA-256 `3e3970a9…`、manifest SHA-256 `a7ce32a8…`、`3,283` 受管文件、`source_dirty=false`、`external_acceptance_eligible=true`），开发机 `outputs/a9-69-alpha8/win7/local-verify.cjs` 取得 4/4 PASS。
- **Win7 `DEV_CHANNEL` 运行 `win762`（Win7 实机）**：负责人批准 60 分钟窗口与临时 `26 GB` 上限后，执行代理在 `DCCS-CHAIZL-PC`（build `7601`、普通用户 `agent`、Session `1`、Medium 完整性）对同字节 `WIN7-62` 包运行 `a969-win762-controller`，取得 **14/14 PASS**（`exit_code=0`、`normal_quit=true`、回环请求 `4` 次、外部模型请求 `0` 次）：
  1. `MANIFEST_IDENTITY` / `PACKAGE_SOURCE` / `PACKAGE_CLOSURE`（`3,283` 文件逐字节核验，仅入口 `package.json` 由驱动覆盖）。
  2. `SQLITE_NATIVE_LOAD`（`3.43.1`）与 `PRODUCT_MODULE_AND_ALPHA8_DESCRIPTOR_LOAD`（`0.3.0-alpha.8` / `WIN7-CODING-AGENT-A9-ALPHA8`）。
  3. `WIN7_DPAPI_AVAILABLE` / `WIN7_DPAPI_NO_PLAINTEXT_IN_SQLITE` / `WIN7_DPAPI_100K_AND_MULTIWORKSPACE_RESTORE`（真实 Win7 DPAPI 加密 100K 草稿与双中文工作区重启恢复）。
  4. `A968_IPC_SNAPSHOT_NONBLOCKING`（对账期间 `a9.snapshot.get` 耗时 `326 ms`）、`A968_RECOVERED_TURN_EXECUTES`、`A968_CONTINUE_TASK_FATAL_FAIL_CLOSED`。
  5. `A9_SETTINGS_128K_NO_TRUNCATION_AND_REJECTION`、`A9_SETTINGS_QUEUE_RETENTION_AND_AUTO_CLEAR`。
  6. `WIN7_CHROMIUM108_WORKBENCH_DOM`（真实 Chromium `108.0.5359.215` `BrowserWindow` 验证 `maxLength=128000`、`budgetPlaceholder=400000`、`composerPlaceholder=128000`、`thinkingOptions`/`effortOptions` 含 `auto`）。
- **收尾与后检**：`cleanup.ps1` 已删除 `runtime`、`sandbox`、`controller-profile`、`profile`。UTC `2026-11-16T05:00:48Z` 实机 `status` 核查 `root_bytes=24,565,966,508`、`free_bytes=855,244,808,192`、`lock.active=false`（`holder=a946lanrx`）、`processes=[]`、`tasks=[]`、`extraction_lifecycle_unknown=false`；临时 `26 GB` 容量例外已从 `common.ps1` 与 `win7-dev.mjs` 移除。汇总见本机 `outputs/a9-69-alpha8/win7/RESULT_FINAL.json`。
- **待裁决**：ADR-0333 / ADR-0320 限定接受、`README.md` 下载指向更新、`origin/main` 与 `v0.3.0-alpha.8-win7-62` 标签推送及公开 GitHub Release 发布均为 `NOT_PERFORMED`。

## 6. 负责人限定接受与发布授权（2026-11-16 UTC）

负责人选择选项甲，依据 ADR-0333 与 ADR-0320 将 `WIN7-62`（源码 `585ea92b…`、ZIP `3e3970a9…`、manifest `a7ce32a8…`）签发为 `A9_69_WIN7_62_PASS_WITH_KNOWN_LIMITS`，并授权更新 `README.md` 下载指向、推送 `origin/main` 与标签 `v0.3.0-alpha.8-win7-62`，以及上传 4 个附件并公开 GitHub Pre-release；接受记录保存在本机 `outputs/a9-69-alpha8/publish/OWNER_ACCEPTANCE.json`。

登记的已知限制：

1. 证据层级为开发机验证加 Win7 实机 `DEV_CHANNEL`（`win762` 14/14 PASS）；未执行双构建、正式冻结与门 A/B，不产生正式 Win7 PASS。
2. Win7 实机验证经候选外驱动与本地回环 SSE 完成（外部模型请求 `0` 次）；`C:\A9-DEV` 根当前已用约 `24.57 GB`（高于默认 `20 GB` 上限，后续新 Win7 上传需另行报批清理或扩容）。
3. 同包 Win10 验收机验证、原生 125% DPI 视觉验证、真实外部模型推理、完整 Review 后端及完整人工 GUI 旅程为 `NOT_PERFORMED`。
4. 沿用基线限制：会话内删除已绑定恢复目录后需重开工作区（A9-66/67 非阻断 P2）、深历史分页全量扫描及 200 MiB 单文件同步后态约 `829 ms`。

## 7. 同字节公开与回下载核验（2026-11-16 UTC）

- `origin/main` 快进到接受与 `README.md` 更新提交 `2bf536c4…`（`scripts/dashboard/` 保持未跟踪）。
- 标签 `v0.3.0-alpha.8-win7-62` 准确指向产品源码 `585ea92b…`；未重建产品。
- Pre-release 于 UTC `2026-11-16T06:52:07Z` 公开，release ID `446694106`，[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.8-win7-62)。
- 附件 4 个：`Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip` 111,281,027 字节、`WIN7-62-RELEASE-EVIDENCE.json` 2,836 字节、`ACCEPTANCE.md` 1,036 字节、`SHA256SUMS` 285 字节。
- 草稿与公开后各完成回下载核验；大小、本地 SHA-256 与 GitHub asset digest 三方一致，asset ID 保持不变（草稿首次下载 `ACCEPTANCE.md` 遇到一次 TLS EOF 中断，重下后四件全部校验通过）。核验记录保存在本机 `outputs/a9-69-alpha8/publish/DRAFT_ASSET_VERIFICATION.json` 与 `outputs/a9-69-alpha8/publish/PUBLICATION_VERIFICATION.json`。
