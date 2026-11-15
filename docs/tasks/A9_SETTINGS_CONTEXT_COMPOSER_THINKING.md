# A9 Settings：上下文预算、输入框上限与 thinking 设置

Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE

## 授权范围

`APPROVED_FOR_IMPLEMENTATION`。实际分支 `box/a9-settings`，基线 `0153b394`。

交付 Provider 设置抽屉中的上下文预算、全局输入框上限、thinking 模式和思考强度；将非秘密字段经配置 IPC、Runtime 校验和持久化、快照回填及 Core/Gateway 请求链路传递。配置 schemaVersion 保持不变，不改专用 DeepSeek Provider，不新增依赖。

必要验证：Core 编译及指定测试、Gateway 指定测试、Shell 指定测试、`npm run docs:check`、`git diff --check`。证据范围为本机开发机（macOS，Node 20.17.0）；Win7 实机验证不在本任务内。

停止条件：模块编译或定向测试失败且无法最小修复，或发现超出本范围的产品缺陷。不得修改 ADR、MODES.md、AGENTS.md、CLAUDE.md、冻结候选或历史证据；不得推送公开 origin。

## 交付记录

2026-11-15 实现完成并取回本机复验。7 个产品代码文件 + 1 个文档登记。本机 Node 20.17.0 复验：core 52、gateway 19、shell 719 定向测试全过；core/gateway tsc 通过；renderer 语法通过。修复员工实现 1 处兼容性缺陷：`auto` 语义从"总是发送双协议字段"改为"不发送字段，后端用默认"，符合本任务书"未配置时不写，保持向后兼容"。

Phase-Gate：`A9_SETTINGS_IMPLEMENTATION`（实施完成，开发机验证）。Win7 实机验证未执行，不在本任务授权范围。
