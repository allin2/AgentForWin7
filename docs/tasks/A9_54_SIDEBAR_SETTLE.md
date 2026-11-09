# A9-54 — 侧边栏“已结束”改为保存的状态

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: box/a9-54-be2 → box/a9-54-be3 → box/a9-54-fe（staging）
Source Baseline: 7b8207856346b64705663c2adf3cccd6681a567e
Phase-Gate: A9_54_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

- 授权：负责人 2026-11-08 回复“同意”，同意方向 Demo、5 项范围推荐与 InstaBox 派单确认表。
- 本任务只做开发机交付；上机另行批准。
- 决定：ADR-0321、ADR-0322
- 2026-11-08 负责人另同意：P1-1 选甲（ADR-0322）；行悬停置顶按钮并入本任务前端包；置顶继续存 localStorage。
- 方向 Demo：本机 `outputs/a9-sidebar-settle-demo/index.html`（未入库，只作方向参考，不是合同）

## 1. 交付结果

收件箱的“已结束”分组从“每次现算”改为由保存的时间戳决定，重启后结果不变：

1. 用户可以手动“结束”一个空闲对话，也可以把已结束的对话“恢复”到活跃。
2. 空闲满 7 天的对话自动显示在“已结束”。置顶、运行中、待审批、待回答、有草稿的对话不自动结束。
3. 对话开始新一轮运行、出现待审批或待回答时，清掉手动结束标记，回到活跃。
4. “已完成”提示改为“最近一次运行完成时间晚于上次查看时间”。两个时间都保存，重启不丢。
5. 正在查看的对话不因空闲而立刻折叠。离开后仍留在活跃，直到手动结束或满 7 天。
6. 鼠标移到对话行上显示“置顶”或“取消置顶”，与“…”菜单里的置顶入口等效。
7. 后台驻留工作区的对话行也能直接结束、恢复，不需要先切换过去（ADR-0322）。

不包括：稍后提醒、按 PR 自动结束、拖拽排序、自动结束天数设置、置顶改存数据库、归档逻辑改动。

## 2. 实际分支与基线

- 基线：main `7b820785…`（alpha.7 发布记录提交）。它与 alpha.7 源码 `22b575cc…` 的 `src/` 目录没有差异。
- 开发在私有 staging 仓库的工作包分支：后端 `box/a9-54-be`，前端在后端提交上接续 `box/a9-54-fe`。
- 合入本地 main、公开推送、打包与发布：NOT_PERFORMED，均需负责人另行确认。

## 3. 数据与接口合同

### 3.1 保存位置

保存在 `a9_sessions.metadata_json` 的 `inbox` 对象中，不升级 `A9_SCHEMA_VERSION`（当前为 4）：

| 键 | 类型 | 含义 |
|---|---|---|
| `inbox.version` | 数字 1 | 本对象的格式版本 |
| `inbox.settledAt` | ISO 字符串或 null | 手动结束时间；null 表示未手动结束 |
| `inbox.activeSince` | ISO 字符串或 null | 最近一次“恢复”或自动清除结束标记的时间；参与 7 天计时 |
| `inbox.lastVisitedAt` | ISO 字符串或 null | 用户最近一次查看该对话的时间 |

- 写入只合并 `inbox` 键，保留 `metadata_json` 中其他键。
- 写这三个时间不得改变 `a9_sessions.updated_at`，避免打乱按时间排序。现有 `mergeConversationMetadata` 会更新 `updated_at`，需要另加不改 `updated_at` 的写法。
- 无法解析或缺失的 `inbox` 按全部 null 处理，不报错、不覆盖其他键。
- 2026-11-08 首个后端包（a9-54-be）核对发现：`saveSession()` 更新已有对话时整体覆盖 `metadata_json`（alpha.7 `a9-persistence.ts` 第 668 行）。
  生产调用只有 `ensureActiveConversation()` 的 v3 历史会话迁移分支（第 691 行）。本任务把它改为合并写，保留已有键。
- 已知限制：降级回 alpha.7 后，若某工作区没有当前对话且存在 v3 历史会话，旧版会清掉该历史对话的 `inbox`；影响只是它回到活跃组，对话内容不受影响。

### 3.2 快照字段

`snapshot.conversations[]` 与 `snapshot.workspaces[].conversations[]` 的每个对话增加：

| 字段 | 来源 |
|---|---|
| `settledAt` | `inbox.settledAt` |
| `lastVisitedAt` | `inbox.lastVisitedAt` |
| `lastCompletedAt` | 该对话最近一次成功完成的运行时间；没有则 null |
| `lastActivityAt` | 最近一次运行开始或结束、审批或提问出现、`activeSince`、`lastVisitedAt` 中最晚的时间；都没有时用 `created_at` |

### 3.3 IPC 动作

经现有 Schema IPC 与工作区目标绑定（ADR-0319）新增三个动作，参数为工作区标识与对话标识：

| 动作 | 行为 | 拒绝条件 |
|---|---|---|
| 结束对话 | 写 `settledAt=现在` | 对话运行中、待审批、待回答，或已归档 |
| 恢复对话 | 写 `settledAt=null`、`activeSince=现在` | 已归档 |
| 记录查看 | 写 `lastVisitedAt=现在` | 已归档 |

- 新一轮运行开始、出现待审批或待回答时，主进程把 `settledAt` 置 null、`activeSince` 置为现在。
- 拒绝时返回结构化错误码，不静默忽略。
- Renderer 不直接读写数据库。
- 目标（ADR-0322）：三个动作的 `scope.workspaceId` 可以是任一已驻留、未在关闭中的工作区，不要求是前台工作区；`scope.conversationId` 必须等于 `payload.conversationId`，不要求是该工作区的当前对话。
  工作区未驻留或在关闭中返回 `A9_SCOPE_STALE`；两个对话标识不一致返回 `A9_SCOPE_INVALID`。其他动作的绑定不变。

### 3.4 Renderer 判定

| 分组 | 条件 |
|---|---|
| 置顶 | 已置顶（仍存 localStorage，不变） |
| 活跃 | 未置顶，且有实时状态（运行、待审批、待回答、失败、中断）；或未满足“已结束”条件 |
| 已结束 | 未置顶、无实时状态，并且 `settledAt` 非空；或无草稿且 `现在 − lastActivityAt ≥ 7 天` |

- “已完成”提示：无实时状态、不是正在查看，且 `lastCompletedAt > lastVisitedAt`（`lastVisitedAt` 为 null 视为最早）。
- 打开一个对话、或正在查看的对话运行完成时，Renderer 调用“记录查看”。
- 活跃组的空闲行显示剩余天数；鼠标移到行上显示“结束”或“恢复”。按钮文字用“结束对话”“恢复到活跃”。
- 鼠标移到任一分组的行上显示“置顶”或“取消置顶”按钮，写入现有 localStorage 键，不新增存储。后台工作区的行同样显示这些按钮。
- 活跃组排序保持现状：待处理 → 失败或中断 → 运行 → 已完成 → 时间。
- 删除 `state.inboxUnread` 这类只存在内存里的未读集合。

## 4. 工作包

| 包 | 账号 | 员工 | 范围 |
|---|---|---|---|
| 后端 a9-54-be2 | czl | Codex CLI，GPT 6.1 Sol high | §3.1～§3.3：State 层读写、Runtime 快照字段、IPC 与 preload 暴露、运行开始时清标记；对应测试 |
| 后端补充 a9-54-be3 | czl | Codex CLI，GPT 6.1 Sol high | §3.3 目标（ADR-0322）；对应测试 |
| 前端 a9-54-fe | czl | Claude Code，Opus 5.5 high | §3.4：分组、提示、结束与恢复、记录查看调用、悬停置顶；workbench 合同测试 |
| 后端审核 | czl | Claude Code，Opus 5.5 high，只读 | 只报 P0/P1 |
| 前端审核 | czl | Codex CLI，GPT 6.1 Sol high，只读 | 只报 P0/P1 |

cw、chai2、chai521 账号机器配额各 1 台且已被占用，全部工作包改在 czl 账号新机上开，员工与模型不变。

`wp.py` 当前没有模型与档位参数。员工实际模型与档位以日志读回为准，写入结果。

## 5. 必要验证

| 检查 | 范围 |
|---|---|
| State 测试 | 合并写不丢其他键；不改 `updated_at`；坏 JSON 按 null；归档对话拒绝 |
| Runtime 与 IPC 测试 | 三个动作的成功与拒绝；运行开始清标记；当前工作区与其他驻留工作区都返回新字段 |
| 重启测试 | 关闭再打开同一数据库后，`settledAt`、`lastVisitedAt`、`lastCompletedAt` 不变 |
| Workbench 合同测试 | §3.4 每个分组条件、7 天边界（差 1 毫秒与正好 7 天）、提示条件、按钮可用性 |
| 工作包门 | `wp.py` 的 G0、G1；`docs:check`；`git diff --check` |

界面截图与 Win7 运行：NOT_PERFORMED，不属于本任务。

## 6. 停止条件

- 需要升级数据库版本、新增依赖、原生模块或系统权限时，停止并报告。
- 除 §3.1 已登记的 `saveSession()` 外，再发现会丢掉 `inbox` 键的写入路径时，停止并报告。
- 需要改动归档、对话数量上限或工作区目标绑定语义时，停止并报告。
- 同类测试失败两轮未闭环时，先做最小诊断再继续。

## 7. 结果记录

| 包 | 提交 | 结果 | 证据层级 |
|---|---|---|---|
| a9-54-be | 无 | BLOCKED：发现 `saveSession()` 覆盖写，见 §3.1 | 云端 Linux 开发机 |
| a9-54-be2 | `a0d98c8c…` | COMPLETE；审核 P0 0、P1 1（后台工作区不能原地操作，已由 ADR-0322 处理）；G0 state+shell PASS；Mac G1 9 项 PASS | 云端 Linux 开发机、Mac 开发机 |
| a9-54-be3 | `c82e7e07…` | COMPLETE；审核 P0 0、P1 0（静态审核，定向测试未独立复现）；G0 shell PASS；Mac G1 9 项 PASS | 云端 Linux 开发机、Mac 开发机 |
| a9-54-fe | `ce0bcfe1…` | 员工自报 BLOCKED（派单未放行命令，测试未跑）；审核 P0 0、P1 1（空闲时跨 7 天边界不重绘）；G0 shell FAIL（batch2 rehearsal 14 七例缺桩） | 云端 Linux 开发机 |
| a9-54-fe2 | `0e782023…` | COMPLETE；员工 shell 1508 通过 0 失败；复审 P0 0、P1 0；G0 shell PASS（68 文件，1508 通过、12 跳过）；Mac G1 9 项 PASS | 云端 Linux 开发机、Mac 开发机 |

A9-54 开发机交付完成，尖端为 staging `box/a9-54-fe2` 的 `0e782023…`。合入本地 main、推送、打包与 Win7：NOT_PERFORMED。
已知限制：列表运行中每 500 ms 重建，键盘焦点停在行悬停按钮上时会丢失（既有重建方式）；记录查看失败时，离开后满 7 天的旧对话立即归入“已结束”。

审核员工读回模型 `claude-opus-5-5`，档位 UNKNOWN。性能备注：32 个对话各 2 万事件时单次快照约 60 ms（内存库），索引评估移到 RC。

## 8. 本地整合后继记录（2026-11-09 UTC）

A9-54 的四个实现提交已在本地 main `802d40a…` 的历史中。负责人随后批准 A9-55 前后端检查通过后，连同 A9-54 文档公开推送。A9-54 原开发机证据与限制保持，未重跑未变化的功能；Win7 仍为 NOT_PERFORMED。A9-55 合并记录与后继开发构建见 A9-55 §9，公开推送以其最终记录为准。
