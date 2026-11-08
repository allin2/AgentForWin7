# A9-51 — alpha.6 排队输入与可靠性发布准备

```text
Status: COMPLETE
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: ef6a692294fa4e0403b2d1e00ea188b2e79749f8
Target Version: 0.3.0-alpha.6
Candidate: WIN7-59
Phase-Gate: A9_51_WIN7_59_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 当前范围

负责人在 A9-50 开发交付后要求“推进发布”。
本轮从 main 收口 A9-50，包含当前 HEAD 已有的 A9-49 可靠性修复。
允许必要的本地提交、版本身份、锁、打包工具、候选外驱动和发布材料准备。
只暂存准确任务路径及共享文档内本轮段落。其他会话的修改保留，不混入提交。
本轮不新增产品能力、权限、依赖、系统设置或模型费用。

## 2. 顺序与 Gate

1. 核对实际源码与开发回执，建立新版本身份；不改旧版 Profile、锁或冻结候选。
2. 从准确干净提交单次构建开发包，核对 manifest、ZIP、七模块实际加载和原生闭包。
3. 在开发机通过真实产品 main/preload/IPC/runtime/SQLite，验证 FIFO、草稿隔离、停止、失败、审批与恢复。
4. 准备同包 Win7 增量验证的准确载荷、身份、路径、预算和停止条件。
5. 取得当前版本适用的目标执行授权后，完成同包 Win7 开发级运行。
6. 按标准合同完成正式准备、一次双干净构建、冻结和门 A/B。各门等待负责人准确批准。
7. 取得接受结论后，推送并公开同一已验收字节，回下载核验全部附件。

ADR-0315 的合并验收例外只适用于 WIN7-58，本版本不继承该例外。
`推进发布` 不是对尚未形成的准确门 A/B 材料的预签。
开发通道常设授权仍受 ENGINEERING_03 §10.4 的工作区限制。
本轮在 main 的目标窗口和工作区差异尚未批准时，不执行目标写入或产品运行。
只读预检不替代普通用户执行证据。

## 3. 验证与影响

- 新增 alpha.6 Profile、输入锁和包内 runtime 身份；校验串号拒绝，旧版本行为保持。
- 沿用 Electron 22.3.27、Node 16.17.1、SQLite 8.7.0 / ABI 110 与 managed v26 精确原生输入。
  复用必须直接核对哈希、批准注册表及调用契约，不重编未变化原生。
- 先编译生产者，再运行受影响合同及发布必需检查。旧开发证据仅按准确未变字节继承。
- 队列密文恢复必须补真实 Windows DPAPI；Linux/Mac 合成 safeStorage 不代替目标实测。
- UI 覆盖输入、队列、停止、窄窗和低高度可达；保留原主题与现有对话行为。
- 本地构建沙箱位于系统临时目录，finally 清理；需保留结果明确复制到本轮证据目录。
- 同类两轮未解释失败先最小诊断；身份、完整性、安全或未知生命周期失败停止依赖动作。

## 4. 已知边界与交付

证据集中在本机 `outputs/alpha6-r1/`；状态只在 STATUS 维护。
Win10 同包、原生 125% DPI、外部模型、完整 Review/batch2 和跨机可重复性沿用原未执行边界。
版本为内部试用预发布，不宣称完整 Alpha、RC 或稳定版。
本轮保留现有 alpha.5 用户进程、他人锁、所有历史候选和证据；不执行删除或根外终止。
发布范围不授权接管活动锁、扩容、安装、修改系统或复制目标凭据。

## 5. main 工作区、Win7 窗口与 holder 沿用批准

负责人对准确源码 `6d43e43a…`、ZIP `5bc6f96a…` 的执行请求回复：
“批准本版 Win7 开发验证及 holder 沿用”。
据此仅本版本允许从 main 使用 r2 通道，沿用 inactive holder `a946lanrx`；不使用 --steal。
目标为 `192.168.1.9` / DCCS-CHAIZL-PC / Win7 build 7601 / 普通 agent Session 1。
60 分钟内最多 2 次有界运行；最后 10 分钟不开始新场景。
零外部模型；预期 34 次回环请求，每 run 最多 50 次、窗口最多 100 次。
只写 `C:\A9-DEV` 本 run、候选缓存与通道记录；开发根不超过 20 GB，剩余至少 50 GB。
保留现有 alpha.5 四个进程及身份，前后直接核对；不 close、不改系统、不读取用户凭据或配置。
只使用新数据根、当前用户 DPAPI 与本机回环夹具。
身份、完整性、安全、必需审计或未知生命周期失败停止下游；普通同范围修复以新输入和 run 在原窗口内重试。
该批准仅为 DEV_CHANNEL，不授权正式门 A/B、公开发布或删除历史。
准确请求及批准在本机 `outputs/alpha6-r1/target-ready-r3/REQUEST.json`、`OWNER_TARGET_APPROVAL.json`。

## 6. 首次独立源码审核与局部修复

负责人批准一个只读审核代理，审核准确源码 `6d43e43a…` / ZIP `5bc6f96a…`。
独立源码审核未发现 P0/P1，报告两项 P2；不代表正式门 A/B。
健康后台进程误用对话切换阻断，导致队列不消费；实际 BackgroundProcessManager/SQLite 的反例先失败，
主代理分离同对话派发与会话切换条件，未知状态或 cleanupRequired 仍拒绝自动发送。
新信封不是旧 alpha.5 可读格式；发布说明明确回退须还原升级前数据备份或使用独立新数据根，不能只换 EXE。
本轮属已批准范围内局部修复；新源码与新包另存，旧包、双构建和第一 run 证据保留。
第二 run 若执行，沿用 §5 原始开始和截止时间，不重置 60 分钟或两次上限。

## 7. 恢复身份边界的追加反例

主代理进一步核对 BackgroundProcessManager，发现恢复身份由 recoveryStatus/pidReusePossible 表达，
正常 status 仍可为 running，且旧事实可能没有 cleanupRequired。
新反例在原修复源码得到 3 次请求，期望为 2，直接证明未知恢复事实旁仍消费了队列。
源码 `484baff4…` 按实际字段拒绝自动派发；四个相关文件 132 项通过，普通 PID 事实不发送终止信号。
原包、两次干净构建与正在运行的第二 run 均保留原源码身份，不升格为该修复的 Win7 证据。
该修复形成新包；超出 §5 两次上限的新目标执行须先准备准确材料并由负责人追加批准。
不借更换 run 或包重置已消耗次数、原窗口或容量限额。

## 8. 已批准窗口收尾与当前证据（2026-11-07 UTC）

负责人追加批准一次同范围有界运行后，第三 run `94df7e6d-02d3-4927-b87d-1265a3010902` 在原窗口内完成，状态为 `DEV_CHANNEL` `PASS`。最终源码为 `484baff4e1c972399aafffbf0b93f7c92abb0835`，ZIP SHA-256 为 `241af4ca9e251362062d95957e0cf67011476be4adb1909fc097862c76370a36`，manifest SHA-256 为 `6abb2618e5310dbff7319dff5fc289c90972afcc02a29e6c76cbea1efd1a86db`。目标端完成新包逐文件重建校验、队列恢复与真实 Windows DPAPI、显式继续后无重放、临时文件回收、后检零任务及 alpha.5 四进程集合不变；结果见 `outputs/alpha6-r1/TARGET_RUN_RECOVERY.json` 与 `outputs/win7-dev/alpha6-94df7e6d/`。

第二 run `4cfd8ee9-69fd-4077-8a33-0265fe9d02da` 绑定 `0aded040…`，队列/DPAPI、可靠性受限运行和收尾均为 `PASS`；其可靠性目标证据只绑定该源码与对应 ZIP。最终 `484baff4…` 的可靠性链路在本地同包结果中通过，未把第二 run 的可靠性结果改绑到最终源码。开发机最终 132 项定向 Shell 测试、424 项发布合同检查均为 `PASS`（发布检查保留 16 项 `NOT_PERFORMED`）。三份 `recovery-dev`/`recovery-a`/`recovery-b` 构建的 ZIP 与 manifest 逐字节一致，汇总见 `outputs/alpha6-r1/DOUBLE_BUILD_RECOVERY.json`。

独立只读审核仍绑定原始 `6d43e43a…`，结论为 P0/P1 零项、两项 P2；后续 `0aded040…` 与 `484baff4…` 修复由主代理定向复现和验证，记录为主代理证据，不升格为最终提交的独立审核。正式冻结、门 A、门 B、负责人接受、推送及公开发布继续为 `NOT_PERFORMED`。

## 9. alpha.6 发布材料准备（2026-11-07 UTC）

负责人要求开始发布后，已按最终源码 `484baff4…`、ZIP `241af4ca…` 和 manifest `6abb2618…` 重新生成发布材料，旧的 `publication/` 目录仍保留且不作为当前发布输入。新材料位于 `outputs/alpha6-r1/publication-final/`，包含 `PUBLICATION_PREPARATION.json`、`RELEASE_NOTES.md`、`SHA256SUMS` 和 `PUBLICATION_BLOCKERS.json`，并绑定 recovery-dev 包内 manifest、输入锁、验证套件和 SBOM。

最终源码采用旧基线审核加全部后继差异独立复核。P0/P1 为零，旧两项 P2 关闭，未发现新增 P2。组合审核见 `review/FINAL_SUCCESSOR_REVIEW.json`。审核索引的测试路径笔误以候选外 `publication-final/REVIEW_PATH_ERRATUM.json` 勘误，冻结字节保持不变。

同一包已在 `.acceptance/candidates/WIN7-59/` 只读冻结，共 14 文件。冻结记录 SHA 为 `77397a75…`，状态 FROZEN_NOT_FORMALLY_ACCEPTED。后继负责人接受记录保存在候选外，不回写冻结快照。GitHub 直连认证检查通过；先前代理连接错误不能证明凭据无效。

## 10. 负责人限定接受（2026-11-08 UTC）

负责人明确选择：“本版限定接受并发布：接受 484baff4… / ZIP 241af4ca… 的现有 Win7 DEV_CHANNEL 证据和已知限制，明确以负责人接受替代本版 Gate A/B”。后继 ADR-0318 仅对本版替代 §2 与 ADR-0317 的标准签发顺序；原 ADR 正文与历史证据保留。

结论为 `A9_51_WIN7_59_PASS_WITH_KNOWN_LIMITS`。接受记录在 `outputs/alpha6-r1/publish/OWNER_ACCEPTANCE.json`，绑定源码、ZIP/manifest、冻结身份与 run。原实机报告保持 DEV_CHANNEL，正式门 A/B 未执行。未知恢复 PID 负向用例只有开发机直接证据，最终包 Windows 可靠性组未重跑；旧 `0aded040…` 报告不改绑。§4 其他已知限制和数据回退要求保持。

负责人授权推送源码、准确标签与同一冻结产物的内部试用预发布。公开与回下载核验结果完成后补录，不预签未来操作。

## 11. 同字节公开与回下载核验（2026-11-08 UTC）

标签 `v0.3.0-alpha.6-win7-59` 准确指向产品源码 `484baff4…`。接受与发布文档提交为 `83556b96…`；后继只补本节和下载指引，不重建产品。预发布于 UTC `2026-11-08T01:44:23Z` 公开，release ID `437966857`，[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.6-win7-59)。

ZIP、`WIN7-59-RELEASE-EVIDENCE.json`、`ACCEPTANCE.md` 与 `SHA256SUMS` 共 4 个附件在草稿和公开后各回下载一次。大小、SHA-256 与 GitHub asset digest 三方一致，公开前后 asset ID 不变；核验见 `outputs/alpha6-r1/publish/PUBLICATION_VERIFICATION.json`。冻结 14 文件原字节保持。负责人接受在候选外，不覆盖原冻结待验收快照。

本轮只提交本版准确文档段落并推送 main 与标签。其他会话修改保留。没有新建 Win7 运行、重建包、模型请求或删除。原证据等级和 §10 的已知限制保持；GitHub CI 在发布时尚未完成，不能记为 PASS。
