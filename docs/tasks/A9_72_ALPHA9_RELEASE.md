# A9-72 — alpha.9 集成整合与发布准备

```text
Status: READY_FOR_ACCEPTANCE
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: c00cb8c0cb26bd3f000204e917038fc77c68bfdc
Target Version: 0.3.0-alpha.9
Candidate: WIN7-63
Phase-Gate: A9_72_WIN7_63_PASS_WITH_KNOWN_LIMITS
Win7-Validation: DEV_CHANNEL
```

## 1. 当前范围

负责人指示“推动正式发版”，并同意选择选项甲（限定接受发版路径，沿用 ADR-0320、ADR-0333 与 ADR-0354），明确以下范围与边界：

1. 本地整合：完整整合 Phase ABC 架构与性能优化（C1 办公按需加载与模块化、C2 显式状态机与非法转态 fail-closed、C3 快照 150ms 聚合推送与零空闲轮询、C4 网络超时收敛、C5 文档治理、C6 Win7 SP1 供应链策略、B1 SQLite 复合索引加速、B3 网络代理中文指引）及 P1 锁处置边界修复（ADR-0347～ADR-0353）。
2. 发版身份：建立 `0.3.0-alpha.9` / `WIN7-63` 独立发版 Profile 与输入锁 `release/win7-product-v3/a9-alpha9-input-lock.json`（`A9-ALPHA9-INPUTS-D013-V26-MANAGED`），复用既有 Electron 22.3.27、SQLite 3.43.1/ABI 110 与 D-013 v26 managed 精确原生二进制；保持原生二进制哈希不改变。
3. 验收路径：沿用 ADR-0320 / ADR-0333 限定接受路径，基于 Windows 7 SP1 x64 实机开发通道（`DEV_CHANNEL`）21/21 PASS 真实证据（`outputs/phase-abc-p1-win7/RESULT_FINAL.json`），出具限定接受记录。
4. 边界：不改变系统权限边界，不新增外部网络访问权限，不关闭 TLS；外部模型请求严格为 0；远程推送（`origin/main` 及 Git 标签）与 GitHub Release 公开发布由负责人逐次确认。

## 2. 顺序与 Gate

1. 登记 `A9-ALPHA9-INPUTS-D013-V26-MANAGED` 身份与输入锁 `a9-alpha9-input-lock.json`，运行发布身份测试 `a9-alpha9-identity.test.mjs`。
2. 登记 ADR-0354 及任务书索引 `docs/tasks/README.md`。
3. 从经过实机检验的基线构建 `Win7CodingAgent-0.3.0-alpha.9-win7-x64.zip`，核验 manifest、4,585 文件闭包及原生二进制哈希。
4. 归档 Win7 实机 `DEV_CHANNEL` 21/21 PASS 证据，生成限定接受记录 `outputs/a9-72-alpha9/publish/OWNER_ACCEPTANCE.json`。
5. 准备发版交接材料与发布附件清单，提交负责人裁决与发布授权。

## 3. 已知保留边界

- 证据层级为 Windows 7 SP1 x64 实机 `DEV_CHANNEL`（21/21 PASS）加开发机全量单元回归；未执行双构建、正式冻结与门 A/B，不产生正式 Win7 PASS。
- 同包 Win10 验收机验证、原生 125% DPI 视觉验证、真实外部模型推理、完整 Review 后端及完整人工 GUI 旅程保持为 `NOT_PERFORMED`。
- 沿用基线已知限制：会话内删除已绑定恢复目录后需重开工作区、深历史分页全量扫描及大文件同步延迟。

## 4. Phase ABC 优化与 P1 修复记录

- **C1 办公按需加载与模块化**：日常对话期间外置 Office 进程为 0，工作端口为 0；按需触发归档时启动 Worker，完成后即时退出（exit 0），释放端口与句柄。
- **C2 显式状态机转态**：Runtime 状态流转显式化，非法转态严格 fail-closed；支持 mid-turn 中断与取消。
- **C3 快照事件驱动推送**：快照更新以 150ms 聚合防抖推送到前端，Win7 实机空闲 CPU 占用率 0.195%（远低于 1.5% 上限），零空闲轮询。
- **B1 SQLite 复合索引**：为 session/events 表增加复合索引，2,000 事件会话切换由 480ms 降至 8ms。
- **B3 网络代理中文指引**：网络与代理配置错误提供针对 Windows 7 环境的中文排查建议。
- **P1 锁处置边界修复（ADR-0347～ADR-0353）**：
  - 前缀碰撞隔离：`proc-1` 与 `proc-10` 正确区分，避免误放锁。
  - 跨会话损坏隔离：工作区 A 异常退出保留锁并输出 `A9_MANAGED_DISPOSITION_UNCONFIRMED` 诊断，不影响工作区 B 正常释放。
  - Windows 路径规范化：兼容 Win32 路径盘符大小写规范化，根源消除 `A9_MANAGED_OWNER_MISMATCH` 假阳性。

## 5. Win7 实机 DEV_CHANNEL 验证结果

- **执行宿主**：Windows 7 SP1 x64 build 7601（宿主 `DCCS-CHAIZL-PC`，普通用户 `agent`，Session 1，Medium 完整性级别）。
- **运行载荷**：`outputs/win7-dev/phaseabcp1/controller.json`。
- **测试结果**：21/21 项全部 PASS，`normal_quit=true`，外部模型调用严格为 0。
- **环境清理**：验证完毕后运行目录锁释放（`lock.active: false`），残留进程为 0，残留任务为 0，临时容量窗口代码已还原。
- **完整证据**：归档于 `outputs/phase-abc-p1-win7/RESULT_FINAL.json`（SHA-256 `6b3c84c9…` 绑定产物）。
