# 参与贡献

感谢关注 AgentForWin7。本项目由个人维护，欢迎提交 Issue 和小范围 PR。较大的改动请先开 Issue 讨论方向。

## 开始之前

- 阅读 [README](../README.md) 的“权限与安全”和“开发”两节。
- [AGENTS.md](../AGENTS.md) 是本仓库的执行约束，人和 AI 代理都按它工作。其中 Win7 平台红线见 [Win7 约束](../docs/WIN7_CONSTRAINTS.md)。
- 安全漏洞不要提交公开 Issue，按 [安全说明](../docs/SECURITY.md#报告安全漏洞) 私密报告。

## 开发环境

| 项目 | 要求 |
|---|---|
| 开发机 Node | 20.17.0，以 `.nvmrc` 为准，先执行 `nvm use` |
| 依赖 | 根目录与各模块分别安装，命令见 README |
| 克隆 | 使用完整克隆；`docs:check` 需要历史提交和 tag |

开发机检查通过不代表 Win7 通过。产品运行在 Electron 22 内置的 Node 16.17.1 上。

## 按改动范围选择检查

不必每次运行全部检查。选择与改动相关的最窄入口：

| 改动范围 | 检查 |
|---|---|
| 某个模块的源码或测试 | `npm run test:local -- --module <模块名>` |
| 多个模块 | `npm run test:local`，或重复 `--module` |
| 文档 | `npm run docs:check` |
| `scripts/` 下的检查工具 | `npm run verify:tools` |
| 打包工具或发布合同 | `npm run verify:release` |

在 PR 描述中写明实际运行的命令和结果。未运行的检查写 `NOT_PERFORMED`，不要写成通过。

## 提交要求

- 一个 PR 只做一件事，不顺带格式化或重命名无关文件。
- 不提交厂商安装包、Electron/Node ZIP、构建输出或依赖缓存。新的离线输入只登记来源、版本和 SHA-256，并写入对应的输入锁。
- 不提交 API Key、代理密码、Token 或真实用户数据；日志和截图先脱敏。
- `docs/DECISIONS.md` 中状态为 Accepted 的决策正文不能修改；需要改变决策时新增一条记录。
- 涉及 Win7 行为的改动，说明证据层级：开发机、Win10 验收机或 Win7 实机。

## 许可证

提交的贡献按 [Apache License 2.0](../LICENSE) 授权。
