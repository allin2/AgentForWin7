# A9-56 — 默认对话入口、底部精简与行右键菜单

```text
Status: APPROVED_FOR_IMPLEMENTATION
Task Type: PRODUCT_EXPERIENCE
Target Branch: main 工作区；云上私有 staging box/a9-56-ui → box/a9-56-fix
Source Baseline: 1a25d593ee2bd3f155b043bfe1d9aebf688f8fd1
Phase-Gate: A9_56_DEVELOPER_VERIFIED
Win7-Validation: NOT_PERFORMED
Decision: ADR-0324（Accepted）
```

负责人2026-11-09提出三项修改，并明确“使用instabox完善”。此任务登记该准确范围；不借用A9-54/55旧实现或旧窗口的权限。

## 1. 可观察结果

1. 选择“不选目录，直接开始”后，草稿入口明确显示Full Access；发送首条消息时显式传入full_access，直接启动首轮，不在发送后弹出权限选择。只适用于本入口新对话；不继承其他工作区模式，不改写已有Read Only或Review设置，高影响目标绑定批准继续有效。首次普通问答仍不创建子目录。
2. 隐藏截图圈出的输入框执行目录条，以及输入框下方常驻“工作区已就绪/高影响操作说明/DPAPI已保护”说明。顶部工作目录入口、权限切换、Enter/Shift+Enter指引、运行中草稿提示、错误/不可持久化/仅内存等真实异常与恢复信息保留；不以隐藏错误或失败关闭信息换取精简。
3. 对话行右键可选择“置顶/取消置顶”“结束对话/恢复到活跃”。移除对应行悬停快捷按钮，普通左键只切换对话。菜单绑定被右键的确切工作区和对话，后台行不先激活；运行/待审批/待回答/归档按现有合同限制。菜单靠近触发位置，视口内定位；外点、Escape、滚动及目标失效后关闭；500ms列表刷新不能把菜单动作改绑到另一行。支持键盘菜单键或Shift+F10和基本焦点恢复。置顶继续localStorage，结束/恢复继续既有目标绑定IPC。

## 2. 行为与实现边界

沿用Electron22/Node16、现有主题及布局，无新增依赖、系统API、IPC或数据库格式。预计只修改renderer的JS/CSS/HTML与src/shell/tests下对应合同；发现必须改主进程、State、权限守卫或新增依赖时先报告具体缺口，不擅自扩展。前端可调用已存在的startDefaultConversation(prompt, mode)。Accepted ADR-0321/0322/0323原文及历史证据保留，后继方向见ADR-0324。

## 3. InstaBox交付

沿用已批准云上工作包流程和按需快照。串行一台执行机、一台独立审核机；不操作已有机器或monster，不改快照或账号。前端Opus5.5 high，独立审核Codex GPT6.1 Sol high；同类必要修复沿用该分工，模型不可用时报告，不切换。仅本轮临时机的配置显式设定并读回；不改全局模型。工作包使用私有staging新分支、包装器提交及短命部署密钥回收；本地main不提交、不推公开origin。

执行包close --defer-g0；新审核机完成内容审核后运行Shell G0，Mac G1核路径、指纹、文档。主代理接收后仅将本轮准确源码改动合入当前工作区，保留既有dirty和untracked；此前a9-default-workdir.test.ts的一行临时路径修复作为本轮必要测试夹具修复保留，不回退。

## 4. 验证与完成

目标测试覆盖：默认对话首发显式full_access、已有只读不变；常驻说明隐藏而异常可见；右键当前/后台/已结束行、忙碌拒绝、置顶持久化、目标绑定、菜单关闭及键盘；被牵连的Renderer vm夹具补齐真实所需桩，不删断言。

测试前编译依赖；完成审核机Shell G0、Mac G1，并以真实Electron22 main/preload/IPC/Renderer检查三项可见行为及正常退出；三项均通过后才接收整合。测试沙箱在系统临时目录、项目前缀、finally清理，跑后核对残留。按需要单次开发构建绑定私有准确提交与ZIP哈希，结果仍属开发机；当前Win7新包、原生右键、正式门A/B与发布NOT_PERFORMED。新Win7窗口与根外写入需准确后续批准，不复用已关闭的3fd90770窗口。

停止：认证失败、秘密/凭据漂移、未授权范围、身份/完整性/未知生命周期立即停止依赖动作；同类失败两轮先诊断共同根因。独立审核P0/P1解决并复核后再接收整合。不改变已保存模式、不静默吞错。

## 5. 开发机交付结果（2026-11-09 UTC）

`A9_56_DEVELOPER_VERIFIED`。准确源码 `56129c8b7d1c5fb7f4587ef4a89f7de32c3ced2b` 已按七文件原字节合入本地main工作区；main HEAD仍为 `1a25d593…`，未提交、未推公开origin。默认新对话首发Full Access、底部常驻说明精简、置顶/结束/恢复行右键菜单均已实现。已保存只读模式、真实异常、目标绑定和后端安全链保留。

Opus执行包a9-56-ui的原提交为 `f4fa22c0…`，实际模型claude-opus-5-5，配置与员工回报均high。Workbench78、batch2+default-workdir720、三个Renderer合同101项通过；这些集合重叠，不相加。首轮batch2缺syncRowMenu桩的7项失败保留。首轮Sol独审P0 0/P1 1：当前禁用行不可键盘聚焦。旧源G0明确取消，未签PASS；原P1报告保留。

主代理按MODES§7直接修复两文件，形成最终 `56129c8b…`。禁用行父li提供Tab焦点、名称和菜单提示；关闭菜单后按准确scope返回新行。Workbench78项直接通过。新机a9-56-fixr独审P0 0/P1 0，3项内存探针通过。该审核只签源码与内存探针；因机上未带Mac驱动原件，独立原生键盘证据复核为UNKNOWN。实际模型/档位自报UNKNOWN，配置读回gpt-6.1-sol/high，不混同配置与运行身份。

最终源码的新审核机Shell G0为PASS：69套件、1549项PASS、12 skipped；日常慢检查 `required fields reject absence and wrong types before comparison` 标NOT_PERFORMED。工作树在G0前后均为准确HEAD、零dirty、零额外提交。Mac主代理修复G1九项PASS，包含准确父链、私有ref、范围、秘密扫描、输入指纹和文档；Shell由该新机G0覆盖，未在Mac重复全套。

Mac真实Electron22 main/preload/IPC/Renderer同源交互17项PASS，结果在 `outputs/a9-56-wp/ui-r7/RESULT.json`。覆盖原生Tab到达当前行、Shift+F10/Down/Return结束、Escape焦点恢复、当前行原生鼠标右键、后台目标置顶/结束/恢复、旧Read Only不变、首次问答零目录、底部精简而仅内存警告保留、菜单关闭及浅/深色视口。该run回环2次、外部模型0；全7个UI run合计回环14次、外部模型0。ui-r1时间等待、r3/r4输入码/Return字符、r5/r6闲置Renderer外部调用导致的驱动失败均保留；最小探针和实际Renderer入口修正后通过，未削弱判据。每轮数据/源码沙箱已清理；两张最终浅/深色截图已查看。

单次开发构建 `outputs/a9-56-wp/dev-1/Win7CodingAgent-0.3.0-alpha.2-win7-x64.zip`，SHA-256 `b5eb246446247e6571f2dd2339b0d651bf87eed1d61fa078b77bda55cec8ad5f`，110582812字节。manifest SHA-256 `e7ef2e75bc10744337447853dc4e3ac1a7d246c3358b9a5578a215c3bd04e972`；3261文件闭包及八模块加载入口PASS，包内Renderer与实际UI测试字节一致。它是开发构建，不是冻结候选；没有双构建、正式门或发布。

三个本轮临时机均已回收，部署密钥撤销、凭据元数据不变；原有两台机器和monster未操作。18个其他原dirty文件哈希不变；ADR/索引新增前的文档原字节已核对保留。已有默认工作目录测试的一行临时路径修复与接收字节相同，未回退。源、原始失败、模型配置、review、G0/G1、包及清理回执在本机 `outputs/a9-56-wp` 与 `outputs/wp/a9-56-*`。

新包Win7部署、Win7原生右键、同包Win10、正式门A/B和发布均为NOT_PERFORMED。原A9-55的Win7窗口与23GB/Documents例外已关闭，本轮未复用；Win7现有程序保持旧包。
