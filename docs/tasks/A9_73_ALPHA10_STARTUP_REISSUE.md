# A9-73 — Alpha.10 启动修复换发

```text
Status: COMPLETE
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: a70628d06d298f3823644587241e08ab09cb5d56
Target Version: 0.3.0-alpha.10
Candidate: WIN7-64
Phase-Gate: A9_73_WIN7_64_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 范围与授权

负责人指示“把修复版进行打包发版”，并明确批准 Alpha.10 / WIN7-64 的 90 分钟 Win7 开发级复验。实际工作分支为 `box/phase-abc-p1-repair`。本轮从已发布 Alpha.9 的后继文档提交开始，只修复启动身份与打包校验，登记 Alpha.10 独立版本和输入锁。原标签、发布 ZIP 与原始记录留档。故障见 [A9-72 §6](A9_72_ALPHA9_RELEASE.md#6-发布后启动阻断)。

沿用 Electron 22.3.27、SQLite 3.43.1/ABI 110 和 D-013 v26 managed 的精确锁定字节。无需系统改动、外部模型请求或访问原用户数据。依 ADR-0355 完成本地提交、定向检查和干净源码构建。公开前按准确源码、ZIP 和实机结果记录适用的负责人接受决定。

## 2. 同包验证

开发机验证 Alpha.10 身份、拒绝跨候选号、文件闭包与实际包内加载器。Win7 在 `DCCS-CHAIZL-PC` 的 `C:\A9-DEV` 内使用普通 `agent` 交互桌面，以原始 ZIP 解压并启动包内 `electron.exe`，观察窗口就绪，经正常桌面关闭入口退出。使用隔离数据根，外部模型请求 0，容量上限 28,000,000,000 字节，C 盘剩余不少于 50,000,000,000 字节。窗口 2026-11-20 07:38:06–09:08:06 UTC，结束前 10 分钟只收尾。身份、锁、完整性、启动、退出或收尾异常即停止后续发布。

同包 Win7 核验只记 `DEV_CHANNEL`。发布使用经过核验的相同 ZIP，记录源码、SHA-256、运行与证据。正式门 A/B 另按其合同授权。


## 3. 同包验证与负责人接受

- 干净源码 `5e1962947652a8d71340a5341e524ce0b91b6878` 构建 ZIP，SHA-256 `ad4180733d9375f4f145b5a4d22656b2f80226c6948180d680cd37c7a8747e4d`，大小 115,104,967 字节。manifest SHA-256 `51e161a1677bf6796d66ccb51c75c4057fcff9c0d63bb0c427a09b88fb231808`。开发机从发布 ZIP 实际提取和执行包内加载器，4,585 个文件闭包与原生哈希通过。打包后只调整了旧 W41 测试夹具，产品、发布锁与待发布 ZIP 字节固定。
- 开发机 Shell 启动相关 62 项通过。发布回归 418 项通过、16 项按环境记录为 `NOT_PERFORMED`。首轮旧 W41 夹具未加载正式状态模块，发布前基线同样失败。恢复实际模块加载后全套通过。
- Win7 SP1 x64 build 7601，普通 `agent` 交互 Session 1、Medium。重试 run `b4262f8f-c770-4c79-a1ff-3e274805a0d4` 校验 4,585 个文件并正常开窗、使用窗口关闭入口退出，退出码 0。外部模型请求 0，独立数据根。本轮临时运行目录已移除，进程 0、计划任务 0、锁已释放。首轮 Win7 的 ASAR 读取错误发生在取证工具校验阶段，产品尚未启动。失败原件保留，重试修正取证工具，重复使用同一 ZIP。
- 负责人确认“限定接受并公开发布”，接受上述准确源码及 ZIP，授权推送 `origin/main` 和准确新标签并发布 GitHub Pre-release。结论 `A9_73_WIN7_64_PASS_WITH_KNOWN_LIMITS`。正式门 A/B、双构建、冻结、同包 Win10 和完整人工 GUI 旅程为 `NOT_PERFORMED`。

## 4. 公开预发布与回下载核验

- 新标签 `v0.3.0-alpha.10-win7-64` 指向构建源码 `5e1962947652a8d71340a5341e524ce0b91b6878`。
- GitHub Pre-release ID `452419701`，ZIP、接受说明、证据 JSON 和校验和共四个附件。草稿和公开后分别回下载核对。四件的本地字节、回下载字节和 GitHub SHA-256 一致，附件 ID 一致。[发布页面](https://github.com/allin2/AgentForWin7/releases/tag/v0.3.0-alpha.10-win7-64)
- 本机归档位于 `outputs/a9-73-alpha10/`。发布核验记录 `publish/PUBLICATION_VERIFICATION.json`，实机结果 `win7/retry-1/RESULT_FINAL.json`。上一版失败包与发布记录原样留档。
