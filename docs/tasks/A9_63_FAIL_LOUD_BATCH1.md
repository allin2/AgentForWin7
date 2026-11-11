Status: APPROVED_FOR_IMPLEMENTATION
Task Type: Reliability Hardening
Target Branch: a9-63-fail-loud
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d
Win7-Validation: NOT_PERFORMED

# A9-63 Fail-Loud Batch 1

本批次只处理 A9 Robustness Audit R1 的 F-002、F-013、F-014、F-015、F-017、F-018、F-021、F-024。

- F-002：`wmic` 与 `taskkill` 作为内部清理辅助命令使用有界期限；期限到达后终止辅助进程并返回无法证明清理完成的结构化事实。用户命令期限不变。
- F-013：A8 表探测只把明确的缺表结果视为 false；锁定、损坏或权限错误进入 `A9_SQLITE_PROBE_FAILED` 诊断。
- F-014：WAL 设置失败保留 ready 判定，同时记录实际 journal mode 与 `A9_SQLITE_WAL_UNAVAILABLE` 事实。
- F-015：safeParse 保持单参数调用，记录有界损坏计数及首个表名/行标识；不记录持久化内容。
- F-017/F-018/F-024：Git 投影通过新增可选 diagnostics 字段区分非仓库、启动失败、超时、退出码非零和配置不可读；既有投影字段保持兼容。
- F-021：RecoveryManifestStore 在 A9 产品路径可达。ENOENT 继续返回 undefined；其他读取或解析错误返回 `A9_RECOVERY_MANIFEST_UNREADABLE` 并锁定恢复协调器。

开发机回归使用真实 SQLite、真实 Git 仓库和真实辅助子进程。临时目录使用系统临时目录的 `a9-63-*` 前缀并在清理钩子中删除。Win7、打包、推送和发布均未执行。
