# A9-67 — 批次5：网络与边界可靠性

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

本批与 A9-66 组合完成云端开发、Claude Code 新机独审、G0 及 Mac G1。私有交付绑定 aa3f68ac3b322d489d6fa30f4e3cb17b0979678f，33 文件已整合到本地 main 工作区，未提交。实际 HEAD 仍为 44ddaf90…；既有修改及 Runtime 45s/30s 配置保留。具体结果、首轮 G0 超时和非阻断 P2 见 [A9-66 当前交付](A9_66_LARGE_INPUT_RESPONSIVENESS.md)。接口与边界见 [ADR-0331](../DECISIONS.md)。

## Win7 限定接受（2026-11-13，WIN7-61）

候选 WIN7-61：源码 `c7f51ea…` / ZIP `0cebc0b0…` / manifest `7279f6ea…`。负责人按 [ADR-0332](../DECISIONS.md) 限定接受，结论 `A9_66_A9_67_WIN7_61_PASS_WITH_KNOWN_LIMITS`，不产生 FORMAL PASS。Win7 实机库层断言 run `a96667-controller`（DEV_CHANNEL）24/24 PASS：F-011/012/025/008/007/009/027，identity/Medium/session 1 核验，closure 3265 文件，sqlite 3.43.1。详细验证过程与证据见 [A9-66 §Win7 限定接受](A9_66_LARGE_INPUT_RESPONSIVENESS.md#win7-限定接受2026-11-13win7-61)。正式门 A/B、完整 GUI 旅程、公开推送及发布 NOT_PERFORMED。

| Finding | 最终处置 |
|---|---|
| F-001 | 不采用统一默认命令期限；保留 ADR-0089 的取消、输出与进程清理合同。 |
| F-009 | Gateway 总等待期限不随持续数据刷新，idle 计时独立，结束时清理定时器。A9 OpenAI-compatible 入口原有总期限保持。 |
| F-010 | 旧 updater 在当前产品不可达，不新增自动更新系统。 |
| F-022 | 真实身份无法确认时拒绝；合法不存在目标仍解析最近已有父目录，保留默认目录延迟创建。 |
| F-023 | 产品不可达；仅库层加固。同步入口在启动原生 async handler 前拒绝，正常异步入口只执行一次。 |
| F-026 | Provider 拼接 body 按字节预算，超限中止底层连接。 |
| F-027 | 未完成 SSE 帧按字节预算，保留跨 chunk、多字节和取消收尾。不新增完整帧大小合同。 |
| F-028 | SQLite 探测错误保留稳定 code 和有界脱敏诊断。 |
| F-029 | 基线遗漏的祖先下不授予 delete-new 资格；保留未知/不可恢复事实和撤销漂移拒绝。 |

新审核未发现新增 P0/P1，原失败全部保留。新 Linux 审核机 Core 924、State 435、Gateway 332 通过；新 Shell 完整运行 1744/1744 通过。Mac 当前 Runtime 消费者 20 项通过；Electron22/Node16 当前编译产物和受控 Provider 恢复/切换/取消链路通过。Node16 Gateway 原 3 项验证按未变化组件字节作为 INHERITED_EVIDENCE，不冒充本轮重跑。

非阻断 P2 保留：删除已绑定恢复目录后需重新打开工作区。首轮 Office 测试超时根因 UNKNOWN，新窄测和完整 Shell 已通过，不延长测试期限。Win7/Win10、Windows ACL、完整 GUI、打包、冻结、门 A/B、公开推送和发布均为 NOT_PERFORMED。证据集中在 outputs/a9-66-67-instabox/FINAL_RESULT.json 及原工作包记录。以下保留各阶段原记录。

## 交付与范围

原始依据：outputs/a9-robustness-audit-r1/AUDIT.md。本批复核并处置F-001、F-009、F-010、F-022、F-023、F-026、F-027、F-028、F-029。成功条件是对应真实入口的响应性、容量、取消和失败事实正确，且既有恢复完整性、路径归属、权限和历史合同保持。

- F-009：执行已有totalTimeout总等待合同，持续低速数据不能不断刷新总期限；已有idle语义、TLS、取消、错误映射与收尾保持。不是给用户命令增加固定期限。
- F-026/F-027：Provider自身拼接的body与未完成SSE帧有明确字节上限，沿用既有transport/parser预算并确认多字节和无换行输入；失败中止底层连接，不能只限制最终返回值。
- F-022/F-028/F-029：路径长度与身份不明、探测错误、checkpoint基线遗漏必须保留稳定脱敏事实。身份失败不可把lexical回退说成已校验；基线incomplete不能提升恢复/撤销资格。保留既有中文/空格/外部路径合同。
- F-023：核实同步IPC启动异步handler的真实注册/调用。若可达，应在副作用前明确拒绝同步调用；正常异步入口仍只执行一次，不能先执行再报错让调用方重试。不得新增公开request registry架构。
- F-001：先对照ADR-0089与用户长命令合同、真实Core signal链路，审计“统一default/idle deadline”建议不直接采用。不改变工具固定超时策略；仅补真实缺失的取消/收尾或作出有依据的不适用处置。
- F-010：先核实旧更新校验是否是当前产品可达入口；可达才修复hash流取消/读失败/等待收尾。不是新增自动更新系统；不可达须给真实调用证据与保留范围。

## 授权与边界

负责人于2026-11-12要求“开始使用instabox流程进行开发两批次”。本轮按已讨论的批次3、5连续开发、普通修复、区分度验证、独立审核和Mac回收整合。实际main基线44ddaf90dab7931adda138d73bb6b400e360382a，既有dirty/untracked完整保留；不得把既有未提交修改混入私有产品基线。

使用现有wp.py的open→run→poll→commit→close→receive流程。两批在一个组合开发工作包按先3后5实施，分别报告finding、改动和验证；独立新机只读审核组合tip并运行G0。优先czl/r4现有ready快照；chai2满额不占用或删除既有机器。开发最长180分钟，审核最长90分钟，必要同范围返修和新复审各一次；临时机串行，每台既有14400秒自动删除兜底。模型沿用既有可用配置，Claude执行、Codex独立审核；记录实际服务模型/effort，不修改全局配置，不静默切换不可用模型。

所选工作流包括私有allin2/win7-coding-agent-staging准确base/工作分支推送、wrapper按Mac核验的逐文件SHA清单提交、回收结果核SHA、撤销本轮短命key及回收本轮临时机。不得删除或唤醒母机、其他项目机器、快照及ci/monster。结果尚未回收核验不得删机。保留首FAIL；同类失败两轮先诊断；身份、完整性、秘密或生命周期未知即停止依赖动作。

不新增依赖、原生组件、Worker、SQLite迁移/格式、持久化格式、权限/审批语义或系统配置。复用Node16.17.1/Electron22.3.27支持的API；保留旧同步接口和现有公开IPC schema。可补内部异步入口并接入真实消费者；不能只写无人调用的辅助方法。需要改变重大架构、公开契约或安全语义时报告具体取舍并暂停依赖动作，其余范围内工作继续。

主代理维护共享状态、ADR及本地整合。远端员工不改共享治理文档，不提交、不推送、不安装工具、不派子代理；代码完成交给wrapper按SHA清单提交。Mac不自动提交本地main、不推送公开origin、不发布。Win7/Win10窗口、打包、冻结、双构建、门A/B及发布均不在本轮授权内。

## 验证要求

### 共因修复过程记录（2026-11-13 UTC，开发机；原状态保留）

9de03c57…的 Claude Code 独审结论为 DO_NOT_INTEGRATE。主代理已复现其恢复目录 P1、chmod 与搜索 P2，并完成隔离修复。该阶段状态与验证见 A9-66“共因修复过程记录”和 outputs/a9-66-67-instabox/COMMON_ROOT_REPAIR.md。原 FAIL 不改判，该阶段本地 main 产品未整合，新独审仍交 Claude Code。

F-023 的处置更正为“产品不可达；库层加固”。IPCChannel 无产品消费者，不能把库层修复记作产品入口修复。Win7/Win10、GUI、打包、门 A/B、公开推送及发布仍为 NOT_PERFORMED。

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

## 负责人后继选择：Box Codex 续修

Claude返修因5小时额度耗尽退出1，原包按EMPLOYEE_MODEL_QUOTA保留。11份源码与33份证据453331字节已回收核SHA，临时机已删。负责人选择“改用Box已配置的Codex继续”。新包a9-66-67-codex以3e123e0691442bcaf380f3c190bb91298f34a407为Git基线，恢复11份输入；State替换为主代理F-008修正版并加入永久回归，输入逐文件绑定。采用既有gpt-6.1-sol/high配置，不改全局默认、不静默fallback；新独审仍审核完整44ddaf90..最终tip。恢复源码的目录身份探针已在Mac Node20及Electron22/Node16拒绝，尚不替代新独审。F-007与Shell剩余3项失败继续收口，首FAIL保留；本地产品尚未整合，Win7/Win10、GUI、打包、门A/B及发布NOT_PERFORMED。

## Codex 官方认证恢复

首Codex包实际请求5.678秒退出1，refresh token revoked，源码未变；12份源码与33份证据已再次回收核SHA。负责人通过安全输入完成本轮临时Box官方登录，CLI退出0，新认证只存本机独立钥匙串引用并用于本轮开发与独审临时机；母机及快照未改。原包保留FAILED并已删机。新包a9-66-67-codex2从同一私有WIP恢复，显式记录授权认证注入及新包凭据基线；不将预期登录更新伪装为原凭据未变。未回退模型，真实生成结果另记。

## 7751df50返修与新GBK归属P1

Codex已完成并由wrapper按16文件SHA清单提交7751df50a765184a74dea1c3638ccd586dd3fbaa，私有推送后开发机已删、凭据未漂移。父代理实际测试通道State433/433、Workspace551 PASS/1 D9省略、原HTTP消费者25/25通过；新审核机完整Workspace通过，组合只读独审进行中。父代理真实FS确认GBK准备await后根替换可向外部创建文件和恢复区且outsideWorkspace=false，阻断本地整合。隔离最小修复同11项测试旧源9 FAIL/2 PASS、新源11 PASS，Node20及Electron22/Node16原探针均拒绝，外部无写入。源码和证据PARENT_GBK_FIX及GBK_P1_PARENT_REPAIR.md保留，主工作区产品未改。独审其余发现待收口，修复需新tip与独立复审，不能改判7751原失败。

负责人后继明确“后续新审核继续交给claude code”。当前已运行Codex独审保留结论；GBK返修后的新独立复审采用Claude Code及本轮已有有效钥匙串认证引用，记录实际可用性，不改全局模型配置、不静默回退。开发仍按已选择的Box Codex执行。

当前独审又指出copyEntry在await后沿用旧lstat；主代理真实编译助手与原生queueMicrotask确认源叶由普通文件换为外部符号链接后，目标普通文件包含外部虚构内容，违反不跟随链接语义。隔离最小修复在让出后、删除任何目标前复核源lstat身份；同5项旧源4 FAIL/1 PASS、新源5 PASS，Node20/Node16原探针拒绝且未建目标。与GBK P1组合为2源码+2常驻测试的同范围返修，PARENT_GBK_FIX/COPY_RED_GREEN_BINDING.json保留准确绑定；未改主工作区产品。

独审最终报告绑定44ddaf90..7751df50，结论DO_NOT_INTEGRATE（2 P1、2 P2），原件REVIEW2_FINAL.md与REVIEW2_STRUCTURED_FINAL.json；审核机已删、凭据未漂移。原tip已知P1，停止接收整合，其余最终G0留给修复后新机；已执行Workspace检查不改判。父代理同范围补齐GBK归属、copy叶身份及部分文件清理、..shadow后代识别、目录基线缺口。当前22项真实回归旧源18 FAIL/4 PASS、新源22 PASS，全部沙箱回收。新包a9-66-67-gbkfix正在核验先前20项输入；父代理新增的2项清理修复仅在员工退出后顺序整入，不改动其运行源码。下一轮新复审采用负责人指定Claude Code。
