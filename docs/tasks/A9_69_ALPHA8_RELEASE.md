# A9-69 — alpha.8 集成整合与发布准备

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: d12f840bb5fff8bcb83a87e220ae8b3e8d753c83
Target Version: 0.3.0-alpha.8
Candidate: WIN7-62
Phase-Gate: A9_69_IMPLEMENTATION_AUTHORIZED
Win7-Validation: NOT_PERFORMED
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
4. 从干净提交构建 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`，核对 manifest、3265 文件闭包、原生输入与 Mac Electron 22 包内主链路。
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
