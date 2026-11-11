# A9-57 — 运行中只读浏览同工作区其他对话

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main 工作区；InstaBox 私有 staging box/a9-57-be → box/a9-57-fe → box/a9-57-fix
Source Baseline: main 1a25d593ee2bd3f155b043bfe1d9aebf688f8fd1 加既有修改；产品源码与 56129c8b7d1c5fb7f4587ef4a89f7de32c3ced2b 相同
Phase-Gate: A9_57_DEVELOPER_VERIFIED
Win7-Validation: DEV_CHANNEL
Decision: ADR-0325
```

负责人 2026-11-09 明确按日常模式推进，并指定在 InstaBox 开发。授权对象为上一轮建议的“运行中浏览同工作区其他对话”，第一版只读。

## 1. 可观察结果

1. A 对话运行、等待审批、等待回答或仍有托管进程时，可左键查看同一工作区 B 对话的已保存历史，A 继续原执行。
2. 页面明确标出“只读查看 B”和 A 的当前状态，提供“返回执行对话”。A 完成时不自动把用户拉回；用户返回后沿用现有正常交互。
3. 浏览支持请求、最终答复及已保存过程记录的有界加载、失败重试和复制文本。历史内容按不可信文本处理，不执行其中的动作。
4. 浏览期间不显示可发送输入、队列控制、审批回答、恢复执行、撤销、Review Apply、目录修改或权限修改入口；保留 A 的草稿、选区、队列和执行状态。可查看其他历史，也可随时返回 A。
5. 浏览不激活 B，不改变模型上下文，不改写工作区当前对话，不恢复或重放副作用。A 的审批与回答必须返回 A 后操作。
6. 当前工作区或执行对话发生变化时退出浏览；迟到回复按工作区、执行对话、浏览目标和代次丢弃。未知或跨工作区目标由主进程拒绝。

不包括同工作区多写者、运行中转向、新窗口、跨完整历史搜索、修改队列语义、永久删除或新长期记忆。

## 2. 实现合同

### 2.1 后端与 IPC

新增单一只读动作 `a9.conversation.browse`，preload 暴露 `browseConversation(values)`。
仅支持当前 v9 请求，必须有现有活动工作区/执行对话 scope。继续经过注册表现有 `resolve`，不放宽其他动作。

payload 精确为 `conversationId`、`kind` 及可选分页参数。`kind` 为 `facts` 或 `events`；facts 可用 `before` 和 `limit`（1～100），events 可用 `beforeEventId` 和 `limit`（1～300）。错误类型、长度、未知键和混用游标均拒绝。facts 游标沿用 `createdAt/taskId`，events 沿用正安全整数事件 ID。

Runtime 新增 `browseConversation(input)`。先在 `persistence.listConversations(canonicalWorkspace)` 中确认目标，未知或其他工作区均返回 `A9_CONVERSATION_MISMATCH`；允许当前工作区已归档历史只读查看。复用 `listConversationFactPage`、`listSessionEvents`，不调用激活、保存、草稿、上下文恢复或执行入口。facts 返回 `ok/conversationId/title` 和现有事实分页形状；events 返回 `ok/conversationId/title/events/hasMore`。受限 Runtime 同名方法保留对应诊断错误，不抛缺方法异常。

### 2.2 前端

执行快照、现有 `state.activeConversationId` 和 scoped API 继续绑定 A。浏览状态单独保存 scope、目标、分页、错误与代次，采用独立只读容器，避免把 B 的事实灌入 A 的缓存或复用有副作用的卡片。
复用现有主题、排版、文本渲染与有界显示规则；不复制整份 Renderer，不加框架。正文之外的写入入口须同时有可见禁用/隐藏与处理函数守卫，防止快捷键或旧 DOM 动作绕过。返回后焦点与草稿选区恢复，轮询不抢焦点或滚动。跨工作区选择继续走现有流程，并退出浏览。

## 3. 日常 InstaBox 流程与边界

日常模式按既有工作包流程执行，不映射成 MODES.md 的四种特殊模式。主对话配置不变。
后端由 Codex GPT 6.1 Sol high，前端由 Claude Opus 5.5 high，最终新机由独立 Codex Sol high 只读审核并跑 Shell G0；串行一台工作机，必要普通修复沿用分工。模型不可用时报告，不擅自换模型。
使用 czl ready 快照 `sn_agq2jii7qd46ez2r4afj3gbbku`；只操作本轮 `wp-a9-57-*` 新机，保留母机、其他工作机、快照和 ci/monster。允许工作包包装器准确提交、推送私有 staging 新分支、回收结果后删除本轮临时机与撤销短命部署密钥。员工不提交、不推送、不改共享状态或 ADR，不再次委派。
执行包 defer G0；最终新审核机跑 G0，Mac G1 核对父链、路径、秘密扫描、输入指纹、文档；然后整合本轮准确差异到 main 工作区。保留 BEFORE.json 所记既有 dirty/untracked。本地 main 不提交，不公开推送或发布。
每个执行包限 90 分钟，审核包限 45 分钟；不额外做模型空探针，不修改账号或全局模型。必要同范围修复连续执行，出现认证失败、凭据漂移、新系统权限/依赖/架构扩展或未知生命周期时停止依赖动作；同类失败两轮先诊断。

## 4. 必要验证

- 后端真实 SQLite/Runtime/IPC：A 在途时查询 B 成功；分页；错属/未知/非法参数/缺 scope/旧 schema 拒绝；查询前后 A、队列、草稿与当前会话不变，零额外模型请求；受限 Runtime 诊断保持。
- 前端：打开 B、B/C 快切、分页失败重试、A 完成与待处理提示、返回 A、草稿与选区、迟到回包、跨工作区切换、快捷键与写入口零派发。
- 先构建依赖再测试；新审核机 Shell G0、Mac G1、`docs:check`、`git diff --check`。沙箱在系统临时目录，finally 清理并核对残留。
- Mac 真实 Electron 22 main/preload/IPC/Runtime/SQLite 最短链路：A 请求挂起 → 查看 B → A 保持 → 返回 A → 完成；另查等待审批/回答状态、窄窗、键盘与正常退出。仅本地回环模型夹具，外部产品模型请求为 0。
- Win7 新窗口、同包 Win10、正式候选、门 A/B 与发布均 NOT_PERFORMED，须另行批准。仅按需要生成单次开发构建，不分配候选号。

## 5. 执行记录

2026-11-09 开发机完成基线与资源核对。既有产品源码与私有 `56129c8b…` 同字节。默认代理 CONNECT 中断；本轮子进程移除代理环境变量后，保持默认 TLS 校验直连成功。czl 2/5 台、快照 ready；既有两台 suspended，保持不动。实现、独审、G0/G1、当前包 Win7 均 NOT_PERFORMED。


### 5.1 后端开发与 Mac 回环补测

InstaBox 后端四文件由包装器提交为 `7169697a…` 并推到私有 `box/a9-57-be`，工作机和短命部署密钥已回收。员工沙箱内新套件10项、preload/restricted27项、scope/路径3项通过；进程内模型传输明确标 SURROGATE，3项真实回环因listen EPERM未执行。

Mac 实际回环三项通过，另四项夹具因 `/var` 与 `/private/var` 路径别名被正确拒绝。主代理定位为新测试根目录未 realpath，单行修正后同源产品、新测试字节 `59430073…` 的13项全部通过；临时目录已清理。原失败保留，不放宽产品归属检查。该测试修正随前端包交付，后端历史提交不改写。准确原始日志与结果见本机 `outputs/a9-57-wp/BACKEND_MAC_R2.json`。


### 5.2 前端开发与主代理边界修复

Opus5.5 在 InstaBox 完成独立浏览状态、只读容器、分页/重试、执行状态提示、写入口守卫与焦点恢复。11套件878项开发机定向检查通过；首轮旧batch2 VM缺document造成的7项失败保留，补齐夹具后通过。

主代理源码核对发现 A 完成后点击 C 会退出浏览并尝试激活。新增反例在原实现上 EXIT=1；局部修正点击判定后14项前端行为检查通过，整个修正发生在同一前端工作机、员工退出后。浏览中继续查看其他历史仍保持只读，显式返回后才恢复普通激活。原执行scope、后端锁及产品权限不变。原始反例与修后日志在 `outputs/wp/a9-57-fe/collected/primary-row-*-a957/`，回执为 `outputs/a9-57-wp/PRIMARY_ROW_FIX.json`。


### 5.3 Mac 真实产品入口检查

准确源码 `340d307c…` 在 Mac Electron22.3.27 / Node16.17.1 实际 main/preload/IPC/Runtime/SQLite 入口完成8组检查。原生鼠标打开B/C、A运行时scope/草稿/暂停队列保持、浏览中写入口与Enter零派发、A完成后继续B/C只读查看、原生Return返回并恢复草稿选区焦点、A待审批/待回答返回处理及800×700实际视口均通过。工具读取原件保持；SQLite integrity=ok、活动task/turn/run和锁均为0，进程正常退出、临时目录删除。产品外部模型请求0，回环请求明细与绑定哈希在 `outputs/a9-57-wp/ui-r2/RESULT.json`。

首轮ui-r1因旧Mac Electron缓存缺失在启动前失败。按WIN7_CONSTRAINTS既有开发机探针Profile恢复同一官方ZIP，SHA-256 `2b87e9f7…` 与登记值一致后再跑；未更换版本、未安装到系统，原失败保留。源码隔离只复制编译所需模块和产品文件，依赖只读引用，finally清理。上述都是开发机证据，Win7/Win10和打包运行仍NOT_PERFORMED。


### 5.4 独立审核与局部修复

新机 Codex 独审绑定 `340d307c…`，结论为 P0 0 / P1 0 / P2 3。
独审以源码与内存探针复现：浏览 B 时 A 的未读完成标记缺失、字符串计划正文为空、待保存草稿定时器与旧 blur 可派发保存。
原报告在 `outputs/a9-57-wp/a9-57-review-report.md`，不改写其结论。
执行代理直接修复这三处，并把 saveDraft 纳入零派发统计；新增反例先在原产品运行。
旧源 G0 为 NOT_PERFORMED，原因是源码正在修复；最终 G0 绑定修后源码执行。
原审核机日志回收并校验后已删除，凭据未变。后继工作包为私有 `box/a9-57-fix`，仍只操作本轮临时机，不开放 Win7 或发布范围。


### 5.5 最终修复、审核机 G0 与 Mac G1（2026-11-09 UTC）

修后准确提交 `9c2f45b3…` 由主代理在本地整合，父链为 `7169697a…` → `340d307c…` → `9c2f45b3…`。
修复覆盖三项 P2：浏览期间 A 的未读完成标记、字符串计划正文、浏览期间草稿保存暂停与返回后恢复。
新增行为测试先在原实现上失败，修后 `primary-a957-after2` 通过浏览、批次和工作台合同测试；临时目录已删除。

新审核机 `wp-a9-57-review2` 只做准确源码身份复核并运行 Shell G0；G0 为 PASS，审核机已删除。
Mac G1 绑定准确提交、三条私有 staging 分支、输入指纹、秘密扫描、`docs:check` 和 Shell G0，结果为 PASS。
最终 Mac Electron 22.3.27 / Node 16.17.1 / ABI 110 真实产品检查 8 组 PASS，外部模型请求为 0，SQLite integrity 为 ok，活动 task/turn/run 与锁均为 0。

证据：`outputs/a9-57-wp/REPAIR_BEFORE.json`、`PRIMARY_REPAIR.diff`、`ui-r3/RESULT.json`、`CUMULATIVE_G1.json`、`INTEGRATION.json`。
上述均为开发机证据。Win7、同包 Win10、正式候选、门 A/B、公开推送和发布仍为 `NOT_PERFORMED`。

## 6. Win7 开发级验证准备（2026-11-10 UTC）

负责人后继指令：“下面进行win7开发机验证”。本轮从当前 main 使用常设 r2 通道，验证 A9-57；结果只记 `DEV_CHANNEL`。现有 HEAD 为 `1a25d593…`，原有修改和未跟踪文件按本机 `outputs/a9-57-win7-dev-r1/BEFORE.json` 保留。不提交、不推送或发布。

### 6.1 准确开发包与直接检查

产品源码与已交付提交 `9c2f45b3ed71c25710ff82ea4c03c3176b13401b` 相同。在系统临时目录建立该提交的干净本地克隆，依赖只读引用现有安装；未创建新提交。按 A9-32 开发 Profile 单次打包，沿用其 alpha.2 标签，不分配候选号。原生源码、ABI、输入锁和打包器均未修改。

三个原生输入从已核对卷 UUID 的外置归档 `archive-20261109-outputs-b2/acceptance-deps` 定向恢复。先核对密文、明文和原清单，再逐一匹配仓库输入锁 SHA-256。仅恢复 Electron、helper 返回包和 SQLite 返回包；解密、构建临时目录均已删除。首轮构建准备在依赖链接的 Git clean 检查停止，未调用打包器；后继只为临时克隆的链接补本地 exclude，产品字节未改。原失败保留。

| 项 | 直接结果 |
|---|---|
| 源码 | `9c2f45b3ed71c25710ff82ea4c03c3176b13401b`，包内 `source_dirty=false` |
| ZIP | `a2309321af92cccce7c6959ab193cb929ed78087a296b5012768667aa464ccf8`，110592891 字节 |
| manifest | `a1c251fb664bcfc1291b9cb91cb710390affdd59d145fa289a0652a6dcdede01` |
| 开发机包检查 | manifest 的 3261 个文件逐项大小/SHA 通过；ZIP 的 3262 个文件集合精确匹配；44 个产品源码文件与提交逐字节匹配 |
| 打包运行资格 | `external_acceptance_eligible=false`；Win7 与同包 Win10 均 `NOT_PERFORMED` |

包在本机 `outputs/a9-57-win7-dev-r1/package/`。直接证据为同目录外的 `INPUT_RECOVERY.json`、`build-r2.log`、`PACKAGE_CHECK.json`。

### 6.2 目标准入与容量阻断

只读 status 确认 DCCS-CHAIZL-PC / Win7 SP1 x64 build 7601，agent 会话 1。严格主机键保持；解包无未知状态，临时任务 0。锁 holder 为 `a946lanrx`，active=false。开发根内有四个 A9-55 旧产品进程：11368、13736、9228、12412，均保留。这里只证明管理通道状态，尚未证明新包普通用户进程身份。

开发根实际占用 21881579176 字节，超过 r2 默认 20000000000 字节。C: 剩余 856431132672 字节。旧窗口的容量例外已关闭，不继承。目标上传、启动和进程停止均 `NOT_PERFORMED`；本轮目标产品验证为 `BLOCKED`，原因是容量前置未满足。

准备的运行 UUID 为 `22d2cc2c-3df0-42f9-9fe6-d41fb41d061f`，运行根为 `C:\A9-DEV\run\22d2cc2c`。请求本次 60 分钟窗口内把容量上限临时设为 23000000000 字节，并允许沿用确认 inactive 的 `a946lanrx`；两项均待负责人批准。按新 ZIP、展开包、独立运行时副本及 300 MB 余量计算，占用上界为 22838712367 字节。最低剩余 50 GB 不变，不删除历史材料，不结束已有四个进程，不使用 steal 或 close 删根。

### 6.3 已确定的运行范围

容量例外获准、驱动实际运行时准入完成并重新确认身份/锁后才开始窗口。窗口含传输、执行、回收和收尾；最后 10 分钟不开新场景。最多两次开发尝试，外部模型请求 0，每次回环夹具最多 40 次、窗口累计最多 80 次。同范围普通夹具修复保留首败，用新不可变版本及新 run 复验；身份、完整性、安全、必需审计或未知生命周期失败立即停止依赖动作。

最短真实链路为：新包 main/preload/IPC/Runtime/SQLite 启动 → A 请求挂起 → 原生鼠标查看 B → 验证执行仍绑定 A → 返回 A → 完成 → 正常退出。再检查 B/C 切换、只读写入口、草稿/选区/暂停队列、A 完成不抢视图、等待审批/回答返回处理、800 像素窄窗、同 profile 重启零重放、SQLite 完整性与本 run 进程/任务/锁收尾。模型仅用本机回环夹具；不读取 agent 现有凭据和 Provider 配置。

详细字节预算、目标只读回执、四个保留进程及待批准项在本机 `outputs/a9-57-win7-dev-r1/WIN7_PLAN.json`。正式候选、门 A/B、同包 Win10、公开推送、发布和历史材料删除不在本轮范围。


### 6.4 负责人批准本窗口

负责人对 §6 的容量及锁方案回复“批准”。本次允许 60 分钟内使用 23 GB 上限，并沿用确认 inactive 的 `a946lanrx`；四个旧 A9-55 进程保留。准确起止由执行代理在材料齐备后的首个目标写动作前登记，不从批准时间提前消耗窗口。其余 §6.3 边界保持，准备完成后再次只读核对目标。正式门 A/B、推送、发布、历史删除和活动锁接管未授权。


执行窗口已登记：UTC `2026-11-10T08:11:28.130Z` 至 `2026-11-10T09:11:28.130Z`，新场景截止 `2026-11-10T09:01:28.130Z`。两层通道容量判断仅在该 holder 和时间内允许 23 GB；相邻时间、其他 holder、超额 incoming 与最低剩余边界已在开发机检查。驱动本机回环夹具的 SSE 探测、历史答复、挂起/释放及超额拒绝通过；这是 Mac Node20 夹具证据，包内 Node16/Win7 准入仍由本轮实际 controller 取得。


### 6.5 首次传输超时及同字节恢复

首个 SFTP 上传在既有时限停止，exit=124；传输字节数仍为 UNKNOWN，未解包或启动产品。原失败 action 与控制台回执保留在 `outputs/a9-57-win7-dev-r1/FIRST_TRANSFER_FAILURE.json`。后继只读 status 确认锁 inactive、无解包未知状态、四个旧进程保持。

在原锁协议及账本内取得锁后，远端部分文件 80347136 字节的 SHA `308cbe89…` 与本地 ZIP 同长度前缀完全一致。仅续传剩余 30245755 字节，沿用原单次传输时限及本窗口，不重传整包或修改通道工具。完成后远端全 ZIP 为 110592891 字节，SHA `a2309321…` 与本地相同；然后按既有通道提交缓存和解包检查。3262 个文件的解包检查通过，锁正常释放。此阶段仍不是产品行为通过；结果在 `RESUME_TRANSFER.json` 及原自动账本。


### 6.6 首轮夹具失败与第二次尝试

首轮 run `22d2cc2c…` 在 Win7 普通 agent / Session1 / Medium 完成准确包 3261 文件校验、SQLite 3.43.1 和六模块加载。前六组真实产品行为通过：运行 A 查看 B、B/C 切换、写入口禁用、A 完成不抢视图、原生 Return 返回后草稿/选区/队列/焦点保留、审批期间只读查看。

驱动随后因“拒绝后等待终态”超时而 FAIL。实际界面已显示“受阻”，源码 `a9-agent-runtime.js` 的合法结果含 blocked；本轮新加的夹具终态枚举漏了 blocked。管理通道 exit=0 不等于产品检查 PASS；原 controller/first 报告保留 FAIL，不改判。首次 UI 正常退出，独立 postflight 证明该 run 进程/任务均 0。未启动重启阶段，缺失文件回收错误保留；不是产品或身份失败。

第二次尝试只补夹具合法终态 blocked，不改产品、原生、权限或判据。新 run `b61c096d-6d0d-48f5-95d5-c944f5695668`，驱动 SHA `f486aa2fbbb41c33ed3559aad6897a3751a15f4877481aec2cb69050a895171e`；沿用原窗口截止和最多两次额度。独立运行时/数据目录在新 run 根。

容量不扩大。共享读取首轮准确未变的完整产品树 `C:\A9-DEV\run\22d2cc2c\p`，controller 再逐项核验全部 3261 文件；不复制第二份完整产品。新测试包装器复制相同 Electron EXE 与核心文件，只带本轮使用的 en-US/zh-CN 语言资源。原 ZIP 和完整产品语言资源均不改，省略只发生在候选外包装器；不形成其他系统语言的验证结论。新运行时文件计 203890088 字节，另留 16000000 字节给配置、manifest、隔离 profile 与证据。按最新只读状态 22777817835 字节计算，上界 22997707923 字节，低于已批准 23 GB；仍保留首轮运行及四个旧进程，不删除材料。


### 6.7 第二次尝试完成与窗口关闭

第二次 run `b61c096d-6d0d-48f5-95d5-c944f5695668` 取得 `DEV_CHANNEL` PASS。包、源码与原生字节未改，仍绑定源码 `9c2f45b3…`、ZIP `a2309321…`、manifest `a1c251fb…`。真实普通 agent / Session1 / Medium，Electron22.3.27 / Node16.17.1 / SQLite3.43.1；controller、首次 UI 和重启 UI 的 PID、creation、SID、Session 与实际运行路径均已核对。

首次 UI 的八组检查通过，重启的非空中文草稿、历史、队列及零重放检查通过。原生鼠标打开 B/C 与原生 Return 返回均经真实窗口输入。新包完整 3261 文件、六模块及 SQLite 原生加载通过；SQLite integrity=ok，活动 task/turn/run 全为 0、锁 0。两次 UI 都走正常产品退出，退出码 0。第二次尝试 8 次回环请求，首次 7 次，窗口共 15 次，外部模型 0。

11 个回收文件全部经过通道秘密扫描、大小及 SHA-256 检查。postflight 中 10 个文件元数据与本地原件一致，另保留 postflight 自身 GET 身份。三图已实际查看：1366×768 只读浏览和 800×700 返回 A 的稳定界面可读；800×700 浏览图抓到检查器收起动画中间帧，不据此签发稳定窄窗浏览布局 PASS。该项为 NOT_VERIFIED；800 像素返回按钮在视口内的独立行为检查为 PASS。原生125%DPI仍 NOT_PERFORMED。

最终只读 status 于 UTC `2026-11-10T08:55:33.548Z` 完成，窗口在 44.090 分钟收尾。两个本轮 run 均无进程/任务残留，holder inactive、无解包未知；四个旧 A9-55 进程的 PID/父 PID/映像路径与开场一致。开发根 22993068763 字节，低于本窗口 23000000000 字节；C: 剩余 854836367360 字节。窗口已关闭，不沿用剩余时间、请求额度或容量例外开启新运行。未删除历史材料，未提交或推送。

准确结果与视觉边界在本机 `outputs/a9-57-win7-dev-r2/RESULT.json`、`VISUAL_REVIEW.json`；原始文件在 `outputs/win7-dev/a9-57-b61c096d-6d0d-48f5-95d5-c944f5695668/`。首轮 FAIL 和首次传输 FAIL 均保留。开发 ZIP 已位于目标 `C:\A9-DEV\cand\a2309321af92cccc\package.zip`，完整产品树为 `C:\A9-DEV\run\22d2cc2c\p`；旧用户窗口仍为原版本，没有替换默认运行实例。

本结果仅覆盖 A9-57 本节开发级范围。A9-56 的完整原生右键菜单、其他系统语言、完整窄窗视觉、同包 Win10、正式候选、门 A/B、公开推送和发布未由本轮补签。
