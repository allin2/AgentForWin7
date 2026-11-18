# 当前项目状态

更新：2026-11-17 America/Los_Angeles。当前开发工作区 main；本页只保留当前有效基准、进行中的工作与未签发/已知限制声明，已结算历史交付记录迁入 [STATUS_LOG](STATUS_LOG.md#2026-11-17-自-status-迁入的已结算历史交付记录adr-0340)（ADR-0340）。

## 产品与可试用结果

- 最新已发布试用版：`v0.3.0-alpha.8-win7-62`，内部预览版；[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.8-win7-62)。UTC `2026-11-16T06:52:07Z` 公开，4 个附件草稿与公开后回下载和本地原件大小/SHA/digest 一致。整合 A9-54～A9-68、A9-Settings 与 Windows CI 适配，原证据为开发机加 Win7 `DEV_CHANNEL`，负责人按 ADR-0333 与 ADR-0320 限定接受，见 [A9-69 §6](tasks/A9_69_ALPHA8_RELEASE.md#6-负责人限定接受与发布授权2026-11-16-utc)。
- 当前已签发限定接受候选：`v0.3.0-alpha.8` / `WIN7-62`，源 `585ea92b…`，ZIP `3e3970a9…`，结论 `A9_69_WIN7_62_PASS_WITH_KNOWN_LIMITS`。负责人按 ADR-0333 与 ADR-0320 限定接受并授权发布，未执行门 A/B，详见 [A9-69 §6](tasks/A9_69_ALPHA8_RELEASE.md#6-负责人限定接受与发布授权2026-11-16-utc)。
- Full Access / Read Only 为当前产品能力；Review 保持 fail-closed。完整 Alpha / RC 未签发；当前已知限制见 [A9-43 §8.35](tasks/A9_43_ALPHA3_WIN7_56_RELEASE.md#835-负责人准确确认与-win7-56-验收签发)。历史限制见 A9-39 与 ADR-0286，不把版本名等同完整验收。
- 当前有效需求：[A9 PRD](prds/WIN7_TRUSTED_CODING_AGENT_REQUIREMENTS_V1.md)；后继决定以 [ADR 索引](DECISIONS_INDEX.md) 定位。源码、历史需求和运行结论冲突时按后继决策核实，不以源码替代需求。

## 当前交付、进行中的工作与授权

- [健康体检与体验优化（Phase A / Phase B / Phase C）](tasks/README.md#当前工作与待批准任务)：`APPROVED_FOR_IMPLEMENTATION`。负责人授权开展全面体检、Phase A 快速修复、Phase B 体验与质量提升以及 Phase C 长期架构优化。Phase A（已提交 `fda0aee`）、Phase B（已提交 `35678eb`，ADR-0339）、Phase C 批次 1（已提交 `dbf9cf1`，ADR-0340）与 Phase C 批次 2（已提交 `c717f7d`，ADR-0341）均已闭环。当前完成 Phase C 批次 3：C1 巨石文件拆分（`a9-card-renderers.js`、`a9-runtime-office.js`、`a9-runtime-model-failure.js`、`a9-runtime-redaction.js`、`a9-runtime-persisted-context.js`、`a9-runtime-unavailable.js`），并通过代码审查修复加固；开发机通过 Shell、Core、Gateway 全量测试及文档一致性检查。Win10、Win7 实机、正式门 A/B 与公开推送为 `NOT_PERFORMED`。

- [A9-70](tasks/A9_70_OFFICE_WORKFLOW_BATCH1.md#10-当前交付与接续点)：`APPROVED_FOR_IMPLEMENTATION`。cloud-main 上 OpenCode Hydrogen/xhigh 已基于 `a9-70-p1b` 本地提交 P2～P6 并完成 `claude-opus-5-5`/`high` 独立只读审核（`71b341b..1a3730d` 检出 `P0=0`、`P1=3`、`P2=9`）后的 P1 全量修复与 P2 加固，覆盖流式 ZIP32、DOCX 模板强制数据与边界样张确认门、PPTX 五版式与模板填充、离线单文件 HTML 看板与独立会话 Chromium 108 受限预览、只读邮箱（Worker 隔离、Mock 标 `SURROGATE`、EML/GBK、Win7 危险附件阻断）、办公界面引导/勾选/样张与技能目标确认安装（真实 SQLite checkpoint 撤销）及 `office-lite` 闭包检查。当前均为开发机证据（Node `20.17.0` + Electron `22.3.27`/Node `16.17.1`/Chromium `108`），不声明 Windows Explorer（无 KB2704299 可能乱码 UTF-8 中文名）或 ZIP64，不声明任意排版分页保真，Worker 超时待 Win7 实测；Win10、Win7 实机、正式门 A/B 与公开推送发布为 `NOT_PERFORMED`，不变更 alpha.8 已发布结果。
- [A9-69](tasks/A9_69_ALPHA8_RELEASE.md)：**COMPLETE，`WIN7-62` 限定接受并已发布**，`A9_69_WIN7_62_PASS_WITH_KNOWN_LIMITS`（`0.3.0-alpha.8`，ADR-0333 / ADR-0320）。本地整合、增量只读独立审核复审（`P0=0`、`P1=0`、`P2=0`）及全量开发机检查已通过，干净源码 `585ea92b…` 单次构建 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`（`111,281,027` 字节、ZIP `3e3970a9…`、manifest `a7ce32a8…`、`3,283` 文件）。Win7 `DEV_CHANNEL` `win762` 取得 **14/14 PASS**（真实 DPAPI 100K/双工作区、非阻塞 `a9.snapshot.get` `326 ms`、128K/队列缩容保留/`auto` 清除及 Chromium 108 DOM；回环 `4` 次，外部模型 `0` 次），运行目录已清理、锁 `inactive`、临时容量例外已移除，证据见本机 `outputs/a9-69-alpha8/win7/RESULT_FINAL.json`。标签 `v0.3.0-alpha.8-win7-62` 准确指向 `585ea92b…`，Pre-release 于 UTC `2026-11-16T06:52:07Z` 公开，4 个附件草稿与公开后回下载核验全部一致，见本机 `outputs/a9-69-alpha8/publish/`；正式门 A/B、双构建与冻结为 `NOT_PERFORMED`。
- 已结算任务（A9-68 及更早的 A9-4x～A9-6x 交付、ENGINEERING_03～06 环境与 Win7 开发通道记录）的逐项结论、哈希与限制不再在本页重复，见 [STATUS_LOG](STATUS_LOG.md#2026-11-17-自-status-迁入的已结算历史交付记录adr-0340) 与 [任务索引](tasks/README.md)；ADR-0340 规定迁移规则，不改判任何已签结论。

## 日常入口

```sh
nvm use                            # .nvmrc：Node 20.17.0
npm run test:local -- --module gateway --test-file tests/a9-r3-external-changes.test.ts
npm run test:local                 # 日常集合，含依赖构建
npm test                           # 集成完整回归，含慢检查
npm run docs:check                 # 文档与规则修改
```

选择、风险覆盖及 Win7 开发运行见 [研发运行说明](../scripts/README.md)。不要求每次小改动执行全部命令。

## 待负责人决定与阻断

- 新需求范围、重大架构/产品权限语义、系统权限/配置、超预算、正式签发、产品推送及发布仍单独决定。
- 数据损坏、凭据泄露、越权、失控进程、目标平台无法运行阻断依赖交付；非阻断缺陷明确列出后供负责人验收。

## 未签发与已知限制声明

- 正式门 A/B、双构建与冻结、完整 Alpha / RC、完整 Review 均未签发；Win10、Win7 实机、正式性能预算、公开推送发布对 Phase C 与 A9-70 当前改动均为 `NOT_PERFORMED`。
- `alpha.8` / `WIN7-62` 为负责人按 ADR-0333 与 ADR-0320 限定接受的内部预览版，已知限制以 [A9-69 §6](tasks/A9_69_ALPHA8_RELEASE.md#6-负责人限定接受与发布授权2026-11-16-utc) 及 [A9-43 §8.35](tasks/A9_43_ALPHA3_WIN7_56_RELEASE.md#835-负责人准确确认与-win7-56-验收签发) 为准，不把版本名等同完整验收。
- 运行时 EOL 与供应链边界（Electron 22、Node 16.17.1、SQLite 3.43.1）见 [WIN7_CONSTRAINTS §6.2](WIN7_CONSTRAINTS.md) 与 [SECURITY §6.1](SECURITY.md)（ADR-0340）。

## 历史与恢复

旧 STATUS 原文及任务索引旧流水迁入 [STATUS_LOG](STATUS_LOG.md#2026-10-26-迁入的原-status全文历史快照)，保留原时间点结论。
历史候选和原始证据恢复见 [归档取回](acceptance/EVIDENCE_ARCHIVE_RETRIEVAL.md)。
`status/latest-validation.json` 是 A1–A3 历史记录，绑定 `b2019f022f910b2b8df150ad94c3bccdefa1fa7b`，不表示当前 Alpha 状态。
