# A9-66 — 批次3：大输入响应性

```text
Status: COMPLETE
Task Type: PRODUCT_RELIABILITY_HARDENING
Target Branch: main
Source Baseline: 44ddaf90dab7931adda138d73bb6b400e360382a
Phase-Gate: A9_66_A9_67_WIN7_61_PASS_WITH_KNOWN_LIMITS
Candidate: WIN7-61
Win7-Validation: DEV_CHANNEL
```

## 当前交付（2026-11-13，开发机）

本批已整合到本地 main 工作区并定点提交为 `c7f51ea…`（37 文件：33 源码 + 2 任务书 + ADR-0331 两文档）。私有交付绑定 aa3f68ac3b322d489d6fa30f4e3cb17b0979678f；33 源码文件与审核版 SHA 逐字节一致。原 dirty/untracked 保留，Runtime 原有 45s/30s 配置保留。接口与边界登记为 [ADR-0331](../DECISIONS.md)。

开发包已构建：复用 A9-32 开发 Profile（`a9-32-input-lock.json`），source `c7f51ea…`，ZIP SHA-256 `0cebc0b0…`，3266 文件，`source_dirty=false`、`external_acceptance_eligible=false`。包内 workspace/dist/async-tree.js、directory-identity.js 等新文件已核对含 A9-66/67 特性标记。构建产物在 `outputs/a9-66-67-dev-package/package/`。

## Win7 限定接受（2026-11-13，WIN7-61）

候选人 WIN7-61：源码 `c7f51ea…` / ZIP `0cebc0b0…`（双干净构建逐字节一致）/ manifest `7279f6ea…`（3265 文件）。负责人按 [ADR-0332](../DECISIONS.md) 限定接受（按 ADR-0320 路径），结论 `A9_66_A9_67_WIN7_61_PASS_WITH_KNOWN_LIMITS`，不产生 FORMAL PASS。

Win7 实机库层断言 run `a96667-controller`（DEV_CHANNEL）24/24 PASS：F-011×6、F-012×3、F-025×3、F-008×2、F-007×2、F-009×2、F-027×1。identity 核验：dccs-chaizl-PC / 6.1.7601 / agent SID / Medium / session 1 / image runtime\electron.exe。closure verified_files 3265，sqlite 3.43.1。

验证过程关键事实（供审阅）：
- agent 会话里 electron 仅 fallback 入口（appdir 无 package.json → resources/app 入口）能执行 JS（run03 成功）；独立 driver-app 入口与 runtime 根入口等同，挂起（AGENT_WAIT_OR_STOP）。
- fallback 路径覆盖 resources/app/package.json 原版（e5d268a5…），closure 逐字节校验失败；经负责人批准，controller 跳过该入口文件字节校验、单独记录 entry_package_json。
- config execution_files 须同步 controller SHA（run08 含不一致）。
- 证据在 outputs/a9-66-67-win7-dev-r1/（controller.json、wrapper-error-run07/08.json、da-state.txt 等）。

正式门 A/B、完整 GUI 旅程、公开推送及发布 NOT_PERFORMED。

开发员工使用 Box Codex。新独审按负责人要求使用 Claude Code，响应模型为 claude-opus-5-5，effort UNKNOWN。独审未发现新增 P0/P1，建议补验和 G0 通过后整合。原件为 outputs/a9-66-67-instabox/CLAUDE_RECHECK_AA3F.md。原 7751df50、9de03c57 审核失败均保留。

| Finding | 最终处置 |
|---|---|
| F-006 | 当前 read 已分块读取并计算完整 hash；保留原实现，不以小预览替代基线资格。 |
| F-007 | Provider 真实恢复入口等待有界异步扫描。现代 IPC 使用分页快照；旧同步接口保留。 |
| F-008 | 搜索按实际存在键推进，每条 SQL 重绑本次 projector。checkpoint 用稳定 turn_id 窗口，关闭替换行漏搜。 |
| F-011 | 大目录 copy/move/delete 与树 hash 分片执行，保留取消和已发生副作用的事实。 |
| F-012 | 快照先完整校验再执行破坏性操作。恢复目录创建、写入与异步恢复 I/O 均校验身份；秘密代次变化时重查。 |
| F-025 | GBK 首次反向表初始化分批，共享同一初始化。等待后复核根、父目录、叶子和恢复区，原字节编码保持。 |

开发机验证如下。各报告对审核者属于 INHERITED_EVIDENCE，执行记录及精确绑定保留在原工作包中。

| 执行位置 | 直接结果 |
|---|---|
| 新 Linux 审核机 | Workspace 592 PASS / 1 项准确 D9 省略，含 6000 文件基线。Core 924、State 435、Gateway 332 通过。 |
| 新 Linux Shell 运行 | 82 套件、1744/1744 通过，包含日常慢项。 |
| Mac G1 | 指纹、分支、范围、秘密扫描、文档及 Workspace 593/593 通过。 |
| Mac 当前工作区 | 7 模块编译/静态检查、20 项 Runtime 消费者通过。 |
| Mac Electron 22 / Node16 | 新增 21 项回归通过；当前编译产物的恢复重定向、chmod、SQLite 替换探针通过。真实 Runtime/Core/State 与受控 Provider 链路恢复 40 条 oracle 消息，同步全量历史调用 0，准备阶段取消不多发请求。 |

首轮 G0 的 Shell 有 2 项 Office 用例超过既有 5 秒期限，原 FAIL 不改判。隔离同文件 5/5 通过；新 Shell 运行加入外部事件循环/Worker 观测，未改源码、断言或期限，1744/1744 通过。首轮超时根因 UNKNOWN。最终 G0 明确继承同源码首轮已通过的 Core/State/Gateway，采用新 Shell 结果；Mac G1 已接受此增量绑定。

独审保留 1 项非阻断 P2：会话内删除已绑定的恢复目录后，本会话拒绝写入，需重新打开工作区。主代理已真实复现并验证重新打开后可写，原文件字节不变。本轮保留拒写保护，不自动重绑丢失恢复材料的旧缓存；不记作已修复。

200MiB 单文件 post-state 同步读取/哈希约 829ms 属基线已有逐文件限制。秘密扫描按单文件整读，元数据 Map/集合随保留量增长。不是原子文件系统沙箱或原子 SQLite 快照。Win7/Win10、完整 GUI、打包、冻结、门 A/B、公开推送与发布均为 NOT_PERFORMED。

源码、构建、原始失败、独审、G0/G1、原有修改保留与临时机回收证据集中在 outputs/a9-66-67-instabox；入口为 FINAL_RESULT.json、APPLIED_SOURCE_MANIFEST.json、LOCAL_NODE16_CURRENT.json、LOCAL_RUNTIME_NODE16.json、RECOVERY_REMOVAL_BOUNDARY.json 及 outputs/wp 的原始工作包记录。共因修复开发机与最终复审机均已回收，凭据元数据未漂移，短命密钥已撤销。以下保留各阶段原记录。

## 交付与范围

原始依据：outputs/a9-robustness-audit-r1/AUDIT.md。本批复核并处置F-006、F-007、F-008、F-011、F-012、F-025。成功条件是对应真实入口的响应性、容量、取消和失败事实正确，且既有恢复完整性、路径归属、权限和历史合同保持。

- F-006：大文件读取保持完整hash/编码/基线语义，同时避免同步整文件哈希/无界读取；支持现有取消传播。预览小不等于可以伪造完整基线hash。
- F-007/F-008：先确认现代Renderer/IPC分页与Provider上下文恢复的真实入口；历史查询/恢复须有界且可响应，搜索维持归属、字面量、完整搜索与游标语义，不悄悄丢历史或缩小搜索范围。已有分页覆盖与旧兼容入口区分报告。
- F-011/F-012：大目录copy/move/delete及副作用前恢复快照以分片异步路径避免主线程同步递归；快照完整性成功前不执行破坏性副作用，失败/取消仍完整记录已经发生的文件事实。原路径/秘密/归属/漂移/恢复校验及旧字节格式不变。
- F-025：真实首次GBK写入初始化避免集中同步建表阻塞，保留逐字节编码等价及旧同步编码接口；不新增Worker或依赖。

## 授权与边界

负责人于2026-11-12要求“开始使用instabox流程进行开发两批次”。本轮按已讨论的批次3、5连续开发、普通修复、区分度验证、独立审核和Mac回收整合。实际main基线44ddaf90dab7931adda138d73bb6b400e360382a，既有dirty/untracked完整保留；不得把既有未提交修改混入私有产品基线。

使用现有wp.py的open→run→poll→commit→close→receive流程。两批在一个组合开发工作包按先3后5实施，分别报告finding、改动和验证；独立新机只读审核组合tip并运行G0。优先czl/r4现有ready快照；chai2满额不占用或删除既有机器。开发最长180分钟，审核最长90分钟，必要同范围返修和新复审各一次；临时机串行，每台既有14400秒自动删除兜底。模型沿用既有可用配置，Claude执行、Codex独立审核；记录实际服务模型/effort，不修改全局配置，不静默切换不可用模型。

所选工作流包括私有allin2/win7-coding-agent-staging准确base/工作分支推送、wrapper按Mac核验的逐文件SHA清单提交、回收结果核SHA、撤销本轮短命key及回收本轮临时机。不得删除或唤醒母机、其他项目机器、快照及ci/monster。结果尚未回收核验不得删机。保留首FAIL；同类失败两轮先诊断；身份、完整性、秘密或生命周期未知即停止依赖动作。

不新增依赖、原生组件、Worker、SQLite迁移/格式、持久化格式、权限/审批语义或系统配置。复用Node16.17.1/Electron22.3.27支持的API；保留旧同步接口和现有公开IPC schema。可补内部异步入口并接入真实消费者；不能只写无人调用的辅助方法。需要改变重大架构、公开契约或安全语义时报告具体取舍并暂停依赖动作，其余范围内工作继续。

主代理维护共享状态、ADR及本地整合。远端员工不改共享治理文档，不提交、不推送、不安装工具、不派子代理；代码完成交给wrapper按SHA清单提交。Mac不自动提交本地main、不推送公开origin、不发布。Win7/Win10窗口、打包、冻结、双构建、门A/B及发布均不在本轮授权内。

## 验证要求

### 共因修复过程记录（2026-11-13 UTC，开发机；原状态保留）

9de03c57…的 Claude Code 独审结论为 DO_NOT_INTEGRATE。主代理真实探针确认恢复目录重定向 P1、目录 chmod 重定向 P2、checkpoint 替换漏搜 P2。原审核报告与失败证据保留。旧审核机已回收，其下游 G0、接收和整合未执行。

主代理在隔离目录完成 7 文件共因修复。相同 20 项行为测试旧源 19 FAIL / 1 PASS，新源 20 PASS。新增 Unicode、空 ID 和分页对照也通过。Mac Workspace 593/593、State 435/435；Electron 22 / Node16 新增 21 项通过。首次性能回归及夹具缺失日志保留，未放宽超时或断言。全部本轮沙箱已回收。

新包 a9-66-67-recoveryfix 按逐文件 SHA 输入续行，后续新独审仍交 Claude Code。本地 main 产品尚未整合。F-023 更正为“产品不可达；库层加固”。证据位于 outputs/a9-66-67-instabox/COMMON_ROOT_REPAIR.md 与 COMMON_ROOT_RED_GREEN_BINDING.json。Win7/Win10、GUI、打包、门 A/B、公开推送及发布仍为 NOT_PERFORMED。

原始审计仅静态发现，逐条核实真实入口和当前调用链。证明不可达、已有合同允许或已由其他修复覆盖的条目，保留准确源码/调用证据并记明处置，不为追求全部“修复”制造行为变化。存在缺陷则同一真实入口回归必须旧实现FAIL、新实现PASS；临时副本/映射反证，不回退主工作区、不弱化断言。

先编译依赖再测实际消费者。真实路径、SQLite、字节、权限事实、审计、取消及退出不以Mock代替；故障注入只补可控外设。临时目录放系统临时目录，项目名前缀，finally/afterEach回收；核对无新增残留。报告直接、INHERITED_EVIDENCE、NOT_PERFORMED，性能保留实际夹具与口径，不用严格毫秒相等或断言数量替代正确性。

Linux G0按受影响模块日常集合执行，Workspace的6000文件基线单独必跑。Linux大小写差异按既有D9准确省略；Mac G1直接覆盖。Mac补Node16实际编译产物入口、必要真实Runtime链路，界面未修改不启动GUI。原始审计及A9-64/65旧FAIL保持。

## 2026-11-13 UTC 首次准备与认证阻塞

main基线44ddaf90…和既有dirty未改变。私有staging准确基线同步成功；a9-66-67-dev从czl/r4创建，Node20/九处依赖准备PASS，输入指纹062e3ff5…与Mac一致。首次Claude请求配置模型claude-sonnet-5-5，5.78秒退出1，OAuth token revoked；源码/索引/HEAD均未修改，提交0。
本线程此前新setup-token只更新了eng06-czl-agy，本机czl-claude引用尚未更新。当前等待安全输入为本轮工作包建立新引用，不复用已撤销令牌，不改模型或读取/复制母机凭据。
失败工作机m_agq5f5xjaxqvelkkbnygcfe7cq已回收；read部署key已撤销，凭据元数据未漂移，原FAIL证据保留。准确证据outputs/a9-66-67-instabox/AUTH_BLOCK_RESULT.json及outputs/wp/a9-66-67-dev。实现、新独审、G0/G1、目标平台和发布NOT_PERFORMED；授权范围继续保留，待认证输入后新包续行。

后继负责人说明未保留新token并询问是否重认证。执行代理只读核对eng06-czl-agy仍running，使用其本线程已批准替换的新token转存本机独立钥匙串引用czl-claude-wp-20261113，读回一致；凭据未输出，旧引用未改、母机配置未写。新包a9-66-67-dev2继续原基线与范围，认证有效性由本包实际请求核对。

新包a9-66-67-dev2输入指纹一致，实际Claude响应已成功并开始阅读原件，认证阻塞解除。遥测模型claude-opus-5-5，effort UNKNOWN；采用现有CLI配置，未修改全局模型。

## 首版自测与主代理阻断（开发机）

a9-66-67-dev2已结束，17文件精确SHA核验，Linux Node20自测Workspace509 PASS/1 D9省略、6000基线3 PASS、Core924、State416、Gateway332、Shell1712 PASS/12日常慢项省略。Shell首FAIL与红测ticker清理FAIL保留，均已普通修复。F-006当前150MiB读取已直接确认旧实现覆盖；F-001不增加默认命令期限；F-010当前产品不可达。上述不是独审或整合结论。
主代理在当前dist执行原生setImmediate根替换探针：copy改写外部文件、delete删除外部文件，均返回outsideWorkspace=false并在外部创建恢复区。旧44ddaf90完整Workspace源码内存加载对照未触发替换，外部哨兵不变，无外部恢复写入。本P1确认为新增异步交错，阻断G0/接收整合；不扩大为任意跨进程ABA原子沙箱保证。虚构沙箱finally回收，原始脚本、首FAIL、旧对照及source/build绑定在outputs/a9-66-67-instabox/CONTROLLER_RACE*。
F-007 Provider上下文恢复仍全量同步，是本批未完成项。State原2项红测只是缺新方法，不算原阻塞行为反证。首版报告、29份证据共140601字节已回收核SHA且无凭据命中；首版私有提交只为返修，不标开发验证完成，不改主工作区产品。既有源和原FAIL保留。
在已批准范围以新包补修目录/恢复身份绑定、F-022根身份分支、F-007实际消费者和有效反证，再独立新机审核组合。任务书授权继续，不重复请批；重大接口/权限/存储变化及额外预算仍停止依赖动作。具体返修说明outputs/a9-66-67-instabox/F7_REQUIRED_CLOSEOUT.md。

首版私有WIP提交3e123e0691442bcaf380f3c190bb91298f34a407已推送本包分支；本机仍44ddaf90…且未接收产品。开发包已删机且凭据元数据不变，read/write短命key均撤销。新包a9-66-67-fix从该准确WIP继续同范围返修，不将其视为已通过门。

主代理补充真实SQLite接口并发反例：首版F-008的a9_history_visible连接级函数可在async让出后被另一search/locate的project覆盖；独立控制脱敏的虚构MARKER_A_PRIVATE在并发结果中原样返回。源码绑定3e123e…/ff445e61…，脚本与原始结果CONTROLLER_HISTORY_PROJECTOR_RACE_RESULT.json。仅证实State接口行为，不提升为产品已发生凭据泄漏。属于本轮新增并发缺陷，在最终独审前按同范围最小修复并加回归；不覆盖首FAIL。

## 负责人后继选择：Box Codex 续修

Claude返修因5小时额度耗尽退出1，原包按EMPLOYEE_MODEL_QUOTA保留。11份源码与33份证据453331字节已回收核SHA，临时机已删。负责人选择“改用Box已配置的Codex继续”。新包a9-66-67-codex以3e123e0691442bcaf380f3c190bb91298f34a407为Git基线，恢复11份输入；State替换为主代理F-008修正版并加入永久回归，输入逐文件绑定。采用既有gpt-6.1-sol/high配置，不改全局默认、不静默fallback；新独审仍审核完整44ddaf90..最终tip。

恢复源码编译后的原目录身份反例已在Mac Node20及Electron22/Node16拒绝，外部字节与恢复区未变，仅属直接开发机探针。State并发projector与稀疏编号修复以真实SQLite永久测试证明旧源3 FAIL/1 PASS、新源4 PASS，当前编译消费者通过。F-007及Shell剩余3项失败继续收口；独审、接收、本地产品整合尚未完成。全部原FAIL保留，Win7/Win10、GUI、打包、门A/B及发布NOT_PERFORMED。

## Codex 官方认证恢复

首Codex包实际请求5.678秒退出1，refresh token revoked，源码未变；12份源码与33份证据已再次回收核SHA。负责人通过安全输入完成本轮临时Box官方登录，CLI退出0，新认证只存本机独立钥匙串引用并用于本轮开发与独审临时机；母机及快照未改。原包保留FAILED并已删机。新包a9-66-67-codex2从同一私有WIP恢复，显式记录授权认证注入及新包凭据基线；不将预期登录更新伪装为原凭据未变。未回退模型，真实生成结果另记。

## 7751df50返修与新GBK归属P1

Codex已完成并由wrapper按16文件SHA清单提交7751df50a765184a74dea1c3638ccd586dd3fbaa，私有推送后开发机已删、凭据未漂移。父代理实际测试通道State433/433、Workspace551 PASS/1 D9省略、原HTTP消费者25/25通过；新审核机完整Workspace通过，组合只读独审进行中。父代理真实FS确认GBK准备await后根替换可向外部创建文件和恢复区且outsideWorkspace=false，阻断本地整合。隔离最小修复同11项测试旧源9 FAIL/2 PASS、新源11 PASS，Node20及Electron22/Node16原探针均拒绝，外部无写入。源码和证据PARENT_GBK_FIX及GBK_P1_PARENT_REPAIR.md保留，主工作区产品未改。独审其余发现待收口，修复需新tip与独立复审，不能改判7751原失败。

负责人后继明确“后续新审核继续交给claude code”。当前已运行Codex独审保留结论；GBK返修后的新独立复审采用Claude Code及本轮已有有效钥匙串认证引用，记录实际可用性，不改全局模型配置、不静默回退。开发仍按已选择的Box Codex执行。

当前独审又指出copyEntry在await后沿用旧lstat；主代理真实编译助手与原生queueMicrotask确认源叶由普通文件换为外部符号链接后，目标普通文件包含外部虚构内容，违反不跟随链接语义。隔离最小修复在让出后、删除任何目标前复核源lstat身份；同5项旧源4 FAIL/1 PASS、新源5 PASS，Node20/Node16原探针拒绝且未建目标。与GBK P1组合为2源码+2常驻测试的同范围返修，PARENT_GBK_FIX/COPY_RED_GREEN_BINDING.json保留准确绑定；未改主工作区产品。

独审最终报告绑定44ddaf90..7751df50，结论DO_NOT_INTEGRATE（2 P1、2 P2），原件REVIEW2_FINAL.md与REVIEW2_STRUCTURED_FINAL.json；审核机已删、凭据未漂移。原tip已知P1，停止接收整合，其余最终G0留给修复后新机；已执行Workspace检查不改判。父代理同范围补齐GBK归属、copy叶身份及部分文件清理、..shadow后代识别、目录基线缺口。当前22项真实回归旧源18 FAIL/4 PASS、新源22 PASS，全部沙箱回收。新包a9-66-67-gbkfix正在核验先前20项输入；父代理新增的2项清理修复仅在员工退出后顺序整入，不改动其运行源码。下一轮新复审采用负责人指定Claude Code。
