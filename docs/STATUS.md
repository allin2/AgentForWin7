# 当前项目状态

更新于 2026-11-19 UTC。当前开发工作区 main；本页只保留当前有效基准、进行中的工作与未签发/已知限制声明，已结算历史交付记录迁入 [STATUS_LOG](STATUS_LOG.md#2026-11-17-自-status-迁入的已结算历史交付记录adr-0340)（ADR-0340）。

## 产品与可试用结果

- **启动阻断**：已发布的 Alpha.9 / `WIN7-63`（源码 `6c8bd75d…`、ZIP `b739cf3c…`）出现普通桌面启动失败。开发机从该 ZIP 提取并执行原加载器，复现 `A9_PACKAGE_RUNTIME_CONFIG_INVALID`。暂停使用该包，临时试用可沿用 Alpha.8。修复通过开发机定向验证，换发与新包 Win7 实机验证为 `NOT_PERFORMED`。见 [A9-72 §6](tasks/A9_72_ALPHA9_RELEASE.md#6-发布后启动阻断)。
- 最新已发布试用版：`v0.3.0-alpha.9-win7-63`，内部预览版；[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.9-win7-63)。整合 Phase ABC 架构与性能优化（C1～C6、B1、B3）及 P1 锁处置修复（ADR-0347～ADR-0353）；原证据为 Windows 7 SP1 x64 实机 DEV_CHANNEL 21/21 PASS（回环 SSE 4 次，外部模型 0 次，进程树与锁清理完毕，归档 outputs/phase-abc-p1-win7/RESULT_FINAL.json），负责人按 ADR-0354、ADR-0333 与 ADR-0320 限定接受并授权发布，见 [A9-72](tasks/A9_72_ALPHA9_RELEASE.md)。
- 当前已签发限定接受候选：`v0.3.0-alpha.9` / `WIN7-63`，源 `6c8bd75d…`，ZIP `b739cf3c…`，结论 `A9_72_WIN7_63_PASS_WITH_KNOWN_LIMITS`。负责人按 ADR-0354、ADR-0333 与 ADR-0320 限定接受并授权发布，未执行门 A/B，详见 [A9-72](tasks/A9_72_ALPHA9_RELEASE.md)。
- 前一发布试用版：`v0.3.0-alpha.8-win7-62`，内部预览版；[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.8-win7-62)。详见 [A9-69 §6](tasks/A9_69_ALPHA8_RELEASE.md#6-负责人限定接受与发布授权2026-11-16-utc)。
- Full Access / Read Only 为当前产品能力；Review 保持 fail-closed。完整 Alpha / RC 未签发；当前已知限制见 [A9-43 §8.35](tasks/A9_43_ALPHA3_WIN7_56_RELEASE.md#835-负责人准确确认与-win7-56-验收签发)。历史限制见 A9-39 与 ADR-0286，不把版本名等同完整验收。
- 当前有效需求：[A9 PRD](prds/WIN7_TRUSTED_CODING_AGENT_REQUIREMENTS_V1.md)；后继决定以 [ADR 索引](DECISIONS_INDEX.md) 定位。源码、历史需求和运行结论冲突时按后继决策核实，不以源码替代需求。

## 当前交付、进行中的工作与授权

- [A9-73](tasks/A9_73_ALPHA10_STARTUP_REISSUE.md)：Alpha.10 / WIN7-64 启动修复换发已获本地实施与 90 分钟 Win7 开发级复验授权。

- [健康体检与体验优化（Phase A / Phase B / Phase C）](tasks/README.md#当前工作与待批准任务)：`APPROVED_FOR_IMPLEMENTATION`。负责人授权开展全面体检、Phase A 快速修复、Phase B 体验与质量提升以及 Phase C 长期架构优化。Phase A（已提交 `fda0aee`）、Phase B（已提交 `35678eb`，ADR-0339）、Phase C 批次 1（已提交 `dbf9cf1`，ADR-0340）与 Phase C 批次 2（已提交 `c717f7d`，ADR-0341）均已闭环。当前完成 Phase C 批次 3：C1 巨石文件拆分（`a9-card-renderers.js`、`a9-runtime-office.js`、`a9-runtime-model-failure.js`、`a9-runtime-redaction.js`、`a9-runtime-persisted-context.js`、`a9-runtime-unavailable.js`），并通过代码审查修复加固；开发机通过 Shell、Core、Gateway 全量测试及文档一致性检查。Win10、Win7 实机、正式门 A/B 与公开推送为 `NOT_PERFORMED`。

- [Phase C 快照与 SQLite 遗留修复](#phase-c-开发分支交接)：第七轮独立复审确认本地未提交修复差异 `45fde898…` 的 P1 为 0，开发机复审阻断解除。目录创建时间 P2 已在第六轮通过。

- [A9-70](tasks/A9_70_OFFICE_WORKFLOW_BATCH1.md#10-当前交付与接续点)：`APPROVED_FOR_IMPLEMENTATION`。cloud-main 上 OpenCode Hydrogen/xhigh 已基于 `a9-70-p1b` 本地提交 P2～P6 并完成 `claude-opus-5-5`/`high` 独立只读审核（`71b341b..1a3730d` 检出 `P0=0`、`P1=3`、`P2=9`）后的 P1 全量修复与 P2 加固，覆盖流式 ZIP32、DOCX 模板强制数据与边界样张确认门、PPTX 五版式与模板填充、离线单文件 HTML 看板与独立会话 Chromium 108 受限预览、只读邮箱（Worker 隔离、Mock 标 `SURROGATE`、EML/GBK、Win7 危险附件阻断）、办公界面引导/勾选/样张与技能目标确认安装（真实 SQLite checkpoint 撤销）及 `office-lite` 闭包检查。当前均为开发机证据（Node `20.17.0` + Electron `22.3.27`/Node `16.17.1`/Chromium `108`），不声明 Windows Explorer（无 KB2704299 可能乱码 UTF-8 中文名）或 ZIP64，不声明任意排版分页保真，Worker 超时待 Win7 实测；Win10、Win7 实机、正式门 A/B 与公开推送发布为 `NOT_PERFORMED`，不变更 alpha.8 已发布结果。
- [A9-69](tasks/A9_69_ALPHA8_RELEASE.md)：**COMPLETE，`WIN7-62` 限定接受并已发布**，`A9_69_WIN7_62_PASS_WITH_KNOWN_LIMITS`（`0.3.0-alpha.8`，ADR-0333 / ADR-0320）。本地整合、增量只读独立审核复审（`P0=0`、`P1=0`、`P2=0`）及全量开发机检查已通过，干净源码 `585ea92b…` 单次构建 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`（`111,281,027` 字节、ZIP `3e3970a9…`、manifest `a7ce32a8…`、`3,283` 文件）。Win7 `DEV_CHANNEL` `win762` 取得 **14/14 PASS**（真实 DPAPI 100K/双工作区、非阻塞 `a9.snapshot.get` `326 ms`、128K/队列缩容保留/`auto` 清除及 Chromium 108 DOM；回环 `4` 次，外部模型 `0` 次），运行目录已清理、锁 `inactive`、临时容量例外已移除，证据见本机 `outputs/a9-69-alpha8/win7/RESULT_FINAL.json`。标签 `v0.3.0-alpha.8-win7-62` 准确指向 `585ea92b…`，Pre-release 于 UTC `2026-11-16T06:52:07Z` 公开，4 个附件草稿与公开后回下载核验全部一致，见本机 `outputs/a9-69-alpha8/publish/`；正式门 A/B、双构建与冻结为 `NOT_PERFORMED`。
- 已结算任务（A9-68 及更早的 A9-4x～A9-6x 交付、ENGINEERING_03～06 环境与 Win7 开发通道记录）的逐项结论、哈希与限制不再在本页重复，见 [STATUS_LOG](STATUS_LOG.md#2026-11-17-自-status-迁入的已结算历史交付记录adr-0340) 与 [任务索引](tasks/README.md)；ADR-0340 规定迁移规则，不改判任何已签结论。

### Phase C 开发分支交接

交接分支为 `staging/box/health-check-phase-abc`。复核基线为 `234dbd8b…`。第 24 轮复核的跟踪差异 SHA-256 为 `69f9f2313c1f767f4245b2e7ae3f3a5ac66e18c73ab9b701ab702d495fba2f67`，新增快照测试的 Git blob 为 `fea71bcdf730d95b874004360af80fddeb0dc4b5`。交接提交在该代码基础上补录本节。

本修复工作树的基线为 `21dbc389…`。本地测试分支 `test-phase-abc` 仍检出该交接提交，尚未合入修复。下表保留第 24 轮的原始问题和验证目标。

| 级别 | 交接提交 `21dbc389…` 在开发机复现的问题 | 修复验证目标 |
|---|---|---|
| P1 | 旧库默认目录从 A 改名为 B，再改绑到 C 时，A 内的截断归属可能漏报。复核在旧版改名保留 `origin: 'auto'` 和旧元数据退化为 JSON `null` 时复现。两种关闭选择均误释放 A 的工作区锁。 | 旧库证据无法确认来源时保留锁，A 返回归属损坏诊断。核对[历史补齐](../src/state/src/a9-persistence.ts#L1110)。 |
| P1 | 会话按 A → B → A 改绑后，B 内已可确认来源的截断句柄前缀（如 `sh-`）会误阻断 A。复核覆盖 A 的 `stopped` 和 `released` 事实。 | 归属读取和历史校验都按事件写入时的工作区判定。两种关闭选择均可正常释放 A 的锁。核对[归属读取](../src/state/src/a9-persistence.ts#L2769)和[历史校验](../src/state/src/a9-persistence.ts#L2923)。 |
| P1 | 同一会话在 A、B 各完成一次处置，再改绑到 C 后，B 内截断的处置事件会遮蔽 A 内的有效回执。当前 A 和 B 都无法关闭。 | A 继续读取有效回执并正常关闭。B 报告本工作区的处置损坏并保留锁。核对[处置事件读取](../src/state/src/a9-persistence.ts#L3022)。 |

第 24 轮独立复核使用开发机 Node 20.17.0 和 SQLite 3.43.1。State 35 套件、643 项以及 Shell 97 套件、2,066 项均通过。独立反例另外复现上述 3 项 P1。Win10、Win7 实机验证、正式门 A/B 与公开发布均为 `NOT_PERFORMED`。

#### 第 24 轮 P1 本地修复

本地修复使用交接提交 `21dbc389386e0865edf612ede3490f4101cd0b1f`。产品和回归用例的差异 SHA-256 为
`ac8535decc83a03bb7c50b4ff2109312f657ad6447f59fc87bc2e921bffb52a5`。
同一组 Shell 回归使用 macOS、Node 20.17.0 和真实 SQLite 3.43.1。在交接提交上 8 项均复现，在修复工作树上 8 项均通过。
用例覆盖旧版改名后的两种元数据、回绑后的 `stopped` 与 `released`、以及处置回执隔离。回归核对两种关闭选择和 SQLite 锁记录。
处置读取查询计划继续使用事件类型索引和会话主键索引。

开发机全量回归通过 State 35 套件、643 项与 Shell 97 套件、2,074 项。首次回归的配对转移用例在 macOS 默认临时目录触发
`A9_TRANSFER_PATH_TOO_LONG`，在交接提交上同样复现。保留首次结果后，使用短临时目录重跑，测试夹具无残留。
本地证据存放于独立工作树的 `outputs/phase-abc-p1/`。

独立复审针对上述差异完成。第 2 项关闭。第 1 项在 `{"workdir":null}` 时仍可误放锁。第 3 项在另一会话的旧版改绑缺少历史分段时仍可误保锁。审核建议暂缓进入实机验证。

#### 独立复审后的 P1 修复

修复基于同一工作树及上一轮已审差异。显式空 `workdir` 保留未知来源。处置查询依据事件写入时的工作区筛选。
旧记录来源无法确认时，回到已知会话的当前工作区和稳定归属会话。截断载荷可辨的完整句柄或前缀用于确认损坏是否可能影响当前回执。

新增反例在已审差异上复现 7 项，涵盖两种关闭选择及 SQLite 最终锁记录。修复后定向回归 14 项通过。
开发机全量回归为 State 35 套件、643 项和 Shell 97 套件、2,080 项，均通过。
本轮产品和回归用例的差异 SHA-256 为 `53fa80e1f536113348c9f0ce142aa73bfac4ea406c3755ef8d122c72f65011a1`。
本地证据存放于 `outputs/phase-abc-p1/review-repair/`。

第二轮独立复审核对同一差异，报告 P0 0、P1 3、P2 0。上一轮反例已通过。旧版默认目录改名会同时迁移省略 `workdir` 的普通会话。后续改绑误记其事件来源会使 A 误放锁，也会排除 A 的完整回执。损坏历史只残留 B、C 的路径时，仍可遗漏 A 并误放锁。复审直接执行 19 个独立场景和 38 次关闭，建议维持开发机复审阻断。

#### 旧库托管事件归属修复

本轮以 `21dbc389386e0865edf612ede3490f4101cd0b1f` 上已审差异 `53fa80e1…` 为基线。
首次观察到的改绑只确定后续事件的边界。此前已有的托管事件保留未知来源。旧补丁写下的首段路径和损坏历史的残余路径均不能用于排除工作区。
原处置回执按事件的会话、Turn、句柄、原归属、请求、PID、启动时间和处置前修订核验。可明确归属 B 的损坏记录仍只影响 B。

开发机使用 Node 20.17.0 和真实 SQLite 3.43.1。历史版本 `35678eb5a94d50d107eb19d48810e2e862ea60b8` 创建数据库、写入归属与回执，并执行旧版目录改名。
同一组升级用例在已审差异上 8 项失败、2 项对照通过。修复后 10 个场景、22 次关闭全部通过，核对实际 SQLite 锁行。用例另覆盖已由旧补丁误记首段的库。
首次回归中有 12 个 State 断言和 8 个 Shell 断言仍要求将首段归为 A。修正元数据断言后，保留了原损坏诊断和锁断言。
State 全量重跑 35 套件、647 项通过。Shell 首轮其余 96 套件通过，受变更的生命周期套件重跑 255 项通过。
本轮产品及两份回归文件的差异 SHA-256 为 `6597add40da3c151469c674137c0407837c32480b220a31f02059047994dfa5b`。
本地证据存放于 `outputs/phase-abc-p1/history-provenance/`，测试临时目录已清理。

第三轮独立复审绑定上述差异。上轮 3 个具体反例已通过。原第 2 项维持关闭，原第 3 项经回执逐字段反例确认关闭。开发机独立复审维持 `BLOCKED`。
扩展验证在本轮与上一轮差异均复现 3 类 P1。旧版改名后直接打开 A 时，当前 B 路径仍会导致旧损坏事件被排除。删除中间分段后，剩余数组格式和上界仍合法，A 的事件会被归入相邻分段。缺少 `owner` 的 `release_unknown` 事件仍可保有原始会话、Turn 和精确句柄，改绑后它在校验前被过滤。三类反例均导致 A 误放锁。
独立复审另跑了 23 组检查、46 次关闭，并逐次读取 SQLite 锁行。来源可证实为 B 时，A 仍可关闭，B 保留锁。

#### 第三轮独立复审后的锁保护修复

本轮基于已审差异 `6597add4…`。绑定完整性摘要覆盖完整分段，旧库没有可靠绑定时保留未知来源。精确句柄、原会话及 Turn 对应的损坏记录继续参与归属验证。
开发机使用 Node 20.17.0、SQLite 3.43.1。升级夹具由历史 State `35678eb5…` 生成。
相同用例在已审基线上有 6 项失败和 10 项通过。修复后 16 个场景、34 次关闭均通过。两种关闭选择均核对了 SQLite 锁行。已证实归属 B 的损坏仍只阻断 B。
State 全量 35 套件、647 项通过。Shell 全量 97 套件、2,096 项通过。首轮回归发现的工作区错误码已在 State 与 Shell 入口恢复。测试临时目录已清理。
本轮产品和回归文件的差异 SHA-256 为 `bee4aa2329c41243e39d8d7b608714c892608aa7863bb236008c86254409b0f2`。
本地证据存放于 `outputs/phase-abc-p1/binding-proof/`。

第四轮独立复审绑定上述差异。独立重跑升级夹具，16 个场景、34 次关闭通过。旧库直接重开和历史整段丢失的反例关闭。开发机独立复审维持 `BLOCKED`，P0 0、P1 3。

- 稳定归属校验仍会漏读可恢复完整句柄的截断记录。复审覆盖同一原会话和 Turn，以及摘要证实记录写于 A、会话已改绑到 B 的情况。两种关闭均误删 A 锁。
- 处置查询会跳过同一原归属的较新损坏记录，读到 A 的旧回执。有效 JSON 字段损坏与截断两类均复现误放锁。
- 跨连接保存可覆盖已提交的新绑定。Shell 初始化入口能回写旧路径和旧摘要，随后误删 B 锁。Shell 收件箱入口可覆盖新摘要并误保 A 锁。State 的普通元数据合并也复现覆盖。

#### 第四轮独立复审后的修复

本轮以 `21dbc389386e0865edf612ede3490f4101cd0b1f` 和第四轮已审差异 `bee4aa23…` 为基线。在开发机使用 Node 20.17.0、SQLite 3.43.1 和实际 Shell Runtime。
原版定向用例复现 6 个 Shell 场景下两种关闭均误放锁，以及 4 个 State 场景的旧绑定覆盖或迁回。
修复后，原会话和 Turn 的完整句柄在载荷截断时仍参与核验。已证实写于 A 的损坏记录在会话改绑后仍归 A。只有最新相关处置通过完整核验才能结算。
并发夹具通过 Shell 初始化和收件箱入口触发真实的 SQLite 写竞争。第二连接在首个写事务完成后重试改绑成功。两种关闭选择各自释放健康的 A 锁，并保留有损坏的 B 锁。旧派生会话再次打开原目录与同路径往返改绑均保留当前绑定。
旧库升级夹具通过 16 个场景、34 次关闭。State 全量 35 套件、652 项通过。Shell 全量 97 套件、2,102 项通过。
本轮产品和回归文件的差异 SHA-256 为 `406b7203c8ef0fa7fa564fd26b54d16a0cc2afbe3dc29b33fbd533ffe359efa6`。
State 实际加载的 `a9-persistence.js` SHA-256 为 `51796af696beb549d8928da66a9272b89998652c99a84959444dd368b96c8e6c`。
实现决定见 ADR-0351，开发机证据存放于 `outputs/phase-abc-p1/settlement-order/`。

第五轮独立复审绑定上述差异，判为 `BLOCKED`，P0 0、P1 1、P2 1。原归属漏读和跨连接绑定覆盖关闭。剩余 P1 为旧库改名后的不同 Turn 处置记录会遮蔽 A 回执。剩余 P2 为 A→B→A 后陈旧保存可恢复旧目录创建时间。

#### 第五轮独立复审后的修复

本轮基于 `21dbc389386e0865edf612ede3490f4101cd0b1f` 和已审差异 `406b7203…`。相同回归在旧差异上复现 3 项 State 失败和 1 项 Shell 失败。
按 ADR-0352 识别处置事件的原 Turn，更晚的其他 Turn 记录不再遮蔽完整回执。可能相关的损坏、缺少 Turn 证据或原归属冲突继续保锁。
由历史 State `35678eb5…` 真实改名的 SQLite 库中，两种关闭均释放 A 的锁，并保留处置记录受损的 B 锁。双连接往返改绑后，Shell 查询的 `createdAt` 保持 `null`。
开发机 Node 20.17.0、SQLite 3.43.1 下，State 全量 35 套件、654 项通过，Shell 全量 97 套件、2,103 项通过。旧库升级夹具的 34 次关闭和两个 Shell 双连接写入夹具均通过。处置查询命中事件类型索引及会话、Turn 主键索引。
本轮产品和回归文件的差异 SHA-256 为 `6e98372182aeee5b451a8e03ca7683867d2966a8e9c8b62855964047bced1dcb`。
State 实际加载的 `a9-persistence.js` SHA-256 为 `bd2d4e4c3b916b0cb0bddd8d486059e3641906ae1dd3f2d3c76999af59078294`。
开发机证据存放于 `outputs/phase-abc-p1/disposition-origin/`。

第六轮独立复审绑定上述差异。目录创建时间通过。处置归属的剩余 P1 为可信范围内的较新回执声明完整原 `owner`，但 `handleId` 缺失或为 `null` 时，两种关闭均误删工作区锁。

#### 第六轮独立复审后的修复

本轮基于 `21dbc389386e0865edf612ede3490f4101cd0b1f` 和已审差异 `6e983721…`。真实 Shell 在旧差异的六种句柄损坏下，两种关闭均误删锁。
修复后，缺失、`null`、空字符串、数字及两种截断的载荷保有完整原归属时，两种关闭均报告 `A9_MANAGED_DISPOSITION_UNCONFIRMED` 并保留 SQLite 锁行。只有嵌套归属、属于其他句柄或可确认写在 B 的对照仍允许健康的 A 退出。旧库升级夹具的 34 次关闭通过。
Node 20.17.0、SQLite 3.43.1 下，State 全量 35 套件、656 项通过，Shell 全量 97 套件、2,109 项通过。文档检查通过。
本轮产品和回归文件的差异 SHA-256 为 `45fde898f00add78ae14e7e029d0aaf1f62790651468136a1402755098ebb0b4`。
State 实际加载的 `a9-persistence.js` SHA-256 为 `aa88f5753cbed2d8ac90122498161e176b28a79726fb8f839a88b4648f1e2ef0`。实现决定见 ADR-0353。
开发机证据存放于 `outputs/phase-abc-p1/disposition-owner/`。

第七轮独立复审绑定上述 HEAD、四文件差异及 State 产物。复审使用 Node 20.17.0、SQLite 3.43.1 和真实 Shell Runtime，独立检查 64 次关闭。两种关闭选择均保留六种损坏场景的锁。健康 A 仍能退出，受损 B 保留锁。第二连接在关闭预检后提交损坏回执时，最终释放事务重新核验并保留锁。复审范围内 P1 为 0，开发机复审阻断解除。全量回归沿用本节记录。

Win10、Win7 实机验证、打包运行、正式门 A/B 与发布为 `NOT_PERFORMED`。

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
