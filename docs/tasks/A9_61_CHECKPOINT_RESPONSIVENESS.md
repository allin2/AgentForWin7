# A9-61 — 批量文件收尾与恢复校验响应性修复

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELIABILITY_BUGFIX
Target Branch: main
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d
Phase-Gate: A9_61_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
```

## 1. 授权与交付

负责人明确要求“修复上述问题，使用instabox”。本轮修复A9-60已经复现的Checkpoint写入放大、取消后的收尾阻塞和恢复校验主线程停顿。
故障机仍不可连接；持续转圈的原事故根因UNKNOWN，不把本轮性能修复写成已证明修复该事故。
当前main基线d5b99b62…；既有dirty/untracked保留，清单与差异在本机outputs/a9-61-wp/BEFORE.json及before-working-tree.patch。
交付为可整合的产品源码、区分度回归、独立审核和开发机真实入口验证。主代理负责设计约束、整合与交付；InstaBox工作包实施及新机审核。

## 2. 可观察的成功条件

- 批量移动512份虚构文件后，实际收尾不再对每个文件重写完整checkpoint。持久化次数按有界批次增长，全部文件事实、目录事实、重命名和不可恢复标记保持。
- 收集和文件工件校验期间让出事件循环，停止IPC能被处理；取消后仍完整记账，不以丢弃收尾来缩短时间。
- 当前产品真实启动、恢复与首次状态读取使用分片准备路径。不能只新增无人调用的async方法。合法旧清单能恢复，坏清单、错属、敏感数据、篡改和不完整提交仍拒绝；不自动重放模型或工具。
- 批次失败、校验失败、并发查询及正常退出不产生错误确认或未校验缓存。重开进程从真实落盘数据恢复，不能只验内存结果。

## 3. 行为与实现边界

复用Electron22.3.27/Node16.17.1、既有fs/调度能力、SQLite和Runtime。保持checkpoint字节格式及版本、SQLite schema、公开IPC schema、权限、审批、TLS和恢复完整性要求。
不新增第三方依赖、原生组件、系统安装/权限/配置，不删除原件、历史恢复材料、候选或证据。保留Workspace/Checkpoint原同步接口的现有调用合同；可增加内部异步准备和批次入口并接入真实消费者。Runtime内部Diff返回可由已异步的主进程IPC等待；错属校验仍同步拒绝，Renderer公开IPC schema与响应字段不变。
批次必须限定到准确Turn/操作，不把共享全局“暂停落盘”标记跨await维持。收到Stop不能跳过已经发生的文件变化；最终collected只能在必要事实成功落盘后确认。
异步校验不能在完成前提升缓存或撤销资格；写入/撤销仍做适用的目标身份与漂移校验。若最小完整方案需要改变持久化或公开权限/API语义，先报告该具体取舍，其余独立工作继续。
改动定位为Workspace Checkpoint/外部变更收集、Shell Runtime/工作区注册/主进程相关调用及直接相关测试。共享文档和ADR由主代理维护；不顺带改Renderer视觉、Runner、Provider超时或其他既有dirty。

## 4. InstaBox工作包

使用现有open → run → poll → commit → close → receive；不修改包装器和派单系统。使用czl账号ready的r4快照sn_agq2jii7qd46ez2r4afj3gbbku，临时机名称仅wp-a9-61-*，串行最多4台：开发、审核，以及必要同范围修复与复审各1台。
开发包最多90分钟，审核包最多45分钟；机器自动删除兜底14400秒。使用现有可用模型与账号配置，记录实际model/effort，不更改全局设置；不可用时停止相应派发，不静默换模型或复制凭据。
允许现有包装器按准确清单在私有allin2/win7-coding-agent-staging新base/工作分支提交和推送，回收核SHA后撤销本轮短命部署密钥并删除本轮临时机；这是所选工作流的交付动作。不提交本地main，不推送公开origin，不发布。
母机、其他项目机器、全部既有快照和ci/monster保留。账号身份、快照或凭据漂移、未知生命周期、安全或必需审计失败时停止依赖动作。同类失败两轮先诊断，不盲目整批重试。
开发包defer G0；独立新审核机只读审核准确提交，并运行受影响Workspace/Shell日常集合和必跑6000文件基线让出用例。Mac receive/G1绑定准确审核包、tip和输入指纹。

## 5. 验证与证据

先构建依赖，再测真实消费者。新增回归至少覆盖批量收集的写入次数、收集与冷校验的事件循环交错、取消后事实、批次落盘失败/中断、冷重开、完整性/错属/秘密拒绝和零重放。
用同一回归在旧实现或按语义撤掉修复的临时副本验证失败，再对新实现通过。性能记录实际耗时，不用严格毫秒阈值代替行为证明。测试沙箱置于系统临时目录并在finally/t.after清除，核对零新增残留。
必跑Workspace的tests/unit/a9-19-baseline-yield.test.ts；Shell的真实Runtime/IPC生命周期和恢复集成随消费者影响覆盖，不用Mock证明真实落盘与恢复。
Mac Electron22/Node16入口使用与A9-60相同规模的虚构文件与回环模型，验证真实收尾/停止/恢复、文件SHA和进程退出，记录写入次数与主线程最长停顿。外部产品模型请求0。
开发机检查完成后，按准确源码与影响准备后继Win7复验材料。本轮不沿用已关闭的A9-60窗口；新的Win7窗口、容量例外、打包提交、正式候选、门A/B和发布均须适用授权。

## 6. 初始核对

2026-11-11 UTC只读账号核对：czl为2/5台，r4快照ready；chai2为1/1台，不占用或删除其既有机器。母机running、其他项目机器suspended均保持。私有staging/main为79388ea0…，待提供准确d5b99b62…基线。账户与快照证据在outputs/a9-61-wp/ACCOUNT_PREFLIGHT.json和SNAPSHOTS_PREFLIGHT.json。

开发包a9-61-dev已从r4创建，准确机器m_agq4tdb3xkbsy3dwlpnr74fctq。私有base/d5b99b62已提供准确源码，公开origin及本地HEAD未变。模型只读配置核对：Codex为gpt-6.1-sol/high；Claude未设置显式model/effort，本轮不更改全局配置。开发使用既有Claude运行时凭据引用czl-claude和CLI默认模型，实际服务模型由启动遥测记录；新审核机使用独立会话。旧快照Codex认证的历史失效不通过复制凭据或重写快照处理。

开发包启动遥测确认实际模型claude-opus-5-5，permissionMode=acceptEdits；effort未显式配置，保持UNKNOWN。使用既有CLI默认选择，没有修改全局模型或配置。开发机Electron22/Node16同规模对照探针完成旧实现测量：2054次物理checkpoint提交，累计1,117,144,425字节；collect最大事件循环间隔1292ms，重复收集1964ms，冷加载309ms且期间定时心跳0次。512份SHA通过，临时目录finally删除。准确JSON为outputs/a9-61-wp/BULK_BEFORE.json；这不替代Win7测量。

开发包Workspace日常集合出现1项既有Linux大小写环境失败：review-staging的normalizes Windows separators and rejects case-folded duplicates and sensitive paths。267项通过，产品修复专项及6000文件3项通过。准确d5b99b62源码不含本地既有D9工具差异，未把该工具差异并入产品修复。新审核机将按既有D9仅省略该准确名称，完整运行其余Workspace测试及6000用例；Shell G0由包装器运行。Mac receive/G1必须执行完整Workspace集合，直接覆盖该大小写项。保留Linux原FAIL，不重复无效整批运行、不改包装器或判据。

## 7. 开发包与Mac初始整合

InstaBox开发包员工正常退出0，耗时2376.543秒，最终9个源码/测试路径由Mac核对大小/SHA和范围后通过包装器提交为9ce23488e4bdb71e7ddfd40e870abce48e8e0875。首次受影响回归FAIL及语义回退的编译失败均保留，不计为区分度PASS；有效旧代码回归和有效语义回退失败证据见extra-a9-61-dev/EVIDENCE_SUMMARY.md与21份回收日志，450892字节逐份核SHA。
最终云端Shell 15组987项、Workspace相关8组78项、Gateway 4组41项及7模块编译静态门通过。Workspace新专项13项；原源码Part A为3 FAIL/1 PASS，Runtime专项旧源码2 FAIL。语义回退分别捕获缓存误提升、同步校验伪异步、跨await旧草稿和并发重写误判。
主代理已将这9个路径的准确差异整合进当前main工作区，未提交本地main；Provider探测超时的原2行dirty及其余无关文件SHA保持。Mac当前整合后的Runtime/生命周期2组98项通过。
Electron22/Node16同规模探针记录12次物理清单提交、6156955字节，512份文件SHA通过；冷异步加载期间有22次定时心跳，最大间隔19ms。该探针与GUI启动有部分并发，耗时只作单次开发机观测，不作Win7或普遍性能保证。
Mac实际main/preload/IPC/Runtime/SQLite首次产品4项、重启1项通过；收尾停止到终态184ms，实际POSIX等待命令停止188ms，512份SHA、正常退出和SQLite完整性/零活动生命周期通过；第二进程零模型重放。Win7 CMD/move/ping被明确替换为Mac bash/mv/sleep，未新增Win7证据。产品退出后的可选Python SQLite摘要发生unable to open database file；原两份产品报告完整且已落PASS，执行代理另存RESULT_RECOVERED.json汇总，没有重跑或覆盖原始报告。可选Shell摘要NOT_PERFORMED，产品SQLite原检查保持直接证据。临时目录自动清除并核对零残留。

## 8. 独立审核首轮发现与修复继续

新审核机独立Claude会话在plan/只读模式完成347.176秒静态审核，未改源码。该CLI模式禁止会写dist/TMP的测试，员工明确标记验证NOT_PERFORMED；执行代理没有要求负责人再批计划，而是通过已授权工作包启动独立验证作业。审核原报告保留在REVIEW_STATIC_R1.md。
P1-1为新增awaitRuntimeReady前后未复验scope；P2-1为异步恢复未与shutdown/锁释放同步；P2-2为两个CheckpointManager顺序异步秘密重验间保留旧缓存；P2-3记录内部getDiff在恢复pending时为Promise。批次及共用校验实现未发现其他静态缺陷。
执行代理用真实IPC handler、真实Registry、真实Runtime/SQLite，仅扣住whenReady作为时序夹具，直接复现P1-1：在同一A1 scope依次提交切换A2和保存A1草稿，新handler把草稿写进A2；d5b99b62旧handler返回A9_SCOPE_STALE且A2草稿为空。原始JSON在SCOPE_RACE_LOCAL.json。当前9ce23488…不能签最终修复完成；后继范围内修复P1及两项并发风险，补红绿回归并重新独审，保持原失败和首包代码身份。

首审核机独立验证271项Workspace通过、1项准确D9省略，包含6000文件与13项专项；同机真实Registry/Runtime探针确认P1-1。随后Shell G0通过、源码clean且HEAD不变，审核机已删除、凭据未漂移。首包Mac receive/G1在准确9ce23488…上通过父链、范围、秘密扫描、输入指纹、docs及完整Workspace平台回归；这些是技术检查结果，不解除P1阻断。新修复包a9-61-fix以该准确tip继续，仍在原最多4台预算内。

## 9. Claude额度阻断与准确后继方案

a9-61-fix员工在阅读源码后触发Claude五小时限额，CLI退出1，耗时101.059秒；提示额度重置为UTC 2026-11-11T12:40。未反复请求或更换模型。源码仍为9ce23488…，dirty=false、commits=0，产品修改0。首因及原始日志保留在FIX_QUOTA_FIRST_FAILURE.json和outputs/wp/a9-61-fix；包装器因NO_COMMITS记录FAILED，不能把它误写成产品回归FAIL。
本包日志已全部回收核SHA，临时目录由作业清理，机器已删除，凭据元数据未漂移，未申请写入密钥或推送。本轮已用3台，全部已回收；现有母机、其他项目机器、快照和monster未操作。
只读codex login status返回Logged in using ChatGPT；既有r4配置为gpt-6.1-sol/high。真实Codex生成未执行，因此认证可用性仍待最小调用核验；不把登录状态当成服务调用成功。
后继修复任务已具体写成outputs/a9-61-wp/FIX_TASK.md，准确base为9ce23488…，包含真实作用域复现和三项并发修复/红绿回归；最终只读复审任务在FINAL_REVIEW_TASK.template.md。拟建wp-a9-61-fix2及wp-a9-61-review2，两台串行、分别最多90/45分钟，固定czl/r4，沿用原凭据、路径、临时密钥回收和公开发布边界。
若改用已配置Codex并在需要时官方重登，仍须负责人选择模型接续及本轮累计最多5台的预算；较§4增加1台。批准前不派新包、不换模型、不进行新Win7窗口或打包。当前初补丁含已确认P1，不可交付；本轮修复未完成。

## 10. GPT接续批准

负责人明确批准GPT-6.1 Sol high接续及追加1台预算，允许需要时同账号官方重登。本轮累计上限改为5台，后继wp-a9-61-fix2和wp-a9-61-review2各用1台、串行执行；90/45分钟、原scope、安全与回收边界保持。先核对实际模型/effort及真实调用，认证失效时只走同账号官方流程，不复制凭据、不更新既有快照或全局模型。


### 10.1 第4台创建核对与真实调用

wp-a9-61-fix2的首次创建等待返回CREATE_FAILED；只读核对确认同一machineId m_agq4tzh6o7fn7htxea3pc2uoea随后running/ready，快照及账号匹配。执行代理在原机器续完准备，没有重建或消耗第5台。原失败与核对分别保留在OPEN_FIX2.log、FIX2_CREATE_RECONCILE.json和工作包收据。
真实Codex最小只读生成退出1：刷新令牌已撤销。当前配置确认为gpt-6.1-sol/high，不能记生成可用。正式员工尚未启动，产品修改0。本轮已按负责人批准启动同账号官方OAuth重登，等待安全输入卡的loopback回跳；必须通过state、原账号subject哈希、权限及第二次真实生成后才派发修复。没有复制凭据或更新快照。第5台仍保留给新机复审，首包P1阻断保持。

### 10.2 官方登录完成与修复包恢复

同账号官方OAuth登录退出0，state和原账号subject哈希匹配，auth文件0600、目录0700。真实生成探针auth-probe-fix2-r2返回A9_61_AUTH_OK，退出0，配置gpt-6.1-sol/high。原认证失败保留，成功结果见outputs/a9-61-wp/LOGIN_VERIFICATION_FIX2_R3.json与outputs/wp/a9-61-fix2/collected/auth-probe-fix2-r2。
2026-11-11 UTC负责人要求继续修复。执行代理核对第4台身份、源码clean和凭据基线一致后，在原机启动emp-a9-61-fix2，限时5400秒；未重建机器、未改变模型/effort/Fast或快照。修复F1作用域复验、F2恢复关闭时序、F3秘密缓存窗口，要求旧版失败/新版通过；第5台仍留给新机复审。首包P1未解除，本地main未提交，Win7复验与公开推送发布NOT_PERFORMED。

### 10.3 GPT修复结果与Mac整合返修

第4台员工正常退出0，耗时1573.346秒，作业临时目录已删除。有效红测3项FAIL，最终定向124项PASS。实际服务model/effort遥测UNKNOWN，既有配置为gpt-6.1-sol/high。五路径准确产物形成私有提交0a25e387…；35份额外材料455373字节全部核SHA，两个持久摘要差异另存，原失败保留。

Mac完成依赖构建与Shell静态门。17项新回归首轮16 PASS/1 FAIL。诊断确认夹具使用/var路径播种，而Registry使用/private/var真实路径，创建了不同会话，未进入恢复分支。仅将夹具根做realpath归一化后17项PASS，追加提交68516463…，未改产品或首提交。首次私有push成功，但执行代理漏传Mac remote参数，包装器默认用SSH读取引用而本机staging使用HTTPS；PUSHED_REF_MISMATCH保留。后继显式staging回读确认准确提交，写密钥已撤销，机器保留。复审机创建前两次同因失败均未创建机器；只修正调用参数，包装器和仓库remote未改。

Mac Electron真实入口随后复现产品回归：Provider配置期间，未带scope的状态刷新被新增可用性门拒绝为A9_APPLICATION_BUSY。执行代理补真实handler/Registry/Runtime回归，修复前1项FAIL，修复后18项PASS，配置期间写操作继续拒绝。最小修改保留原只读Snapshot入口，Runtime身份与其余作用域复验保持。最终私有提交为3a600fbf7b9a9f23906006d891da91ec1d22b5e6，未改写历史。

该源码的Mac Electron22/Node16真实入口首次4项、重启1项全部通过；512份文件SHA、取消、零模型重放、SQLite完整性、零活动生命周期和正常退出通过。外部产品模型请求0，测试根已删除。原两次入口FAIL、各次正常退出及SQLite记录均保留。新私有push准确引用回读通过，临时写密钥已撤销。独立复审尚未完成，交付阻断保持；本地main未提交，Win7复验、正式门A/B与公开推送发布NOT_PERFORMED。

### 10.4 独立复审 P1 与后继修复

第5台独立复审从准确 tip `3a600fbf…` 读取11文件差异。它确认 F1/F2/F4 已无新的 P0/P1 静态问题，但发现一项新的 P1：在途 Diff 跨分片时保留旧预览，Provider 新秘密登记后仍可能把旧明文返回 Renderer。负责人明确要求不修复的 P2 是失败 shutdown 后状态/恢复入口持续被关闭标记阻断；P2 保留为已知限制。

执行代理用真实 Runtime、CheckpointManager、Registry 和 IPC 夹具复现 P1。普通 IPC、直接 manager、跨工作区 Provider 更新和 Shell 校验失败四条路径在旧实现上都能返回旧预览；反向删除两个返回前代际检查后，对应回归失败。修复在 CheckpointManager 的文件字节/分片代际校验和 Runtime 返回前秘密代际校验；保留公开 IPC schema、同步 Workspace API、Provider/审批/权限语义。最终本地专项23/23 PASS，Workspace 依赖构建和 Shell 静态门 PASS，回退两档均失败，生产文件恢复逐字节一致。

准确私有提交为 `6b0e0c8d…`，基线为 `3a600fbf…`，私有 staging 引用已回读确认，未创建新机器。完整摘要见 `outputs/a9-61-wp/P1_FINAL_SUMMARY.md`。Mac 主代理以准确源文件完成一次真实 Electron22/Node16 入口检查：首轮4项、重启1项通过；512份 SHA、取消、零模型重放、SQLite完整性、零活动生命周期和正常退出通过。测试夹具报告和全部原始失败保留在 `outputs/a9-61-wp/`。

独立复审机的 G0 返回 FAIL，原因是 Shell 日常集合未执行“required fields reject absence and wrong types before comparison”这一既有慢项，其他模块构建/静态门通过。该结果不改写历史证据，也不等价于产品 P1 FAIL。当前 P1 已完成开发机修复和真实 Mac 入口验证，但最终独立复审尚未对 `6b0e0c8d…` 重新执行；Win7 实机、Win10、正式门A/B、候选冻结、公开推送和发布仍为 `NOT_PERFORMED`。

## 11. 最终复审与本地合并授权

负责人要求“推动代码合并”，并明确批准追加第6台InstaBox临时机。固定czl/r4、gpt-6.1-sol/high，独立只读复审最多45分钟；不增加替补机器或额外重试额度。按原流程回收证据、核SHA、撤销短命密钥并删除本轮临时机。最终P0/P1关闭且必跑验证通过后，允许将完整5提交链快进合并到本地main；公开推送、发布、Win7窗口、候选冻结和门A/B不在本次授权内。P2失败shutdown后的关闭状态限制按原决定保留。

准确源码为`6b0e0c8dc500148e242beb91fdc7c896c929f52d`，基线为`d5b99b62abb8c7fe1a52875272811a1b01f8bc5d`。隔离集成工作树`/private/tmp/a9-61-integration`已完成快进演练；主工作树HEAD尚未移动。新增检查补齐前次独审未覆盖的最终P1代码和G0慢项，不以执行代理的自查代替独立审核。材料与本轮记录集中在`outputs/a9-61-wp/merge-20261111/`。

本地完整Shell回归发现原交付卡重启夹具仍调用已成功关闭的旧Runtime。首FAIL保留；仅修正夹具为新Registry/IPC绑定，并保留原交付卡相等、零状态变化和归档Undo拒绝断言，新增旧入口明确拒绝断言。12/12通过，形成本地提交`35622ae7f1477f90da204031602e0363a09f1f82`，父为`6b0e0c8d…`，产品字节未变。第6台在员工启动前通过核SHA的Git bundle快进到该准确tip，初始open基线与输入修订收据均保留，无私有或公开推送。

### 11.1 第6台独审发现的在途兄弟工作区窗口

第6台`wp-a9-61-review3`在`35622ae7…`完成独立只读审核，耗时317.307秒，确认仍有一项P1：兄弟工作区在Provider配置/probe持续pending期间尚未接收新秘密和代际，已在途Diff可返回旧明文。原报告完整保留在`outputs/a9-61-wp/merge-20261111/INDEPENDENT_REVIEW.md`，不改判。

执行代理新增两条真实Runtime/Registry/IPC/SQLite回归，仅控制Provider probe的调度；旧实现的probe成功/失败两条路径均在配置未结束时返回测试秘密，2/2红测保留。最小修复仅在Runtime Diff返回前检查既有`isProviderConfiguring`回调；配置结束后的原代际检查保持。新回归及关联集合80/80通过，Shell静态门通过，准确提交`6c460fd9c270a5e1234b86912dd5d1505f9ea6fc`。不改变schema、权限、审批、依赖、Provider配置语义或已接受P2。

同一第6台在首轮审核结束后，以新不可变bundle快进到`6c460fd9…`，另起全新只读审核会话复核该P1与最小差异；首报告、初始source及修订收据保留。复核限时1200秒，加首轮317.307秒低于本轮45分钟审核预算，不创建第7台。最终G0在该准确新tip上运行。此前Workspace271项及6000文件基线、required-fields12项通过；Linux大小写项在Mac直接覆盖，不把该省略记PASS。

Mac在准确`6c460fd9…`产品源码上重新执行Electron22/Node16真实main/preload/IPC入口，首轮4项、重启1项通过；512份SHA、取消、零模型重放、SQLite完整性、零活动生命周期与正常退出通过，外部模型请求0，测试根已清理。准确绑定与结果在`outputs/a9-61-wp/ui-final-merge-r1/`。旧`35622ae7…`的继承分析记录只适用于该旧tip，本轮最终入口使用新直接证据。

### 11.2 最终产品复审与测试收尾

第6台新只读会话在`6c460fd9…`完成独立复核，耗时209.816秒。结论：原P1关闭，未发现新的产品P0/P1。原报告为`outputs/a9-61-wp/merge-20261111/INDEPENDENT_RECHECK.md`。两次审核累计527.123秒，低于45分钟上限。原产品shutdown P2按负责人决定保留。

复核另指出新增测试在配置意外reject时可能跳过`f.close()`。执行代理仅为测试补嵌套finally，25/25专项通过，提交为`4ae74f3254ba1a2ae07807e9e59a39c2ca5ef5e7`。该后继提交未改产品字节；不把它写成又一轮独立复审。最终G0在该准确测试tip执行。产品独审与Mac入口按精确产品字节继承`6c460fd9…`，原始首FAIL、两条明文红测和第6台首轮P1报告保持。

回查第5台原始`outputs/wp/a9-61-review2/collected/g0-a9-61-review2/stderr.log`确认：该轮G0实际为1 FAIL / 1626 PASS / 12 skipped；FAIL是交付卡重启夹具调用已关闭旧Runtime。required-fields慢项是另一个NOT_PERFORMED，并非退出1的唯一原因。上文历史摘要将FAIL仅归因于省略慢项不准确；本段作后继纠正，原日志和历史失败均保留。本轮分别修正绑定并补跑12项，不改写旧FAIL。

### 11.3 开发机交付与本地整合

最终源码`4ae74f32…`的第6台Shell G0通过：76套件、1634 PASS / 12 skipped。12项为日常集合有意省略的required-fields慢项；同机额外执行12/12 PASS，对应测试、driver、夹具与本轮后继源码变化无交集，按准确字节标INHERITED_EVIDENCE。新机Workspace271 PASS / 1项已登记Linux大小写省略，含6000文件基线；Mac完整Workspace272 PASS直接覆盖该平台项。最终专项25/25与关联集合80项通过；Mac真实入口5项的产品输入哈希10/10一致。

本轮主代理仅修正重启夹具、在途兄弟工作区P1和新测试异常清理。第6台两轮审核分别绑定`35622ae7…`和`6c460fd9…`；`4ae74f32…`仅为后继测试清理提交。产品独审P0/P1为0，已接受shutdown P2保留。首FAIL、首轮P1和所有不可变bundle保留。证据集中在`outputs/a9-61-wp/merge-20261111/`及`outputs/wp/a9-61-review3/`，不另建并行状态入口。

第6台已删除，凭据未漂移，短命读密钥已撤销；无私有或公开新push。完整8提交链及本节文档只作本地main快进整合，原有无关dirty/untracked与Provider探测超时两行改动保留。最终HEAD、逐文件保护核验和整合动作见`outputs/a9-61-wp/merge-20261111/MERGE_RESULT.json`。Win7/Win10、开发包、候选冻结、正式门A/B、公开推送与发布均NOT_PERFORMED。A9-60持续转圈原事故根因仍为UNKNOWN，不将本轮性能修复扩写为已解决原事故。
