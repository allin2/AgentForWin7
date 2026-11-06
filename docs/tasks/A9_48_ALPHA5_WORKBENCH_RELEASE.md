# A9-48 — alpha.5 工作台与运行中草稿发布

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: b0af55d283b2796fe83b9635f8ff6a2dc1ef30fc
Target Version: 0.3.0-alpha.5
Candidate: WIN7-58
Phase-Gate: NOT_PERFORMED
Win7-Validation: NOT_PERFORMED
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
