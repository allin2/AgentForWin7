# A9-59 — alpha.8 收口

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: 1a25d593ee2bd3f155b043bfe1d9aebf688f8fd1 + existing working-tree changes
Target Version: 0.3.0-alpha.8
Phase-Gate: A9_59_IMPLEMENTATION_AUTHORIZED
Win10-Validation: NOT_PERFORMED
Win7-Validation: NOT_PERFORMED
```

## 1. 版本范围与授权

负责人回复“收口aplha8”，批准整理 A9-54～58、核查四项审查 UNKNOWN、必要的局部修复、统一新包身份和本地验证。
实际分支 main，HEAD 如上；既有 dirty/untracked 按本机 `outputs/alpha8-r1/BEFORE.json` 保留。
不实施长任务接续、整套 DPI 优化、新权限、依赖、原生组件或数据库迁移。
本轮由主代理直接完成，不继承前轮 InstaBox 派发或已关闭的目标窗口。
负责人后继明确授权一次相关路径与文档段落的本地提交及单次构建。Win7 准确窗口与预算、门 A/B、限定接受和公开推送/发布在材料齐备后按适用授权执行。

## 2. 影响与成功条件

- 新版本集中交付：已结束对话、默认工作目录、默认 Full Access 与行菜单、运行中只读浏览、完整历史搜索与事实交付卡。
- 四项疑点分别复现、分类并保留原 UNKNOWN；只修复确认的问题。
- 新包文件名、应用 package、输入锁、manifest、SBOM 与开发检查身份一致；旧锁、旧候选不改写。
- 复用 Electron22.3.27/Node16.17.1、SQLite3.43.1/ABI110、managed v26 准确原生字节；只修改产品 JS/State 查询与装配身份。
- 开发机按真实 State/IPC/Runtime 跑搜索分页和交付卡，按最短产品链路检查菜单、浏览、搜索、Diff、重启与零重放。
- 测试与构建沙箱位于系统临时目录，finally 清理；证据保留在本机 `outputs/alpha8-r1/`。

## 3. 检查与停止条件

先构建当前依赖，再运行受影响 Shell/State 测试、发布工具检查、docs:check 和 diff 检查。
不以 A9-58 旧包的 Win7 DEV_CHANNEL 结论代替 alpha.8 新包；新包直接校验自身闭包与原生输入。
正式候选、双构建、独立审核、目标验证与发布均保持 NOT_PERFORMED，直到对应动作实际完成。
同类两轮未解释失败先最小诊断；身份、完整性、安全或未知生命周期失败停止依赖动作。
容量不足不清理历史材料，不延用旧容量例外；不接管他人锁或替换默认实例。

## 4. 执行记录

本轮已核对 main、HEAD 与 既有 dirty/untracked 文件。准确清单以 BEFORE.json 为准。
四项疑点：checkpoint 父目录 realpath、旧迁移时间游标、同毫秒文本 ID 排序、深历史同步查询耗时。


### 4.1 遗留疑点定向结论

- 路径别名：真实 Runtime/IPC 反例在旧实现失败 1 项。合法祖先别名导致交付卡 UNKNOWN；修复后同一用例通过，重定向 checkpoints 目录和文件符号链接仍拒绝。只改变只读元数据路径比较。
- 旧游标：真实 State 查询生成 SQLite UTC 时间游标后，原产品 validator 拒绝第二页。旧实现失败 1 项，修复后完整分页通过；保留原始游标字节，非法日期、小时与注入文本仍拒绝。
- 同毫秒排序：原 State 用例覆盖 310 个结果的全分页，实际 SQL 探针另外检查 1,000 条跨数字位数结果，无漏项和重复。排序为文本 ID 降序，是稳定总序；不声明同毫秒内为数字 ID 倒序，不改其行为。
- 深历史：开发机 Node20/SQLite 原查询实测 1,000/10,000/25,000 条、每条约 2KB。25,000 条首/次/无命中查询分别 95.73/98.60/84.33ms。每页仍同步全量扫描，命中时投影约两次/行，不能据此签 Win7 大规模性能 PASS。保留为版本限制，不增加索引、缓存或异步查询架构。

原 A9-58 的 UNKNOWN 是历史审查事实，不回改。准确反例与探针见本机 `outputs/alpha8-r1/DELIVERY_RED.log`、`CURSOR_RED.log`、对应 GREEN 日志和 `HISTORY_PROBE.json`。

### 4.2 开发机验证

Node20.17.0，当前工作区含本轮补丁。七模块依赖构建及 Shell 静态门通过；State 全模块 408 项通过；Shell 日常集合 74 文件、1607 项通过，12 项合同慢检查在独立发布必需检查中补跑。
打包定向 4 项通过，包括 alpha.8 应用/package/runtime/manifest 同身份、串号拒绝和旧 A9-32 管线。
Mac Electron22.3.27 真实 main/preload/IPC/Runtime/SQLite 两进程共 10 项通过，覆盖历史搜索/定位、非空队列与运行身份隔离、真实文件交付卡/Diff、重启零重放及正常退出。
首轮复用了较旧夹具，未等待带 turnId 的持久化事实而失败；保存 `ui-source/` 首败。候选外夹具改为等待正确身份并使用已验证的队列场景后，`ui-source-r2/` 两阶段通过。未修改产品来适配夹具。
本轮 Mac 不证明 Windows DPAPI 草稿持久化，标 NOT_PERFORMED。源码 GUI 检查不等于 Windows 包运行；新包实际加载另行记录。
文档检查通过 414 文件、82 任务书，diff 检查通过；发布全组和两项常设发布检查结果待补记。

### 4.3 当前授权依赖

单次本地开发构建使用新 alpha.8 开发锁，保留干净源码和原生注册表门。构建器不接受未提交开发源码。
负责人已明确选择“授权本地提交并构建（推荐）”。仅提交相关产品、测试、装配和文档段落；不推送、不发布。
后继目标窗口需在准确新 ZIP、manifest、驱动和容量材料就绪后决定；不从旧 24GB/60分钟窗口推导授权。
