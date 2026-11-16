# A9-60 — 批量文件整理、停止延迟与重启阻塞诊断

```text
Status: COMPLETE
Task Type: DIAGNOSTIC_TOOLING
Target Branch: main
Source Baseline: d5b99b62abb8c7fe1a52875272811a1b01f8bc5d + existing working-tree changes
Phase-Gate: A9_60_DIAGNOSIS_COMPLETE
Win7-Validation: DEV_CHANNEL
```

## 1. 范围

负责人报告几百份文档整理时命令、停止、再次打开均卡住。故障机不可连接；负责人要求用本机所连接的Win7模拟。
本轮只制作诊断夹具、运行隔离复现和记录原因，不修改产品、真实文档、原会话、数据库、默认实例或系统设置。
实际main为d5b99b62…加既有差异；故障机版本、命令及文件规模未取得，保持UNKNOWN。
选用已验证alpha.8准确ZIP36491b75…作为可重现基线，不将结果冒充故障机实测。
保留并发产品修改及旧A9-57四进程，不接管活动锁、不清理历史材料、不发真实模型请求、不提交/推送/发布。

## 2. 本地证据

Electron22.3.27/Node16.17.1直接加载该ZIP的Workspace/Checkpoint模块。
夹具为512个64KiB虚构文件和1个128MiB稀疏大文件；不存在真实文档或慢盘注入。
无移动时收集约297ms、最大事件循环间隔223ms；移动512文件后收集约1676ms、最大间隔1350ms。
第二次按Core的取消后收集入口不传用户取消信号，最大间隔2075ms。
两次变化收集及冻结累计2054次checkpoint持久化、1118871703字节元数据写入。
冷checkpoint加载约333ms，尚未复现无限转圈。
这些是开发机诊断，不能签Win7或故障机结论。源日志及finally清理在本机outputs/a9-hang-diagnosis-r1。

## 3. Win7模拟准备

最短链路：隔离虚构文件 → 本地回环生成CMD整理命令 → 实际Runner执行 → 收尾阶段点击停止 → 记录IPC/事件循环/持久化次数 → 正常退出 → 重启恢复。
第一场景通过实际configureShell入口选CMD，移动512个虚构文件，在首次外部变更收集前经Renderer停止按钮派发取消。观测钩子会影响派发时序；不将该场景当作任意时刻停止的延迟保证。
第二场景执行带开始/结束标记的CMD等待命令。看到开始标记后用原生鼠标事件点击停止，检查cancelled终态及结束标记未生成。
随后仅在本run测试数据库，将第二场景的真实Turn标为interrupted并省略其最终SQLite checkpoint行；保留原manifest字节。此状态明确标注SURROGATE_STATE_SEED，观察冷checkpoint校验与零模型重放，不称作真实崩溃。
记录端到端CMD时间、freeze/collect/persist/load分段、停止请求与主进程收到的时刻、终态时间、可见启动时间、SQLite和进程收尾。
结果允许“仅复现短暂停顿，未复现持续卡死”，不得为复现而人为延迟产品、弱化校验或放宽取消/审计条件。
夹具、观测器和控制器只在候选外；不替换Runner、Policy、审计或恢复校验。测试沙箱用完删除，先保留必要证据。
准确目标窗口和容量例外须在输入就绪后绑定；不延用已关闭的A9-59窗口。

## 4. 待批准的准确目标资源

目标为DCCS-CHAIZL-PC，192.168.1.9，Win7 SP1 build7601，普通agent Session1。
准备复用目标上已缓存的alpha.8开发构建；不上传或重建ZIP。run为cf2b68d5-dd6e-4cfa-92a7-895ddf126382，隔离根为C:\\A9-DEV\\run\\cf2b68d5。
待申请40分钟新窗口，最后10分钟只取证和收尾，最多1次产品尝试，真实模型请求0，回环夹具请求合计最多10。
待申请25,000,000,000字节临时上限及准确inactive holder a946lanrx复用；不接管活动锁。常设上限20,000,000,000字节及旧窗口关闭记录保持。
现有只读快照中开发根24,397,987,994字节；本轮新增上界556,192,072字节，总量上界24,954,180,066字节。该数包含100,000,000字节预留；最低剩余50GB规则保持。执行前刷新，若超出已批准上限则停止目标写入。
计划、准确源码/ZIP/manifest、driver及支持文件完整哈希在outputs/a9-hang-diagnosis-r1/WIN7_PLAN.json。driver为b7e9a5db…；六份诊断JS已按当前字节在Electron22/Node16下通过语法检查。候选外观测钩子的实际Runtime加载检查通过；Windows CMD与实际停止IPC仍为NOT_PERFORMED。
目标写入为NOT_PERFORMED。容量例外与新窗口批准前不部署；不删除历史材料、不终止旧A9-57四进程、不提交、推送或发布。

## 5. 本轮执行批准

负责人批准§4的40分钟、25GB、inactive holder a946lanrx复用与最多1次产品尝试。准确窗口为UTC 2026-11-11T07:11:06.374Z 至 2026-11-11T07:51:06.374Z，新场景截止 2026-11-11T07:41:06.374Z。部署、执行、取证与收尾全部计入窗口。
本run只增加两端容量函数的准确holder/UTC临时条件；结束时仅移除本轮插入块。完整前后SHA见outputs/a9-hang-diagnosis-r1/WINDOW_TOOL_PATCH.json。

## 6. 首次运行：套件失败，产品症状尚未执行

run cf2b68d5于UTC 2026-11-11T07:13:58.608Z进入控制器。源码d5b99b62…、ZIP36491b75…、manifest69431b11…、3262份包文件与SQLite原生加载校验通过，普通agent Session1/Medium身份绑定通过。
首个产品窗口正常退出，但套件在ui-scenarios.cjs:11切换CMD时失败。configureShell请求漏传必填envOverlay，Schema按合同拒绝；未发整理或取消任务。控制器报告FAIL，外层进程退出码却为0；本轮只采信内部FAIL，不以退出码0改判。
产品测试数据库integrity_check为ok，活动tasks/turns/runs均0，工作区锁0。本run独立postflight确认进程0、任务0；保留测试数据库快照并清除本次虚构文件沙箱。首个窗口FAIL证据保留于outputs/win7-dev/a960-cf2b68d5，不覆盖原输入。
本轮已经使用1次产品尝试。512文件整理、实际CMD停止与重启恢复场景均NOT_PERFORMED；不得把准备阶段失败作为故障机根因或产品缺陷。

## 7. 套件修复与追加尝试材料

修正版run为0c85c6b8-b793-41bd-9387-04a35754fa74，输入在outputs/a9-hang-diagnosis-r2。显式Shell还需要用户选择器返回路径；夹具只为自己的测试配置提供准确System32/cmd.exe选择结果，经原Runtime.configureShell({kind:'cmd',envOverlay:{}})执行真实身份校验和持久化。主窗口随后只校验加载的workspace_explicit CMD，不绕过Runner、Policy或文件身份检查，也不宣称实测系统文件选择器。
本地Electron22/Node16直接加载准确ZIP模块，已证明旧参数在选择器调用前被A9_PAYLOAD_INVALID拒绝，完整参数经实际Runtime测量并保存Shell，重开Runtime仍能加载准确设置。该本地检查使用/bin/bash替代CMD，只证明配置链路；Windows CMD仍NOT_PERFORMED。证据SHELL_ENTRY_NODE16.json，临时沙箱已在finally删除。
五份修正版JS语法检查通过。追加尝试和容量调整尚待负责人决定，不自动重跑，不覆盖首次FAIL。

本轮于UTC 2026-11-11T07:20:02.048263+00:00完成收尾并关闭窗口，未用预算不沿用。目标根24,609,575,644字节，余853,201,760,256字节。两端容量插入块已移除，SHA均恢复本轮执行前，原其他dirty保持。旧A9-57四进程仍在，全部保留。完整结果在outputs/a9-hang-diagnosis-r1/RESULT_FINAL.json。
追加方案为新的40分钟窗口、最后10分钟只收尾、25.5GB临时上限、准确inactive holder复用、最多1次产品尝试、真实模型0、回环最多10。新增上界556,192,072字节，根总量上界25,165,767,716字节。此方案待批准。

## 8. 修正版追加批准

负责人明确批准§7修正版再试1次，新40分钟窗口、25.5GB、准确inactive holder复用与原请求边界。run 0c85c6b8，准确UTC 2026-11-11T07:21:40.235Z 至 2026-11-11T08:01:40.235Z，新场景截止 2026-11-11T07:51:40.235Z。本轮计数独立，旧窗口仍关闭；容量条件只覆盖本轮UTC和holder。
修正版对错误分支也保存回环请求记录，第二进程计数包含第一进程记录，合计最多10；真实模型0。

## 9. Win7开发级模拟结果

修正版run 0c85c6b8的控制器为DEV_CHANNEL PASS。源码d5b99b62…、ZIP36491b75…，3262份文件校验通过；准确driver为35582328…，普通agent Session1/Medium身份通过。控制器于UTC 2026-11-11T07:24:22.027Z开始，07:25:06.064Z正常退出。该结论只表示诊断场景执行完成，不表示性能达标、正式Win7验收或故障机根因已确定。

| 直接观察 | 本run结果 | 边界 |
|---|---|---|
| 512个文件实际CMD移动 | Runner报告327ms、exitCode 0；512份SHA全部保留 | 虚构64KiB文件，非故障机文档 |
| 文件变更收尾 | collectExternalChanges最长5844.352ms | 候选外观测器包裹原方法，无人为慢盘注入 |
| 收尾阶段停止 | 派发至主进程收到6ms；到终态5948ms | 在收集前经Renderer按钮派发，时序受夹具影响 |
| 第一窗口主线程 | 最大心跳间隔4933ms；1032次checkpoint持久化，总耗时4813.791ms | 包含两个Turn，不将全部持久化都计为一次命令 |
| 实际CMD等待中的停止 | 原生鼠标停止至主进程收到62ms，到cancelled终态1383ms；结束标记未生成 | Runner报告processTreeReaped=true，未模拟真实第三方整理程序 |
| 重启恢复阶段 | loadCheckpoint最长5195.840ms；最大心跳间隔6135ms；最终ready | SURROGATE_STATE_SEED，非真实崩溃 |
| 模型与重放 | 真实模型0；回环请求第一窗口3、第二窗口0 | 不证明故障机网络或模型服务状态 |
| SQLite生命周期 | integrity_check为ok，活动tasks/turns/runs均0，工作区锁0 | 第二个Turn的interrupted状态是夹具明确构造 |

源证据在outputs/win7-dev/a960-0c85c6b8，提取结果在outputs/a9-hang-diagnosis-r2/MEASUREMENTS.json。十份独立postflight文件已核对大小与SHA。本run进程0、临时任务0；测试数据库快照保留，虚构文件沙箱已删除。第一次套件FAIL不改判。

## 10. 诊断结论与后继最小修复建议

本轮在Win7直接复现了秒级主线程停顿和取消后等待。整理命令本体短于收尾阶段；因此界面显示命令仍在运行，不能据此认定CMD进程仍在执行。尚未复现持续卡死或无限启动转圈；故障机准确版本、命令、文档规模、磁盘和恢复状态仍UNKNOWN。
源码与计时共同指向Checkpoint同步开销：Workspace逐项recordExternalFact，CheckpointManager每项同步序列化并原子重写完整清单；Core为保留已发生变更的事实，取消后仍执行收集。文件事实记录循环没有分段让出事件循环。冻结基线和冷清单完整性校验也同步读取及校验恢复材料；本轮冷loadCheckpoint已出现5.196秒单次调用。
定位入口为src/workspace/src/a9-workspace-service.ts:1196、src/workspace/src/checkpoint-manager.ts:730、:809、:1298、src/core/src/a9-agent-loop.ts:1554。当前工作树的独立Provider超时改动不在准确ZIP内，未归入本轮验证。
建议后继修复聚焦受控批量checkpoint持久化、收集循环分片让出主线程、恢复及快照入口的校验分片。必须保留取消后文件事实完整记账、失败可恢复、完整性与审计判据；不能直接删恢复数据、跳过校验或一收到Stop就放弃收尾。本任务没有实施这些产品修复。
最低有效回归应在同一虚构文件规模验证文件SHA、取消终态、进程树清理、恢复完整性和零重放，并比较checkpoint写入次数与主线程最长停顿。精确故障机根因仍需其日志或现场；不得将本轮可复现瓶颈提升为已证明的原事故原因。

## 11. 最终收尾

UTC 2026-11-11T07:30:42.516364+00:00关闭本轮窗口，用时9.038分钟；未用预算不沿用。最后只读status：根24,825,813,830字节，余852,983,910,400字节，锁inactive、任务0、解包生命周期已知。仅保留旧A9-57四进程，本run进程0。两端临时容量块已移除，SHA均恢复本轮执行前；其余已有修改保留。最终绑定与结果在outputs/a9-hang-diagnosis-r2/RESULT_FINAL.json。
本任务的诊断范围COMPLETE，产品修复NOT_PERFORMED。故障机事故原因仍UNKNOWN，持续转圈未复现。本轮不提交、不推送、不发布，不签门A/B。
