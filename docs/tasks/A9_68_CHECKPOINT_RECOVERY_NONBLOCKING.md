# A9-68 — checkpoint 恢复对账非阻塞（B 方案：打开即用）

```text
Status: DEVELOPER_VERIFIED
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: main（本地整合）
Source Baseline: 453c54a5（私有 staging base/a9-68-453c54a5）
Phase-Gate: A9_68_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

## 1. 范围

负责人选定 B 方案：会话打开立即出 UI；checkpoint 恢复对账后台化；对账完成前高风险动作返回结构化「恢复校验进行中」提示，不无限等待；不弱化 `quick_check`、checkpoint 完整性、崩溃恢复判定等安全校验。

本任务只改 `src/shell/product/a9-agent-runtime.js` 的 checkpoint 恢复门语义，并新增/调整对应产品测试。不改 `a9-persistence.ts`、`sqlite-event-ledger.ts` 的校验逻辑。

## 2. 现状与改动点

| # | 位置 | 现状 | B 改为 |
|---|---|---|---|
| 1 | `a9-agent-runtime.js` `submitTurn` 首行 `if (checkpointRecoveryPending) await checkpointRecoveryReady;` | 有中断 turn 时，用户打开会话后首次发送会被对账无限 `await` 阻塞 | 打开后 UI 立即可用；对账后台跑；对账完成前 `submitTurn` 返回 `{ ok:false, error:{ code:'A9_CHECKPOINT_RECOVERY_PENDING', ... } }`，不无限等；对账失败仍置 `checkpointRecoveryFatal` fail-closed |
| 2 | 同文件其余 `if (checkpointRecoveryPending) await checkpointRecoveryReady;`（`undo`/`diff`/`getTurnReview`/`continuation` 等入口） | 同上无限等待 | 同 1：改为结构化 PENDING 提示，不无限等；`checkpointRecoveryFatal` 保持 fail-closed |
| 3 | 打开路径 `SNAPSHOT_GET` | 已走分页 + 异步 Provider 恢复（`conversationPage:true`），不阻塞 | 不动（已确认非主因） |

## 3. 行为边界

- 安全不变：`quick_check`、checkpoint manifest 校验、崩溃恢复判定、`checkpointRecoveryFatal` fail-closed 全部保留。
- 行为变化：对账未完成时，从「无限等待」改为「返回 A9_CHECKPOINT_RECOVERY_PENDING，提示稍后重试」。UI 打开不被堵。
- 无中断 turn（正常关闭重开）：`checkpointRecoveryReady=Promise.resolve()`，行为不变（同步快速路径）。
- 对账失败：`checkpointRecoveryFatal=true`，禁止后续自动执行（fail-closed 不变）。

## 4. 验证（开发机，box 内执行）

- 单元/产品测试：新增用例覆盖「对账 pending 时 submitTurn/undo/diff 返回 A9_CHECKPOINT_RECOVERY_PENDING 且不抛异常」「对账完成后恢复可执行」「对账失败后 fail-closed」。
- 既有回归：`a9-visible-waits.test.ts`、`a9-61-runtime-responsiveness.test.ts`、`a9-21-checkpoint-pagination.test.ts` 必须通过。
- Shell 日常集合（`node scripts/verify_integration.mjs --daily`）必须通过；Linux 的 D9 workspace 省略项保持 NOT_PERFORMED。

## 5. 交付边界

- 只改 `a9-agent-runtime.js` + 测试文件。不提交本地 main，不推公开 origin。
- box 从 `base/a9-68-453c54a5` 建，产物回本地后手工应用（不触碰本地 dirty：`a9-agent-runtime.js` 的 400k 上下文预算改动、`a9-agent-loop.ts`、`workbench.html`、`a9-26-context-budget-config.test.ts`）。
- Win7/Win10、打包、门 A/B、发布 NOT_PERFORMED。

## 6. 任务书内嵌与必读

- 内嵌：本任务书全文、`src/shell/product/a9-agent-runtime.js` 相关区段。
- 必读：`AGENTS.md`、`docs/WIN7_CONSTRAINTS.md`、`docs/tasks/A9_TRUSTED_AGENT_RUNTIME.md`、`scripts/README.md`。

## 7. 执行记录（2026-11-15）

### 7.1 box 执行（chai2 / Codex，commit 6fd8f1e3）

- box 从 base/a9-68-453c54a5 建，Codex 执行完成（exit 0，333 s）。改动与 §2 一致：7 处 await 改 checkpointRecoveryBlock（PENDING）+ 新增测试。
- G0 全量 shell 测试失败：4 套件 5 测试（1729 通过 / 12 跳过），全部为 A9-68 引入（基线 453c54a5 对照确认）。
- commit 6fd8f1e3 已推私有 staging box/a9-68-b，未推公开 origin。**未签 A9_68_DEVELOPER_VERIFIED**。

### 7.2 回归根因与负责人裁决

- 5 个回归：a9-61 F2（shutdown 被 PENDING 遮盖）、a9-61 F4（foreign Diff 同步 throw 被遮盖）、a9-batch2（mode 拒绝被遮盖）、a9-lifecycle F5（approval UNKNOWN 被遮盖）、a9-ask-user（restart 恢复被阻断）。
- 根因：`checkpointRecoveryBlock()` 放在 7 入口最前，无条件优先返回 PENDING，遮盖 shutdown/scope/foreign/approval 等确定态安全语义。
- 负责人裁决：选项 1（恢复基线 + 改新测试），「立即 PENDING」与既有安全测试不可共存。

### 7.3 本地修复（A9-68 不改变 7 入口 await 语义）

- 7 入口（submitTurn/continueTask/undoTurn/undoFile/resumeApproval/answerQuestion/getDiff）恢复基线 await：对账有界完成，shutdown/scope/foreign/approval 语义优先。
- continueTask 增加 FATAL 提前检查（fail-closed 更快，对账失败返回 A9_CHECKPOINT_RECONCILIATION_FAILED）。
- 新测试改为「有界等待」语义：对账未完成时入口挂起（非无限轮询）、gate.release 后正常执行；fail-closed 保留。
- 「打开即用」由 SNAPSHOT_GET 分页异步（§2 #3）保证；quick_check 实测 74 ms/次非主因。
- 验证：shell 全量 product 测试 77 套件 1667 测试全部通过（含 a9-61-runtime-responsiveness 本机通过，box 中因沙箱 EPERM BLOCKED）。

### 7.4 状态

- `A9_68_DEVELOPER_VERIFIED`（开发机全量 1667 测试通过）。
- Win7/Win10、打包、门 A/B、发布 NOT_PERFORMED。
