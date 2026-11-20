# A9-73 — Alpha.10 启动修复换发

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: a70628d06d298f3823644587241e08ab09cb5d56
Target Version: 0.3.0-alpha.10
Candidate: WIN7-64
Phase-Gate: A9_73_IMPLEMENTATION_AUTHORIZED
Win7-Validation: NOT_PERFORMED
```

## 1. 范围与授权

负责人指示“把修复版进行打包发版”，并明确批准 Alpha.10 / WIN7-64 的 90 分钟 Win7 开发级复验。实际工作分支为 `box/phase-abc-p1-repair`。本轮从已发布 Alpha.9 的后继文档提交开始，只修复启动身份与打包校验，登记 Alpha.10 独立版本和输入锁。原标签、发布 ZIP 与原始记录留档。故障见 [A9-72 §6](A9_72_ALPHA9_RELEASE.md#6-发布后启动阻断)。

沿用 Electron 22.3.27、SQLite 3.43.1/ABI 110 和 D-013 v26 managed 的精确锁定字节。无需系统改动、外部模型请求或访问原用户数据。依 ADR-0355 完成本地提交、定向检查和干净源码构建。公开前按准确源码、ZIP 和实机结果记录适用的负责人接受决定。

## 2. 同包验证

开发机验证 Alpha.10 身份、拒绝跨候选号、文件闭包与实际包内加载器。Win7 在 `DCCS-CHAIZL-PC` 的 `C:\A9-DEV` 内使用普通 `agent` 交互桌面，以原始 ZIP 解压并启动包内 `electron.exe`，观察窗口就绪，经正常桌面关闭入口退出。使用隔离数据根，外部模型请求 0，容量上限 28,000,000,000 字节，C 盘剩余不少于 50,000,000,000 字节。窗口 2026-11-20 07:38:06–09:08:06 UTC，结束前 10 分钟只收尾。身份、锁、完整性、启动、退出或收尾异常即停止后续发布。

同包 Win7 核验只记 `DEV_CHANNEL`。发布使用经过核验的相同 ZIP，记录源码、SHA-256、运行与证据。正式门 A/B 另按其合同授权。
