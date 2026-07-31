# win7-coding-agent

面向 **Windows 7 SP1 x64** 的企业内部通用 Coding Agent 执行端与客户端。
模型推理默认运行在远程/内网服务器；Win7 端负责交互界面、代码读取、受控修改、命令执行、测试验证、状态保存与审计。

Windows 7 是唯一固定平台。项目不再全局限定 Python-only、stdlib-only、CLI-only，也不再禁止
Node.js、Electron、.NET Framework、Win32 原生组件或第三方依赖；每个组件必须声明精确的
Runtime Profile、锁定依赖并通过 Win7 实机验证（ADR-0027）。这项架构变更不改变既有
Phase 1/2 的 Python 3.8.10 冻结合同，也不绕过 `AGENTS.md` C14 的任务授权机制。

## 项目状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| 0 | 工程基线与文档体系 | 进行中（本仓库当前内容） |
| 1 | Capability Probe | 修复轮 R1--R8 已实现，待架构师解除 Phase-Gate 后进行 Win7 E1/E2 实机验收 |
| 2 | 正式只读代码分析 Agent | 复审通过（REVIEW_PASSED），CPython 3.8.10 验证通过（PYTHON38_VALIDATED）；仅 Win7 实机验收未执行 |
| 3–7 / 新客户端 | Gateway、Workspace、State、Core/Runner、Shell | ADR-0036 已授权理论先行；阶段分支源码已汇入 `codex/integrated-robustness`，开发机 685 项测试通过；SPIKE_01~04 与 Win7 实机验收未执行 |

所有实现遵循任务授权机制（`AGENTS.md` C14 / ADR-0011）。Phase 3–7 的理论先行实现由
ADR-0036 与各阶段任务书授权，跨阶段整合由
[`INTEGRATION_01_ROBUSTNESS_HARDENING`](docs/tasks/active/INTEGRATION_01_ROBUSTNESS_HARDENING.md)
授权。现代开发机测试只表示源码基线可回归；SPIKE 与 Win7 实机验收完成前不得将阶段标记为完成。

## Phase 3–7 整合验证

各模块依赖使用自己的 `package-lock.json` 固定。首次验证先在所需模块执行 `npm ci`，然后从
仓库根目录运行：

```text
npm run verify
npm run verify:quick
```

`verify` 顺序执行 7 个模块的类型检查、构建和测试，并明确提示失败模块；`verify:quick`
只执行类型检查与构建。命令不会把开发机结果表述为 Win7 验收通过。

## Phase 1 Capability Probe 运行方式

Capability Probe 是历史阶段组件，仍固定使用 CPython 3.8.10 标准库。在 Windows
`cmd.exe` 中从项目根目录运行：

```bat
scripts\run_probe.bat
scripts\run_probe.bat --out "D:\中文 目录\probe_report.json"
scripts\run_probe.bat --list
scripts\run_tests.bat
```

也可以在已将 `src` 放入 `PYTHONPATH` 的环境中运行：

```bat
python -m win7_agent.probe --out probe_report.json --db probe_report.sqlite3
```

Probe 仅做离线环境检测，不安装软件、不修改系统配置、不访问网络。JSON 报告是唯一权威输出；
退出码 `0` 表示全通过，`1` 表示存在可降级能力，`2` 表示存在失败/检查错误，`3` 表示参数或
报告写出错误。Win7 实机验收步骤见 [`tests/win7/README.md`](tests/win7/README.md)。
这里的"离线"和"仅标准库"只属于 Phase 1 冻结合同，不是所有未来组件的全局限制。

## 给 Coding Agent / 新成员的入口

按此顺序阅读：

1. [`AGENTS.md`](AGENTS.md) — 最高约束，单一事实来源
2. [`docs/WIN7_CONSTRAINTS.md`](docs/WIN7_CONSTRAINTS.md) — 兼容性红线与依赖评审流程
3. 当前分支对应的阶段或整合任务文档；Phase 1–7 与 Spike 任务书在 `docs/tasks/`（活跃任务位于 `active/` 子目录），
   当前整合分支使用
   [`docs/tasks/active/INTEGRATION_01_ROBUSTNESS_HARDENING.md`](docs/tasks/active/INTEGRATION_01_ROBUSTNESS_HARDENING.md)

Claude 专用指令见 [`CLAUDE.md`](CLAUDE.md)。

## 文档地图

```
AGENTS.md                       最高项目约束（先读这个）
CLAUDE.md                       Claude 工作指令
README.md                       本文件
docs/
  PROJECT_CHARTER.md            项目章程：目标、范围、非目标、成功标准
  ARCHITECTURE.md               架构：当前实现 vs 未来规划（明确区分）
  WIN7_CONSTRAINTS.md           Win7 兼容性 Profile + 依赖/运行时评审登记表
  ROADMAP.md                    阶段划分与各阶段完成标准
  SECURITY.md                   威胁模型与安全规则
  EVALUATION.md                 验证与评估方法
  DECISIONS.md                  ADR 决策记录
  PENDING_CONFIRMATIONS.md      待确认事项
  ROBUSTNESS_AUDIT.md           健壮性审计
  docs/reports/                 验收与审计报告
  tasks/
    README.md                   任务书索引
    PHASE_01_CAPABILITY_PROBE.md  阶段 1 任务书（Python 3.8.10）
    PHASE_02_READONLY_CODE_ANALYSIS.md  阶段 2 任务书（只读 Agent）
    active/
      PHASE_03_*.md ... PHASE_07_*.md     新客户端各模块任务书
      SPIKE_01_*.md ... SPIKE_04_*.md     Win7 实机验证任务书
      INTEGRATION_01_ROBUSTNESS_HARDENING.md  Phase 3–7 整合与修复
      PROTOTYPE_FULL_AGENT_SKELETON.md    独立原型线任务书
src/
  phase1-2/                     Phase 1/2 Python 活跃阶段代码
```

## 核心硬约束速览

- 唯一固定目标环境是 Windows 7 SP1 x64；运行时、架构、依赖与交付模式由组件
  Runtime Profile 和获批任务书声明。
- 可使用经评审且固定版本的 Python、Node.js、Electron、.NET Framework、Win32 原生组件
  与第三方依赖；Docker/WSL 可以用于构建或远程服务，但不能成为 Win7 本地前置。
- 禁止使用 Win10+ 专属 API；可选能力缺失必须明确降级，不能静默失败。
- Agent 非交互命令具备超时、输出上限与进程树终止；用户交互终端具备取消、背压、
  会话上限与强制终止。
- Agent 工具使用结构化参数并经过 Policy、权限确认与审计；不执行模型拼接的 Shell 字符串。
- Git 使用专用隔离适配器；用户交互终端不向模型开放 stdin，不能作为 Runner 权限旁路。
- 所有路径逻辑兼容中文/空格路径；文本 I/O 显式编码，未知内容按字节保持。
- 每个实现仍须满足 C14：任务书状态为 `APPROVED_FOR_IMPLEMENTATION`，且只修改白名单路径。

完整清单见 `AGENTS.md` §4。
