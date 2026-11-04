# A9-45 — OpenAI 兼容后端 system 消息归一化

```text
Status: COMPLETE
Task Type: PRODUCT_COMPATIBILITY_BUGFIX
Target Branch: main e6efd0f7 (integrated 2026-11-03/04, see §9); private box/sys400c; local a9-45-system-message at 3de9bee899a179c8245365297196ee0eb4876227
Source Baseline: 79388ea0c2da4af73c01d2869dd32ebd7319aa5a
Phase-Gate: A9_44_WIN7_57_PASS_WITH_KNOWN_LIMITS
Win10-Validation: NOT_PERFORMED
Win7-Validation: A9_44_WIN7_57_PASS_WITH_KNOWN_LIMITS
Evidence-Class: DEV_CHANNEL
Acceptance-Basis: SHIPPED_AND_ACCEPTED_WITH_WIN7_57 (A9-44 §9.20)
```

## 1. 交付与依据

负责人于 2026-11-03 要求确认本机交接 `2026-11-03-system-message-400.md` 中的问题，并使用加入 InstaBox 的工作流修复。
本任务按 C14 / ADR-0290 登记本轮缺陷修复，不沿用历史任务额度。
执行代理已用当前 Gateway 编译输出和回环 HTTP 严格模板桩复现。
单条开头 system 返回 200，连续两条和历史中间 system 返回相同 400。
直接证据为 `outputs/a9-45-system-message-r1/BASELINE_REPRODUCTION.json`。
同事实际后端、请求和故障版本为 UNKNOWN，不能凭错误字符串确定供应商或模板型号。
交接称 DeepSeek 固定适配器继承通用适配器，与当前源码不符；产品入口实际使用通用适配器。

成功条件：通用 Provider 默认发送最多一条位于开头的 system；内容按原序保留。
工具关联、图片、历史摘要的数据权限声明及输入对象不被破坏。
严格模板桩完成首句和工具续步，对照 passthrough 重现 400。

## 2. 实现与边界

仅修改 Gateway 的通用 OpenAI-compatible wire 构造和对应单元、HTTP 合同测试。
完整回归发现 J1 旅程的旧出站断言仍要求两条 system；同步该断言及内容索引。
该检查继续要求项目指令被加载，并禁止预加载项目配置内容，不删除或省略旅程。
增加可选内存构造参数 `systemMessagePolicy: 'merge-leading' | 'passthrough'`，缺省 merge-leading。
按原序以两个换行拼接所有非空 system 文本，移到开头；非 system 消息保持相对顺序。
空字符串 system 丢弃；非空单条开头 system 和无 system 的报文保持原状。
不 trim 文本，不解析或改写摘要的 `authority: data_only`，不改变源消息数组。
先做原有角色、图片及工具 wire 校验，归一化不能绕过非法图片拒绝。
保留 passthrough 作为 Provider 构造级诊断选项，不增加产品 UI、配置文件字段或 schema 迁移。
产品运行时无需额外透传即可获得默认修复。Core 提示词、权限、审计和持久化语义不变。
不修改历史固定 DeepSeek 适配器，不新增依赖、网络权限、系统 API、运行时或原生组件。
接口决定见 ADR-0313。

## 3. InstaBox 工作包

沿用 ENGINEERING_06 §1.11、§1.12 和 r4 §22、§23。
只使用 czl 私有登录快照 `sn_agqzcjtcjpqyjt5xxcfn3cdwam`。
本轮采用既有最小流程上限：两台新机串行存在；执行 sys400a，审核 sys400b。
Codex workspace-write 实现一次、Claude Code plan 只读审核一次，各限时 900 秒。
Claude 使用现有钥匙串引用 czl-claude，秘密不进入任务单或报告。
员工只修改、自检和报告；包装器在主代理核对准确路径及字节后提交。
仅向私有 staging 的 `box/sys400a` 推送；短命取码、写入部署密钥用完撤销。
执行包 `close --defer-g0`；新建审核机只读审核后跑 Gateway G0。
执行包 `receive --g0-from sys400b`，Mac G1 检查身份、父链、路径、秘密、指纹和文档。
通过后建立本地 `a9-45-system-message` 分支；本地 main 保留原 HEAD 和全部脏改动。
将该提交的相同三文件同步到当前 main 工作树，作为本轮已授权缺陷修复，不提交 main。
同步前确认这三条路径仍无其他修改；出现并发改动时停止覆盖并报告。
只回收本轮两台工作机；删机前确认准确机器身份、全部日志哈希和凭据元数据。
母机必须保持 suspended，不唤醒、不检查登录，不更改快照。
本任务不创建 PR、不推送公开 origin、不合并或提交 main、不发布、不改现有 CI workflow。

## 4. 验证与停止条件

先用严格模板桩保存未修复反例，再运行定向单元与 HTTP 合同测试。
覆盖无 system、单条原样、多条开头、中间/末尾、空文本、摘要声明、工具关联、图片拒绝、passthrough 和输入不可变。
Gateway 编译及完整 Gateway 测试由新建审核机的既有 `test:local --module gateway` 执行。
不运行 Core 全量、UI、Windows 构建、Win10/Win7 或真实付费后端请求。
同事真实后端首句和续步验证为 NOT_PERFORMED，不能用模板桩替代。

身份、范围、完整性或安全失败停止依赖动作。
认证失败不重试模型，凭据元数据变化进入 CREDENTIALS_HOLD。
日志未完整核验不得删机；密钥撤销或删机失败立即报告。
P0/P1 未解决、G0/G1 失败时不集成；普通同范围修复只在现有额度内完成。
不追加机器或模型调用预算；不足时保留结果和最短后继动作。

## 5. 本轮开发执行记录

证据层级为开发机，基线为 `79388ea0…`。
原始结果保留于 `outputs/a9-45-system-message-r1/` 与 `outputs/wp/sys400a/`。
员工启动首次回执丢失，工具记 JOB_START_UNKNOWN。
只读对账确认作业目录不存在、Codex 进程数为 0、工作区未变。
执行代理确认作业目录为排他创建且从不删除后，使用同一 job ID 继续启动，未重复启动员工。
Codex 一次调用，343.062 秒，交付两个测试文件。
沙箱回环监听报 EPERM，HTTP 验证受阻，员工未改 Provider 源码。
无需监听的测试对旧实现有 8 项归一化断言失败、4 项通过。
这项源码反例不能替代 HTTP 证据；HTTP 反例由本轮 Mac 直接复现。
员工退出后，执行代理补齐 Provider wire 修复和缺失的 passthrough HTTP 对照。
未新增模型调用，未放宽员工沙箱。
既有包装器在员工沙箱之外运行：Gateway 编译及两个定向文件 33 项 PASS。
补充对照后，A9-45 的 15 项 PASS，原有 20 项省略，完整回归留给新建审核机 G0。
员工原件引用为 REFERENCED，ORIGINALS_READ 声明保留；引用证据不等于全文阅读证明。

## 6. Mac 修正版与 Box 补跑待批准

当前工作区的修复已完成，证据层级为开发机。
产品实现及最初两个测试文件绑定私有提交 `df22fa0396d5cb6df11e4c4a89011ec30ba68d2f`，唯一父节点为本任务基线。
Claude Code 独立审核 91.88 秒，P0=0、P1=0；工作区无变化。
审核使用部分未列入 Bash 枚举的只读命令，包括 cat、ls、grep、head 和 git rev-parse。
未观察到写入或凭据读取；不宣称精确命令清单完全合规，详见 CONTENT_VERDICT.json。
非阻断项为类型合同外的非字符串 content、模板桩不证明真实后端、合并会改变消息边界。
摘要的数据权限声明原文保留，产品源码及相关测试字节未因后继旧断言修复而变化。

新建审核机 G0 为 FAIL：19 组中 18 组通过，305 项中 304 项通过。
唯一失败是 a9-05-journeys.test.ts 的 J1 仍要求出站两条 system，内容索引仍为 1。
G0 原结果和原 G1 FAIL 保留；不改判，不将 Mac 结果补写为 Box PASS。
执行代理同步这两行旧断言，保留项目指令加载、实际文件读取、引用及禁止预加载项目内容的检查。
当前 main 仅增加未提交的四文件修复，原 HEAD 与其他已有修改保留。
Mac 使用 Node 20.17.0 执行 `npm run test:local -- --module gateway`，19 组、305 项全部 PASS，无省略。
该入口先构建 workspace、state、runner、git-adapter、gateway 和 core，随后测试实际消费者。
完整原件为 CURRENT_RESULT.json、CURRENT_WORKTREE.diff、mac-gateway-full.log。

两台工作机已删，母机保持 suspended，staging 部署密钥为空。
14 个作业的日志字节数、SHA-256、TMPDIR 清理全部通过；本轮 Mac 临时目录无残留。
原有工作区保护核对通过，Claude 令牌未出现在本轮回收文件。
两次员工首次启动均出现传输回执丢失；第二次先跑无模型后台诊断成功，再按相同 job ID 的排他创建机制继续。
未重复启动员工，传输根因为 UNKNOWN。

本轮两台机器额度已用完。执行代理已准备修正版，请负责人决定是否追加一台仅计算工作机，完成确定性包装器提交、私有推送和 G0/G1。
不新增模型调用；原产品独立审核只能按准确未变字节标为 INHERITED_EVIDENCE，新增两行测试由执行代理检查。
追加机器未获准前不启动；真实同事后端、Win10、Win7、主分支提交、公开推送和发布均为 NOT_PERFORMED。

## 7. 负责人追加一台计算机授权

负责人明确选择“授权追加 1 台，完成工作流（推荐）”。
本节取代 §3、§4 对本轮机器总数的上限：累计最多三台，新增仅 sys400c 一台，名称 wp-sys400c。
模型调用不追加，仍只有此前 Codex 与 Claude Code 各一次。
计算包从私有提交 `df22fa0396d5cb6df11e4c4a89011ec30ba68d2f` 开始。
确定性脚本只修改 a9-05-journeys.test.ts 的两行旧断言，按本机已通过 305 项的准确字节提交。
包装器核对基线、分支、唯一改动路径及 SHA-256，创建一条提交；私有推送仅到 `box/sys400c`。
新机 G0 使用既有 Gateway 完整入口，测试限时 900 秒；随后核验日志、凭据元数据并回收准确机器。
Mac G1 使用最终准确提交核对父链、引用、范围、秘密、指纹、文档与 Gateway 消费者。
成功后建立本地 `a9-45-system-message` 分支，当前 main 继续保留未提交修复和原有修改。
产品源码及两个定向测试与已独审提交逐字节一致，独审结论标为 INHERITED_EVIDENCE；两行旅程断言由执行代理核对。
其他母机、快照、目标平台、公开仓库和发布边界保持原合同。
本次 G0 失败即先诊断，不自动追加第四台或模型调用；日志未核验或凭据变化时保留机器并报告。

## 8. 最终开发机交付与工作流结果

执行代理完成本轮缺陷修复和获批工作流，结论为 A9_45_DEVELOPER_VERIFIED。
最终源码为 `3de9bee899a179c8245365297196ee0eb4876227`，唯一父节点为 `df22fa0396d5cb6df11e4c4a89011ec30ba68d2f`。
私有分支为 `box/sys400c`，本地交付分支为 `a9-45-system-message`。
当前 main HEAD 保持 `79388ea0c2da4af73c01d2869dd32ebd7319aa5a`，四个未提交修复文件与最终提交逐字节一致。
完整绑定、文件 SHA-256 与逐项结果见本机 `outputs/a9-45-system-message-r1/FINAL_RESULT.json`。

| 检查 | 结果与证据层级 | 绑定与原件 |
|---|---|---|
| 严格模板与对照 | 开发机 PASS；passthrough 复现 400，默认首句及工具续步成功 | Provider 与两个定向测试字节同 df22fa03…；baseline 原始反例和合同测试保留 |
| 新机 Gateway G0 | Linux 开发机直接 PASS；Node 20.17.0，19 组、305 项，无省略，26.639 秒 | sys400c；测试上限 900 秒，原始 spec 核对；`outputs/wp/sys400c/collected/g0-sys400c/` |
| Mac G1 | 开发机直接 PASS；8 项身份、父链、引用、范围、秘密、指纹、文档与消费者检查通过 | sys400c-receive.json；Gateway 19 组、305 项 PASS，Node 20.17.0 |
| 产品独立审核 | INHERITED_EVIDENCE，P0=0、P1=0 | sys400b 对 df22fa03…的原报告可核验；Provider 与两个定向测试 SHA-256 不变，依赖指纹一致，行为边界不变 |
| 旅程断言修正 | 执行代理直接核对两行差异，确定性脚本与包装器绑定准确字节，G0/G1 全量覆盖 | sys400c-apply.json、sys400c-commit.json；仅 J1 角色数组及内容索引变化，语义检查保留 |
| 日志与收尾 | 开发机 PASS；21 个作业的 stdout/stderr 字节数和 SHA-256 一致，TMPDIR 全部清理，Mac 无本轮临时残留 | COLLECTION_VERIFICATION_COMPLETE.json；三个工作机已删，凭据元数据未变，无令牌落入证据 |
| 资源与原工作区 | 开发机 PASS；仅保留准确 suspended 母机，staging 部署密钥为空；原有受保护修改和 main 身份不变 | sys400c-verify.json、PROTECTED_WORKTREE.json 和最终核对 |

计算机为 `m_agq2bhgegysc6bzcrdyni2ppke` / wp-sys400c，已回收。
后继仅新增一台机器，新增模型调用为 0；本轮总 CLI 模型调用仍为 Codex 一次、Claude Code 一次。
固定准备入口只运行 CLI 版本观测，不计为模型生成调用。
最终 G0/G1 先编译六个所需模块，再测试 Gateway 实际消费者，不运行 Core 全量测试。
本轮负责人额外介入为一次追加计算机授权；追加机首次 G0 与 G1 均通过，未再补跑。
旧 sys400b G0 FAIL、sys400a G1 FAIL、员工沙箱 EPERM 和启动回执异常均保留，不改判。

真实同事后端、Win10、Win7 实机、产品打包、门 A/B、main 提交、公开 origin 推送及发布均为 NOT_PERFORMED。
该结果只证明当前源码的开发机修复和 InstaBox 工作流闭环，不改变已发布包或任何冻结候选的字节与结论。

## 9. 后继：main 集成、真实请求与 Qwen 模板对照

### 9.1 负责人指示集成 main

负责人后继要求将暗色主题与 A9-45 统一提交，并先推进验证和合并到 main。
本节取代 §3 中“不合并或提交 main、不推送公开 origin”的限制；§3 原文保留。
执行代理推送前未向负责人指出该限制冲突，属执行偏差。
执行代理将负责人所说的“实机验证”理解为真实模型请求；本项目“实机”专指 Win7 实机，见 GLOSSARY。

| 提交 | 内容 | 验证与证据层级 |
|---|---|---|
| `32b16ec…` | A9-45 产品源码与测试，A9-44、A9-45、ENGINEERING_06 任务书及索引 | 四个产品文件与 `3de9bee8…` 逐字节一致；Gateway 19 组 305 项、docs:check、verify:release 399 项 PASS，均为开发机 Node 20.17.0 |
| `e6efd0f…` | shell `a9-provider-persistence.test.ts` 环境信息断言 | 完整日常集合 7 模块 PASS（开发机）；GitHub CI run 41758140357 PASS |

`32b16ec…` 使 shell A9-42 环境信息用例必然失败，开发机 20 次全部复现。
原因是该用例查找以 `<environment_facts>` 开头的单独 system 消息，合并后该消息并入开头。
Core 历史仍每轮替换环境信息；Win7 探针 `w42-product-probes.cjs` 按包含匹配，不受影响。
执行代理只改该断言，保留两轮检查。漏检原因是 §4 的验证只覆盖 Gateway。

### 9.2 真实请求与 Qwen 模板对照

| 检查 | 结果 | 限制 |
|---|---|---|
| DeepSeek `deepseek-flash` 真实请求 1 次 | 合并后的两条 system 报文返回 200，按序回复 | 只证明合并报文被接受；不证明严格模板修复。原件 `outputs/a9-45-real-model-20261103/` |
| Qwen 官方聊天模板渲染，未调用模型 | Qwen3.5-27B、Qwen3.5-35B-A3B、Qwen3.6-35B-A3B 对未合并消息抛出 `System message must be at the beginning.`，合并后通过；Qwen2.5 与 Qwen3 系列两种都通过；带工具定义结论相同 | 开发机逻辑验证；服务端预处理、模型回复、流式与思考内容未覆盖。原件 `outputs/a9-45-qwen-template-20261104/` |

同事后端仍为 UNKNOWN；Qwen3.5/3.6 加官方模板是与报错一致的推断。
另见 QwQ-32B 模板因工具调用 assistant 的 `content` 为 null 失败，与合并无关；真实服务端是否先规避为 UNKNOWN，本轮不修。

### 9.3 当前状态

当前 main 为 `e6efd0f…`。Phase-Gate 保持 A9_45_DEVELOPER_VERIFIED。
真实 Qwen 服务端、同事后端、Win10、Win7 实机、产品打包和发布均为 NOT_PERFORMED。
负责人后继要求本修复与暗色主题一起推进 alpha.4 发版；版本范围记录见 A9-44 §9.17。

### 9.4 随 alpha.4 发布并被接受

本修复随 `v0.3.0-alpha.4-win7-57` 发布，Win7 实机 DEV_CHANNEL 场景与结果见 A9-44 §9.19。
负责人接受 WIN7-57，结论为 A9_44_WIN7_57_PASS_WITH_KNOWN_LIMITS，见 A9-44 §9.20。
已知限制：只经严格模板夹具与 Qwen 官方模板渲染验证；真实 Qwen 服务端与同事实际后端仍为 NOT_PERFORMED。
