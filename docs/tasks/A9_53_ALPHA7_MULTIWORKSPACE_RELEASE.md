# A9-53 — alpha.7 多工作区并行对话发布

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: 7db11cd (A9-52 代码与测试本地提交)
Target Version: 0.3.0-alpha.7
Candidate: WIN7-60
Phase-Gate: A9_53_WIN7_60_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 当前范围

负责人在 A9-52 本地提交后要求“继续推进 win7 验收，发版”，并选择验收方式甲（ADR-0320）。
本轮从 main 收口 A9-52 多工作区并行对话与收件箱式导航，形成 alpha.7 内部试用预发布。
允许必要的本地提交、版本身份、输入锁、候选外 Win7 驱动和发布材料准备。
只暂存准确任务路径及共享文档内本轮段落。其他会话的修改保留，不混入提交。
本轮不新增产品能力、权限、依赖、原生输入、系统设置或模型费用。

## 2. 顺序与 Gate

1. 建立 alpha.7 Profile、输入锁和包内 runtime 身份；串号拒绝，旧版本行为保持。
2. 从准确干净提交单次构建开发包，核对 manifest、ZIP、七模块实际加载和原生闭包。
3. 在开发机以真实 Electron 22 运行开发包内产品，验证多工作区链路与 alpha.6 队列回归。
4. 准备同包 Win7 开发级运行的准确载荷、身份、路径、预算和停止条件，提交负责人批准目标窗口。
5. 获批后在 Win7 完成同包开发级运行，结果标 DEV_CHANNEL。
6. 负责人按 ADR-0320 给出限定接受结论；不做双干净构建、冻结、门 A/B 与独立审核。
7. 取得接受与发布授权后，推送并公开同一已验收字节，回下载核验全部附件。

`继续推进 win7 验收，发版` 不是对尚未形成的目标窗口或发布的预批。
开发通道常设授权 r2 有效至 2026-11-28T00:00:00Z，但从 main 运行须本版本单独批准（ENGINEERING_03 §10.4）。

## 3. 验证与影响

- 沿用 Electron 22.3.27、Node 16.17.1、SQLite 8.7.0 / ABI 110 与 managed v26 精确原生输入，不重编。
- 先编译生产者，再运行受影响合同及发布必需检查。A9-52 开发证据只按准确未变字节继承。
- Win7 新增检查：两个工作区并行请求与写入、各自真实 DPAPI 草稿、并发下进程树清理、双工作区内存与句柄占用。
- alpha.6 FIFO 队列与 A9-49 可靠性组按同包回归，原驱动只改输入身份。
- 本地构建沙箱位于系统临时目录，finally 清理；需保留结果明确复制到本轮证据目录。
- 同类两轮未解释失败先最小诊断；身份、完整性、安全或未知生命周期失败停止依赖动作。

## 4. 已知边界与交付

证据集中在本机 `outputs/alpha7-r1/`；状态只在 STATUS 维护。
Win10 同包、原生 125% DPI、外部模型、完整 Review/batch2 和跨机可重复性沿用原未执行边界。
版本为内部试用预发布，不宣称完整 Alpha、RC 或稳定版；结论只能为 DEV_CHANNEL 加负责人限定接受。
本轮保留现有 alpha.6 用户进程、他人锁、所有历史候选和证据；不执行删除或根外终止。
发布范围不授权接管活动锁、扩容、安装、修改系统或复制目标凭据。

## 5. Win7 DEV_CHANNEL 运行结果（2026-11-08 UTC）

候选 WIN7-60：源码 `22b575cc…`，ZIP `5b8ae87f…`，111,192,055 字节，manifest `e39b88f0…`。
四次尝试均由执行代理在负责人逐次批准的窗口内执行，持锁者 `a946lanrx`，未接管锁。

| 尝试 | run | 结果 | 根因与处理 |
|---|---|---|---|
| 1 | `a3b32318…`（ZIP `78c0222c…`） | 多工作区 FAIL；队列、可靠性 PASS | Windows 小写持久化路径致重开超时；产品修复 `22b575cc…` |
| 2 | `a25a26db…` | 多工作区收尾断言 FAIL；队列、可靠性 PASS | A 未写出 `shell-result.txt`，当时 UNKNOWN；驱动补记录 `5b6efceb…` |
| 3 | `69721b1d…` | 多工作区 FAIL（诊断） | 驱动向 PowerShell 5.1 发出 cmd 语法，`&` 被拒；驱动修复 `0a1f81c4…` |
| 4 | `7949d383…` | 多工作区 PASS | A、B 各写出本工作区文件，退出码 0；11 项检查通过 |

第 4 次前，Codex 独立审核三轮，第 3 轮 P0/P1 为 0，余 1 项工具 P2。
第 4 次回环请求 15 次，外部模型 0 次；SQLite integrity=ok，无活动任务或锁。
后检：开发根 21.27 GB，锁 inactive，任务为空，alpha.6 四进程未变；未删除任何内容。
窗口结束后，A9-53 容量例外已从 `common.ps1` 移除。
汇总见本机 `outputs/alpha7-r1/TARGET_RUN_1_SUMMARY.json` 至 `TARGET_RUN_4_SUMMARY.json`。

## 6. 负责人限定接受（2026-11-08 UTC）

负责人选择 A，接受 WIN7-60 为 `A9_53_WIN7_60_PASS_WITH_KNOWN_LIMITS`（ADR-0320 甲）。
接受记录在本机 `outputs/alpha7-r1/publish/OWNER_ACCEPTANCE.json`，绑定源码、ZIP、manifest 与三组 run。
同 ZIP 证据：多工作区取第 4 次，alpha.6 队列与 A9-49 可靠性回归取第 2 次。

登记的已知限制：

1. 证据类别为 DEV_CHANNEL；未执行门 A/B、双干净构建与冻结。
2. 多工作区证据使用修正后的候选外驱动 `0a1f81c4…`；产品字节未变。
3. Mac 开发机打包运行不执行 Windows Shell 写文件检查；该项只有 Win7 实机证据。
4. Win7 开发根 21.27 GB，高于默认 20 GB；后续上传需另行批准清理或扩容。
5. 通道工具容量检查不能发现 `common.ps1` 其他位置的改动；属工具问题，不属产品。

§4 沿用的未执行边界保持。推送、标签与公开发布未授权，NOT_PERFORMED。
