# A9-58 — 完整历史搜索与任务交付卡片

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main
Source Baseline: 1a25d593ee2bd3f155b043bfe1d9aebf688f8fd1 + existing working-tree changes
Phase-Gate: A9_58_DEVELOPER_VERIFIED
Win10-Validation: NOT_PERFORMED
Win7-Validation: DEV_CHANNEL
```

## 1. 授权、基线与交付

负责人在五项投资建议后回复“同意，使用 instabox 工作流开发”。本轮落实推荐优先项：完整历史搜索、任务交付卡片。
实际分支 main，HEAD 如上；现有产品文件与私有开发提交 `9c2f45b3ed71c25710ff82ea4c03c3176b13401b` 同字节。
本轮以该提交作 InstaBox 开发基线，保留 `outputs/a9-58-wp/BEFORE.json` 记录的既有 dirty/untracked。
不实施长任务接续、整套 DPI 优化、开发包身份修订。三者仍为后继提案。

成功条件：负责人能查到未加载到首屏的旧消息、命令及报错，定位原消息；每轮能集中查看实际改动、执行检查、未解决事项与撤销入口。
结果来自本地持久化事实，不增加模型调用、外部索引、云同步或依赖。

## 2. 完整历史搜索

- 范围为当前活动工作区内全部保留的对话，包括已归档对话；明确展示范围和“只查本机仍保留历史”。不冒充已清理事件的完整副本，不搜索草稿、凭据或其他工作区。
- 由主进程/State 对持久化请求、最终答复及用户可见的工具命令、输出和错误文本执行字面量查询；中文、空格、百分号、下划线、引号与反斜杠不当成 SQL 或模式语法。
- 返回有界分页，包含对话、时间、消息类型、摘录与稳定定位身份。查询与分页在数据库层完成，不能依靠 Renderer 当前缓存或把所有历史加载进 JS 后过滤。
- 结果跳转到原始事实/事件的只读位置，深历史不逐页遍历；请求仍绑定原执行 scope。浏览自己、其他历史、已归档历史均不得激活对话、保存草稿、改变队列/审批/上下文或发送模型请求。
- 新查询、清空、关闭、切换工作区和迟到响应按 scope 与代次隔离。提供加载、无结果、错误/重试、加载更多、返回执行对话；快捷键不抢输入编辑，焦点可恢复。
- 搜索与定位均复用 v9 Schema IPC 的活动 scope 与 canonicalWorkspace 归属校验；旧 schema、未知键、错属、非法文本/游标/长度拒绝。所有可见内容继续脱敏和纯文本渲染。

## 3. 任务交付卡片

- 每轮以既有 task/turn/checkpoint/工具事件为依据生成只读、有界、可重启重建的摘要；展示“改了什么、测了什么、剩什么问题、如何撤销”。不得从最终自然语言猜出验证 PASS。
- 改动以 checkpoint 文件事实为依据；检查展示实际命令、退出码及已有验证结论，未知写 UNKNOWN，未执行写 NOT_PERFORMED；普通命令退出 0 不自动等于测试通过。
- 结果覆盖完成、有警告、失败、受阻、取消、中断；缺失/旧历史事实明确说明，不虚构“无改动”“全部通过”或“已恢复”。
- 撤销复用当前已有 Diff/撤销/确认链路，不能增加权限或在只读浏览中执行。仅当前执行对话、合法轮次且既有守卫满足时才提供写入口；其他情况显示可理解的返回/不可用原因。
- 实时与持久化事实不互相覆盖；同轮恢复/续行及迟到结果不能造成跨轮、跨工作区混合。默认紧凑，不随轮询重建焦点、展开态或滚动位置。

## 4. 实现与 InstaBox 工作流

复用 D-009 Electron22.3.27/Node16.17.1、D-014 SQLite3.43.1 与现有 JavaScript/TypeScript、CSS、Schema IPC；不新增依赖、原生/API、数据库表、迁移或索引。
只改 State 持久化只读查询、Shell Runtime/IPC/preload/Renderer、直接相关测试及本任务文档。持久化字节格式不变，新投影字段与只读接口见 ADR-0326。
主代理负责合同、整合与 Electron 检查；InstaBox 单台执行机由既有 Codex 配置开发，独立新机由 Claude 只读审核并运行 Shell/State G0。读取实际模型配置并记录，不修改全局模型或账号；模型不可用时报告，不静默换模型。
账号 czl、ready 快照 `sn_agq2jii7qd46ez2r4afj3gbbku`；仅操作本轮 `wp-a9-58-*` 临时机。保留母机、其他工作机、全部快照与 ci/monster。
沿用 open → run → poll → commit → close → receive。允许包装器按准确清单提交并推送私有 staging 新分支、撤销本轮短命部署密钥、核验回收全部日志后删除本轮临时机；不提交本地 main、不推送公开 origin、不发布。
每个执行包上限 90 分钟、审核包上限 45 分钟，必要同范围普通修复连续完成。最多四台串行临时机；超过预算、新权限/依赖/重大架构变化、认证失败、凭据漂移或未知生命周期时停止依赖动作。同类失败连续两轮先诊断，不整批盲重试。
执行包 defer G0；最终准确源的新审核机运行 G0；Mac receive/G1 绑定审核包与输入指纹。使用现有安全收尾，不改包装器或派单系统。

## 5. 必要验证与最短链路

1. 先构建依赖，再测真实 State/Runtime/IPC：首屏外历史、归档、中文及特殊字符、命令/报错、分页、稳定定位、错属拒绝、零写入/零模型请求。
2. 卡片检查真实工具退出、失败/取消/中断、checkpoint、无证据历史、重启重建与撤销守卫；测试临时目录位于系统临时目录，finally 清理并核对无新增残留。
3. 新机 Shell/State G0、Mac G1、docs:check 和任务差异格式检查。独审聚焦权限边界、分页/定位和摘要事实，避免单元桩掩盖跨层缺陷。
4. Mac Electron22 实际 main/preload/IPC/Runtime/SQLite：建立深历史 → 搜索 → 点击原消息 → 返回并保留执行状态和草稿；再执行本地回环工具轮次 → 查看交付卡片 → 现有 Diff/撤销入口及重启恢复；补检查错误重试、迟到回包、键盘、800像素布局和正常退出。外部产品模型请求为0。
5. Win7 新窗口、同包 Win10、开发ZIP、正式候选、门 A/B、公开推送与发布均 NOT_PERFORMED；本轮仅开发机交付。

## 6. 执行记录

2026-11-10 UTC：完成 main/HEAD/dirty 与产品基线核对，既有47个改动文件记录于 BEFORE.json。账号只读检查通过；czl 2/5台，母机 running、其他项目机器 suspended，均保持。其余角色账号各1/1台，不占用或删除它们。下一步核对快照 ready、开发配置和私有基线可读。

### 6.1 首包登录阻断

`a9-58-dev` 已从 ready 快照创建独立工作机；基线检出、依赖准备与输入指纹 `062e3ff5…` 通过。快照实际 Codex 配置为 gpt-6.1-sol / high。
员工于 UTC 2026-11-10T11:42:10.939Z 启动，2.499秒后 exit=1；尚未读实现代码或改产品。官方登录返回刷新令牌已使用，附带 MCP 登录 token_expired；未反复请求或复制其他账号凭据。
原始 stdout/stderr 已全部回收并逐项核对大小/SHA。主代理复核源码 HEAD 仍为 `9c2f45b3…`、dirty=false、commits=0，凭据文件元数据与开包时相同。只读检查与首失败记在 `outputs/a9-58-wp/FIRST_FAILURE.json`；包日志在 `outputs/wp/a9-58-dev/collected/emp-a9-58-dev/`。
开发派发 BLOCKED，等待负责人选择现有 Claude 开发或重新登录 Codex。产品实现、独审、G0/G1与产品UI检查为 NOT_PERFORMED。未变更主对话模型、母机、全局配置或既有登录。
Mac现有Electron22已找到，隔离构建的SQLite8.7.0/3.43.1通过Node16/ABI110加载；仅证明开发机运行时准备，不能算本功能检查。构建临时目录已删除，相关产物和来源见 `outputs/a9-58-wp/runtime/MANIFEST.json`。
首包按close流程回收完成，machineDeleted=true，短命读取部署密钥已撤销，未申请写入密钥、未推送。包装器因无提交记录FAILED/NO_COMMITS；业务首因仍为登录失效。G0字段DEFERRED仅表示未执行。准确收尾见 `outputs/a9-58-wp/FAILED_PACKAGE_CLOSE.json`，后继使用新包与新run，不覆盖原失败。

### 6.2 负责人选择重新登录后继续

负责人明确选择“重新登录 InstaBox Codex 后继续”。允许在本轮新开发机 `wp-a9-58-dev2` 通过官方流程恢复本账号登录，并在核验后继续原两项开发；不更换模型、不复制其他机器凭据、不修改母机或其他账号登录，不改变账号安全设置。
登录前后凭据只记录元数据和账号匹配结果，原基线记录保留；成功后以明确授权的登录事件登记该包新凭据基线，避免把预期登录变化误记成员工漂移。后继快照更新与分享不由本授权推导。

2026-11-10 UTC后继：首个browser OAuth会话因未取得回调而在900秒期限退出，保留超时结果。新r2会话经Google官方密码与手机二次确认、OpenAI个人工作区授权完成；回调严格核对来源及本次state，云机HTTP200，CLI退出0且原账号subject哈希匹配。浏览器诊断中的URL被截到501字符，首次本地回调校验因此拒绝且未转交云机；从实际导航记录取回1011字符完整URL后，原state校验通过，没有放宽判据。登录文件0600，目录原755由本轮收紧为0700；最终权限与新包凭据基线复核另存LOGIN_VERIFICATION_R2.json。未更新快照或其他机器登录。

### 6.3 开发交付、独审与 G0/G1（2026-11-10 UTC）

执行包 `a9-58-dev2` 在官方 OAuth 恢复后完成，员工退出码 0；准确私有提交为 `99e1728d1aab4810abab638d86e69c0afffa955d`，12 个文件均按清单提交，私有 staging 分支已推送，执行机已删除。
Mac Electron22.3.27 / Node16.17.1 / SQLite3.43.1 真实产品入口检查 9 项 PASS，覆盖归档深历史字面量搜索、命令/报错/最终答复、分页、只读定位、800 像素返回与草稿焦点恢复、实际文件交付卡、现有 Diff 入口及重启重建；外部模型请求 0，SQLite integrity 为 `ok`，活动 task/turn/run 与锁均为 0。首轮 UI 夹具选中无 turn ID 的请求而失败，未改产品；修正为选择带 turn ID 的 checkpoint 后，第二轮完整结果 PASS，首轮失败保留。
独立 Claude 审查绑定同一提交，未发现 P0；报告列出 4 项需后续探针确认的 UNKNOWN：checkpoint 父目录 realpath、旧迁移行游标格式、同毫秒文本 ID 排序、深历史同步扫描耗时。它们不改变本轮已通过的行为结论。审核机 Shell/State G0 PASS，Mac G1 PASS；指纹、父链、范围、秘密扫描、docs:check 均 PASS，审核机已删除。
开发机、Mac Electron、G0/G1 均为开发证据。Win7、同包 Win10、正式候选、门 A/B、公开 origin 推送与发布仍为 `NOT_PERFORMED`；快照未更新。

## 7. Win7 开发验证（2026-11-10 America/Los_Angeles）

负责人回复“批准做win7开发验证”，批准当前 main 工作区准备并执行 A9-58 开发级运行。
绑定准确开发提交 `99e1728d1aab4810abab638d86e69c0afffa955d`，保留 main HEAD `1a25d593…` 和既有 dirty/untracked；不提交本地 main，不推送或发布。
沿用 ENGINEERING_03 r2 的目标 DCCS-CHAIZL-PC、严格主机键、普通 agent 桌面和 `C:\A9-DEV\` 边界。
先完成本地单次开发构建、包内入口核对及驱动实际运行时检查，再执行最短真实链路和受影响回归。
范围为搜索并定位归档深历史、交付卡实际文件事实及 Diff 入口、运行中执行身份/草稿/队列隔离、重启恢复与正常退出；旧证据不冒充新包直接通过。
开发级运行拟采用最多 60 分钟、最多 2 个产品尝试，最后 10 分钟不启动新场景；外部模型请求 0，本地回环每次最多 40 次、总计最多 80 次。实际窗口在全部材料就绪且容量准入满足后登记。
身份、完整性、安全、必需审计或未知生命周期失败即停止依赖动作；普通夹具失败保留首败、定位后才在原预算内用新 run 重试。
本次不继承已关闭的 23 GB 例外，不接管活动锁，不清理旧材料或结束已有用户窗口。容量、holder 与准确包/驱动在 `outputs/a9-58-win7-dev-r1/` 中记录；若出现新例外，准备完整材料后提交负责人裁决。
结果只记 `DEV_CHANNEL`；Win10、正式候选、双构建、门 A/B 与发布 `NOT_PERFORMED`。

### 7.1 本地材料完成，容量与 holder 例外待批准

UTC `2026-11-11T01:18:20.079Z` 开始的只读 status 确认目标 DCCS-CHAIZL-PC/build7601、agent Session1，开发根进程与临时任务均为0，无解包生命周期未知，holder `a946lanrx` inactive。
开发根实际占用 `22993068763` 字节，C: 剩余 `854854029312` 字节；本轮未取得新容量例外，尚未上传、取写锁或启动产品。

本地从准确私有提交 `99e1728d1aab4810abab638d86e69c0afffa955d` 单次有效构建，ZIP SHA-256 `15b77c9ce515d1db3a06d208cbbb8d935329c0e2365e24b21810b0db25aa80df`，`110604231` 字节；manifest SHA-256 `4dc6fa72358b0a75f96540eb94dfc20440a363300eb3245057e9420b6d9a0da1`，3262个清单文件逐项核验通过，45个产品文件与本地已整合源码一致。
沿用 A9-32 开发构建 Profile，包内仍标 `0.3.0-alpha.2`，本轮只按源码与 ZIP 哈希标识开发输入；这不是新的版本身份或发布产物。本轮不实施此前排除的开发包身份修订。

新驱动 run 为 `21687dbe-d438-416c-bb08-521e1954cafa`，driver SHA-256 `0e7b3ab93a97d3e247bfef5552cafba57da8bc9ed67c85c232247880317fb59f`，完整闭包见 `config.json`。
Mac Electron22/Node16直接语法检查和10项驱动检查通过；本地临时副本省略 Windows 运行时描述符并替换 Mac SQLite，因此 Windows 包加载、身份与 DPAPI 仍为 NOT_PERFORMED。Win7 原驱动保留包完整性、普通 agent/Medium/Session、真实包加载与 DPAPI 断言，不继承 Mac 结果。
本地首构建调用因临时路径别名未进入入口、第二调用因依赖符号链接被认作 untracked 而拒绝，均已定位；有效构建使用 canonical 临时路径及仅针对本轮依赖链接的进程级 Git exclude，不改全局 Git 或产品源码。驱动首轮缺 Windows 描述符、本地第二轮鼠标命中遇到动态布局的失败均保留；后者改为等待目标可命中。全部本轮构建/驱动沙箱在 finally 移除，零新增残留。

完整新增占用上界 `668471117` 字节，含 ZIP、解包、33个独立运行时文件与80MB运行余量；投影开发根上界 `23661539880` 字节。申请本轮60分钟窗口临时上限 `24000000000` 字节，并沿用当前 inactive 的准确 holder `a946lanrx`。最低剩余50GB、最多两次产品尝试、外部模型0及回环总计80次保持；窗口尚未开始，旧窗口不续期。
待负责人批准这两项例外后才绑定准确 UTC、补入本轮容量规则并执行。未知迁移数据、同毫秒排序和更大深历史性能不因本地140轮夹具而改判。
准确材料见本机 `outputs/a9-58-win7-dev-r1/WIN7_PLAN.json`、`PREPARATION_RESULT.json`、`PACKAGE_CHECK_FINAL.json` 与 `local-preflight-r3/RESULT.json`。当前执行状态 BLOCKED，原因是容量及 holder 例外待批准；Win7产品运行 NOT_PERFORMED。

### 7.2 本轮例外批准与执行窗口

负责人对 §7.1 的24GB、60分钟、沿用 inactive holder `a946lanrx` 回复“批准”。
新窗口为 UTC `2026-11-11T01:34:31.856Z` 至 `2026-11-11T02:34:31.856Z`，新场景截止 `2026-11-11T02:24:31.856Z`；材料登记与随后首次目标写入之间的耗时也计入60分钟，不回拨或续用旧窗口。
本轮仅为当前 holder 在上述时间内增加24GB判断；常设20GB、最低剩余50GB、主机键/普通agent/Medium/Session、0外部模型及全部停止条件保持。未授权 close、历史删除、根外终止、正式门A/B或发布。
部署前给候选外驱动补记并核对 UI 子进程 PID/父PID，包与产品源码不变；准确新 driver/闭包哈希由执行记录绑定，不覆盖 §7.1 的准备记录。

部署闭包最终绑定 driver `5038198539340f25a3dad56eb17a6b8a22cea9c151332f6de672d3b50fbb6956`；fixture workspace/data位于当前 run 的进程 TEMP 下 `a9-58-sandbox`。普通产品正常退出、当前 run 进程与任务均归零后，postflight才把SQLite状态复制到 `e/state-snapshot-*`，核SHA后删除本轮自建临时目录；旧目录与旧数据不涉及。修改后的Mac驱动10项复验通过，详见 `local-preflight-r4/RESULT.json`；Windows DPAPI不由Mac结果代替。

### 7.3 首次传输超时与同窗口恢复

首个上传动作在600秒后退出124，原计划110604231字节，实际传输字节保持UNKNOWN；首败在 `FIRST_TRANSFER_FAILURE.json`。恢复status于UTC `2026-11-11T01:50:21.553Z`结束，目标身份匹配、零进程/任务、holder inactive，无解包未知。
远端部分文件62062592字节，SHA `1473108ac07b53248db86e5cccb669b7e30e7c1800febb6fb0e4c6f403b7a430`，与本地ZIP同长度前缀一致。只续传剩余48541639字节，保持原单次期限、24GB上限和同一窗口；产品尚未执行，未重建或重传整包。实际后继结果见 `RESUME_TRANSFER.json`，首败不覆盖。

续传及解包于 UTC `2026-11-11T01:59:17.372Z`完成：完整ZIP110604231字节、SHA `15b77c9c…` 与本地一致，解包3263文件通过。全部动作仍在原窗口内；普通agent产品运行随后执行，不能把此阶段记作功能通过。

### 7.4 Win7 开发验证完成与窗口关闭

本轮准确开发包在普通 agent / Session1 / Medium 的 Win7 SP1 x64 上取得 `DEV_CHANNEL` PASS。源码 `99e1728d…`，ZIP `15b77c9c…`，manifest `4dc6fa72…`，run `21687dbe-d438-416c-bb08-521e1954cafa`，driver `50381985…`；完整哈希见本机 `EXECUTION_BINDING_FINAL.json`。
目标运行时为 Electron22.3.27 / Node16.17.1 / SQLite3.43.1。controller、首次产品与重启产品的 PID、父PID、创建时间、SID、Session和映像路径已直接核对；三次均正常退出0，临时计划任务已删除。

首次产品7项、重启产品3项共10项直接通过：归档深历史字面量搜索、命令/报错/最终答复与分页、只读定位、历史卡缺失事实提示、800像素返回和草稿焦点/选择恢复、真实文件交付卡与既有Diff入口、历史/卡片重建、中文草稿与队列恢复、零模型重放。
运行中使用真实非空队列验证隔离，释放执行前经现有目标绑定入口移除本轮队列项，未自动发送。140轮历史由夹具通过真实State接口生成，命令/报错是保留事实夹具；新文件由真实write工具创建。卡片没有把未运行测试写成验证通过。
当前包3262文件逐项完整性、六模块与SQLite原生加载通过；两次UI与controller的SQLite integrity均为ok，活动task/turn/run及锁均为0。状态副本再次只读核验完整性，存在非空草稿密文，原始DB/WAL/SHM中没有已知未发送中文草稿的UTF-8或UTF-16LE明文；本地读取使用临时副本，原始回收字节保持。
本轮只用1次产品尝试、4次回环请求、外部模型0。13份主回收证据的大小/SHA与目标postflight元数据及get记录一致。两张截图已实际查看：800×700返回与搜索控件可见，1366×768交付卡按事实显示未验证和UNKNOWN/NOT_PERFORMED，内容可滚动。

postflight在本轮进程/任务归零后保存SQLite状态副本并删除当前TEMP内自建 `a9-58-sandbox`，sandbox_clean=true。最终status于UTC `2026-11-11T02:05:56.194Z`完成：根内进程/任务0、holder inactive、无解包未知，开发根23592932703字节，低于本轮24GB，C:剩余854246756352字节。
最后只读回收于UTC `2026-11-11T02:06:43.189Z`结束，总窗口32.189分钟，提前于原截止关闭；剩余时间、请求和未使用的第二次产品尝试不沿用。`CLOSEOUT.json`包含最后只读回收；原 `RESULT.json` 的31.406分钟只计至final status，保留并由 `RESULT_FINAL.json`补充准确总窗口。
首传600秒超时及原UNKNOWN传输计数保留；续传前缀与完整ZIP大小/SHA证明链完整，不把原失败改判。不执行stop、close、锁接管、历史删除、默认实例替换、本地提交、推送或发布。

本轮只证明本任务选定的Win7开发链路；原生125%DPI、真实外部模型、同包Win10、正式候选、双构建、门A/B及发布均NOT_PERFORMED。此前四项审查UNKNOWN不整体关闭：本轮中文/空格路径正向通过，但其他realpath别名、旧迁移游标、同毫秒全量排序与更大深历史性能未穷尽。
主证据在本机 `outputs/a9-58-win7-dev-r1/RESULT_FINAL.json`、`CLOSEOUT.json`、`VISUAL_REVIEW.json` 与 `outputs/win7-dev/a9-58-21687dbe-d438-416c-bb08-521e1954cafa/`。main HEAD与既有无关dirty/untracked保留。
