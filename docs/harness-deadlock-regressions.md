# 工作流死锁与完成收尾回归（0.1.4 / 0.1.5 / 0.1.6）

这些修复针对 Harness 产品工作流，不修改验收用的拼豆项目，也不恢复已归档的 Task Tree。

## 修复边界

- 归属建议可以如实记录 `new_tree`、`merge`、`direct_execution`、`pause`。
- 同项目的 `UserPromptSubmit` 或成功 `PostToolUse / AskUserQuestion` 非空回答可成为用户选择证据；调用前事件、空回答、其他工具返回不能冒充用户回答。
- 归属回答可以用于准备审批。准备并不批准执行；仍需一次实际的原生 Plan 批准，绑定当前树 revision。
- 未定义 executionPhase 的容器节点由当前子节点完成事实与分支验证状态聚合，不要求虚构容器 Attempt。失效子节点仍阻止完成。
- 正常实现同分支计划内的骨架文件不撤销骨架文件创建事实。契约修改、越范围修改仍触发重验。
- 调用/数据交换边不等于证据依赖；失效沿明确依赖及实际资产关联传播。依赖失效时，运行中的下游 Attempt 释放并等待重验。
- 新 revision 保留已有实际产物事实；节点本体、关联契约、验收条件、资产关联及依赖规划均未变更时，成功骨架 Attempt 可作为门禁证据。相关条件改变会要求重新确认与重验；历史 Attempt 的 revision 不被改写。
- Final Report 引用实际复用的旧修订 Evaluation 与验证 Trace，同时排除已失效或不匹配当前验收上下文的成功证据。
- 归档最后一个活动工作流后解除残留结构化会话门禁；暂停选择持久化。Stop 不为收尾强制新建树。
- 数据库 v24→v25 升级保留归属决定、命令及 Profile 历史引用，并校验外键。

## 0.1.5：完成后的 Stop Hook 误报

根因：Final Report 把工作流置为 inactive，却留下 `structured_coding` 会话 Profile；Stop 因此把“已完成”误认为“尚未开始规划”。

- Final Report 成功时，在同一事务里把相关结构化会话转为 `conversation`，追加不可变 `task_tree:completed` Profile Transition；保留路由、归属、审批与执行证据引用。
- 关联依据是当前 Profile 的任务归属、当前请求之后的已消费原生审批 / Execution Attempt，或绑定当前树的最近用户继续请求（路由为继续/精炼，或使用原生回退）。路由缓存复用旧请求时仍检查最新 Trace 的树归属。不能因为项目里有完成报告就无条件放行，也不批量重置其他会话的新请求。
- 已完成 Task Tree 保持 `completed` 和现有 selection，不自动归档、不新建树。归档仍是用户可选的历史管理操作。
- 完成被拒绝或事务失败，不重置 Profile；重复 finalize 只返回原报告，不清除后来到达的新请求。
- 该修复不回写既有最终报告、已归档树、失败 Gate 或 Drift；旧记录保留原样。

## 自动化验证

运行 `npm run check`：类型检查、全部测试、构建、官方插件校验及插件契约测试。

## 0.1.6：骨架缺证据的局部恢复

计数器验收现场的只读诊断确认：当前 revision 的四份契约实际已落库，缺的是绑定的验证事实；规划命令 `npm test` 与带管道、退出码输出的实际命令不是同一签名。全部骨架 Attempt 成功后，旧调度器又禁止成功节点重试，导致无可执行节点。

- Readiness 即使 `artifactContracts` 为空也检查 `requiredContracts`。验证引用必须对应同分支骨架 evidence key，或有骨架归属与证据声明的计划产物；文件引用附加 Trace 绑定警告，不能冒充现成验证。
- 门禁区分 `required_contract_missing`（定义不存在）和 `contract_validation_missing`（验证缺失），后者返回 `missingValidationRefs`。
- 命令匹配读取成功 `PostToolUse` Trace 的不可变 `commandFingerprint`；旧非秘密 Trace 可从原命令计算签名。预调用、失败事件、非零退出码不计通过。秘密文本仍脱敏；不把管道自动等同于裸命令，也不读取命令产物的最新来源作为唯一证据。
- 当前 revision、当前 Workflow revision 的失败骨架门可触发局部补验。`harness_get_next_executable_node` 返回缺证据的骨架节点及 `recovery`，优先选择缺失验证 key 或产物的归属节点，而非一律选择契约提供方。
- 通过 `harness_start_node_attempt` 创建新 Attempt，旧 Attempt / Evaluation / Gate 不回写。无失败门、未确认、活动 Attempt、依赖未完成、blocking Drift 或 revision 不匹配时不能任意重跑成功节点。
- 同一恢复阶段累积同执行上下文且未失效的成功证据；重复门禁评估不丢失上一轮已补证据。补验后先重评门禁，通过才进入实现。
- 允许保守解析的 `ls | head; find | head`、`cd && grep | head` 等只读诊断；未知脚本、写文件、命令替换、危险选项、裸通配符展开仍不豁免。输出补丁的 Git 诊断须禁用 external diff / textconv。此判断是工作流分类，不替代 Claude 权限系统或宿主环境安全隔离。

本版不改数据库 schema，不恢复或修改真实计数器的树与状态。旧失败门保留原样；新评估生成新记录。

### 继续既有计数器验收

1. 更新本地插件并确认 `0.1.6`，完全退出重启 Claude Code（不是只执行 `/clear`）。
2. 在原计数器目录发送：`继续计数器，按当前任务树补齐骨架证据后继续执行。` 不新建树、不清数据库。
3. Agent 查询当前 Runtime、骨架结果和下一可执行节点。若旧结果只列笼统契约缺失，先重评一次，获得当前精确缺项。
4. 对返回的 `recovery` 节点开新 Attempt。命令缺项按原字符串单独执行（如裸 `npm test`，不加 `| tail` 或额外 `echo`）；把成功 Trace 绑定到该节点声明的 required evidence。文件验证引用先读取对应文件并绑定 Read Trace；产物本身已存在时不要求无意义重写。
5. 完成补验 Evaluation 后重新评估 Skeleton Gate，重复局部补验直到通过。检查 treeId / revision / 已消费审批保持原值，旧失败结果和旧成功 Attempt 仍可查询。
6. 正常执行剩余分支、根验证及 Final Report。验收重点是 Harness 能恢复并闭环，不仅是网页能打开。

端到端用例覆盖：原生选项归属 → 树草稿与局部精炼 → 原生 Plan 审批 → 骨架执行与门禁 → 同文件分支实现 → 分支验证 → 根验证 → Final Report → Stop 正常收尾。独立回归覆盖依赖失效恢复、旧 revision 骨架证据、暂停与归档收尾，以及完成后的会话隔离、新请求门禁、幂等重试和事务回滚。

## 人工复测

1. 构建后更新 `agent-harness-local` marketplace 与用户级插件；确认安装版本 `0.1.7`（包含上述 0.1.6 修复）。
2. 完全退出并重启 Claude Code，不能只用 `/clear`。不要重建或恢复原验收项目的已归档树。
3. 在新的测试目录提出一个小型多模块开发需求，要求先讨论、确认规划再实现。选项回答直接选择新建树，不补打一条文字。
4. 只读查询确认归属已解析、草稿 revision 和 readiness；准备审批后仅批准一次原生 Plan。
5. 正常继续执行，检查骨架、分支、根验证最终形成 Final Report；纯容器无需单独 Attempt。
6. 不归档任务树，让 Agent 输出最终结果并结束。Stop 不得报“尚未开始规划”；只读查询应看到树为 `completed`、最终报告为 `completed`、workflow 为 null、会话 Profile 为 `conversation`。
7. 运行一次构建或提出只读查询，不得要求重建树才能收尾/复跑。随后提出另一项明确要求先规划的开发需求，确认仍按新请求进入规划，而不是永久绕过工作流。

旧失败 Gate 与 Drift 是历史事实，不改成 passed。当前正式 Failure Case 仍由失败节点 Evaluation 派生；本版不通过伪造 Evaluation 将流程 Gate 失败包装成节点失败。

若已通过所有分支、却因跨树同名 `root` 无法启动根验收，请使用 [0.1.7 节点身份恢复](node-identity-recovery.md) 的只读预览与显式备份恢复流程，不要重建规划或重新审批。
