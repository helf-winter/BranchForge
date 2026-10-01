# Native Plan → Task Tree Bridge 设计规格

## 1. 目标

在不替代、不禁用 Claude Code 原生 Plan Mode 的前提下，让复杂 coding 请求稳定形成可持久化的 Task Tree，并在用户批准计划后按照 Task Node 推进代码执行。

本设计遵循以下原则：

- Agent Core 继续负责需求理解、项目探索、推理、提问、计划编写和代码实现；
- Claude 原生 Plan Mode 继续作为需求讨论、计划展示和用户批准的交互载体；
- Harness 采用 passive-first 策略，通过 Hooks 记录生命周期事实，通过 Skill 引导计划结构；
- Task Tree 是原生计划的长期结构化投影，不是第二套独立规划，也不是事后从执行痕迹反推的结果；
- Harness 只在“批准计划进入执行”“节点完成”“阶段推进”“高风险或重大 Drift”等必要边界实施确定性约束；
- 小型、自包含请求和用户明确选择直接执行的请求不强制建立 Task Tree。

## 2. 非目标

本设计不做以下事项：

- 不阻止 `EnterPlanMode`；
- 不实现一套替代 Claude `AskUserQuestion`、计划文件或批准界面的 Harness UI；
- 不要求另一次模型调用重新把原生计划拆成任务树；
- 不把 Agent 的隐藏思维链保存为 Task Tree；
- 不在每轮自然语言输入中注入完整 Runtime State；
- 不因为当前 Project 没有 Task Tree 而阻止普通代码修改；
- 不把任意简单请求升级为结构化工作流。

## 3. 核心关系

```text
用户复杂需求
    ↓
Claude 原生 Plan Mode
    ├── 项目探索
    ├── 自然语言推理
    ├── AskUserQuestion
    └── 原生 Plan 文件
    ↓
Native Plan → Task Tree Bridge
    ├── Hook 捕获计划生命周期
    ├── Skill 引导 Task Tree Manifest
    ├── 确定性解析与校验
    └── 绑定原生批准结果
    ↓
Task Tree Runtime
    ├── Skeleton Pass
    ├── Skeleton Gate
    ├── Branch Implementation
    ├── Branch Verification
    └── Root Verification / Final Report
    ↓
Claude 原生 Coding 能力完成当前 Task Node
```

规划阶段以原生 Plan 为当前编辑源。原生计划获得用户批准后，对应的 Task Tree revision 成为执行阶段的结构化计划基准。后续范围变化通过新的原生计划快照或现有 Draft Change Set 机制产生新的 Task Tree revision，不覆盖旧事实。

## 4. Claude Binding 生命周期

### 4.1 进入 Plan Mode

`PreToolUse(EnterPlanMode)` 和 `PostToolUse(EnterPlanMode)` 必须被允许并写入 Trace，不得返回 `deny`。

`PostToolUse(EnterPlanMode)` 返回一次事件相关的 `additionalContext`，内容只说明：

- 原生 Plan Mode 可以照常使用；
- 若该工作属于复杂、多阶段、跨模块或用户明确要求结构化规划，应加载 `agent-harness:task-tree-planning`；
- 最终 Plan 需要包含可持久化的 Task Tree Manifest；
- 小型或明确直接执行的请求不需要建立任务树。

该上下文只在进入 Plan Mode 时注入一次，不替代 Skill，不包含 Runtime State，不形成每轮固定 Prompt。

进入原生 Plan Mode 的请求默认形成 `structured_candidate` 规划会话，因为 Plan Mode 本身代表 Agent 判断当前工作需要显式规划。用户通过 Task affiliation 明确选择 `direct_execution` 后，该会话转为直接执行并豁免 Task Tree；除此之外，原生计划获批后必须在首次项目 mutation 前形成有效 Task Tree revision。该规则不分析用户自然语言复杂度，也不干预 Plan Mode 内部行为。

### 4.2 规划与需求讨论

Agent 使用原生能力完成：

- 读取和搜索项目；
- 通过 `AskUserQuestion` 逐步澄清高影响问题；
- 展示 Task Tree 的人类可读结构；
- 根据用户回答修改原生 Plan；
- 在适用时完成 Task affiliation 的新建、归并、直接执行或暂停选择。

Hooks 被动记录 User Prompt、AskUserQuestion、计划文件写入和工具结果。Task Tree Skill 负责方法论，不接管原生交互界面。

### 4.3 退出 Plan Mode

Claude Code 的 `PreToolUse(ExitPlanMode)` 输入包含 `plan` 和 `planFilePath`。Binding 必须将其规范化为 Native Plan Snapshot，并执行以下流程：

1. 计算规范化 Markdown 的内容哈希；
2. 记录不可变计划快照和来源 Trace；
3. 提取 `harness-task-tree` Manifest；
4. 使用现有 Task Tree Validator、Leaf Task Contract、Artifact、Relation 和 Skeleton Acceptance Criteria 规则校验；
5. 在已解决 Task affiliation 的前提下创建或更新 draft Task Tree revision；
6. 将 snapshot、tree、revision 和 plan file path 建立稳定关联；
7. 允许 Claude 继续显示原生计划批准界面。

解析或校验失败不得破坏原生 Plan Mode。失败事实写入 Trace，并在工具结果旁通过 `additionalContext` 指导 Agent 修正 Manifest 或调用显式同步工具。

### 4.4 用户批准计划

`PostToolUse(ExitPlanMode)` 的 approved plan response 是原生批准事实。Binding 必须：

1. 根据 plan hash 找到精确 Native Plan Snapshot；
2. 记录 `native_plan_approved` Trace；
3. 将批准绑定到精确 Task Tree revision，禁止批准旧 revision；
4. 复用现有分支确认和 Workflow 创建逻辑；
5. 将 Workflow 推进到 `skeleton_pass`；
6. 通过一次 `additionalContext` 引导 `branch-execution` Skill 从当前可执行 Skeleton Node 开始。

不得要求用户在批准原生 Plan 后再批准一套内容相同的 Harness 计划。原生批准必须成为 Task Tree revision 的确认来源。

如果计划被拒绝、取消或修改，则保持 draft 状态；下一次 `ExitPlanMode` 形成新的 snapshot 和 revision。

## 5. Task Tree Manifest

原生 Plan 保持正常 Markdown 可读性，并在末尾包含一个标准 fenced block：

````markdown
```harness-task-tree
{
  "planningVersion": 1,
  "planningContext": {
    "goal": "实现拼豆图案设计网页",
    "scopeBoundaries": ["浏览器端应用"],
    "exclusions": ["服务端账号系统"],
    "unresolvedQuestions": [],
    "unresolvedDecisions": [],
    "plannedEffects": []
  },
  "nodes": [
    {
      "id": "root",
      "parentId": null,
      "title": "实现拼豆图案设计网页",
      "children": ["foundation", "canvas"]
    },
    {
      "id": "foundation",
      "parentId": "root",
      "title": "建立工程骨架",
      "children": [],
      "objectives": ["建立可构建的 React/Vite 工程骨架"],
      "expectedOutputs": ["package.json", "src/main.tsx"],
      "acceptanceCriteria": ["npm run build 成功"],
      "unresolvedQuestions": [],
      "unresolvedDecisions": [],
      "dependencies": [],
      "requiredEvidence": [{"key": "build", "description": "构建成功 Trace"}],
      "executionPhase": "skeleton",
      "stopDecompositionReason": "该节点具有单一可验证工程输出"
    },
    {
      "id": "canvas",
      "parentId": "root",
      "title": "实现画布功能",
      "children": ["grid"]
    },
    {
      "id": "grid",
      "parentId": "canvas",
      "title": "实现网格绘制",
      "children": [],
      "objectives": ["支持点击和拖动放置拼豆"],
      "expectedOutputs": ["画布组件及交互测试"],
      "acceptanceCriteria": ["桌面鼠标与移动端触控测试通过"],
      "unresolvedQuestions": [],
      "unresolvedDecisions": [],
      "dependencies": ["foundation"],
      "requiredEvidence": [{"key": "interaction-test", "description": "交互测试成功 Trace"}],
      "executionPhase": "implementation",
      "stopDecompositionReason": "该节点聚焦一种内聚交互能力"
    }
  ],
  "relations": [
    {
      "fromNodeId": "grid",
      "toNodeId": "foundation",
      "kind": "depends_on",
      "dependencyKind": "execution_order"
    }
  ],
  "artifacts": [],
  "skeletonCriteria": []
}
```
````

Manifest 使用现有 Task Tree Document 领域结构，不引入第二套任务模型。人类可读计划可以自由组织；只有 fenced block 采用稳定 JSON，以避免对自然语言 Markdown 做脆弱的语义猜测。

Skill 必须指导 Agent 让人类可读树和 Manifest 语义一致。Runtime 只信任通过确定性 Validator 的 Manifest；不在 Hook 内调用 LLM 修复或补全 JSON。

Manifest 至少包含：

- 根目标和 `planningVersion`；
- Task Node 父子关系；
- 每个叶子的 objective、expected outputs、acceptance criteria、dependencies、completion evidence、execution phase 和 stop-decomposition reason；
- Skeleton Node 与各顶层分支的 Skeleton Acceptance Criteria；
- 计划态 Artifact、跨分支 Contract 和 Task Relation Edge；
- 未决问题、未决决策和高风险 Effect。

## 6. Native Plan 持久化

新增不可变 `native_plan_snapshots` 记录，至少保存：

- `id`；
- `project_id`；
- `session_id`；
- `plan_file_path`；
- `plan_hash`；
- `plan_markdown`；
- `manifest_json`；
- `parse_status`；
- `source_trace_event_id`；
- `created_at`。

新增不可变 `native_plan_tree_links`，用于保存 Snapshot 后续形成的结构化计划关联：

- `id`；
- `snapshot_id`；
- `tree_id`；
- `tree_revision_id`；
- `source_trace_event_id`；
- `created_at`。

新增不可变 `native_plan_approval_events`，至少保存：

- `id`；
- `snapshot_id`；
- `approved`；
- `execution_policy`，取值为 `task_tree`、`direct_execution` 或 `sync_required`；
- `approval_trace_event_id`；
- `created_at`。

同一 Project、Session 和 plan hash 的重复 Hook 必须幂等。Snapshot 内容不可更新；计划变化创建新 Snapshot。Tree Link 和 Approval Event 都不修改 Snapshot，只追加关联或批准事实。一个 Snapshot 至多关联一个 Task Tree revision；需要修正 Manifest 时必须创建新的 Snapshot，再通过显式同步为新 Snapshot 产生 Tree Link，原失败快照继续保留。

原生 Plan 文件位于 Agent 私有目录时，不作为 Project 文件 Artifact；Native Plan Snapshot 本身作为 planning record，并通过 `source_trace_event_id`、Native Plan Tree Link 和 `tree_revision_id` 与 Trace、Task Tree 相连。计划中声明的工程文件、接口和命令仍进入 Artifact Graph。

## 7. 失败恢复与显式同步

提供 `harness_sync_native_plan` Runtime Tool 作为恢复入口，而不是默认主流程。它接收 snapshot ID 和修正后的 Task Tree Document，执行同一套确定性校验与 revision 写入。

典型恢复场景：

- 第三方模型没有生成 Manifest；
- fenced block JSON 损坏；
- Manifest 未通过 Leaf Task Contract；
- Task affiliation 尚未解决；
- plan hash 与待批准 snapshot 不一致；
- 用户批准后，树写入因存储错误失败。

恢复工具不得重新生成计划，不调用外部模型，不静默选择新建或归并。Agent 依据原生 Plan 生成修正结构，用户已有批准只对内容 hash 一致的计划有效。

## 8. 按 Task Node 执行

### 8.1 执行游标

复用并强化现有 Runtime State：

```text
selected_tree_id
selected_node_id
active_branch_node_id
workflow_stage
workflow_revision
```

用户批准后，调度器按当前 Task Tree revision 计算第一个可执行 Skeleton Node。Agent 在节点内部继续自由推理、读写文件和运行命令；Harness 不规定具体编码步骤。

### 8.2 节点循环

```text
查询当前可执行节点
  ↓
start execution attempt
  ↓
Agent 使用原生 Coding 能力完成节点
  ↓
Hooks 将工具调用和 Artifact 变化绑定到 active node
  ↓
提交节点所需 completion evidence
  ↓
Evaluation 判定 succeeded / failed / blocked
  ↓
Runtime 选择下一节点或推进阶段
```

节点成功不得由 Agent 仅凭自然语言声明。现有 Attempt、Evidence、Evaluation、Verification Freshness、Drift 和 Gate 机制继续作为事实依据。

### 8.3 调度顺序

调度必须保持既定策略：

1. 在所有已确认范围内广度完成 Skeleton Node；
2. Skeleton Gate 通过后，按顶层分支顺序选择一个分支；
3. 在当前分支内深度执行 implementation leaf；
4. 完成分支 verification；
5. 进入下一分支；
6. 全部分支完成后执行 root verification；
7. 最终门禁通过后生成不可变 Final Report。

### 8.4 必要的最小主动边界

Harness 只在以下执行边界主动阻止不合法迁移：

- 原生复杂计划已经批准，但尚无有效 Task Tree revision 时开始修改项目；
- 已进入 Task Tree 执行阶段，但没有 active Task Node 时修改项目；
- Skeleton Gate 未通过时跳入功能分支；
- 当前节点缺少必需证据却尝试完成；
- mutation 跨越未确认分支、破坏 Contract 或形成 blocking Drift；
- 使用旧 plan hash、旧 tree revision 或旧 workflow revision 推进状态。

这些门禁只约束生命周期边界，不限制 Agent 在合法节点内的规划、编码和工具选择。普通直接执行路径不使用这些门禁。

“原生复杂计划”在实现中不依赖 Hook 对自然语言做意图分类：进入 Plan Mode 后默认是 `structured_candidate`；只有用户留下可追踪的 `direct_execution` 选择时才豁免。因此 Skill 漏选不会再次导致已批准计划静默绕过 Task Tree，而用户仍可明确退出结构化工作流。

## 9. Hook Directive 调整

Hook 输出需从当前仅支持 SessionStart context 扩展为事件相关 context：

```ts
type HookDirective =
  | { kind: "deny"; eventName: "PreToolUse"; reason: string }
  | { kind: "context"; eventName: HookEventName; context: string };
```

`hook-entry` 必须使用 directive 自带的 event name，而不是把全部 context 硬编码成 `SessionStart`。

关键事件行为：

| 事件 | 行为 |
| --- | --- |
| SessionStart | 注入一次最小 passive-first 定位，不携带状态 |
| Pre/Post EnterPlanMode | 允许、记录；Post 注入一次 Task Tree Skill 引导 |
| Pre ExitPlanMode | 捕获 plan/path、创建 snapshot、解析并保存 draft revision |
| Post ExitPlanMode | 绑定批准事实、确认 revision、进入 skeleton_pass |
| Pre mutation | 仅校验已进入结构化工作流后的 active node 与阶段边界 |
| Post mutation | 记录 Trace、Artifact、Drift、Verification Invalidation |
| Stop | 若批准计划尚未同步，仅给出非错误恢复提示，不伪造完成 |

## 10. Skill 调整

### task-tree-planning

- 明确原生 Plan Mode 是首选交互载体，不得要求退出或替代；
- 在进入 Plan Mode 后生成和维护人类可读计划与 `harness-task-tree` Manifest；
- 使用原生 `AskUserQuestion` 做问题驱动的局部精炼；
- 完成 Task affiliation，但不重复实现批准 UI；
- 在 `ExitPlanMode` 前确保 Manifest 通过自检；
- 解析失败时使用 `harness_sync_native_plan` 恢复。

### branch-execution

- 原生计划批准后查询 active node；
- 为 active node 启动 Attempt；
- 只在节点范围内执行，跨范围变化走 Drift；
- 节点完成后提交证据并查询下一节点；
- 不自行跳过 Skeleton Gate、Branch Gate 或 Root Gate。

## 11. 一致性和并发

- plan hash、tree revision、workflow revision 必须同时参与状态迁移校验；
- 同一 Project 任意时刻最多一个 active Workflow；
- 两个 Session 同时修改同一计划时，较旧 snapshot 的批准返回 revision conflict；
- 原生计划被批准后又发生 scope change，必须生成新 snapshot 和新 Task Tree revision；
- 用户拒绝计划不会删除 snapshot、Trace 或已有 draft revision；
- Project Clone 可以复制已确认 Task Tree 和 planning provenance，但不能复制原 Session 的批准事实为目标 Project 的新批准。

## 12. 测试与验收

### 自动化测试

1. `EnterPlanMode` 在无树、有 draft tree 和有 active workflow 时均不会因 Harness 被拒绝；
2. `PostToolUse(EnterPlanMode)` 记录 Trace 并返回事件相关 Skill 引导；
3. `PreToolUse(ExitPlanMode)` 从真实 Claude payload 读取 `plan` 和 `planFilePath`；
4. 合法 Manifest 创建或更新 draft Task Tree revision；
5. 缺失、损坏或不合法 Manifest 不破坏原生 Plan Mode，并产生可恢复失败事实；
6. `PostToolUse(ExitPlanMode)` 只批准 plan hash 和 revision 精确匹配的树；
7. 重复 Hook 保持 snapshot、revision 和 approval 幂等；
8. 原生批准后不产生第二个内容重复的用户确认；
9. 批准计划后选择第一个 Skeleton Node，并将后续工具事件绑定到该节点；
10. 无 active node、越阶段、跨未确认分支和 stale revision 的 mutation 被拒绝；
11. 节点内合法 mutation 正常放行；
12. 小型直接执行请求不创建 snapshot/tree，mutation 正常记录和放行；
13. 完整流程遵循 Skeleton breadth → Branch depth → Root verification；
14. 插件安装包、缓存副本和全局安装后的真实 Claude 会话行为一致。

### 黑盒验收

在空目录中直接启动全局安装的 Claude Code，并输入一个从零开发、跨多个功能分支、要求先讨论后实现的项目请求：

- Claude 自主进入原生 Plan Mode；
- Harness 不阻止原生 Plan Mode；
- Claude 使用原生提问界面完成需求精炼；
- 原生 Plan 显示完整 Task Tree；
- 用户只批准一次原生 Plan；
- Runtime 中出现对应 Task Tree revision 和 approved native plan link；
- 首次代码修改属于第一个 Skeleton Node；
- Skeleton Gate 通过前不进入功能实现分支；
- 分支实现期间 Trace、Artifact、Attempt 和 Evaluation 均关联正确节点；
- 一个小型后续修改可以明确选择直接执行且不新建 Task Tree。

## 13. 实施边界

第一阶段只实现 Claude Code Binding，因为它提供明确的 Plan Mode 与 `ExitPlanMode` Hook 契约。核心领域使用中立的 Native Plan Snapshot / Approval Event / Task Tree Revision 语义，未来 Codex 或其他 Agent Binding 可以从其原生计划事件映射到同一领域模型，而无需修改 Task Tree、Workflow、Trace 或 Evaluation 的核心规则。
