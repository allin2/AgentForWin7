# 当前项目状态

更新：2026-11-13 America/Los_Angeles。当前开发工作区 main；A9-34 基线 `f374e3783eb6e863a84c97b0a28c94f52a2169c9`，A9-40 联合验证的源码身份与本地保存记录见任务书 §4.5、§5.1。

## 产品与可试用结果

- 最新已发布试用版：`v0.3.0-alpha.7-win7-60`，内部预览版；[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.7-win7-60)。UTC `2026-11-08T11:45:00Z` 公开，4 个附件回下载与验收原件大小/SHA 一致。包含多工作区并行对话与收件箱式导航。负责人按 ADR-0320 限定接受，原证据为 DEV_CHANNEL，见 [A9-53 §6](tasks/A9_53_ALPHA7_MULTIWORKSPACE_RELEASE.md#6-负责人限定接受2026-11-08-utc)。
- 上一试用版：`v0.3.0-alpha.6-win7-59`，UTC `2026-11-08T01:44:23Z` 公开。
- 当前已签发并发布候选：`v0.3.0-alpha.7` / WIN7-60，源 `22b575cc…`，ZIP `5b8ae87f…`，结论 `A9_53_WIN7_60_PASS_WITH_KNOWN_LIMITS`。负责人限定接受已完成，未执行门 A/B，详见 [A9-53 §6](tasks/A9_53_ALPHA7_MULTIWORKSPACE_RELEASE.md#6-负责人限定接受2026-11-08-utc)。
- 上一签发候选：`v0.3.0-alpha.6` / WIN7-59，源 `484baff4…`，ZIP `241af4ca…`，结论 `A9_51_WIN7_59_PASS_WITH_KNOWN_LIMITS`；原 DEV_CHANNEL 和已知限制保留。
- 上一 Win7 实机已签限定范围结论：`A9_39_WIN7_55_BATCH2_PASS_WITH_KNOWN_LIMITS`（ADR-0286）。source `b4ce2be42cc9448142b831612dc7d5bc3a4df3cd`；ZIP SHA-256 `7de63dd8db0fde0f7c76aafa48f44ce6c9841c651c03b93215e175ad3792824a`。
- 总控 FORMAL `f9ae2982`；补充组 DEV `cdb82d32`；证据等级与签发范围详见 [ADR-0286/0287](DECISIONS.md#adr-0286-win7-55-门-b限定已直接证明范围签发)。本页不将补充组改成 FORMAL。
- Full Access / Read Only 为当前产品能力；Review 保持 fail-closed。完整 Alpha / RC 未签发；当前已知限制见 [A9-43 §8.35](tasks/A9_43_ALPHA3_WIN7_56_RELEASE.md#835-负责人准确确认与-win7-56-验收签发)。历史限制见 A9-39 与 ADR-0286，不把版本名等同完整验收。
- 当前有效需求：[A9 PRD](prds/WIN7_TRUSTED_CODING_AGENT_REQUIREMENTS_V1.md)；后继决定以 [ADR 索引](DECISIONS_INDEX.md) 定位。源码、历史需求和运行结论冲突时按后继决策核实，不以源码替代需求。

## 当前交付、进行中的工作与授权

- [A9-66：批次3](tasks/A9_66_LARGE_INPUT_RESPONSIVENESS.md) / [A9-67：批次5](tasks/A9_67_NETWORK_AND_BOUNDARY_HARDENING.md)：**COMPLETE，WIN7-61 限定接受**，`A9_66_A9_67_WIN7_61_PASS_WITH_KNOWN_LIMITS`。源码 `c7f51ea…` / ZIP `0cebc0b0…` / manifest `7279f6ea…`（双干净构建逐字节一致）。Win7 实机库层断言 run `a96667-controller`（DEV_CHANNEL）24/24 PASS：F-011/012/025/008/007/009/027，identity/Medium/session 1 核验，closure 3265 文件，sqlite 3.43.1。负责人按 ADR-0332 限定接受（按 ADR-0320 路径），不产生 FORMAL PASS。已知限制：非阻断 P2（删除恢复区后需重新打开工作区）、验证为库层非 UI 路径、深历史每页同步全量扫描（基线）、200MiB 单文件同步后态约 829ms（基线）。开发机独审/G0/G1 证据保留在 outputs/a9-66-67-instabox/；Win7 证据在 outputs/a9-66-67-win7-dev-r1/。正式门 A/B、完整 GUI 旅程、公开推送及发布 NOT_PERFORMED。
- [A9-65](tasks/A9_65_VISIBLE_WAITS_AND_DIAGNOSTICS.md)：`A9_65_DEVELOPER_VERIFIED`。产品返修`6ba877d…`已合入本地main，后继仅修Electron夹具的固定等待。main保留既有dirty，直接Shell日常78套件/1710 PASS，12项必需字段慢检查和6000文件基线3项另跑通过；Electron关闭等待、正常退出通过，等待提示首轮FAIL保留，语义等待修正版单场景PASS。文档检查通过，决定见ADR-0329。准确源码/夹具/收尾绑定在outputs/a9-65-closeout-20261113/RESULT_FINAL.json。Win7、打包、门A/B、公开推送及发布NOT_PERFORMED。
- [A9-64](tasks/A9_64_SEARCH_LIST_RESPONSIVENESS.md)：`A9_64_DEVELOPER_VERIFIED`。独立复审建议合入e7905f53…，产品已本地合并为8069a5ba…，决定见ADR-0330。原异步归属P1关闭，P2文档协调完成；旧FAIL保留。组合开发机直接Workspace500/500、Core924/924、Shell五文件879/879，双运行时真实Core→Workspace各12/12 PASS。六模块源码和关键JS与复审同字节；竞态、红绿及性能标INHERITED_EVIDENCE。既有同步TOCTOU/ABA限制保持。Win7、完整GUI、打包、门A/B、推送发布NOT_PERFORMED；准确绑定在outputs/a9-64-main-closeout-20261113/RESULT_FINAL.json。

- [A9-62](tasks/A9_62_DIAGNOSTIC_FLIGHT_RECORDER.md)：`A9_62_DEVELOPER_VERIFIED`。主进程诊断日志落盘与进程级兜底已合入 main，合并提交 `d04629a…`，分支尖端 `afbaa65f…`，决定见 ADR-0328。三轮独立复审后，末次返修由合入会话复核；仅开发机 Node 20 与 Electron 22.3.27 证据。Win7 实机和原生错误框点击为 `NOT_PERFORMED`。
- [A9-63](tasks/A9_63_FAIL_LOUD_BATCH1.md)：`A9_63_DEVELOPER_VERIFIED`。fail-loud 批次 1 已合入 main，合并提交 `a6a3fd3…`，分支尖端 `e841523b…`；仅开发机证据。清理辅助命令的 10 秒期限待 Win7 校准，诊断字段尚无界面读取方。Win7 实机为 `NOT_PERFORMED`。
- [A9-61](tasks/A9_61_CHECKPOINT_RESPONSIVENESS.md)：`A9_61_DEVELOPER_VERIFIED`。最终源`4ae74f32…`；产品`6c460fd9…`独审P0/P1为0，后继仅修测试清理。第6台Shell G0为76套件、1634 PASS，另12项慢项已同机补跑通过；Workspace新机271项与6000基线、Mac完整272项通过，专项25项及Mac Electron22/Node16真实入口5项通过。兄弟工作区pending秘密窗口已红绿闭环，shutdown P2按负责人决定保留。第6台已回收，凭据未漂移，短命密钥撤销。本轮授权本地main整合，保留无关dirty；Win7/Win10、门A/B、公开推送发布NOT_PERFORMED。原G0实际首FAIL及摘要纠正见任务书§11。
- [A9-60](tasks/A9_60_BULK_FILE_HANG_DIAGNOSIS.md)：诊断范围 COMPLETE。准确alpha.8开发构建 `d5b99b62…` / ZIP `36491b75…`，Win7 run `0c85c6b8…` 取得 `DEV_CHANNEL` PASS。512个虚构文件的CMD移动仅327ms，变更收尾5844ms，收尾阶段停止到终态5948ms；构造恢复状态后主线程最大停顿6135ms，最终ready、模型零重放。确认Checkpoint同步写入与校验可造成秒级假死；持续转圈未复现，故障机事故原因 UNKNOWN。首轮套件漏参FAIL保留，修正版10份证据核SHA，本run进程/任务0、测试沙箱已清理，旧四进程保留；窗口已关闭、容量例外已移除。产品修复、提交、推送、发布和门A/B均 NOT_PERFORMED。结果见本机 `outputs/a9-hang-diagnosis-r2/RESULT_FINAL.json`。
- [A9-59](tasks/A9_59_ALPHA8_CLOSEOUT.md)：`A9_59_DEVELOPER_VERIFIED`，当前alpha.8 Win7开发验证取得 `DEV_CHANNEL` PASS，窗口已关闭。源码 `d5b99b62…`、ZIP `36491b75…`、manifest `69431b11…`、run `29401f88…`；普通agent/Session1/Medium。14项产品检查与4项真实DeepSeek检查通过；当前保存模型deepseek-v4-flash，一条消息1011ms返回并可见。外部请求2、回环7、工具事件0，TLS1.3/证书授权/HTTP200，三份原配置SHA未变。3262文件、原生SQLite与正常退出通过，16份证据核SHA，两沙箱清理。本run进程/任务0，旧A9-57包4进程保留；锁inactive，根24.398GB低于本轮25GB，17.150分钟内收尾，例外已移除，剩余额度不沿用。未推送/发布；Win10、125%DPI、正式门A/B与负责人接受NOT_PERFORMED。证据在本机 `outputs/alpha8-win7-r1/RESULT_FINAL.json`，详见任务书§5.2～5.3。 收尾时出现的后续产品工作区差异保留，本结论只绑定上述ZIP，不覆盖后续修改。

- [ENGINEERING_03 §10.12](tasks/ENGINEERING_03_WIN7_DEV_CHANNEL.md#1012-agentsmd-文件整理实测准备2026-11-11-utc)：现有Agent按AGENTS.md文件名规则整理，在Win7普通agent取得专项 `DEV_CHANNEL` PASS。源 `99e1728d…`、ZIP `15b77c9c…`、run `2a55eed5…`；预览无副作用，确认后移动2份文件，5份保留源及冲突目标字节不变。1次产品尝试、8次真实模型HTTP200/TLS1.3，原配置哈希不变。产品执行轮保留 `completed_with_warnings/unverified`，外部字节核对单独PASS。首次退出清理标记false保留；进程结束后独立清理完成，SQLite完整、活动状态与任务/进程0、通道锁inactive，窗口15.154分钟内关闭。仅C盘隔离模拟桌面；真实桌面根、跨卷及新目标目录创建NOT_PERFORMED。产品未改，正式门A/B、提交推送与发布NOT_PERFORMED。证据在本机 `outputs/file-sort-win7-r1/RESULT_FINAL.json`。

- [A9-58](tasks/A9_58_HISTORY_SEARCH_AND_DELIVERY_CARDS.md)：`A9_58_DEVELOPER_VERIFIED`，Win7开发验证取得 `DEV_CHANNEL` PASS，窗口已关闭。准确私有提交 `99e1728d…`，开发ZIP `15b77c9c…`，run `21687dbe…`，普通agent/Session1/Medium；完整历史搜索、实际文件交付卡与Diff入口、运行中草稿/非空队列隔离及重启恢复共10项直接通过。3262文件、六模块、SQLite及正常退出通过，草稿密文存在且原始状态副本无已知中文草稿明文。1次产品尝试、4次回环、外部模型0；13份主证据大小/SHA与两图视觉核验通过。首传超时与前缀续传证明均保留。32.189分钟内收尾，进程/任务0、锁inactive、沙箱已删，开发根23.593GB低于本轮24GB；不延用剩余窗口或额度。原开发机独审/G0/G1保留，四项审查UNKNOWN未整体关闭。Win10、原生125%DPI、正式候选、门A/B与发布NOT_PERFORMED；main未提交或公开推送，原dirty/untracked保留，快照与默认实例未替换。证据见 [任务书§7.4](tasks/A9_58_HISTORY_SEARCH_AND_DELIVERY_CARDS.md#74-win7-开发验证完成与窗口关闭) 和本机 `outputs/a9-58-win7-dev-r1/RESULT_FINAL.json`、`CLOSEOUT.json`。

- [A9-57](tasks/A9_57_BROWSE_WHILE_RUNNING.md)：`A9_57_DEVELOPER_VERIFIED`。最终准确提交 `9c2f45b3…` 已整合到本地 main 工作区，保留既有 dirty/untracked。新增运行中只读浏览保持 A 的执行身份，B/C 只读历史不激活；草稿、未读完成标记和字符串计划边界已修复。独立审核机 G0 与 Mac G1 PASS，Mac Electron22 真实入口 8 组 PASS，外部模型请求 0，SQLite 完整且活动 task/turn/run 与锁均为 0。上述为开发机证据，Win7 后继开发验证见下段。同包 Win10、正式候选、门 A/B、公开推送和发布 `NOT_PERFORMED`。证据见 `outputs/a9-57-wp/CUMULATIVE_G1.json`、`INTEGRATION.json` 和任务书 §5.5。
  后继 Win7 开发验证取得 `DEV_CHANNEL` PASS，窗口已关闭。源码 `9c2f45b3…` / ZIP `a2309321…`，run `b61c096d…`，普通 agent/Session1/Medium；八组产品行为与非空中文草稿/历史/队列重启零重放通过，完整包3261文件与SQLite完整性通过。两次尝试共15次回环、外部模型0；首轮夹具漏 blocked 的 FAIL 与上传超时均保留。UTC `2026-11-10T08:55:33.548Z` 在44.090分钟内收尾，本轮进程/任务0、锁inactive、四个旧进程保留；根22.993GB低于本窗口23GB。稳定800像素浏览视觉NOT_VERIFIED，原生125%DPI/同包Win10/正式门A/B/发布NOT_PERFORMED。完整范围见 [A9-57 §6.7](tasks/A9_57_BROWSE_WHILE_RUNNING.md#67-第二次尝试完成与窗口关闭)，准确结果在本机 `outputs/a9-57-win7-dev-r2/RESULT.json`。

- [A9-56](tasks/A9_56_CHAT_ENTRY_AND_CONTEXT_MENU.md#5-开发机交付结果2026-11-09-utc)：`A9_56_DEVELOPER_VERIFIED`。源 `56129c8b…` 的七文件已合入本地main工作区，未提交/公开推送。新默认对话首发Full Access、底部常驻说明精简、行右键置顶/结束/恢复完成。原独审P1焦点缺口由主代理修复，新独审P0/P1为0；新机Shell G0 1549 PASS/12 skipped，Mac G1九项PASS，真实Electron22交互17项PASS。独审只签源码/内存探针，原生键盘由Mac直接检查。开发ZIP `b5eb2464…` / 110582812字节，3261文件与八入口PASS。三个临时机及部署密钥已回收，原dirty保留。新包未部署Win7；Win7/同包Win10、正式门A/B、发布NOT_PERFORMED。证据在本机 `outputs/a9-56-wp`。

- [A9-55](tasks/A9_55_DEFAULT_WORKDIR.md#97-win7-开发级运行完成2026-11-09-utc)：`A9_55_DEVELOPER_VERIFIED`；Win7开发级运行取得 `DEV_CHANNEL` PASS。源 `4c9adbcc…` / ZIP `6f3578f4…`，普通agent/Session1，run `3fd90770…`，真实Documents创建/重命名/目录外拒绝/重启零重放及A9-54完成提示、结束/恢复共16组通过。三次尝试中前两次夹具失败保留，第三次经负责人增加一次额度后通过；14次回环、外部模型0。36.53分钟收尾，SQLite integrity=ok、活动task/turn/run0、临时沙箱0、进程/任务0、锁inactive；开发根21.882GB低于本窗口23GB。两份前缀测试目录及文件保留，窗口和例外已关闭。原生选择器为受控返回值，真实系统选择器/同包Win10/原生125%DPI/正式门A/B/发布NOT_PERFORMED。公开CI42610841958后来FAIL，测试临时路径别名一行修复本地16/16通过但未推送；产品包未改。摘要在本机 `outputs/a9-55-wp/win7-r1/RESULT.json`。

- [A9-53](tasks/A9_53_ALPHA7_MULTIWORKSPACE_RELEASE.md#7-同字节公开与回下载核验2026-11-08-utc)：COMPLETE，`A9_53_WIN7_60_PASS_WITH_KNOWN_LIMITS`。负责人按 ADR-0320 甲限定接受并授权发布 alpha.7 / WIN7-60：源码 `22b575cc…`、ZIP `5b8ae87f…`、manifest `e39b88f0…`。同 ZIP Win7 DEV_CHANNEL 证据：多工作区 run `7949d383…` PASS（候选外驱动 `0a1f81c4…`），alpha.6 队列与 A9-49 可靠性回归 run `a25a26db…` PASS；前三次失败与根因保留。UTC `2026-11-08T11:45:00Z` 公开内部试用预发布，[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.7-win7-60)；4 个附件草稿与公开后各回下载一次，大小/SHA 与本地原件及 GitHub digest 一致。公开 CI run `42476340351` success。Win7 开发根 21.27 GB，高于默认 20 GB。已知限制 5 项见任务书 §6；门 A/B 未执行。准确接受与发布证据在本机 `outputs/alpha7-r1/publish/`。

- [A9-52](tasks/A9_52_MULTIWORKSPACE_CONVERSATIONS.md#5-收件箱式导航修订2026-11-08-utc开发机)：`A9_52_DEVELOPER_VERIFIED`。多工作区并行、目标绑定 IPC 与收件箱式导航已本地提交为 `7db11cd…`（代码与测试 20 个文件）。Mac 开发机 Shell 67/67 套件、1479 PASS / 12 跳过；真实 Electron 22 产品首轮 9 组、重启 1 组通过，覆盖收件箱切换、筛选菜单关闭后台工作区和命令面板重开。结果在 `outputs/a9-52-multiworkspace/INBOX_RESULT.json`。Win7/Win10、打包运行、Windows DPAPI 与 D-013 并发均 NOT_PERFORMED；未推送。

- [A9-51](tasks/A9_51_ALPHA6_QUEUE_RELEASE.md)：COMPLETE，`A9_51_WIN7_59_PASS_WITH_KNOWN_LIMITS`。负责人按 ADR-0318 限定接受 alpha.6 / WIN7-59。源码 `484baff4…` / ZIP `241af4ca…` / manifest `6abb2618…`，原证据为 Win7 DEV_CHANNEL run `94df7e6d…`。旧基线加全部后继差异独审 P0/P1 为 0，旧两项 P2 已关闭。UTC `2026-11-08T01:44:23Z` 公开内部试用预发布，[下载与说明](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.6-win7-59)。4 个附件公开后全部回下载，大小/SHA 与本地原件及 GitHub digest 一致；冻结 14 文件保持不变。正式 Gate A/B 未补签；未知恢复 PID 负向用例与最终包 Windows 可靠性组的覆盖限制见任务书 §10。完整接受与发布证据在 `outputs/alpha6-r1/publish/`。

- [A9-50](tasks/A9_50_QUEUED_INPUT.md#4-开发交付结果2026-11-07-utc)：`A9_50_DEVELOPER_VERIFIED`。Mac / Linux 开发机绑定 main `ef6a6922…` 加本轮未提交补丁。Composer 状态与显式 FIFO 队列完成，停止、失败和恢复后暂停；草稿不自动消费。cw Shell 集合 1465 PASS / 12 NOT_PERFORMED，最后 Stop/存储修正由 Mac 与 cw 各 142 项直接复验，其余未变组记 INHERITED_EVIDENCE。真实 Electron 22 main/preload/IPC/runtime/SQLite 两进程 6 组 PASS；三视口、草稿隔离、停止和重启不重放通过。cw 源码哈希与回收日志核验，任务进程与临时目录无残留，租约释放；原实例与登录保留，ci/monster 未操作。原 dirty 和 HEAD 保留。真实 Win7 DPAPI、Windows、正式门 A/B、提交、推送和发布均 NOT_PERFORMED。准确回执见本机 `outputs/a9-50-queue-r1/RESULT.json`。

- [ENGINEERING_06 §1.19](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#119-三台角色机-codex-独立账号登录2026-11-07-负责人后继确认)：开发机从各自角色快照恢复 chai2、cw、chai521 三台，并经本机 Chrome 完成 Codex 官方登录。绑定 main `ef6a6922…`；三台状态命令均退出 0、chatgpt、账号匹配，凭据 0600，登录进程与临时目录均无残留。负责人指定 chai2 与 chai521 共用一个账号，cw 使用另一账号。cw 设备码未启用，采用普通 OAuth，未修改账号安全设置。原快照保留，新登录只在当前实例；模型生成及重新建机后的登录恢复均 NOT_PERFORMED。首台旧流程中断及超时回执保留。准确实例、验证与恢复回执见本机 `outputs/instabox-role-snapshots-20261105/codex-login-20261107/RUN.json`；czl 与 ci/monster 未操作。
- [ENGINEERING_06 §1.18](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#118-monster-完整快照ci-排队释放与重开2026-11-06-负责人后继确认)：开发机保存 ci/monster 完整快照 `sn_agq3jh5sngsekutorcmajt27fy`，ready 后删除准确旧机释放唯一名额。四个既有排队 CI 均 success；从该快照重开 monster / `m_agq3jlb5gr2blsx3gxu4xoxhrm`，running/ready、vault=true，系统盘、数据盘与 HOME 检查 PASS。新机默认空闲暂停 1800 秒、最长运行 120 分钟；快照不恢复原进程内存，登录和旧任务恢复 NOT_VERIFIED。免费账号仍只有一台名额，重开的 monster 会占住后续 CI；准确回执和日志在本机 `outputs/instabox-ci-refresh-20261106/FINAL_RESULT.json`。
- [A9-49 §8.2](tasks/A9_49_RUNTIME_FAILURE_HARDENING.md#82-win7-开发级运行结果与收尾)：`A9_49_DEVELOPER_VERIFIED`，Win7 开发级验证取得 `DEV_CHANNEL` PASS。绑定 main `ef6a6922…`、开发 ZIP `dbc4f55d…` / manifest `186aa32f…`；包仍为 source_dirty=true、external_acceptance_eligible=false。普通 agent / Session 1 的 run `bcd96c89…` 使用 Electron 22.3.27 / Node 16.17.1，17 组 HTTP 与 17 项真实 main/preload/IPC 检查通过，覆盖正常入口和三种受限状态。回环请求 25 次、外部模型 0 次；SQLite integrity=ok，活动 task/turn/run、连接及本轮进程残留均为 0，沙箱已删除。13 份回收文件大小/SHA 与 212 个实际加载模块哈希复核通过；原 alpha.5 四进程保持、任务为空、锁 inactive。仅使用一个 run，UTC 09:47:48 完成后检；未调用 stop、close 或 --steal。既有开发机 Linux CI 的准确提交 `a1494791…` / run `42234498020` success 保留，恢复后未重跑。原件在本机 `outputs/a9-49-win7-dev-20261107/TARGET_RUN.json` 与 `outputs/win7-dev/a9-49-bcd96c89/RESULT.json`。同包 Win10、外部模型、正式候选、门 A/B、提交、公开推送和发布均为 NOT_PERFORMED。

- [A9-48](tasks/A9_48_ALPHA5_WORKBENCH_RELEASE.md#8-负责人验收通过与公开发布)：COMPLETE，`A9_48_WIN7_58_PASS_WITH_KNOWN_LIMITS`。负责人已验收并授权发布 alpha.5 / WIN7-58；源码 `498a8f5d…`、ZIP `d1ba4d37…`、111,170,123 字节、Win7 run `2061ce92…`。公开标签指向同一冻结源码，4 个附件保持原 ID/大小/SHA，发布后全部回下载核验一致。原同包 9 组 DEV_CHANNEL、103 项合同、3 项容量检查和发布规则 406 PASS / 16 NOT_PERFORMED 保留；三份构建字节一致。未重建、未替换附件或修改冻结快照。准确接受与发布后校验在本机 `outputs/alpha5-r1/publish/`。同包 Win10、原生 125% DPI、外部后端、正式门 A/B、完整 batch2/Review 与跨机可重复性仍未验证。

- [ENGINEERING_06 §1.17.1](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#1171-结果三个新角色快照恢复检查-pass)：Linux 开发机完成 chai2 审核、chai521 测试、cw 机动开发三份账号内 Snapshot，均 ready。绑定 main `305c100b…` 的锁文件，输入指纹 `062e3ff5…`；三个新恢复实例分别离线 npm ci 9/9 与真实 SQLite 查询 PASS，chai2 一次 Claude plan 请求返回 OK。六台本轮临时机全部回收，三个新增账号只保留快照；czl r4 与母机、ci/monster、Actions 配置保留。新快照无持久模型认证，cw 的 Codex 登录未配置；首个请求前参数失败保留。启动说明与准确 ID 在本机 `outputs/instabox-role-snapshots-20261105/ROLE_SNAPSHOTS.md`。产品测试、Windows、提交与推送均 NOT_PERFORMED。

- [A9-47](tasks/A9_47_DRAFT_WHILE_RUNNING.md#61-结果win7-dev_channel-通过)：`A9_47_DEVELOPER_VERIFIED`，Win7 草稿链路取得 `DEV_CHANNEL` PASS。沿用开发包 source `8d97d182…` / ZIP `9eeaa9ff…` / manifest `223bddd2…`，本轮产品源码和包未改；main `305c100b…` 及已有 dirty 保留。普通 agent / Session 1 的 run `24d96c23…` 以候选外锁定 Electron 加载包内真实 main/preload/IPC/runtime/SQLite，两进程 6 组通过：运行中起草与 Enter、草稿隔离和选择保留、结束后手动发送、停止、DPAPI 密文保存及重启恢复，零自动发送或重放。四个准确 CSS 视口通过，实际 DPR=1；5 次回环请求、外部模型 0。SQLite integrity=ok，活动 task/turn/run 均为 0；11 个回收文件 SHA/大小复核，沙箱已删除，后检进程/任务 0、锁 inactive。新驱动本地 6 组直接通过；原七模块编译、Shell lint、51/51 定向合同按未变字节记 INHERITED_EVIDENCE。原失败保留，窗口已关闭。摘要在本机 `outputs/a9-47-draft-r1/win7-r4/RESULT.json`；原 Mac 结果在 `outputs/a9-47-draft-r1/RESULT.json`。同包 Win10、原生 125% DPI、外部模型、正式门 A/B、推送与发布仍为 NOT_PERFORMED。 本次功能已随 alpha.5 / WIN7-58 验收并发布；此前段落中的未发布记录是该开发阶段事实，当前结论见 A9-48 §8。
- [A9-46](tasks/A9_46_WORKBENCH_MINIMAL_INCREMENT.md#59-新开发包与-win7-真实异常链路窗口2026-11-06-utc)：`A9_46_DEVELOPER_VERIFIED`，新包 Win7 真实异常链路为 `DEV_CHANNEL` PASS。本地范围提交 source `bdb28e40…`，Mac 跨平台装配新 ZIP `9022d25d…` / manifest `210ddb3e…`；3257 个 manifest 文件校验，原生字节未变。Win7 普通用户 agent / Session 1 的 run `a3ac3882…` 中，候选外锁定 Electron 加载包内真实 main/preload/IPC/runtime/Git/SQLite，两进程共 9 组通过：Git clean/dirty/ahead/behind、目录失败后重试、读取失败、问询取消、审批拒绝零执行及重启恢复。8 次回环请求、外部模型 0；SQLite integrity=ok，活动 task/turn/run 均为 0。6 个文件回收复算 SHA，最后核对 78 项输入哈希不变、测试临时目录为空；后检进程/任务 0、锁 inactive。仅使用 1 次运行，第二次未使用，窗口已关闭。原 §5.7 的 11 组产品/8 组显式桩/六视口证据和所有失败保留；本轮结果不升级为正式 Win7 PASS。摘要在 `outputs/a9-46-workbench-r1/win7-negative-r1/RESULT.json`。原 Mac 49 项定向合同直接通过；其他任务 dirty 保留。原生 125% DPI、真实 Shell 停止、未知生命周期终态、外部模型、同包 Win10、正式门 A/B、推送与发布仍为 NOT_PERFORMED。 本次功能已随 alpha.5 / WIN7-58 验收并发布；此前段落中的未发布记录是该开发阶段事实，当前结论见 A9-48 §8。
- [A9-45](tasks/A9_45_SYSTEM_MESSAGE_COMPATIBILITY.md#8-最终开发机交付与工作流结果)：严格模板 system 兼容修复及 InstaBox 工作流已取得 A9_45_DEVELOPER_VERIFIED，绑定最终提交 `3de9bee8…`。新计算机 Gateway G0 与最终提交 Mac G1 均为 19 组、305 项 PASS；产品源码独审 P0=0/P1=0 按准确未变字节记 INHERITED_EVIDENCE，后继两行 J1 旧断言由执行代理核对并直接回归。旧 G0/G1 FAIL 保留。私有 `box/sys400c` 与本地 `a9-45-system-message` 已交付，当前 main 四个修复文件同字节未提交；原 HEAD 和已有修改保留。累计三台工作机全部回收，21 个作业日志及临时目录核验 PASS，母机暂停、部署密钥为空；本次补跑新增模型调用为 0。真实同事后端、Win10/Win7、打包和发布均 NOT_PERFORMED。

- 2026-11-02 暗色主题含 CI 串跑：整体 BLOCKED，见 [ENGINEERING_06 §1.13.1](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md)。执行代理在开发机完成 Codex 执行、包装器提交、私有推送、Claude 独审 P0=0/P1=0、新审核机 G0 与 Mac G1，绑定 `6f4f070c…`；仅新增 CI 配置，产品 `7e45ee5c…` 字节未变。G0 为 63 组、1429 PASS、12 省略；G1 九项 PASS，未重复 shell 测试。
  私有 [CI run 41449669106](https://github.com/allin2/win7-coding-agent-staging/actions/runs/41449669106) 等待超过 240 秒未分配 instabox-medium，执行代理已取消；runner_id=0、steps=[]，CI 测试 NOT_PERFORMED，调度根因 UNKNOWN。下一步须从已有 InstaBox 登录会话的 CI 页读取 waiting/refused 原因；未扩大 App 权限、添加 secrets 或推送公开产品。CI 配置仅在私有 `box/theme-ci-r1`，主分支 CI 未落地。
  CI 复验（fingerprint 降级修复）[run 41554855640](https://github.com/allin2/win7-coding-agent-staging/actions/runs/41554855640) conclusion=success，见 [任务书 §1.13.2](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#1132-ci-复验fingerprint-降级修复后全链路通过2026-11-02-后继)。`box/theme-ci-r2` 提交 `41f7301…` 仅改 `fingerprint.py`：缺失 CLI 降级 `null`，保留严格 `inputs` 指纹；主题测试 23 项 PASS，`test_wp.py` 54 项 PASS。原 BLOCKED 不改判；主分支 CI 未落地。
  两台工作机已删除，staging 部署密钥为空，母机保持暂停；11 个作业日志与临时目录检查 PASS，凭据元数据未变，无令牌落入回收文件。本轮继承准确源码/包的既有 Win7 DEV_CHANNEL 证据；未新增构建或目标运行。结果在本机 `outputs/eng06-theme-ci-r1/`，历史产品与发布状态保持。

- [ENGINEERING_06](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#3-当前结果)：执行代理已完成四账号身份核对、ci 单机环境准备、Claude Code 与 Codex 官方登录，以及私有分支文件流转模拟。
  证据层级为开发机，基线 `bd69a4b6…`，模拟提交 `b5572f9d…`；Mac 核对四文件哈希和环境输入指纹一致，产品文件改动为 0。
  ci 模拟阶段真实模型请求为 0；独立模型审核、Win10 和 Win7 均为 NOT_PERFORMED。Linux 日常集合与 Box 文档检查的 FAIL 保留，未进入修复。
  临时 staging 写入凭据已撤销；ci Box 自动删除时间为 UTC `2026-10-31T10:50:10Z`。暂停不取消该期限；本轮未向公开 origin 推送或提交本地 main。
  后继 czl 母机已保留 Claude Code、Codex、agy 官方登录；负责人完成 T3 Connect 网页授权后，执行代理核对通道可达。
  czl 私有完整镜像 `eng06-czl-base-r1-20261031` 已保存，ID `sn_agqzcjtcjpqyjt5xxcfn3cdwam`，status=ready；保存后母机服务与认证边界检查 PASS，均为开发机证据。镜像恢复验证为 NOT_PERFORMED，见 [任务书 §3.3](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#33-czl-母机配置与私有镜像前置)。
  czl 没有设置自动删除期限。执行代理误发 agy `config` 后已终止会话，未批准其命令；该阶段提交模型轮次为 1，供应商内部请求数 UNKNOWN，详见 §3.3。
  后继单机试跑已完成环境准备、检查与私有报告交换，见 [任务书 §3.4](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#34-czl-项目环境与工作流试跑)。产品基线 `bd69a4b6…`，报告提交 `3e87a552…`；Node `20.17.0`、九处依赖、SQLite 和七模块构建为开发机 PASS，输入指纹 `af2b312e…` 与 Mac 一致。
  czl 日常集合与文档检查仍为开发机 FAIL，分别复现路径大小写用例和历史 Git 对象缺失。原始日志已回收，测试沙箱已删除。Mac 的 Linked environments 关闭，T3 跨机器模型派单 BLOCKED；本轮无模型工作包。
  母机已登记本项目，T3 ACP 工件和独立凭据存在，调用为 NOT_VERIFIED。私有报告回收校验完成，临时部署密钥已撤销并删除；未合入 main，未更新旧快照。
  负责人选定 D7：`docs:check` 移到 Mac 的 G1。r4 设计稿已写出；D8 已裁决为甲（每账号一份登录快照，按需建机、用完删，撤回常驻 Worker），D9 采用推荐项甲（Linux 上省略大小写用例，后继实现与验证见 §1.5、§1.6），见 [任务书 §3.5](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#35-工作流-r4-设计与-d7-裁决)。
  登录快照克隆验证第三次结论为 PASS（开发机）：两台克隆同时各发 1 次 Codex 与 Claude Code 最短请求，4 次均返回 OK，克隆已删除，母机保持暂停。刷新轮换下的并发安全 UNKNOWN，母机登录是否受影响 UNKNOWN，见 [任务书 §1.4](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#14-czl-登录快照克隆验证2026-10-31-后继指示)。
  workflow r4 的 P0 必需项全部 PASS，见 [任务书 §1.6](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#16-workflow-r4-的远端验证先-p0后-p12026-10-31-后继指示)。执行代理在开发机完成 Node 准备、错误 SHA 拒绝、丢失回执恢复、Linux workspace G0 与 Mac G1，绑定私有提交 `f693c415…`。
  甲只建 1 台，模型请求为 0；工作机已删除，只剩 suspended 母机，staging 部署密钥为空。传输失败与同机人工恢复事实保留，网络根因 UNKNOWN。
  本地工具未提交；cloud 17 项、box_job 9 项、wp 33 项离线测试 PASS。新增 Git 元数据目录检查后，审核组 8 项 PASS。乙的 p1a 执行任务 FAIL：Codex 写入探针，但 `git add` 遇到 Git 元数据只读错误，没有新提交。CLI 退出 0 不计任务 PASS；实际参数已含包内 `--add-dir`，沙箱策略根因 UNKNOWN。
  乙仅调用 1 次 Codex，33.382 秒；Claude Code 审核、G0、推送与 G1 均为 NOT_PERFORMED。执行代理已回收并校验探针与最终报告，凭据元数据无变化。p1a 工作机已删；最终核对只剩 suspended 母机、部署密钥为空、临时目录为空。Mac 文档检查 PASS；重试需新执行调用预算。
  负责人后继目标为先跑通工作流，再通过工作流开发暗色主题。执行代理已准备包装器提交候选，见任务书 §1.7；开发机真实 Git 检查 10 项 PASS，绑定 `bd69a4b6…`。Codex 官方文档及固定版本源码支持 Git 元数据受保护的原因分析；旧 FAIL/UNKNOWN 保留。提交职责变化和新执行额度尚未裁决，候选未接入工具，未新增远端或模型调用。
  后继负责人已确认包装器提交与有界重跑，见任务书 §1.8。执行代理已接入 `wp.py commit --manifest`；Codex 保留 workspace-write，只修改、自检和报告。安装后真实 Git 10 项、工作包工具 37 项开发机检查 PASS，无新增临时目录残留，绑定 `bd69a4b6…` 与未提交工具字节。新任务为 p1r2a/p1r2b，串行最多两台，执行与审核各一次、各 900 秒；只推私有 `box/p1r2a`。此前“尚未裁决”是准备阶段事实，后继授权已生效。
  本轮结果为 BLOCKED_LOGIN，见 [任务书 §1.8.1](tasks/ENGINEERING_06_INSTABOX_ENVIRONMENT.md#181-有界重跑结果执行-2026-10-31-utc收尾-2026-11-01-utc)。执行代理完成 Codex 执行、包装器提交、G0、私有推送与 Mac G1；开发机交付为 `b9ecdb7c…`，G0 state 25 组、391 项测试 PASS。Claude Code 审核一次即报 OAuth 会话过期且刷新失败，内容审核 NOT_PERFORMED；执行代理未重试。两台工作机均已删，凭据元数据未变；最终只剩 suspended 母机，部署密钥和本次临时目录为空。完整工作流尚未通过，暗色主题未进入实现；两次调用额度已消耗。Win10 与 Win7 为 NOT_PERFORMED；本地 main 未提交，公开 origin 未推送。
  负责人后继批准仅补独立审核，见任务书 §1.9。新任务 p1r3b 最多建一台审核机，官方 Claude 登录一次、900 秒；允许该机预期登录凭据更新，再只读审核一次、900 秒。母机继续暂停，不更新快照，不重跑执行或 G0/G1，不推送。旧 BLOCKED_LOGIN 保留。
  后继组合工作流为开发机 PASS，绑定 `b9ecdb7c…`，见任务书 §1.9.1。官方登录一次成功，Claude Code 独立审核一次为 P0=0、P1=0；审核后凭据与新基线一致，工作区未变。审核曾额外使用只读 od/head 字节检查，任务单偏差已登记。执行代理核验全部日志后删除审核机；只剩 suspended 母机，无部署密钥或本次临时残留，私有 refs 未变。该结论仅限工作流探针；长期登录复用 UNKNOWN，暗色主题仍待 Demo 与后继范围。
- [A9-44](tasks/A9_44_WORKBENCH_DARK_THEME.md#95-按负责人后继指令集成本地-main)：执行代理已登记 A9_44_DEVELOPER_VERIFIED，绑定开发机提交 `7e45ee5c…`。负责人要求“按照工作流推进”后，执行代理已将该准确提交快速前进集成本地 main；本地交付分支继续为 `a9-44-dark-theme`。
  Box G0、Mac G1、真实 Electron 17 项、界面 14 项、颜色 14 组及窄窗补查均 PASS，原结果见任务书 §8。
  负责人通过 grilling 批准的后继官方登录 PASS；Claude Code 独立代码审核一次、155.533 秒，P0=0、P1=0。
  负责人选择“甲：接受本次结果 (Recommended)”，接受提案绑定 `47d4138e…`。独立审核的原始约束读取证据仍为 NOT_VERIFIED，本次接受不建立长期豁免。
  执行代理核验五作业日志及只读行为后删除审核机。核对时只剩暂停母机，无部署密钥或本次临时目录残留，审核后凭据及工作区未变。
  准确确认与后继组合结果见本机 `outputs/a9-44-dark-theme-review-r3/OWNER_ACCEPTANCE.json` 和同目录 `FINAL_RESULT.json`。本次未新增机器、登录或模型调用，未重跑已通过检查。
  本地集成回执见本机 `outputs/a9-44-local-integration-r1/INTEGRATION_RESULT.json`。九文件与目标提交一致，原有本地文件内容保全，三个同名字节相同文件的原副本与权限已保留；执行代理采用目标 `prepare-linux.sh` 的 0755 权限。执行代理未新建提交或改写历史，暂存区为空。
  执行代理后继完成单次开发构建，源码 `7e45ee5c…`，ZIP `da7cbc74…`，110537425 字节，见 [任务书 §9.6](tasks/A9_44_WORKBENCH_DARK_THEME.md#96-单次开发构建与新-zip-直接校验)。七模块重新编译，3257 个清单文件、新包三个主题文件及八个 JavaScript 入口加载检查 PASS。执行记录和开发包在本机 `outputs/a9-44-developer-package-r3/`；构建沙箱已删除，主工作区保全。
  该包沿用 A9-32 开发 Profile 的 alpha.2 标签，`external_acceptance_eligible=false`，没有新候选号。两轮打包前失败保留，打包器总调用为 1。
  执行代理已完成 Win7 主题增量开发级运行，见 [任务书 §9.14](tasks/A9_44_WORKBENCH_DARK_THEME.md#914-新窗口主题增量完成dev_channel)。准确源码 `7e45ee5c…`、包 `da7cbc74…`、run `3b726a4b…`；证据层级为 Win7 实机 DEV_CHANNEL，28 项诊断检查为 PASS。真实包内 main/preload/Renderer 完成浅色默认、切换暗色、正常退出、同 profile 重启恢复暗色、改回浅色及正常退出；隔离取证、无 Provider 保存、无模型请求检查均 PASS。
  3257 个清单文件逐项 SHA、SQLite 3.43.1 内存查询和六模块加载直接 PASS。11 个回收文件通过秘密扫描、大小与 SHA 核验；四张截图已逐张查看，视觉检查 PASS。完整结果在本机 `outputs/win7-dev/a9-44-3b726a4b-c647-4f33-8bb2-986a6e80295f/FINAL_DEV_CHANNEL_RESULT.json`。
  最终 status 于 UTC `2026-11-01T10:32:40.480Z` 确认零进程、零任务、锁空闲、无解包未知；开发根 34,476,442,461 字节，C: 剩余 853,396,860,928 字节。本窗口已提前收尾；真实模型请求、新构建、审核、Box、登录及 ZIP 重传均为 0；未使用 stop 或 close，历史与本 run 文件保留。
  旧 run `0f817a86…` 的容量/锁准入 BLOCKED、候选外 preload 断言 FAIL 与第二轮时间门停止均保留，见任务书 §9.8～§9.12。新窗口仅修候选外取证，产品字节未变。任务 Phase-Gate 保持 A9_44_DEVELOPER_VERIFIED，Win7-Validation 为 DEV_CHANNEL。未选择工作区，未运行 Runner、Office、真实模型或 Win7 首屏逐帧录像；正式验收、冻结、门 A/B、Win10、公开 origin 推送、PR 与发布均为 NOT_PERFORMED。
- [A9-43](tasks/A9_43_ALPHA3_WIN7_56_RELEASE.md)：`v0.3.0-alpha.3` / WIN7-56 已签发并发布，任务 COMPLETE；当前结果见 §8.29–§8.36。
  同源 `251dbdf4059bfd484d7bfaf1af4945bf45b4995e`、r16 ZIP `11f85358…` 五阶段全部直接完成，结果 DEV_CHANNEL_COMPLETE：batch2、后台恢复、便携、完整 Office/轻量工具/UI、真实模型。
  batch2 `2bedc0ce…` 为 10/10 阶段、37/37 用例、67/67 断言及 GPU PASS，0 失败尝试；1582 文件回收校验、R8 收尾通过。其他阶段逐一核对绑定与收尾，便携及 Office 四张截图已检查。
  最后模型 `80e665a5…` 五场景 PASS，16 次 HTTP200/TLS1.3；原件及默认 Provider 三文件哈希未变。外部读取观察器已在实际完整链证明，不改判 r15 的 S2 FAIL。
  本窗口首探测 `49a4a3ac…` 分类 chat_only/HALTED，原失败保留；有界新 run `42057c62…` 五场景 PASS，独立诊断没有并入版本阶段数组。
  第五窗口已于 UTC `2026-10-31T02:26:32.731Z` 收尾：零任务/进程、锁 idle、无解包未知；累计 22477.184/24300 秒、49/60 模型请求，开发根 33.07/35 GB。本窗口新增删除 NOT_PERFORMED，历史证据全部保留。
  负责人明确报告 r16“试用通过”（OWNER_REPORTED），见 §8.31。两份新干净构建与实机/试用包逐字节相同，3275 成员内容一致，缺失/额外/变化为 0；原生输入未变。
  WIN7-56 于 UTC `02:36:55.289` 本地只读冻结，15 文件哈希与权限复核通过；原冻结回执与五阶段汇总保留原状态，不回写。后继接受结论以 `outputs/next-version-r1/signoff-r1/SIGNOFF_RESULT.json` 为准。
  负责人要求审核和签发后，独立证据审核已完成：产品 P0/P1 零项，支持精确候选已证明范围的接受建议；签发控制 P1 一项、非阻断 P2 三项，见 §8.34。
  负责人回复“批准，按该材料签发”，准确确认提案 SHA `c3e06785…`；ADR-0311 已 Accepted。一次合并独立审核和一次负责人验收决定替代本候选标准门 A/B 执行顺序，签发 `A9_43_WIN7_56_PASS_WITH_KNOWN_LIMITS`；原 DEV 标签和旧门 A/B 未执行事实保持。
  签发结论与确认在 `outputs/next-version-r1/signoff-r1/`。M1～M6、Win10 验证、完整 Review、Office 保真和正式性能预算限制随发布保留。
  负责人选择推送、发布和证据整理三项后，main 的 36 个提交已推送至 `d7a57062…`。标签准确绑定产品源码 `251dbdf4…`，预发布附件与冻结字节一致。发布事实在 `outputs/next-version-r1/publication-r1/PUBLICATION_RESULT.json`；本节后继文档提交随 main 交付，最终远端身份见同目录 `FINAL_CLOSEOUT.json`。
  开发机完整发布组重跑为 410 项、394 PASS、0 FAIL、16 NOT_PERFORMED。首次缺少编译输出的 7 项失败保留；补齐七模块编译后，12 项消费者及完整组通过，无产品源码或发布包变化。
  本地证据归档约 300 MB，2607 个原文件已实际恢复并逐项核对 SHA，恢复源码通过 Git 完整性检查。全部原件与 26 个注册工作树保留；新增产物沿用 `publication-r1/retained-artifacts.json` 台账。本轮无新目标运行、模型请求或删除，旧 35 GB 例外不自动沿用。
  后继本机清理已按负责人“开始清理了”执行，见 §8.37。43 项副本、14.82 GB 逻辑占用已逐项移至指定回收位置；12 个干净工作树由 Git 正常移除，分支保留。现有 14 个注册工作树，含 main 与 13 个脏工作树。原有 8 份修改、共享依赖、冻结候选和完整归档复核未变。可用空间观察从 7.931 GB 增至 11.794 GB；回收位置未清空，不能将移动量计为磁盘释放。准确原路径与恢复位置见 `cleanup-assessment-r1/execution-r1/RESTORE_MAP.json`。本轮未连接 Win7，未提交或推送。
- [A9-42](tasks/A9_42_LIGHTWEIGHT_AGENT_TOOLS.md)：六项轻量能力已完成本地开发交付，包括编辑反馈、环境信息、Skills、ask_user、图片和Office Lite。
  [Office Lite](plans/A9_42_OFFICE_LITE_SCOPE.md) 支持DOCX/XLSX有界读取、新稿和内容级修改副本；详细格式/保真边界及开发验证见任务书§4。
  当前开发包源 `5143b9cf50f6ef598eda0d0b4e2fae17347f08d9`，r4 ZIP SHA-256 `84585361…1dc063`，external_acceptance_eligible=false。
  Win7开发增量范围已覆盖：问询回答、Office生成/读取/哈希副本、真实工具记录和界面撤销引用同包run `a942o-b12c6d8e`，标INHERITED_EVIDENCE。
  本窗口run `a942o-2e94bc71` 直接完成取消、迟到回复拒绝、同批不执行、SQL cancelled事实及正常退出；独立postflight为QUESTION_CANCEL_DEV_CHANNEL_COMPLETE，见任务书§7.13。
  本次仅2次本机夹具请求、0真实模型。最后目标status于UTC23:55:33.270结束：根内零进程/任务、锁inactive、无解包标记；准确搜狗环境实例按ADR-0297保留。
  原包/运行副本完整性已直接核对，组件字节不变；历史失败和中断全部保留。两场景不改写为一次完整Office GUI旅程PASS。
  取证驱动抽屉顺序修复已本地保存为 `9b2e963…`，13项驱动与Electron22/Node16原生交互4项PASS；该修正后单次完整Win7旅程仍NOT_PERFORMED。
  真实模型、正式Gate A/B、长期资源预算、负责人实际使用验收、推送发布仍NOT_PERFORMED。完整release组11项历史FAIL与5项未执行不改判；前序包与全部验证见任务书§4～§7。
  负责人已批准产品直连试用及有界延长，原中继材料保留。首run a942r-8226e8de直接证明Win7真实DPAPI恢复、默认TLS1.3和tool_calling探测；原配置三文件hash不变、正常退出及独立postflight完成。
  实际6次请求，probe200后五任务均400；根因为ask_user内部数组Schema没有转成标准JSON Schema，原5项FAIL保留，见任务书§8.6。
  Gateway最小修复已提交08e41400…，回归21项及实际Electron22/Node16四项PASS；新开发包r5 ZIP cd4a428b…3987da9，仅GatewayJS和两元数据变化，原生不变。
  修复包首次a942r-f6440f58在模型请求前HALTED，触发原因UNKNOWN；原记录保留。候选外控制器补首异常持久化，0模型启动诊断及独立postflight完成，身份/进程硬门不变。
  新r5功能run a942r-542263b5在Win7普通agent真实产品链完成S1 DOCX读取、S2 XLSX转报告、S3修改副本、S4问询回答、S5取消/迟到拒绝，5项直接PASS，见§8.10。
  该run18次HTTP200/TLS1.3，连同原6次累计24次；正常退出、原件/原配置hash不变、独立postflight及最终根内零进程/任务/锁inactive均已直接证明。最后目标动作04:19:17.910Z，实际约51.8分钟，窗口已关闭。
  资源取得启动/60秒空闲与任务采样，只作开发基线，不签正式性能预算。原§7单次含UI撤销的完整旅程、正式Gate、负责人使用验收和发布未执行。原失败与旧包不改判。
- [A9-41](tasks/A9_41_WORKBENCH_UI_POLISH.md)：负责人批准本地工作台 UI 优化并开启 GPT 重置模式 fast。
  长标题开关、窄窗焦点、导航及状态可读性优化已随批准清单保存为产品提交 `100f8db4…`，进入上述A9-42开发包。
  开发机定向测试 73 PASS、Renderer 桩交互 14 PASS保持原证据；已随A9-42补Win7普通agent真实启动/关闭与同包6视口焦点检查，只作DEV_CHANNEL，见任务书§4.6。
  未采用字体候选；正式验收、完整用户使用与发布仍为 NOT_PERFORMED。
- 本轮 [ENGINEERING_05](tasks/ENGINEERING_05_ALPHA_DELIVERY.md)：规则和日常入口已落地，真实 Win7 锁 bug 已修复；第二轮（ADR-0291）把日常集合降到 107.74 秒并加 Node ABI 前置。
  第一批 20 项清理完成；第二、三批归档核验后经负责人批准删除 1,143,164 个原件，df 可用空间增加 10.94 GB。ADR-0290 授权在 main 连续执行；未授权产品推送、发布或正式签发。
  本轮本地工作树整合已保存 21 个未提交文件并核销旧治理差异；139 个材料根已在工作树外核验保留。
  剩余文档合流已完成；负责人确认后，314e 与整合工作树已逐个通过 Git 移除，现仅保留 main 工作树。
  分支和恢复归档继续保留；WIN7-55 候选和证据 2026-11-08 起只在外置加密归档 `archive-20261108-space-r2`，见 [恢复说明](acceptance/EXTERNAL_ARCHIVE_RESTORE.md)。常设开发通道原文保持；A9-34/A9-40 的 main 例外见 ENGINEERING_03 §10.5。
- [ENGINEERING_03](tasks/ENGINEERING_03_WIN7_DEV_CHANNEL.md)：已登记 Win7 开发通道，目标运行仍核对有效签发、主机/身份、锁和预算。本轮不继承他人的活动锁。
- [A9-34](tasks/A9_34_RECOVERED_CLEANUP_DISPOSITION.md)：2026-10-27 负责人批准方案 U（ADR-0294），为重启恢复的“清理未确认”后台事实提供用户确认处置出口。
  开发机检查及 Win7 开发试用链路已完成：异常恢复、取消与确认、事件和事实落盘、操作恢复、正常关闭及再次重启保持均有直接证据。结果只作 DEV_CHANNEL，见 A9-40 §5.12～§5.13；WIN7-55 结论不变。
- ENGINEERING_04 为待审 RC 方案，未整体批准。其余历史任务与未闭合义务见 [任务索引](tasks/README.md)，不自动开放历史草案。
- [A9-40](tasks/A9_40_BACKGROUND_PROGRESS_VISIBILITY.md)：产品源码为本地提交 `f68b6c8e…`，开发 ZIP `efccd14a…2469bcc`。2026-10-28 Win7 普通用户联合运行已完成迟到输出自动显示、自然退出控件恢复、SQLite 持久化与 A9-34 恢复链路；正常阶段均经产品关闭释放锁。确认框实际图像已定向补证，结果只作 DEV_CHANNEL。历史 HALTED 保留，准确绑定见 §5.12～§5.13。
  同字节 ZIP、校验值与独立数据目录试用说明已整理到 `outputs/a9-34-main-integration/a9-3440-owner-handoff-20261028-r1/`，见 [§5.14](tasks/A9_40_BACKGROUND_PROGRESS_VISIBILITY.md#514-本地试用交付材料)。负责人实际使用验收为 NOT_PERFORMED。
  原始输入路径已在 main `158a737f…` 的干净源码上完成开发重建，新 ZIP `1e8fb772…48f9429`。与上述实机试用包相比，781 文件相同，仅三份追溯元数据变化，后台进展与恢复链路引用 INHERITED_EVIDENCE。新包已直接完成 Win7 普通用户 portable 初始化、Read Only 首次选择、真实鼠标新建对话、持久化、正常退出和释放锁，结果只作 DEV_CHANNEL，见 [§5.17～§5.19](tasks/A9_40_BACKGROUND_PROGRESS_VISIBILITY.md#517-原始输入路径开发重建与证据适用性)。

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

- A9-34/A9-40 该轮获准的开发试用已完成，原目标窗口已关闭。最后开发根零进程、零任务、锁 inactive；准确 SGTool 环境实例按 ADR-0297 保留，不声称其同步退出。该轮真实模型请求 0 次，证据见 [A9-40 §5.13](tasks/A9_40_BACKGROUND_PROGRESS_VISIBILITY.md#513-视觉补证与本轮收尾)；当前发布入口见页首。
  原始 Runner BuildA/BuildB ZIP 已从原 Win10 `192.168.1.13` 取回到 `.acceptance/deps/a9-v26-managed-r3-original/`，输入缺失阻断已解除。正常输入路径开发打包及新包 portable 最短链路已完成，未重编原生或改锁。新增窗口于 UTC `15:45:08` 收尾，零根内进程/任务、锁 inactive；准确 SGTool 环境实例仍按 ADR-0297 保留。负责人使用验收为 NOT_PERFORMED，正式构建与门 A/B 未开放，见 [§5.16～§5.19](tasks/A9_40_BACKGROUND_PROGRESS_VISIBILITY.md#516-原始-runner-双返回恢复完成)。
- 第一批 20 文件已按批准清单删除；物理净释放未证实（APFS 克隆使重复 ZIP 删除几乎不释放）。
- 第二轮删除清单 SHA `9c78aac6…9368` 已执行，0 失败；原件实际物理释放约 6.9 GB，低于已分配 16.52 GB，原因 UNKNOWN，见 ENGINEERING_05。
- 新需求范围、重大架构/产品权限语义、系统权限/配置、超预算、正式签发、产品推送及发布仍单独决定。
- 数据损坏、凭据泄露、越权、失控进程、目标平台无法运行阻断依赖交付；非阻断缺陷明确列出后供负责人验收。
- 本轮开发机结果、Win7 开发结果及未执行项只在 ENGINEERING_05 维护。用户接受为 NOT_PERFORMED，等待交付后验收。

## 历史与恢复

旧 STATUS 原文及任务索引旧流水迁入 [STATUS_LOG](STATUS_LOG.md#2026-10-26-迁入的原-status全文历史快照)，保留原时间点结论。
历史候选和原始证据恢复见 [归档取回](acceptance/EVIDENCE_ARCHIVE_RETRIEVAL.md)。
`status/latest-validation.json` 是 A1–A3 历史记录，绑定 `b2019f022f910b2b8df150ad94c3bccdefa1fa7b`，不表示当前 Alpha 状态。
