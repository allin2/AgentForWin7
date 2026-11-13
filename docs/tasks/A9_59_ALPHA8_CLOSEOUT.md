# A9-59 — alpha.8 收口

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_RELEASE
Target Branch: main
Source Baseline: 1a25d593ee2bd3f155b043bfe1d9aebf688f8fd1 + existing working-tree changes
Target Version: 0.3.0-alpha.8
Phase-Gate: A9_59_DEVELOPER_VERIFIED
Win10-Validation: NOT_PERFORMED
Win7-Validation: DEV_CHANNEL
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


### 4.4 本地提交、准确包与开发机收口

负责人后继授权后，仅提交33个相关路径或共享文档段落，准确提交 `d5b99b62abb8c7fe1a52875272811a1b01f8bc5d`。main 领先 origin/main 一次提交，未推送。
单次干净源码构建完成：ZIP `36491b7551c03635eafcfb646ca4df9a8f8ce35bce74474ca207ddce5f481252`，110597586字节；manifest `69431b115a47d540d880717b40f68003fa4b7d33f1f5c1df03c5188460da70d2`。
包名为 `Win7CodingAgent-0.3.0-alpha.8-win7-x64.zip`。3262个清单文件逐项核验通过，45个产品文件与提交完全一致。
输入锁、应用package、runtime、manifest及SBOM统一为alpha.8；七模块开发机加载和Electron22/Node16描述符校验通过。没有正式候选号和authority，external_acceptance_eligible=false。

发布工具全组411项通过、16项按既定原因NOT_PERFORMED；发布必需的字段拒绝检查12项、6000文件基线检查3项通过。
新包Mac Electron实际产品13项通过，补测原生鼠标右键、Shift+F10、Escape与焦点恢复，以及新默认对话首发Full Access、首次真实写工具在隔离Documents下建目录。
这13项使用当前ZIP的JS及编译模块；Mac仅替换运行时/SQLite，并在临时副本省略Windows描述符，WindowsDPAPI不作Mac证明。独立原字节描述符/原生哈希检查通过，不等于Windows原生执行。
源码GUI首败保留；最终包13项所用夹具修正已在实际Electron22/Node16执行，完整闭包另作目标输入绑定。

构建工作树、包检查、描述符与GUI沙箱均在finally删除。27个不属于提交范围的既有修改文件SHA保持原值；共享文档仅暂存本轮段落，其他未提交修改保留。
准确汇总在本机 `outputs/alpha8-r1/RESULT.json`，ZIP在其 `package/`。开发机收口完成；新包Win7/Win10、原生125%DPI、正式门A/B、负责人接受和公开发布NOT_PERFORMED。

### 4.5 下一窗口准备（未执行）

只读status于UTC `2026-11-11T06:05:53.368Z`结束：目标DCCS-CHAIZL-PC/build7601，agent Session1，根内进程/任务0，解包生命周期已知，holder `a946lanrx` inactive。
当前根23797998920字节，C:余854024871936字节。新增ZIP、解包、33个运行时文件和80MB余量上界668426709字节；投影总量24466425629字节。
拟申请本轮25GB上限、最多60分钟、最多2次产品尝试，最后10分钟不启新场景；外部模型0，每次回环最多40、合计80。最低余量50GB保持，不执行历史删除或默认实例替换。
沿用该准确inactive holder需负责人同意；不接管active锁。准入时重新核对目标与空间，其他任务增长导致超界则停止。
新run `29401f88-b9e3-4e05-bea9-e39357a85d07`。包、驱动、controller、UI及完整闭包SHA在本机 `outputs/alpha8-r1/WIN7_PLAN.json`。deadline保持null，未授权前驱动fail-closed。
目标检查覆盖两处修复适用入口、搜索/交付卡、运行中隔离/队列、重启/DPAPI零重放，以及默认对话/原生右键键盘入口；普通本地夹具范围内修复可有界重试，身份/完整性/安全/必需审计/未知生命周期失败即停止下游。
当前只准备准确材料，未上传、取锁或启动Win7产品；正式门与发布另行决定。


## 5. Win7 开发验证及 DeepSeek 当前消息可用性（负责人已批准）

负责人针对§4.5回复“批准，验证消息当前调用deepseek的可用性”。本轮批准25GB、60分钟、最多2次普通产品尝试与准确inactive holder复用，并追加真实DeepSeek消息检查。
执行代理为该追加检查采用最多6次外部请求，含能力探测和重试；每次回环40、累计80保持。只发一条短文本消息，不要求模型使用工具；产品切为Read Only，工具事件必须为0。费用未指定金额硬上限，实际结算为UNKNOWN。
沿用api.deepseek.com默认TLS验证与当前保存模型，不更换账号、模型或线路。同普通agent进程只读原配置、DPAPI密文与Local State必要字段，克隆到本run独立临时profile，由产品实际恢复密钥；不输出或下载明文，原文件前后核SHA。
既有13项新包检查继续执行。DeepSeek实际产品窗口、流式消息可见、HTTPS状态、TLS授权、usage、请求总数、正常退出和零重放分别取证。模型失败不把回环通过写成真实模型通过。
新候选外工具集中在本机outputs/alpha8-win7-r1，产品ZIP与提交不变；所有新改工具先在Electron22/Node16解析并核模块闭包，既有直连guard7项开发机测试通过。Win7与真DPAPI仍待执行。
窗口将在全部输入准备完毕且只读准入返回后绑定准确UTC；旧窗口、次数与容量例外不沿用。身份/完整性/安全/必需审计/未知生命周期失败停止下游；普通失败先定位，最多在原预算内一次修复重试。

### 5.1 准确执行窗口

UTC `2026-11-11T06:20:33.975Z` 至 `2026-11-11T07:20:33.975Z`，新场景截止 `2026-11-11T07:10:33.975Z`。25GB与holder例外只适用该窗口。绑定run29401f88，材料和所有部署准备耗时计入窗口。

绑定闭包包含11份执行/支持文件，driver `c24c3946…`；准确哈希在 `outputs/alpha8-win7-r1/EXECUTION_BINDING.json`。目标操作工具只增加本窗口25GB条件，前后SHA与插入块记录在 `WINDOW_TOOL_PATCH.json`，结束时移除本轮条件，不回写其他未提交内容。

部署前候选外夹具补充旧SQLite时间的真实IPC第二页检查。首次Mac预检因夹具未传scope被产品拒绝，保留local-preflight首败；修正为捕获活动scope后，local-preflight-r2两阶段14项通过，零外部模型。最终部署闭包记录为EXECUTION_BINDING_DEPLOY.json；产品ZIP未变化。


### 5.2 当前 alpha.8 Win7 开发验证完成

本轮取得 DEV_CHANNEL PASS，窗口已关闭。绑定源码 `d5b99b62…`、ZIP `36491b75…`、manifest `69431b11…`、run `29401f88-b9e3-4e05-bea9-e39357a85d07`、driver `c24c3946…`；完整哈希和证据在本机 `outputs/alpha8-win7-r1/RESULT_FINAL.json`。
目标为Win7 SP1 x64/build7601，普通agent/SID1001/Session1/Medium。controller及三次产品进程的PID、父PID、创建时间、Session与映像路径直接核对；四者正常退出0，临时计划任务删除。
3262文件完整性、SQLite3.43.1原生加载、六模块与实际Shell入口通过；原ZIP未重建或修改。

| 范围 | 直接结果 | 边界 |
|---|---|---|
| alpha.8产品入口 | 14项PASS | 搜索/只读定位、旧SQLite UTC游标第二页、非空队列与执行身份隔离、中文草稿及队列DPAPI重启恢复、零重放、实际文件交付卡/Diff、800像素返回、原生右键/Shift+F10/Escape/焦点、默认Full Access与首次工具建目录 |
| DeepSeek当前配置 | PASS | 真实产品从同agent保存的DPAPI材料恢复，api.deepseek.com / deepseek-v4-flash；不更换账号、模型或线路 |
| 真实消息 | PASS，1011ms | 产品界面可见回复 `A959-DEEPSEEK-OK-29401f88`；一条消息、一个完成轮次；Read Only，工具事件0 |
| HTTPS/TLS | PASS | 探测1次、消息1次，均HTTP200、TLS1.3且证书authorized=true；首字节174/168ms，消息传输885ms |
| 原配置与数据 | PASS | 三份源文件SHA前后不变；驱动不自行解密，产品恢复；UI/事件精确秘密扫描通过。默认实例、会话、数据库未替换 |
| 生命周期 | PASS | 三个产品SQLite integrity=ok、活动task/turn/run及锁0；本run进程/任务0，两套临时沙箱删除 |

真实外部请求2次，小于6次上限；回环7次；只使用1次产品尝试。可观测usage合计2674 tokens：input2587/output87，其中缓存命中128；供应商实际结算UNKNOWN。
控制器20项检查通过，16份回收证据逐项大小/SHA匹配；两张Win7截图已人工视觉核对，证明所拍搜索与交付卡界面，不替代原生125%DPI。

### 5.3 窗口收尾与保留边界

UTC `2026-11-11T06:37:42.951885+00:00` 完成本轮收尾，总窗口17.150分钟。两个工具文件只移除本轮25GB条件，SHA回到本轮执行前；原其他dirty保持。
最终只读status：锁inactive、无解包生命周期未知、任务0；本run进程0。开发根24397987994字节，低于25GB；C:余853416013824字节。
最终还显示旧A9-57包a2309321…的4个进程，路径不属于本run；其启动来源UNKNOWN，全部保留，未执行stop、close或终止旧窗口。不能把本run零残留写成全机零进程。
本轮未使用的窗口、第二次尝试和请求额度不沿用。目标机未作安装、系统配置或DPI变更，未新增系统权限，未删除历史材料。
新包Win10、原生125%DPI、Win7大规模历史性能、正式候选/门A/B、负责人接受与公开推送/发布仍NOT_PERFORMED或NOT_VERIFIED。原A9-58审查UNKNOWN和旧FAIL保持原事实。
证据及准确旧进程列表见 `RESULT_FINAL.json`、`CLOSEOUT.json`、`COLLECTION.json` 和本机 `outputs/win7-dev/alpha8-29401f88-b9e3-4e05-bea9-e39357a85d07/`。

收尾后26个无关文件SHA仍与本轮最初基线一致，暂存区为空；STATUS_LOG仅追加本任务流水。文档/差异检查最终通过。开发验证记录留在工作区，未追加提交或推送。

收尾时工作区另有5个产品/测试路径出现后续差异：Runtime、Agent Panel、Workbench及两份测试。本轮目标运行始终加载准确ZIP36491b75…，不加载这些后续源码。全部保留，当前后续工作区不因本轮包证据取得PASS；清单及SHA在CONCURRENT_WORKTREE_BOUNDARY.json。
