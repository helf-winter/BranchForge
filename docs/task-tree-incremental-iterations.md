# 已完成任务树的增量迭代（0.1.9 起，0.1.10 修正实现推进）

新功能可以追加到已完成的原树中，不必创建另一棵树。规划与编码仍由 Claude 原生执行；Harness 保存约束、执行证据和交付历史。

## 原生操作流程

用户可以说：「给计数器增加命名快照，合并到原任务树。先讨论方案，确认后实现。」

1. 查询候选树。已完成且未归档的候选标记 `supportsIncrementalMerge: true`。
2. 使用原有 `harness_propose_task_affiliation` / `harness_resolve_task_affiliation` 明确选择 `merge`，绑定同项目、同会话的真实用户回答证据。选择本身不启动执行。
3. 先调用 `harness_get_tree_view(depth: "detail")`，读取 `planningDocument` 与 `treeRevisionId`。这是原 revision 的完整规划（不受视图筛选影响），不是当前可变产物投影。保留旧范围并在根节点追加新分支，再用原有 `harness_create_task_tree_draft` 提交完整 `planningVersion: 1` 文档及精确 `expectedTreeRevisionId`。返回同一 treeId、新 revision，以及 added/reused/revalidation 节点清单；不需要从旧会话或数据库自行拼凑规划。
4. readiness 通过后准备新 revision 的审批引用，写入原生 Plan，并通过一次原生执行审批。旧审批不能授权这一轮执行。现有用户选项回答证据可用，不额外强迫用户再打一条重复确认。
5. 按调度结果执行。`executionPurpose: "revalidation"` 表示先跑现有验收和补证据，不代表要重写已交付代码。验证前调用 `beginVerification`，随后跑真实验证命令并绑定每个 requiredEvidence key，最后 Evaluation。
6. 新分支及受影响范围通过后，重新执行根验收，生成新 Final Report。同一树可以有多份报告，每个完成 revision 一份。

## 追加边界

旧分支/叶子正文、产物定义、关系、骨架要求和契约提供方/签名/版本不能借“追加”改写。旧规划目标、排除项及范围约束保留；新范围可以追加。根节点保留身份和既有证据 key，允许扩展子分支及更新覆盖描述；既有验收条目不得删除。契约可以增加新分支消费者。

要重构旧节点或变更旧契约，需要另行讨论明确的范围变更；本入口不隐式代做。无新增根分支、过期 revision、未解决归属、归档树、活动执行或冲突待处理操作都会拒绝，事务失败会回滚。

## 证据复用，不是复用状态标签

验证开始/结束时记录 SHA-256 文件字节与契约定义指纹，只保存哈希，不保存源文件内容或 API 密钥。验证时段内已知输入发生变化，成功提议会降为 uncertain，需重新取得稳定证据。先测试后开始验证的历史顺序仍兼容现有生命周期，但不会据此发放可复用指纹。

文件只从已登记项目的真实路径读取。越界路径、外部符号链接、缺失/不可读输入是 unknown；每文件上限 16 MiB、每次捕获上限 64 MiB。修改时间不是复用依据。平台、架构与 Node 版本必须兼容。

复用审计绑定旧 Evaluation/Attempt/Gate 来源；后续 mutation 会使其失效。影响通过产物/契约、`depends_on` 和验证祖先传播，不通过纯通信关系传播。未关联产物的 expectedOutputs 路径以及完成后的项目级修改 Trace 也会纳入判断。

声明的契约消费者也会捕获提供方输入，并在后续提供方修改时补验，不需要再重复写一条 consumes/dependency 关系。如果继承分支完成后又出现无 Hook 的外部文件修改，显式 phase Gate 或 finalize 会记录真实的 `verification_baseline_stale` 观察、失效旧来源并退回可执行阶段。此时在同 revision、同审批下继续调度即可，不要重建树。查询和 next 不会为此修改 Runtime 状态。普通同 revision 的实现推进与既有骨架兼容规则保留。

旧版报告没有指纹时，按重新验证处理，不在升级时根据当前文件伪造旧基线。纯容器分支由子节点证据和分支门禁聚合，不制造容器 Attempt。历史创建 Trace 与当前验证分开：共享文件被新增功能修改后，不要求旧骨架重写文件才能恢复创建归属。

### 同分支的正常实现（0.1.10）

实现节点可能将输出写成「src/snapshots.js 完整实现」等描述；这不是字面文件路径。当前已审批修订中，节点与文件的 `implements` / `modifies` 关系可用于识别已规划实现，不再强迫说明文本恰好等于 locator。旧版精确路径 `expectedOutputs` 仍兼容；只有 `reads` / `verifies` 关系且没有精确路径输出时不算已规划写入。

保留骨架证据的条件限定为：真实 `PostToolUse` 文件工具写入，绑定同项目、同树、同当前 revision、同节点与同会话的运行中 Attempt，且 Trace 不早于 Attempt 开始；该文件由同一根分支的骨架节点 `creates`。仅该创建者的骨架证据不因填充实现而失效，新的实现证据、分支验收和根验收仍须执行。验证阶段、无运行中 Attempt、其他会话与 `verification_baseline_stale` 观察不得套用此豁免。

跨分支修改、无已规划写入关系或精确路径输出的修改、契约 Artifact 变化仍按原规则失效重验。此规则不分析任意源码 API 的兼容性，也不承诺所有计划内修改都免于回退。0.1.10 不修改已完成的现场树、旧报告或已有失效记录，不增加数据库迁移。

## 当前交付与历史交付

snapshot / tree summary 的 `currentRevisionFinalReport` 只指当前 revision 的报告。新增规划或执行期间它为 null；`latestIteration` 显示迭代来源和规划时的影响/复用清单。这份清单是审计快照，不保证后续文件修改后证据仍可用。

`harness_get_final_reports` 的旧报告保持 completed，仍可按 reportId 查询；它不代表新 revision 已完成。旧 idempotency key 只返回原来的历史结果，不能完成新工作流。查询、选择已完成树、暂停、普通“继续”或小改动都不自动追加分支。

## 升级与复测

更新插件后须关闭并重开 Claude Code，`/clear` 不能重载旧 MCP/Hook 进程。升级不重开真实项目，也不删除旧报告；schema 27 只增加指纹与迭代审计表，旧记录不自动回填。首次正常启动会执行新增 schema migration，应按平时的 Runtime 数据备份流程保留备份。

本次自动化在临时项目/SQLite 中通过原生 Hook 审批、实际服务执行与门禁模拟两轮交付；测试中的工具结果是受控验证事实，不是生产计数器的实测报告。真实项目的功能状态应依据其独立验收，不从这些 fixture 推断。0.1.10 仅修正 Harness，不修改计数器或重开真实任务树。
