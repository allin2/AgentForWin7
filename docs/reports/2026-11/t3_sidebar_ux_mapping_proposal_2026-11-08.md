# T3 Code 侧边栏 UX 交互模式对 A9 左栏的借鉴映射（开发机提案）

日期：2026-11-08
性质：**开发机提案，不构成实现授权**。任何落地需按 AGENTS.md §1 新增任务书 / ADR。
证据来源：T3 Code (Nightly) app.asar（`apps/server/dist/client`，SHA-256 `81edf8aa…66de`）静态逆向；
代码级证据与 REA Evidence 索引见《T3 Code 左侧边栏 UX 交互逻辑逆向报告》（会话内报告 / `/tmp/t3code-rea/`）。
映射对象：A9-16 U01–U07 左栏现状（`docs/reports/2026-09/a9_16_ui_implementation_2026-09-14.md`）。

## 0. 结论速览

T3 侧栏 12 个已证实模式中，5 个建议采纳（T1/T4/T7/T8/T12），3 个值得 Spike（T5/T9/T10），
2 个明确不采纳（T3/T11），2 个已有等价物无需重复（T2/T6）。全部采纳项都落在
Electron 22.3.27 / Chromium 108 能力集内，不触碰 WIN7_CONSTRAINTS 禁用清单。

| 编号 | T3 模式 | 处置 | 对应现状 |
|---|---|---|---|
| T1 | marker 行拍平列表 | 采纳（重构分组渲染） | A-3 双组渲染 |
| T2 | 五区状态模型 | 已有等价物 | 进行中/更早/归档 |
| T3 | 2000ms working 宽限期 | 不采纳 | — |
| T4 | IntersectionObserver 预激活 | 采纳 | 全量实时订阅 |
| T5 | 拖拽跨区语义复用 | Spike | 无 |
| T6 | 折叠焦点归还 | 已有等价物 | U03/U05 |
| T7 | 搜索 ARIA combobox | 采纳（增量） | U02 搜索框 |
| T8 | IME 组合期放行 | 采纳 | — |
| T9 | 变量注入式拖拽调宽 | Spike | 固定 232px |
| T10 | Shift+click 变体动作 | Spike | 无 |
| T11 | 触屏扩容命中区 | 不采纳 | 无触屏场景 |
| T12 | 动作权限收缩交互面 | 已有等价物 | fail-closed 契约 |

## 1. 建议采纳（P1）

### T1 marker 行拍平列表（替代双组分组渲染）

T3 的线程列表不是"数组 + 按组渲染"，而是拍平的行序列：`working-header`、`settled-header`、
`pinned-divider` 等分区标记与线程行同构（`kind:"marker"`，key `sidebar-marker-*`）。分区折叠、
组头计数、键盘遍历、拖拽落点判定全部复用同一条行遍历逻辑。

对 A9-16 的价值：现 `renderConversationDirectory` 把"进行中/更早"作为两个独立数组渲染，
组头与行分离。改为 marker 行后：

- 增加第三个分组（如"待审批"）不再新增渲染分支，只加一种 marker；
- 键盘 ↓/↑ 遍历（若后续采纳搜索 T7 或行内导航）自然覆盖组头；
- 组头计数/折叠状态回归为单列表上的聚合函数，可测试性更好。

Win7 约束核对：纯 DOM 结构变更，Chromium 108 完整支持；行数不变，U02 高度预算契约不受影响。
风险：`a9-workbench.js` 的 DOM 保活测试（357 项）需同步更新，工作量集中在渲染层单文件。

### T4 IntersectionObserver 分区预激活

T3 对屏外行（viewport ±160px 之外）不订阅高频实时状态，进入视口前才激活租约
（`leaseLiveStatus`）。这是它敢把几千个会话放进一个列表的前提。

对 A9 的价值：A9 的事件源是本地 EventStore（SQLite），没有网络高频流，但"进行中"任务会以
秒级推送流式输出。若任务目录规模增长（多工作区 × 多任务），全量订阅会在 Renderer 产生
无谓的 IPC 与重渲染。此模式把"状态类切换"的订阅范围限制在可视区 + 160px 缓冲带。

实施建议：`observeIntersection` 逻辑约 40 行；对 ≤ 每屏 20 行的当前规模收益为零，
**建议登记为候选，触发条件为"单目录任务数 > 50 或流式更新引发可测渲染抖动"**，
不作为近期工作项。

### T7 搜索 ARIA combobox 增量

T3 的侧栏搜索是完整 combobox：`role=combobox`、`aria-autocomplete=list`、`aria-expanded`、
`aria-controls="sidebar-thread-search-results"`、`aria-activedescendant="…-result-N"`，
结果以 `role=option` 列表呈现，`id=sidebar-thread-search-result-{index}`。

对 A9 的价值：现目录搜索框（Ctrl+K 聚焦）无结果浮层语义。补齐 ARIA 后：
- 屏幕阅读器用户可获得"共 N 个结果 / 当前第 M 个"的等价播报；
- 为 T10（Enter 打开 / ↑↓ 选择）提供结构基础。

实施建议：与 U02 现有搜索框共存，仅增强属性与结果容器语义；**注意 Win7 无障碍栈
（MSAA/UIA via Chromium）的实测归属 SPIKE 任务，不在开发机断言 PASS**。

### T8 IME 组合期放行

T3 搜索键盘处理显式跳过 `isComposing || keyCode===229`，中文输入法组合期间的 Enter/方向键
不触发结果选择。A9 用户指南为中文，IME 是主路径而非边缘场景；现 `a9-workbench.js`
搜索框若无此判定，中文用户按 Enter 上屏候选词会误触发搜索行为。

实施建议：约 5 行补丁 + 1 个中文 IME 组合输入契约用例。**这是本清单中性价比最高的一项。**

## 2. 值得 Spike（P2，先验证后授权）

### T5 拖拽跨区语义复用

T3 拖拽落点通过分区标记推得目标区，并映射为四类动作：拖入 pinned=置顶、拖出 pinned=取消置顶、
拖入 settled=归档、从 snoozed 区拖出=唤醒；working/snoozed 区为非法落点（返回 null 拒绝）。
一次拖拽手势承载四类状态转移。

对 A9 的候选场景：任务行拖入"归档"区=归档、拖出=恢复、拖入"进行中"区=重新调度。
价值在于把手势归入手势、状态转移归入状态机（Agent Core 的事件流），与项目
"UI 不承载业务状态"的架构方向一致。

Spike 要验证的 Win7 特有问题：
1. Chromium 108 上 HTML5 dragstart/dragover 与 `-webkit-app-region: drag` 标题栏的冲突；
2. 触控板/老鼠标在 125% DPI 下的命中精度（T3 的 clamp-到-viewport 命中算法可直接复用）；
3. 拖拽中命令式状态（T3 用脱离 React 的 Set + 一次性 dragend 复位避免重渲染掉预览）在
   原生 DOM 渲染层是否必要。

### T9 变量注入式拖拽调宽

T3 拖拽期间直接对两个 DOM 节点 `setProperty('--sidebar-width', …)`，松手才写回状态并持久化；
clamp 边界由调用方声明（256–992px），另有 `shouldAcceptWidth` 业务否决钩子。

对 A9 的候选场景：左栏 232px 固定宽度（U04 网格列）改为 200–320px 可调，服务"长任务标题"
场景；右侧 Inspector 同理。U04 四态网格改为 `var(--rail-width)` 驱动即可保留全部断点逻辑。

Spike 要验证：Chromium 108 高频 CSS 变量写入的合成器开销（T3 实测路径，Win7 机器性能
按 PERFORMANCE_BUDGET #2/#10 口径复核）；与 U05"只切类不重建 DOM"契约的兼容性。

### T10 Shift+click 变体动作

T3 主按钮 "New thread" 的 Shift+click = 在当前项目开新线程（tooltip 明示）。
A9 对应候选：任务列表"新建任务"Shift+click = 在当前工作区开任务（默认是全局）。
成本极低，但需先确认与既有快捷键表（`thread.pin` 类）无冲突，属产品决策。

## 3. 明确不采纳

### T3 2000ms working 宽限期

T3 用 2 秒宽限防止 turn 结束瞬间 spinner 闪烁（避免"运行中→空闲→可能又运行"的视觉抖动）。
**不采纳理由**：A9 的进行中状态由本地 Agent Core 事件流驱动，状态转移本身就有审批/检查点
屏障，不存在 T3 那种"轮询快照滞后"的抖动源；且 A9-19 的实时进度契约（21/21 PASS）
对状态显示时效有明确验收口径，人为延迟 2 秒会引入"状态说谎"窗口，与
"进行中任务必须真实可见"的产品要求冲突。若未来接入远程多端快照（快照滞后场景出现），
可按 T3 原始动机重新评估，届时归入 Gateway 层去抖而非 UI 层。

### T11 触屏扩容命中区

T3 对 `pointer-fine:hidden`（粗指针设备）把按钮命中区扩到 3rem。A9 运行场景为
企业 Win7 桌面机（键鼠），无触屏部署形态；44px `.nav-item` 触达目标契约已覆盖键盘/鼠标。
无收益，不引入。

## 4. 已有等价物（不重复实施）

- **T2 五区状态模型**：T3 的 pinned/active/working/snoozed/settled 与 A9 的
  进行中/更早/归档三区是同一状态机在不同产品语义下的投影；差异仅在"已结束但未归档"的
  中间态（T3 settled ≈ A9 完成未归档，A9 已用"更早"组承载）。若采纳 T1 拍平，分组数可无成本扩展。
- **T6 折叠焦点归还**：T3 折叠时把焦点移到面板外第一个 trigger；A9 U03/U05 已实现
  （`closeNavigation` 抽屉分支补焦点归还，A9-16 §1）。
- **T12 权限收缩交互面**：T3 无 `orchestration:operate` 的线程不可拖/不可改名；
  A9 的 fail-closed 契约（Review disabled、能力令牌、Schema IPC allowlist）在更深处实现了
  同一原则。T3 的"UI 层可见的权限收缩"提示样式（禁用态不隐藏）可作为细节参考。

## 5. 落地顺序建议（供任务书起草参考）

1. **T8（IME 放行）**：几行代码，独立契约用例，可随任意 UI 任务捎带；
2. **T7（搜索 ARIA）**：与 T8 同属搜索框小改造，建议合并为一个工作项；
3. **T1（marker 拍平）**：独立重构项，需同步更新 357 项测试中的 DOM 保活用例与 U02 预算模型；
4. **T5/T9/T10**：各自起草 Spike 任务书，实机验证后按 ADR 流程裁决；
5. **T4**：仅登记触发条件，不排期。

## 6. 边界与未知

- 本提案基于 T3 静态逆向（不证明运行时行为），T3 实测的动画时长、tooltip 延时等运行时值
  未纳入映射；
- 全部 Chromium 108 能力判断基于公开兼容性口径，未做 Win7 实机验证；按项目纪律，
  实现前必须完成对应实机复核（参照 A9-16 §4 的真实 Electron 量测方法）;
- T3 是商业产品，本提案仅借鉴交互模式（状态机、事件模型、ARIA 结构），未复制任何代码。
