# A9-48 — alpha.5 工作台与运行中草稿发布

```text
Status: COMPLETE
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: b0af55d283b2796fe83b9635f8ff6a2dc1ef30fc
Target Version: 0.3.0-alpha.5
Candidate: WIN7-58
Phase-Gate: A9_48_WIN7_58_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 授权与结果

负责人明确要求“按照这个流程推动，关键决策也由你决定，我来验收”。
本次从 main 收口 A9-46 与 A9-47，构建准确新版发布包，完成同包 Win7 增量验证、双干净构建和只读冻结，
准备源码、标签与 GitHub 内部试用预发布草稿，交负责人验收。验收前保持草稿，不代负责人签署接受。
验收后公开同一已验收字节，不在发布时重建。

原 HEAD `305c100b…` 与远端 `93ae2535…` 的下载说明已普通合并为上述基线；不改写历史。
原 23 个 dirty/untracked 文件的原件、差异与哈希在本机 `outputs/alpha5-r1/before/`。
只收录本次产品、合同与发布需要的明确文件/文档段落，其他会话工作保持原字节和未提交状态。

## 2. 版本与边界

- 版本 0.3.0-alpha.5，候选 WIN7-58，标签 `v0.3.0-alpha.5-win7-58`；已核对远端无冲突。
- 包含 A9-46 工作台反馈、查找、耗时和工具终态，以及 A9-47 运行中草稿与手动发送。
- 保留主题和 system 合并；不新增队列、转向、并发、权限、数据库格式或依赖。
- 新增准确发布 Profile、锁与运行时身份白名单；历史 WIN7-56/57 和冻结证据不改。
- Electron、SQLite、managed helper 的输入和批准注册表不变；按哈希继承原生，不重编 helper。
- 依据 ADR-0315，仅本版采用一次 Win7 最短组合链路加负责人合并验收，替代门 A/B。
  证据仍为 DEV_CHANNEL，不回填 FORMAL。

## 3. 检查与执行预算

先验证 Profile、包运行时的准确身份和串号拒绝，再按依赖编译，完成受影响合同和项目发布检查。
从准确干净提交构建，新包直接核清单、包内模块自加载、原生绑定、许可证和 SBOM。
同包验证真实 main/preload/IPC/runtime/SQLite 的草稿、手动发送、停止、DPAPI 重启与零重放，
并覆盖 A9-46 查找/耗时/真实工具终态、主题恢复及严格模板首句/工具续步。
未变化且适用的证据按准确字节记 INHERITED_EVIDENCE。
两次独立干净构建与实机测试包逐字节一致后，冻结同一产物。

目标 DCCS-CHAIZL-PC / Win7 SP1 x64 build 7601 / `192.168.1.9`，严格主机键与普通 agent 桌面。
仅当前 `C:\A9-DEV` run 与通道记录；默认根 20 GB、剩余至少 50 GB。
代理选择一个 60 分钟窗口、最多两次有界 run，最后 10 分钟不开新场景；首次远端写入计时。
零外部模型、最多 20 次回环请求，无新 Box/登录/模型费用。
同范围局部修复形成新输入后可有界重试；身份、完整性、安全或生命周期未知立即停止下游。
同类失败两轮未解释先最小诊断；主机不可达只暂停目标动作，继续本地工作。
不接管他人锁、不改系统或 DPI、不终止根外进程、不删除历史，不 close 整个开发根。

## 4. 交付与限制

交付准确源码、冻结 ZIP、SHA256SUMS、发布说明、验证/继承矩阵、回退说明和验收清单。
草稿附件回下载核 SHA，验收后发布同一附件。
同包 Win10、原生 125% DPI、外部后端、完整 Review、完整 batch2 和跨机可重复性仍为
NOT_PERFORMED/既有已知限制，不宣称完整 Alpha、RC 或稳定版。
本轮证据集中在本机 `outputs/alpha5-r1/` 与现有开发通道账本。

## 5. 源码与本地结果（2026-11-06 UTC）

源码收口提交为 `ac8ef955…`；后继候选外驱动发布包判据修正为 `498a8f5d…`，后者是本轮候选源码。
只暂存 15 个明确路径；共享文档通过准确段落暂存，ADR-0312/0313 和其他会话 dirty 保持未提交。
本轮未修改系统、原生、依赖、Runner、Core 或 State。

| 直接检查 | 结果与本机证据 |
|---|---|
| 七模块编译、Shell 静态与两项合同 | 103/103 PASS，`shell-targeted.log` |
| 新 Profile / suite 身份 | 2/2 PASS；历史套件判据和原生绑定保持；`identity-test-r2.log` |
| 实际 Electron 22 main/preload/IPC/runtime/SQLite | 7+2 组 PASS，5 次回环、外部模型 0；Mac 仅内存降级，`local-combined-r2/RESULT.json` |
| 发布规则集合 | 422 项：406 PASS、0 FAIL、16 项按原规则 NOT_PERFORMED；`release-check.log` |
| 发布准备的基线扫描 | 6000 文件容量与事件循环检查 3/3 PASS；`workspace-capacity.log` |
| 新包完整性 | 3275 项 manifest、ZIP 闭包、七模块加载、包内 runtime 身份与驱动输入验证 PASS；`dev-3-record.json` |
| 双独立干净构建 | dev-3 / freeze-a / freeze-b 三个 ZIP 逐字节一致，`DOUBLE_BUILD.json` |

候选 ZIP 为 111,170,123 字节，SHA-256 `d1ba4d37d003d91449eb55b2121ca5cce9d6cb84528f221ffbf501ba4f86e391`。
两个正式一致性构建均为全新系统临时目录内的独立源码克隆，共享只读已安装依赖；退出后沙箱已删除。
跨机器可重复性未执行。未重编原生工件。

首个外层构建工具因 Mac `/var` 临时路径与 ESM 的 `/private/var` 规范路径不一致，入口未执行却退出 0，
后续闭包读取拒绝该结果；该失败保留在 `dev-1-record.json`。工具改用 realpath 后构建成功。
新候选外驱动的旧开发包 eligibility 预期在上机前修正，并增加实际发布包的 verify-only 准入。
dev-2 的旧源码包保留为准备记录，未当作当前候选或复用其实机结论。
Win7 组合执行与冻结结果在完成后补录；当前不预签通过，不替负责人接受。

## 6. 同包 Win7 通过与冻结完成

首个 run `f02ad7e8…` 在准备阶段因 ZIP_IDENTITY_MISMATCH 停止，产品启动次数为 0。
原因是代理生成 setup 时先替换短哈希，破坏了完整 ZIP SHA 常量；工具独立上传校验的实际 ZIP 身份正确。
保留原失败和后检，修正候选外脚本，并在本地核对完整常量。产品与包未改，判据未放宽。
新 run `2061ce92-32c6-4d55-a545-cc2d3c6b8958` 复用同一已验证不可变包，在原窗口内执行，未重置时间预算。

Win7 普通 agent / Session 1、Electron 22.3.27 / Node 16.17.1 / ABI 110，两进程 7+2 组 PASS。
本轮直接覆盖实际包内 main/preload/Schema IPC/runtime/SQLite、运行中草稿、原生 Enter、选择/刷新保留、
手动发送仅一轮、停止保留、DPAPI 密文保存及重启恢复、零重放、正文查找与焦点、真实读取成功/历史耗时、
主题切换/重启恢复，以及严格模板首句/真实工具续步的单条开头 system。
四个 CSS 视口全部达到请求尺寸；DPR=1，900/780 两张暗色截图已查看。
5 次回环请求、外部模型 0；SQLite integrity=ok，活动 task/turn/run 均为 0，样本未变，测试沙箱已删除。
11 个产品/任务/身份回收文件按 SHA 和大小复核；后检根内进程/任务 0、锁 inactive，无解包未知。
开发根 15,262,513,393 字节，C: 剩余 864,921,550,848 字节。
窗口 UTC 07:52:18.796 至 08:06:07.461 提前关闭，包含失败准备、修复和回收；未使用 stop/close。

同一测试包与两次干净构建字节一致，现只读冻结在 `.acceptance/candidates/WIN7-58/`，共 13 个文件。
冻结状态 FROZEN_NOT_FORMALLY_ACCEPTED；准确冻结 SHA、source/tree、ZIP/manifest/SBOM/锁、run 与驱动绑定
见本机 `outputs/alpha5-r1/FREEZE_RESULT.json` 和候选内 FROZEN_CANDIDATE.json。
候选内预执行 NOT_PERFORMED 保留为构建时快照，不回写包或旧失败。
当前技术准备完成，负责人接受仍 PENDING。发布材料在本机 `outputs/alpha5-r1/publication/`，人工步骤见
`outputs/alpha5-r1/ACCEPTANCE.md`。不宣称正式门 A/B、Win10、原生 125% DPI 或外部后端通过。

## 7. 发布草稿与附件回下载核验

准确源码及标签 `v0.3.0-alpha.5-win7-58` 已推送；标签指向冻结源码 `498a8f5d…`，后继提交只补验收记录。
GitHub release ID `436252681` 为 Draft / Prerelease，published_at=null，未公开。
[负责人验收草稿](https://github.com/allin2/AgentForWin7/releases/tag/untagged-8999c509e9acb17788ce)。

四个附件为安装 ZIP、SHA256SUMS、WIN7-58-RELEASE-EVIDENCE.json 和 ACCEPTANCE.md。
全部回下载，与本地冻结/发布材料按大小、SHA-256 及 GitHub asset digest 三方核验一致。
记录见本机 `outputs/alpha5-r1/PUBLICATION_VERIFICATION.json`；回下载在 `roundtrip/`。
证据附件是验收前技术快照，负责人后续接受及公开状态以发布说明和候选外接受记录为准，不重写冻结文件。

交付过程中直连 GitHub 的 HTTP2/传输曾失败。只读确认系统现有代理后，交付命令显式复用该代理并成功，
未修改系统、全局 Git、远端或 TLS 设置。没有 force-push、重写历史、删除或后台遗留任务。
当前状态 A9_48_READY_FOR_OWNER_ACCEPTANCE。负责人保留人工验收；通过后公开这组同字节附件，不重建。

## 8. 负责人验收通过与公开发布

负责人在收到准确候选、验收包及已知限制后，明确回复“验证通过，可以发版”。
据此接受 WIN7-58，结论 `A9_48_WIN7_58_PASS_WITH_KNOWN_LIMITS`。
准确接受绑定 source `498a8f5db5ababc0efe32a2a1b139777ef79bb39`、ZIP
`d1ba4d37d003d91449eb55b2121ca5cce9d6cb84528f221ffbf501ba4f86e391`、
冻结记录 `79ec8f53…` 与 Win7 DEV_CHANNEL run `2061ce92…`。
接受记录位于本机 `outputs/alpha5-r1/publish/OWNER_ACCEPTANCE.json`，不改候选内冻结快照。

预发布于 UTC `2026-11-06T09:48:19Z` 公开，release ID `436252681`；
[v0.3.0-alpha.5-win7-58](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.5-win7-58)。
四个附件保持原 asset ID、大小和 SHA-256，公开后全部回下载，与批准草稿/本地冻结材料及 GitHub digest 一致。
ZIP 仍为 111,170,123 字节；未重建、未重传或替换附件，标签仍指向相同候选源码。
发布后校验见本机 `outputs/alpha5-r1/publish/PUBLICATION_VERIFICATION.json`。

本次为负责人按 ADR-0315 接受限定范围与已知限制，不将原 DEV_CHANNEL 升为 FORMAL，正式门 A/B 未补签。
同包 Win10、原生 125% DPI、外部后端、完整 Review/batch2 和跨机可重复性仍未验证。
附件中的待验收/草稿字段是验收前快照，为保持 SHA256SUMS 不变而保留；当前状态以本节及公开发布说明为准。
README 和当前状态下载入口同步到 alpha.5；保留其他未提交工作。本任务在本版范围内 COMPLETE。
