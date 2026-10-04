# Structured Coding Runtime 与 Native Plan Approval Binding 设计规格

## 1. 设计目标

本设计解决一个已在真实测试中暴露的问题：用户提出完整工程需求时，Claude Code 能够进入原生 Plan Mode、讨论需求并输出文字计划，但 Agent Harness 没有稳定地产生 Task Tree，也无法保证后续代码执行与树节点关联。

目标不是替代 Claude Code 的规划能力，而是把原生规划过程沉淀为可持久化、可修订、可确认、可执行和可追溯的工程事实。

同一个 Agent Runtime 必须支持三种工作方式：

1. 普通问答：直接回答，不建立 Task Tree；
2. 直接执行：处理小型、局部或用户明确要求跳过规划的编码操作；
3. 结构化开发：对需要讨论、分解和分阶段实施的工程任务建立 Task Tree，并绑定原生 Plan 的用户确认结果。

## 2. 核心设计原则

### 2.1 一个 Agent Runtime，而非两套系统

Claude Code 的推理、提问、Plan Mode 和工具执行能力保持原生行为。Harness 以插件形式成为同一 Agent Runtime 的长期工程能力层，通过 Skills 引导行为，通过类型化工具维护事实，通过 Hooks 记录生命周期事件。

不得形成“Claude 先执行，Harness 再从外部接管”的双系统结构。

### 2.2 Skill 定义方法，Tool Provider 维护事实

- Skill 规定何时应建立任务树、怎样拆解、怎样精炼、怎样执行；
- Task Tree Tool Provider 负责创建、修订、校验和读取结构化任务树；
- Hook 负责观察原生生命周期并完成确定性绑定；
- Jev 只提供请求分类建议，不直接修改运行时事实。

### 2.3 Task Tree 是一等领域对象

Task Tree 不是从聊天文本或 Markdown 中事后猜测出来的副产品。规划 Agent 在讨论过程中使用类型化工具直接创建和修订 Task Tree，数据库中的具体 revision 是唯一事实源。

### 2.4 Hook 被动优先，边界恢复

Hooks 默认只记录和关联事件，不承担语义规划，不生成任务树，也不修复 Agent 输出。只有当结构化流程即将越过关键边界且缺少必要事实时，Hook 才返回可恢复的引导信息。

## 3. 总体架构

```text
User Prompt
    ↓
UserPromptSubmit Hook
    ↓
Jev Request Router（建议性分类）
    ↓
Runtime Profile Resolver
    ├── conversation
    ├── direct_coding
    └── structured_coding
            ↓
Task Planning Skill（规划方法）
            ↓
Task Tree Tool Provider（结构化事实）
    ├── create draft
    ├── atomic patch
    ├── validate
    └── prepare approval
            ↓
Task Tree Revision
            ↓
Claude Native Plan（展示与原生确认）
            ↓
Plan Approval Binding Hook（确定性绑定）
            ↓
Scheduler / Attempt / Trace / Artifact / Evaluation
```

这里不存在额外的“规划 LLM”。同一个 Claude Code Agent 负责理解需求、向用户提问、构造 Task Tree 文档以及解释计划。Harness 提供结构化生命周期，而不重复推理。

## 4. Jev Request Router

### 4.1 分类结果

Jev 对新用户请求返回以下三类之一：

| 分类 | 含义 | 默认 Profile |
| --- | --- | --- |
| `direct_response` | 问答、解释、只读查看，不产生项目资产变更 | `conversation` |
| `direct_execution` | 边界清晰、影响局部、不值得建立任务树的编码操作 | `direct_coding` |
| `task_tree_workflow` | 新项目、跨模块功能、架构调整或用户明确要求先规划确认 | `structured_coding` |

当项目存在活动 Task Tree 时，Router 还应给出关系建议：

- `continue_existing_tree`
- `change_existing_tree`
- `create_new_tree`
- `unclear`

### 4.2 路由不拥有执行权

Jev 输出是建议证据，不是不可越过的授权系统。Runtime Profile Resolver 综合以下信息确定工作方式：

1. 用户显式命令或明确自然语言要求；
2. 当前项目是否存在活动 Task Tree；
3. 当前是否处于已确认的结构化工作流；
4. Jev 分类、置信度和理由；
5. 确定性例外规则。

用户明确说“直接执行，不建立任务树”时，应进入 `direct_coding`。用户明确要求“先讨论并确认规划”时，应进入 `structured_coding`。

### 4.3 置信度和降级

- `confidence >= 0.80`：采用 Jev 建议；
- `0.50 <= confidence < 0.80`：把建议交给 Agent 结合上下文判断；
- `confidence < 0.50`：不依赖分类结果，由 Agent 原生判断；
- Jev 超时、限流、鉴权失败或返回非法结构：记录失败并降级，不阻断用户请求。

### 4.4 隐私边界

Router 默认只接收：用户当前请求、规范化项目标识、活动树摘要和有限的运行状态。不得上传项目源码、密钥、完整对话历史或工具输出。

## 5. Runtime Profile

### 5.1 `conversation`

- 保留 Claude 的正常问答与只读工具能力；
- 不要求创建 Task Tree；
- Hooks 仅记录必要的会话级事实。

### 5.2 `direct_coding`

- 允许 Agent 原生执行局部修改；
- 不要求先创建 Task Tree；
- 工具调用、文件变化和结果仍可写入 Trace；
- 若执行过程中影响范围显著扩大，Agent 可建议切换为 `structured_coding`，但不得丢失当前上下文。

### 5.3 `structured_coding`

- 加载 Task Planning Skill；
- 先确认任务归属，再进行问题驱动的局部精炼；
- 使用 Task Tree Tool Provider 建立一等任务树；
- 在用户通过原生 Plan 确认前，不开始计划中的项目修改；
- 确认后由 Scheduler 按任务树推进并记录节点 Attempt。

插件可以保持工具注册状态；Profile 决定哪些状态迁移当前合法。后续可在 Agent 平台支持时增加 capability snapshot，以减少无关工具对模型的可见噪声，但这不是首期正确性的前提。

## 6. Structured Planning Lifecycle

### 6.1 任务归属

收到 `task_tree_workflow` 请求后，Agent 先读取当前项目候选树，并让用户确认：

- 新建 Task Tree；
- 归并到现有 Task Tree；
- 修改现有 Task Tree；
- 暂不进入结构化工作流。

该决定被持久化为 `affiliation_decision`，后续创建 Draft 时必须引用它。

### 6.2 问题驱动的局部精炼

Agent 使用原生对话与提问能力讨论影响最大的未决问题。每次得到会改变计划结构、节点契约或验收标准的答案后，Agent 应通过 Tool Provider 原子修订 Task Tree，而不是等到最后重新生成一份不相关的计划。

### 6.3 首次完整 Draft

信息足够时，同一个 Agent 一次性生成完整 `TaskTreeDocument` 并调用创建工具。该文档至少包含：

- Tree 目标、范围与非目标；
- Skeleton 节点；
- 功能分支与子节点；
- 节点目标、输出、验收标准和完成证据；
- Task Relation Edges；
- Artifact Graph Draft；
- 未决问题与决策；
- 执行阶段和停止拆分理由。

### 6.4 局部修订

后续调整通过带前置 revision 的原子 patch 完成。不得以“最后写入者获胜”的方式静默覆盖并发变化。

### 6.5 准备确认

当 Agent 认为规划可执行时：

1. 调用校验工具；
2. 修复结构性错误或继续向用户提问；
3. 校验通过后调用 `prepare approval`；
4. 把工具返回的 canonical Task Tree block 写入 Claude Native Plan；
5. 由用户使用 Claude 原生确认界面批准或拒绝。

## 7. Task Tree Tool Provider

首期提供四个核心操作：

```ts
harness_create_task_tree_draft({
  cwd,
  affiliationDecisionId,
  expectedTreeRevisionId?,
  document: TaskTreeDocument,
  idempotencyKey,
}): TaskTreeRevisionView

harness_patch_task_tree({
  cwd,
  treeId,
  expectedTreeRevisionId,
  operations: TaskTreePatchOperation[],
  idempotencyKey,
}): TaskTreeRevisionView

harness_validate_task_tree({
  cwd,
  treeId,
  treeRevisionId,
}): PlanReadinessView

harness_prepare_task_tree_approval({
  cwd,
  treeId,
  treeRevisionId,
  readinessResultId,
  sessionId,
}): TaskTreeApprovalPreparation
```

内部服务按职责拆分：

- `TaskTreeDraftService`：创建和原子修订；
- `TaskTreeValidationService`：结构、叶子契约、关系和 readiness 校验；
- `TaskTreeApprovalService`：冻结待确认 revision、生成展示块与一次性 approval reference。

所有写操作必须支持幂等键，并返回确定的 revision 标识。

## 8. Native Plan Approval Binding

### 8.1 Native Plan 的职责

Claude Native Plan 负责：

- 向用户展示可读实施计划；
- 承载 Task Tree 的确定性摘要；
- 提供 Claude 原生的批准、拒绝和修改交互。

它不是 Task Tree 的事实源。

### 8.2 Canonical Task Tree Block

`prepare approval` 返回不可由模型自行拼造的 canonical block：

```markdown
<!-- agent-harness-task-tree:start approval_ref="<opaque-id>" -->
## Task Tree

<由 Runtime 确定性渲染的树、Artifact 草案、关系和验收摘要>
<!-- agent-harness-task-tree:end -->
```

Runtime 对完整 block 计算 hash，并把 `approval_ref`、`tree_revision_id`、`session_id`、`project_id`、block hash 和有效期一并保存。

### 8.3 进入与退出 Plan Mode

- `EnterPlanMode`：始终允许；Hook 只记录 planning lifecycle 开始；
- `PreToolUse(ExitPlanMode)`：读取计划文件快照，提取 opaque `approval_ref`，验证 block hash、项目、会话、树 revision 和 readiness；
- `PostToolUse(ExitPlanMode)`：根据 Claude 返回的原生批准结果，将该 Plan hash 与精确 Task Tree revision 绑定；
- 用户拒绝或修改：不激活 revision，Agent 继续讨论并产生新 revision。

Hook 不解析完整 JSON，不从 Markdown 重建树，也不进行 LLM 语义判断。

### 8.4 未使用 Plan Mode 的恢复路径

若 `structured_coding` 已生效，但 Agent 未完成 approval binding 就尝试第一次项目写入，PreToolUse Hook 返回一次可恢复的生命周期提示，要求 Agent 回到 Task Planning Skill 完成准备确认。它不是全局工具封锁：

- 只作用于高置信结构化工作流的首个变更边界；
- Runtime Introspection、Task Tree 工具和只读工具保持可用；
- 用户可明确选择“直接执行，不建立任务树”，Profile 随即切换为 `direct_coding`。

## 9. Hook 职责边界

| Hook | 应做 | 不应做 |
| --- | --- | --- |
| `UserPromptSubmit` | 记录 prompt receipt、调用 Jev、保存 route decision、解析 Project Identity | 创建任务树、替 Agent 规划 |
| `PreToolUse` | 检查关键状态迁移、关联节点、验证 approval ref、必要时返回可恢复提示 | 对所有工具强制阻断、进行开放式意图判断 |
| `PostToolUse` | 记录工具结果、Artifact delta、Attempt evidence、原生批准结果 | 从日志反推完整计划 |
| `SessionStart/End` | 恢复/归档运行状态并记录生命周期 | 把 Session 当作 Task 边界 |
| `Stop` | 收敛当前 Attempt、触发可确定的评估 | 自动宣称整个树完成 |

Hooks 必须尽量 fail-open。只有确定会破坏生命周期一致性的关键写入边界可以 fail-closed，并且必须返回具体恢复动作。

## 10. 执行调度

用户批准 Task Tree revision 后，Scheduler 创建不可变的 `Workflow Revision`。执行策略为：

1. 先按广度完成 Skeleton 阶段，建立公共接口、数据结构和最小可运行框架；
2. Skeleton Gate 通过后，按用户选择或依赖关系进入某个功能分支；
3. 分支内部按深度推进到可验证完成；
4. 节点结果逐级汇总，最后验证根目标。

Agent 仍使用原生推理和工具能力执行代码。Harness 只提供当前可执行节点、节点契约、关系和状态迁移，并通过 Hooks 把实际工具事件关联到对应 Attempt。

## 11. 持久化事实

除既有 Task Tree、Task Node、Trace、Artifact 和 Attempt 数据外，需要增加：

### 11.1 `request_route_decisions`

- `decision_id`
- `project_id`
- `session_id`
- `prompt_fingerprint`
- `classification`
- `tree_relation`
- `confidence`
- `reason_codes`
- `provider`
- `fallback_reason`
- `created_at`

### 11.2 `task_tree_approval_references`

- `approval_ref`
- `project_id`
- `session_id`
- `tree_id`
- `tree_revision_id`
- `readiness_result_id`
- `canonical_block_hash`
- `status`
- `expires_at`
- `created_at`

### 11.3 Native Plan 事实

- `native_plan_snapshots`
- `native_plan_task_tree_links`
- `native_plan_approval_events`

这些表保存 Plan hash、精确 revision 绑定、原生批准结果和时间信息。批准后不得把新 revision 偷换为旧批准对象。

## 12. 一致性、并发与恢复

### 12.1 乐观并发

每次 patch 必须携带 `expectedTreeRevisionId`。不匹配时返回冲突和最新 revision 摘要，由 Agent 重新读取后再决定修订。

### 12.2 幂等性

所有创建、patch、准备确认和批准绑定操作均使用 `idempotencyKey` 或事件指纹，避免 Hook 重试造成重复事实。

### 12.3 崩溃恢复

重启后根据项目身份、Session 映射和最新未完成状态恢复：

- 当前 Profile；
- 活动 Tree/Revision；
- 待确认 approval reference；
- 当前 Workflow Revision 与 Attempt。

过期或跨项目的 approval reference 必须拒绝绑定。

## 13. 多 Agent 与多会话

Task Tree 绑定 Project Identity，而不是绑定某个 Session。不同 Agent 或会话可以读取同一棵树，但写入必须遵循 revision 并发控制。

每个执行 Attempt 还应绑定：

- `agent_runtime`
- `session_id`
- `tree_revision_id`
- `workflow_revision_id`
- `task_node_id`

这样既允许多个 Agent 协作，又能明确每次变更来自哪个已确认版本和哪个节点。

## 14. 非目标

本阶段不做以下事情：

- 不用第二个 LLM 把 Claude Plan 翻译为 Task Tree；
- 不从任意自然语言中强行抽取完整树；
- 不要求所有编码请求都建立 Task Tree；
- 不用 Hooks 替代 Agent 的规划和提问；
- 不把完整 Task Tree JSON 嵌入 Plan 再由 Hook 解析；
- 不建立独立于 Agent Runtime 的 Harness 管理后台；
- 不复制 ACE 面向通用数据工作流的类型端口模型到 Coding Task Tree。

## 15. 验收与测试

### 15.1 Router

- 三分类结构解析；
- 显式用户要求覆盖分类；
- 活动树关系判断；
- 超时、401、429、5xx 和非法响应降级；
- 不上传源码和密钥。

### 15.2 Task Tree Provider

- 完整 Draft 创建；
- 原子 patch 成功与 revision 冲突；
- 非法关系、非叶子契约、未决问题等 readiness 失败；
- 幂等重放不产生重复 revision。

### 15.3 Approval Binding

- canonical block hash 一致时可以绑定；
- block 被模型或用户修改后拒绝旧 ref；
- 跨项目、跨 Session、过期 ref 拒绝；
- 用户拒绝 Plan 时不激活 Workflow Revision；
- native approval 精确绑定一个 tree revision。

### 15.4 Hook 行为

- 普通问答不触发建树；
- direct coding 不被 Task Tree Gate 阻断；
- structured coding 缺少批准时，首个写入得到可恢复提示；
- Runtime 自身工具和只读工具不会被错误拦截；
- Hooks 失败时不会让 Claude Code 整体不可用。

### 15.5 黑盒验收场景

使用“从零开发可实际使用的拼豆图案设计网页”作为黑盒请求：

1. Router 选择 `task_tree_workflow`；
2. Agent 询问任务归属和关键需求；
3. Agent 使用工具建立并逐步修订 Task Tree；
4. Native Plan 展示与数据库一致的 canonical Task Tree；
5. 用户批准后生成 Workflow Revision；
6. 代码执行先完成 Skeleton，再进入分支；
7. Tool/Artifact/Trace/Attempt 均关联到具体节点；
8. 用户要求小型直接修改时，可不建立新树并正常执行。

## 16. 实现边界

首期实现范围包括：

1. Jev Request Router 与降级策略；
2. Runtime Profile Resolver；
3. Task Planning Skill 更新；
4. Task Tree Tool Provider 四个核心操作；
5. Native Plan canonical block 与 approval binding；
6. Skeleton-first / branch-depth Scheduler 接线；
7. 对应持久化迁移、自动化测试和黑盒验证。

此前“在 Native Plan 中输出完整 JSON Manifest，再由 ExitPlan Hook 解析并迁移为 Task Tree”的方案被本规格取代，不得继续作为实现依据。
