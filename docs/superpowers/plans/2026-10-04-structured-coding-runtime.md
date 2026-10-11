# Structured Coding Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add advisory Jev request routing, persisted Runtime Profiles, first-class Task Tree authoring tools, native Claude Plan approval binding, and deterministic node scheduling without replacing Claude Code's native reasoning or Plan Mode.

**Architecture:** `UserPromptSubmit` obtains a bounded Jev route suggestion and resolves one of three Runtime Profiles. In `structured_coding`, the same Claude agent authors immutable Task Tree revisions through typed MCP tools, renders a Runtime-generated canonical block into its native Plan, and binds successful `ExitPlanMode` completion to the exact revision. Existing Workflow, Attempt, Trace, Artifact, Skeleton Gate, Branch Phase, Evaluation, and Final Report services remain the execution backbone.

**Tech Stack:** TypeScript 7, Node.js 22.13+, `node:sqlite`, Zod 4, MCP SDK 1.30, Vitest 5, Claude Code plugin Skills/Hooks/MCP, TypeSafe Jev SystemOne

**Spec:** `docs/superpowers/specs/2026-10-01-native-plan-task-tree-bridge-design.md`

## Global Constraints

- Preserve Claude Code native reasoning, `AskUserQuestion`, Plan Mode, permission flow, and tool execution.
- Task Tree revisions in SQLite are the planning source of truth; native Plan Markdown is a presentation and approval surface.
- Jev is advisory and fail-open. Provider failure must never make Claude Code unusable.
- Jev receives no source code, complete conversation history, tool output, environment variables, credentials, or hidden reasoning.
- `confidence >= 0.80` is accepted, `0.50 <= confidence < 0.80` is advisory, and lower confidence falls back to native Agent judgment.
- Hooks never generate Task Trees, repair model output, or reconstruct a Task Tree from arbitrary Markdown.
- A native Plan contains only a Runtime-rendered canonical Task Tree block and opaque approval reference, never a complete JSON manifest.
- `conversation` and `direct_coding` must not be blocked by Task Tree lifecycle checks.
- `structured_coding` blocks only the first illegal mutation boundary and returns a concrete recovery action; Runtime tools and read-only tools remain usable.
- Task Tree writes use optimistic revision checks and idempotency keys.
- MCP tools never trust a caller-supplied raw Session ID. They resolve Session provenance from the confirmed affiliation decision or a same-Project `UserPromptSubmit` Trace reference.
- Execution order is Skeleton breadth first, then one active branch at a time with depth-first eligible node selection, then root verification.
- Task Tree state is Project-scoped; Session identifies provenance and approval binding, not the Task boundary.
- Preserve all existing uncommitted user changes. Each implementation commit stages only the files named by its task.
- Do not implement Codex or another Agent Binding in this plan.

## Review Focus

- Jev timeout, 401, 429, 529, malformed JSON, and missing API key must fall back without creating a Project for a pure conversation.
- A modified, expired, cross-Project, cross-Session, reused, or stale-revision approval reference must never activate a Workflow.
- An explicit `direct_execution` affiliation answer must immediately bypass structured mutation gating without deleting Task Tree history.
- Duplicate Hook deliveries and duplicate MCP commands must return the original fact instead of creating duplicate revisions, approvals, or Workflow transitions.
- Two sessions editing one Task Tree must receive a revision conflict instead of silently overwriting each other.

---

## File Structure

New focused modules:

- `src/domain/request-routing.ts`: routing/profile types, configuration, thresholds, and pure profile resolution.
- `src/bindings/typesafe/jev-request-router.ts`: bounded Jev SystemOne request and response validation.
- `src/application/request-routing-service.ts`: route orchestration and immutable decision persistence.
- `src/application/runtime-profile-service.ts`: current Profile projection and append-only transitions.
- `src/domain/task-tree-authoring.ts`: typed draft commands, patch operations, and approval preparation views.
- `src/application/task-tree-draft-service.ts`: affiliation-bound, idempotent draft creation and atomic patching.
- `src/application/task-tree-validation-service.ts`: exact-revision readiness validation.
- `src/domain/native-plan.ts`: deterministic canonical block rendering, extraction, and hashing.
- `src/application/task-tree-approval-service.ts`: approval reference lifecycle and canonical block preparation.
- `src/application/native-plan-binding-service.ts`: native Plan snapshot verification and approval/rejection binding.
- `src/application/execution-scheduler-service.ts`: deterministic next-node projection over existing Workflow facts.

Existing integration points:

- `src/application/runtime.ts`: construct and expose the new services.
- `src/application/hook-ingestion-service.ts`: route prompts, observe Plan lifecycle, apply recovery gates, and bind tool facts.
- `src/application/workflow-service.ts`: share confirmation activation logic with native approval evidence.
- `src/application/task-affiliation-service.ts`: update the Profile when the user chooses direct execution, new tree, merge, or pause.
- `src/bindings/claude/hook-mapper.ts`: retain only the documented Hook payload fields needed by the binding.
- `src/bindings/claude/mcp-server.ts`: register the four Task Tree authoring tools and scheduler query.
- `plugin/skills/task-tree-planning/SKILL.md`: teach the Agent the structured authoring lifecycle.
- `plugin/skills/branch-execution/SKILL.md`: teach the Agent to query and execute the scheduled node.

### Task 1: Request Routing Domain and Persistent Profile Schema

**Files:**
- Create: `src/domain/request-routing.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/domain/errors.ts`
- Test: `tests/unit/request-routing.test.ts`
- Test: `tests/integration/database.test.ts`

**Interfaces:**
- Produces: `RequestRouteClassification`, `TaskTreeRelationSuggestion`, `RuntimeProfile`, `RouteDisposition`, `JevRequestRoutingConfiguration`, `RequestRouteResult`, `RuntimeProfileResolutionInput`, `resolveJevRequestRoutingConfiguration(environment)`, and `resolveRuntimeProfile(input)`.
- Produces migration version 21 tables: `request_route_decisions`, `runtime_profile_states`, and `runtime_profile_transitions`.
- Consumes: existing `HarnessError`, Project IDs, Session IDs, and `canonicalJson` conventions.

- [ ] **Step 1: Write the failing routing-domain tests**

Add tests named:

- `defaults request routing to disabled without an explicit flag`
- `accepts an enabled routing configuration with a TypeSafe key`
- `rejects routing thresholds outside zero to one`
- `resolves accepted high-confidence routes to their matching profiles`
- `keeps medium-confidence routes advisory and low-confidence routes native fallback`
- `lets an explicit direct execution decision override a structured suggestion`
- `keeps an active approved Workflow in structured coding unless the user records a new affiliation decision`

Assert these exact mappings:

```ts
direct_response    -> conversation
direct_execution   -> direct_coding
task_tree_workflow -> structured_coding
```

Use routing defaults `acceptedConfidence: 0.80`, `advisoryConfidence: 0.50`, `timeoutMs: 2_000`, model `jev-1.13.0`, endpoint `https://api.typesafe.ai/v1/systemone`.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npm test -- --run tests/unit/request-routing.test.ts`

Expected: FAIL because `src/domain/request-routing.ts` does not exist.

- [ ] **Step 3: Implement the routing domain**

Define:

```ts
export type RequestRouteClassification = "direct_response" | "direct_execution" | "task_tree_workflow";
export type TaskTreeRelationSuggestion = "continue_existing_tree" | "change_existing_tree" | "create_new_tree" | "unclear";
export type RuntimeProfile = "conversation" | "direct_coding" | "structured_coding";
export type RouteDisposition = "accepted" | "advisory" | "native_fallback" | "explicit_override";

export function resolveJevRequestRoutingConfiguration(environment: NodeJS.ProcessEnv): JevRequestRoutingConfiguration;
export function resolveRuntimeProfile(input: RuntimeProfileResolutionInput): {
  profile: RuntimeProfile;
  disposition: RouteDisposition;
  reasonCode: string;
};
```

Use `HARNESS_JEV_ROUTING_ENABLED`, `HARNESS_JEV_ROUTING_TIMEOUT_MS`, `HARNESS_JEV_ROUTING_ACCEPTED_CONFIDENCE`, and `HARNESS_JEV_ROUTING_ADVISORY_CONFIDENCE`. Reuse `TYPESAFE_API_KEY` but do not couple this flag to `HARNESS_JEV_ENABLED`.

- [ ] **Step 4: Add migration version 21 and its schema assertions**

The tables must enforce:

- immutable route decisions keyed by `id`, with Project/Session, prompt fingerprint, classification, relation suggestion, confidence, probabilities/reason codes JSON, disposition, provider/model metadata, bounded fallback code, and timestamp;
- one current `runtime_profile_states` row per `(project_id, session_id)`;
- append-only `runtime_profile_transitions` with prior/next profile, source route/affiliation reference, reason code, and timestamp;
- no credential or raw provider-response columns.

Add update/delete rejection triggers for route decisions and profile transitions. Extend `tests/integration/database.test.ts` to assert migration 21, table columns, foreign keys, and immutability.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/unit/request-routing.test.ts tests/integration/database.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/domain/request-routing.ts src/domain/errors.ts src/storage/migrations.ts tests/unit/request-routing.test.ts tests/integration/database.test.ts
git commit -m "feat: add request routing domain"
```

### Task 2: Bounded Jev Request Router and Decision Service

**Files:**
- Create: `src/bindings/typesafe/jev-request-router.ts`
- Create: `src/application/request-routing-service.ts`
- Modify: `src/application/runtime.ts`
- Test: `tests/unit/jev-request-router.test.ts`
- Test: `tests/integration/request-routing-service.test.ts`

**Interfaces:**
- Consumes: `JevRequestRoutingConfiguration` and route types from Task 1; `RuntimeDatabase`.
- Produces: `RequestRouteSnapshot`, `JevRequestRouteResponse`, `JevRequestRouter.route(snapshot)`, `RequestRoutingService.route(input)`, and `RequestRouteDecisionView`.
- `RequestRoutingService.route` accepts `projectId: string | null`, the Hook-supplied `sessionId`, `prompt`, a bounded active-tree summary, and an optional prompt Trace ID.

- [ ] **Step 1: Write failing provider tests**

Cover:

- one SystemOne request with `request_kind` Choice and optional `tree_relation` Choice;
- request state contains only prompt, `hasActiveTree`, active tree title/current node title, and `hasActiveWorkflow`;
- successful response parsing returns classification, relation, probabilities, confidence, model, token usage, and latency;
- 401/429/529/422/other HTTP errors map to existing provider error codes;
- timeout, network error, malformed JSON, missing answer, unknown choice, invalid probability, and invalid confidence throw bounded `HarnessError`s;
- serialized request never contains source code fixture text, environment variables, API key, tool output, or conversation history.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `npm test -- --run tests/unit/jev-request-router.test.ts`

Expected: FAIL because `JevRequestRouter` does not exist.

- [ ] **Step 3: Implement `JevRequestRouter`**

Expose:

```ts
export class JevRequestRouter {
  constructor(config: JevRequestRoutingConfiguration, fetcher?: typeof fetch);
  route(snapshot: RequestRouteSnapshot): Promise<JevRequestRouteResponse>;
}
```

Use `AbortSignal.timeout(config.timeoutMs)`. Never retain the API key or response body in error details.

- [ ] **Step 4: Write failing decision-service tests**

Assert:

- disabled or misconfigured routing returns `native_fallback` without calling the provider;
- high confidence persists `accepted`, medium persists `advisory`, and low persists `native_fallback` when `projectId` exists;
- a provider failure persists only its bounded error code when `projectId` exists;
- `projectId: null` returns a transient decision and writes no Project or route row;
- repeating the same `(project, session, prompt fingerprint, routing policy version)` returns the same decision;
- a different prompt or policy version produces a new immutable decision.

- [ ] **Step 5: Implement `RequestRoutingService` and wire `openRuntime`**

Expose:

```ts
export class RequestRoutingService {
  route(input: {
    projectId: string | null;
    sessionId: string;
    prompt: string;
    promptTraceEventId?: string;
    activeTree?: { treeId: string; title: string; currentNodeTitle: string | null };
    hasActiveWorkflow: boolean;
  }): Promise<RequestRouteDecisionView>;
}
```

Fingerprint the bounded snapshot with SHA-256 and persist canonical JSON only for allowed fields.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/unit/jev-request-router.test.ts tests/integration/request-routing-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/bindings/typesafe/jev-request-router.ts src/application/request-routing-service.ts src/application/runtime.ts tests/unit/jev-request-router.test.ts tests/integration/request-routing-service.test.ts
git commit -m "feat: add advisory Jev request routing"
```

### Task 3: Runtime Profile Resolution at UserPromptSubmit

**Files:**
- Create: `src/application/runtime-profile-service.ts`
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/application/task-affiliation-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/bindings/claude/hook-entry.ts`
- Test: `tests/integration/runtime-profile-service.test.ts`
- Test: `tests/integration/hook-ingestion.test.ts`

**Interfaces:**
- Consumes: `RequestRoutingService.route`, `resolveRuntimeProfile`, Project identity inspection/persistence, and Task affiliation decisions.
- Produces: `RuntimeProfileService.resolveForPrompt`, `RuntimeProfileService.applyAffiliationChoice`, `RuntimeProfileService.current`, and event-specific Hook context.

- [ ] **Step 1: Write failing Runtime Profile tests**

Assert:

- `direct_response` in a new directory returns `conversation` and creates neither Project marker nor database Project;
- accepted `direct_execution` persists the Project and `direct_coding` transition;
- accepted `task_tree_workflow` persists `structured_coding` and returns minimal context containing the profile and next action, but no Task/Artifact dump;
- advisory and native fallback results do not pretend a structured lifecycle has been accepted;
- an active approved Workflow resolves to `structured_coding` after restart;
- `direct_execution` affiliation changes the same Session to `direct_coding`;
- new-tree/merge affiliation retains `structured_coding`; pause makes no mutation permission claim;
- repeated Hook delivery is idempotent.

- [ ] **Step 2: Run profile tests and verify RED**

Run: `npm test -- --run tests/integration/runtime-profile-service.test.ts`

Expected: FAIL because `RuntimeProfileService` does not exist.

- [ ] **Step 3: Implement `RuntimeProfileService`**

Expose:

```ts
export class RuntimeProfileService {
  resolveForPrompt(input: {
    cwd: string;
    sessionId: string;
    prompt: string;
    promptTraceEventId?: string;
  }): Promise<RuntimeProfileDecisionView>;
  applyAffiliationChoice(input: {
    projectId: string;
    sessionId: string;
    affiliationDecisionId: string;
    choice: TaskAffiliationChoice;
  }): RuntimeProfileDecisionView;
  current(projectId: string, sessionId: string): RuntimeProfileDecisionView | null;
}
```

Use inspect-before-persist: only accepted non-conversation routes create/persist a new Project. Derive `structured_coding` from an active Workflow when no current projection exists.

- [ ] **Step 4: Integrate `UserPromptSubmit`**

Change Hook ingestion so a prompt is recorded before routing when a Project already exists, then resolve its Profile. For a new directory, route transiently first and persist identity only for accepted `direct_coding` or `structured_coding`.

Return event-related `additionalContext` only for `structured_coding`:

```text
Harness runtime profile: structured_coding.
Establish and obtain native approval for a first-class Task Tree revision before project mutation.
```

Do not instruct Claude to invoke a Skill by name; Claude discovers the Skill from its registered description.

- [ ] **Step 5: Bind affiliation resolution to Profile transitions**

After validating the user-answer Trace, use its `session_id` in the same database transaction to apply the profile transition. Do not erase prior route decisions or trees.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/integration/runtime-profile-service.test.ts tests/integration/hook-ingestion.test.ts tests/integration/task-affiliation-service.test.ts`

Expected: PASS, including provider failure and direct-execution Review Focus cases.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/application/runtime-profile-service.ts src/application/hook-ingestion-service.ts src/application/task-affiliation-service.ts src/application/runtime.ts src/bindings/claude/hook-entry.ts tests/integration/runtime-profile-service.test.ts tests/integration/hook-ingestion.test.ts tests/integration/task-affiliation-service.test.ts
git commit -m "feat: resolve runtime profiles from prompt routes"
```

### Task 4: First-Class Task Tree Draft and Patch Commands

**Files:**
- Create: `src/domain/task-tree-authoring.ts`
- Create: `src/application/task-tree-draft-service.ts`
- Create: `src/application/task-tree-validation-service.ts`
- Modify: `src/application/task-tree-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/storage/migrations.ts`
- Test: `tests/unit/task-tree-authoring.test.ts`
- Test: `tests/integration/task-tree-draft-service.test.ts`
- Test: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: resolved `task_affiliation_decisions`, `TaskTreeService`, `TaskTreeDocument`, `RefinementDecisionInput`, and current readiness analysis.
- Produces: `TaskTreePatchOperation`, `TaskTreeDraftService.createDraft`, `TaskTreeDraftService.patch`, and `TaskTreeValidationService.validate`.
- Produces migration version 22 table `task_tree_authoring_commands` for idempotency and command provenance.

- [ ] **Step 1: Write failing authoring-domain tests**

Define the only v1 patch operation as:

```ts
export type TaskTreePatchOperation = {
  op: "replace_document";
  document: TaskTreeDocument;
  sourceUserMessageTraceEventId: string;
  decision: RefinementDecisionInput;
  previewId?: string;
};
```

Test canonical payload hashing and rejection of an empty operation list, multiple `replace_document` operations, and an operation without a user-visible Decision Record.

- [ ] **Step 2: Write failing draft-service tests**

Cover:

- `createDraft` requires a resolved `new_tree` or `merged` affiliation decision from the same Project;
- new-tree affiliation may omit `expectedTreeRevisionId` only while its auto-created tree is still the one-node blank root;
- merged affiliation requires the exact current revision;
- a complete `planningVersion: 1` document creates one new immutable revision and returns it;
- a structurally valid incomplete draft is accepted and later validation reports blockers;
- duplicate idempotency key with the same payload returns the original revision;
- duplicate key with a different payload returns `revision_conflict`;
- `patch` applies one evidence-linked local refinement atomically;
- two sessions patching the same base revision cause the second call to fail without partial rows;
- cross-branch changes still require the existing preview contract.

- [ ] **Step 3: Implement migration version 22**

`task_tree_authoring_commands` contains Project, Tree, affiliation decision, command kind (`create_draft` or `patch`), idempotency key, input hash, base revision, result revision, source Session/Trace, and timestamp. Enforce `UNIQUE(project_id, idempotency_key)` and append-only triggers.

- [ ] **Step 4: Implement `TaskTreeDraftService`**

Expose:

```ts
export class TaskTreeDraftService {
  createDraft(input: {
    projectId: string;
    sessionId: string;
    affiliationDecisionId: string;
    expectedTreeRevisionId?: string;
    document: TaskTreeDocument;
    idempotencyKey: string;
  }): TaskTreeRevisionView;

  patch(input: {
    projectId: string;
    sessionId: string;
    treeId: string;
    expectedTreeRevisionId: string;
    operations: TaskTreePatchOperation[];
    idempotencyKey: string;
  }): TaskTreeRevisionView;
}
```

Delegate document persistence and Artifact projection to `TaskTreeService`; do not duplicate its revision writer.

- [ ] **Step 5: Implement exact-revision validation**

Expose:

```ts
export class TaskTreeValidationService {
  validate(input: {
    projectId: string;
    treeId: string;
    treeRevisionId: string;
  }): PlanReadinessView;
}
```

Reject a non-current revision with `revision_conflict`; then reuse the existing readiness analyzer and persisted result.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/unit/task-tree-authoring.test.ts tests/integration/task-tree-draft-service.test.ts tests/integration/task-tree-service.test.ts tests/integration/database.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/domain/task-tree-authoring.ts src/application/task-tree-draft-service.ts src/application/task-tree-validation-service.ts src/application/task-tree-service.ts src/application/runtime.ts src/storage/migrations.ts tests/unit/task-tree-authoring.test.ts tests/integration/task-tree-draft-service.test.ts tests/integration/task-tree-service.test.ts tests/integration/database.test.ts
git commit -m "feat: add first-class task tree authoring"
```

### Task 5: Canonical Task Tree Approval Preparation

**Files:**
- Create: `src/domain/native-plan.ts`
- Create: `src/application/task-tree-approval-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/storage/migrations.ts`
- Test: `tests/unit/native-plan.test.ts`
- Test: `tests/integration/task-tree-approval-service.test.ts`
- Test: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: current Task Tree revision, exact ready `PlanReadinessView`, active Workflow revision, and existing `WorkflowService.createConfirmationPrompt` storage semantics.
- Produces: `renderCanonicalTaskTreeBlock`, `extractCanonicalTaskTreeBlock`, `hashNativePlanBlock`, `TaskTreeApprovalService.prepare`, and `TaskTreeApprovalPreparation`.
- Produces migration version 23 tables: `task_tree_approval_references`, `native_plan_snapshots`, `native_plan_task_tree_links`, and `native_plan_approval_events`.

- [ ] **Step 1: Write failing canonical rendering tests**

Assert:

- rendering the same revision twice is byte-identical;
- node, Artifact, relation, acceptance, unresolved-decision, and execution-phase summaries appear in deterministic document order;
- the block has exactly one start marker with `approval_ref` and one end marker;
- extraction rejects missing, duplicate, nested, or malformed blocks;
- CRLF and LF plans normalize before hashing, while any semantic or visible block change changes the hash;
- no JSON manifest appears in the rendered block.

- [ ] **Step 2: Implement the native Plan domain helpers**

Expose:

```ts
export function renderCanonicalTaskTreeBlock(input: {
  approvalRef: string;
  tree: TaskTreeRevisionView;
  readiness: PlanReadinessView;
}): string;
export function extractCanonicalTaskTreeBlock(markdown: string): { approvalRef: string; block: string };
export function hashNativePlanBlock(block: string): string;
```

- [ ] **Step 3: Write failing approval preparation tests**

Cover:

- exact ready result and current revision produce an opaque reference, canonical block, block hash, internal pending confirmation ID, and expiry exactly 24 hours after creation;
- stale/not-ready/wrong-tree readiness is rejected;
- cross-Project or archived/completed tree is rejected;
- preparing a new reference expires the previous unconsumed reference for the same Project/Session/Tree revision;
- a reference is single-use and stores no raw prompt or API key;
- restart recovers the pending reference.

- [ ] **Step 4: Add migration version 23**

Add all four tables from the spec. Include `confirmation_prompt_id`, `tool_use_id`, `plan_hash`, status checks, Session/Project/Tree/revision foreign keys, idempotency constraints, and append-only triggers for snapshots, links, and approval events. Approval references may only transition from `prepared` to `consumed`, `rejected`, `expired`, or `superseded`.

- [ ] **Step 5: Implement `TaskTreeApprovalService.prepare`**

Expose:

```ts
export const APPROVAL_REFERENCE_TTL_MS = 86_400_000;

export class TaskTreeApprovalService {
  prepare(input: {
    projectId: string;
    sessionId: string;
    treeId: string;
    treeRevisionId: string;
    readinessResultId: string;
  }): TaskTreeApprovalPreparation;
}
```

Create the existing internal confirmation projection transactionally, but return only the canonical block/reference to the Agent; do not request a second user confirmation.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/unit/native-plan.test.ts tests/integration/task-tree-approval-service.test.ts tests/integration/database.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/domain/native-plan.ts src/application/task-tree-approval-service.ts src/application/runtime.ts src/storage/migrations.ts tests/unit/native-plan.test.ts tests/integration/task-tree-approval-service.test.ts tests/integration/database.test.ts
git commit -m "feat: prepare canonical task tree approvals"
```

### Task 6: MCP Authoring Surface and Planning Skill

**Files:**
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `plugin/skills/task-tree-planning/SKILL.md`
- Modify: `tests/plugin/mcp.test.ts`
- Modify: `tests/plugin/plugin-contract.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5 services.
- Produces MCP tools `harness_create_task_tree_draft`, `harness_patch_task_tree`, `harness_validate_task_tree`, and `harness_prepare_task_tree_approval`.
- Keeps old low-level tree tools temporarily for compatibility, but the planning Skill no longer uses them as its primary workflow.

- [ ] **Step 1: Extend the MCP contract test and verify RED**

Assert the exact four new names and schemas. Raw Session IDs are intentionally absent from the MCP surface:

```ts
harness_create_task_tree_draft({ cwd?, affiliationDecisionId, expectedTreeRevisionId?, document, idempotencyKey })
harness_patch_task_tree({ cwd?, treeId, expectedTreeRevisionId, operations, idempotencyKey })
harness_validate_task_tree({ cwd?, treeId, treeRevisionId })
harness_prepare_task_tree_approval({ cwd?, treeId, treeRevisionId, readinessResultId, sourceUserMessageTraceEventId })
```

Also assert `prepare` returns `approvalRef`, `canonicalBlock`, `canonicalBlockHash`, `treeRevisionId`, and `expiresAt`.

- [ ] **Step 2: Register the MCP tools**

Use the existing guarded error envelope and Zod schemas. Resolve Project identity exactly once per tool call. For draft creation, derive Session provenance from the resolved affiliation decision; for patching, require its single operation's same-Project `sourceUserMessageTraceEventId`; for approval preparation, resolve Session from `sourceUserMessageTraceEventId`. Reject cross-Project, non-`UserPromptSubmit`, or pre-affiliation Trace references. Do not expose provider credentials, internal confirmation IDs, raw Session IDs, or raw database rows.

- [ ] **Step 3: Rewrite `task-tree-planning` behavior**

The Skill must say:

1. use native discussion and `AskUserQuestion` for requirement refinement;
2. obtain explicit affiliation before draft creation;
3. call `harness_create_task_tree_draft` once with the full goal-level document;
4. call `harness_patch_task_tree` after user-visible local decisions;
5. call `harness_validate_task_tree` until ready;
6. call `harness_prepare_task_tree_approval` and insert its returned canonical block unchanged into the native Plan;
7. use native Plan approval exactly once;
8. never write a JSON manifest or ask a second Harness confirmation.

Keep the Skill description broad enough for Claude's native skill discovery. Do not add a fixed SessionStart prompt naming the Skill.

- [ ] **Step 4: Run plugin tests and verify GREEN**

Run: `npm test -- --run tests/plugin/mcp.test.ts tests/plugin/plugin-contract.test.ts`

Expected: PASS with all four tools callable through the in-memory MCP transport.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/bindings/claude/mcp-server.ts plugin/skills/task-tree-planning/SKILL.md tests/plugin/mcp.test.ts tests/plugin/plugin-contract.test.ts
git commit -m "feat: expose task tree authoring tools"
```

### Task 7: Native Plan Lifecycle Binding

**Files:**
- Create: `src/application/native-plan-binding-service.ts`
- Modify: `src/application/workflow-service.ts`
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `tests/integration/workflow-service.test.ts`
- Modify: `tests/integration/hook-ingestion.test.ts`
- Test: `tests/integration/native-plan-binding-service.test.ts`

**Interfaces:**
- Consumes: canonical block/reference from Task 5, Claude `PreToolUse`/`PostToolUse`/`PostToolUseFailure`, and existing Workflow confirmation logic.
- Produces: `NativePlanBindingService.preExit`, `NativePlanBindingService.postExit`, and `WorkflowService.confirmNativePlan`.
- Treats successful `PostToolUse(ExitPlanMode)` as native approval and `PostToolUseFailure(ExitPlanMode)` as rejection/failure; absence of either remains unbound.

- [ ] **Step 1: Write failing native binding tests**

Use Hook fixtures with `tool_name: "ExitPlanMode"`, one `tool_use_id`, and `tool_input.plan` containing the canonical block. Cover:

- PreToolUse persists the normalized plan snapshot and validates the exact reference/block hash;
- successful PostToolUse consumes the reference, appends one approval event and link, and confirms the exact revision;
- PostToolUseFailure records rejection/failure and does not activate the Workflow;
- changed block, expired reference, stale current revision, wrong Project, wrong Session, different tool-use ID, and second consumption are rejected;
- duplicate Pre/Post deliveries return the original facts;
- plan text outside the canonical block may change without changing the approved Task Tree block, but the full plan snapshot/hash remains recorded;
- restart can bind a prepared reference using persisted facts.

- [ ] **Step 2: Implement `NativePlanBindingService`**

Expose:

```ts
export class NativePlanBindingService {
  preExit(input: {
    projectId: string;
    sessionId: string;
    toolUseId: string;
    planMarkdown: string;
    planFilePath?: string;
    traceEventId: string;
  }): NativePlanPreExitView;

  postExit(input: {
    projectId: string;
    sessionId: string;
    toolUseId: string;
    traceEventId: string;
    outcome: "approved" | "rejected";
  }): NativePlanApprovalView;
}
```

Pre-exit performs only deterministic extraction/hash checks. It never parses Task Tree semantics from Markdown.

- [ ] **Step 3: Refactor Workflow confirmation activation**

Extract the shared scope activation transaction from `confirmScope`. Add:

```ts
confirmNativePlan(input: {
  projectId: string;
  confirmationId: string;
  nativeApprovalTraceEventId: string;
  workflowRevision: number;
}): WorkflowConfirmationView;
```

It accepts a successful `PostToolUse(ExitPlanMode)` Trace instead of requiring `UserPromptSubmit`, while preserving readiness, revision, scope, Artifact promotion, confirmation-state, branch-state, and Skeleton transition checks.

- [ ] **Step 4: Replace the old Plan Mode blocking test**

Change the current test that expects `native_plan_mode_bypasses_task_tree` so `EnterPlanMode` is always allowed and recorded. Add Pre/Post `ExitPlanMode` integration tests for approved, rejected, malformed, and stale cases.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/integration/native-plan-binding-service.test.ts tests/integration/workflow-service.test.ts tests/integration/hook-ingestion.test.ts`

Expected: PASS; no test expects `EnterPlanMode` to be denied.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/application/native-plan-binding-service.ts src/application/workflow-service.ts src/application/hook-ingestion-service.ts src/application/runtime.ts tests/integration/native-plan-binding-service.test.ts tests/integration/workflow-service.test.ts tests/integration/hook-ingestion.test.ts
git commit -m "feat: bind native plan approval to task trees"
```

### Task 8: Recoverable Mutation Gate and Deterministic Scheduler

**Files:**
- Create: `src/application/execution-scheduler-service.ts`
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `plugin/skills/branch-execution/SKILL.md`
- Test: `tests/integration/execution-scheduler-service.test.ts`
- Modify: `tests/integration/hook-ingestion.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

**Interfaces:**
- Consumes: current Runtime Profile, Workflow stage/revision, Branch State, Task Tree document order, node status/dependencies, and active Attempt.
- Produces: `ExecutionSchedulerService.next`, `ScheduledTaskNodeView`, MCP tool `harness_get_next_executable_node`, and narrower mutation directives.

- [ ] **Step 1: Write failing scheduler tests**

Assert:

- `skeleton_pass` chooses all eligible Skeleton nodes breadth-first by depth, then stable document order;
- `branch_implementation` chooses the deepest eligible implementation leaf within only the active branch, using stable depth-first document order;
- `branch_verification` chooses only verification nodes in the active branch;
- `root_verification` returns only the root after its direct children succeed;
- unresolved dependency, unconfirmed node, blocking Drift, wrong tree revision, and active sibling Attempt prevent scheduling;
- restart produces the same next-node result.

- [ ] **Step 2: Implement `ExecutionSchedulerService`**

Expose:

```ts
export class ExecutionSchedulerService {
  next(input: { projectId: string; treeId: string }): ScheduledTaskNodeView | null;
}
```

The service is a projection: it does not start Attempts or mark nodes successful. `NodeExecutionService.startAttempt` remains the state-changing boundary.

- [ ] **Step 3: Write failing mutation-gate tests**

Cover:

- `conversation` and `direct_coding` project mutations are recorded and allowed;
- `structured_coding` before approval denies only project mutation with recovery text naming `harness_prepare_task_tree_approval`/native Plan approval;
- Task Tree MCP tools, Runtime introspection, `AskUserQuestion`, `EnterPlanMode`, and read-only tools remain allowed;
- an approved executable Workflow without an active Attempt denies mutation with recovery text naming `harness_get_next_executable_node` and `harness_start_node_attempt`;
- mutation with an active Attempt is recorded against that Task Node;
- an explicit direct-execution affiliation immediately bypasses both structured gates;
- Hook/provider/storage failure falls back without globally terminating Claude Code.

- [ ] **Step 4: Narrow `HookIngestionService` gating**

Derive the current Profile first. Replace broad “active Task Tree means deny” logic with two exact boundaries:

1. structured Profile + no consumed native approval for the active revision;
2. approved structured Workflow + project mutation + no active executable Attempt.

Return a `deny` directive only at those boundaries. The reason must include a single recovery path and mention that the user can explicitly choose direct execution. Continue to redact and record all permitted Trace/Artifact facts.

- [ ] **Step 5: Register scheduler query and update execution Skill**

Add:

```ts
harness_get_next_executable_node({ cwd?, treeId }): ScheduledTaskNodeView | null
```

Update `branch-execution` to query the scheduled node, start its Attempt, execute with native tools, attach evidence, evaluate it, and query again. It must not invent its own cross-branch order.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/integration/execution-scheduler-service.test.ts tests/integration/hook-ingestion.test.ts tests/integration/node-execution-service.test.ts tests/plugin/mcp.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/application/execution-scheduler-service.ts src/application/hook-ingestion-service.ts src/application/runtime-query-service.ts src/application/runtime.ts src/bindings/claude/mcp-server.ts plugin/skills/branch-execution/SKILL.md tests/integration/execution-scheduler-service.test.ts tests/integration/hook-ingestion.test.ts tests/plugin/mcp.test.ts
git commit -m "feat: schedule structured task execution"
```

### Task 9: End-to-End Structured Coding Lifecycle and User Documentation

**Files:**
- Create: `tests/e2e/structured-coding-runtime.test.ts`
- Modify: `tests/plugin/plugin-contract.test.ts`
- Modify: `docs/acceptance.md`
- Modify: `README.md`
- Modify: `docs/Self-Evolving-Agent-Harness-需求文档.md`

**Interfaces:**
- Consumes: the complete Tasks 1–8 surface.
- Produces: one automated vertical slice and one black-box Claude validation procedure for the PinBean request.

- [ ] **Step 1: Write the failing end-to-end vertical slice**

Use fake Jev and Hook/MCP calls to prove:

1. a PinBean full-project prompt routes to `structured_coding`;
2. affiliation is proposed and resolved to a new tree;
3. the full Task Tree draft is created and locally patched;
4. exact-revision validation passes;
5. approval preparation returns a canonical block;
6. Pre/Post `ExitPlanMode` binds native approval once;
7. scheduler returns a Skeleton node before any branch implementation node;
8. an active Attempt allows mutation and binds Trace/Artifact to that node;
9. Skeleton Gate opens the first branch;
10. scheduler stays within that branch until verification;
11. a later small request routed to `direct_coding` executes without creating another tree.

- [ ] **Step 2: Run the vertical slice and verify RED**

Run: `npm test -- --run tests/e2e/structured-coding-runtime.test.ts`

Expected: FAIL at the first missing or incorrectly wired cross-layer behavior.

- [ ] **Step 3: Fix only integration gaps exposed by the vertical slice**

Do not introduce new architecture here. Fix construction, export, schema, transaction, or Hook binding gaps in their owning modules and add the focused regression assertion beside the owning test.

- [ ] **Step 4: Update user-facing documentation**

Document:

- the three Runtime Profiles and Jev environment variables;
- Jev's advisory/fail-open privacy boundary;
- Task Tree Tool Provider versus Skill versus Hook responsibilities;
- native Plan canonical block and single approval flow;
- direct-execution escape path;
- Skeleton breadth → branch depth execution;
- how to inspect current profile, tree, approval, scheduler, Trace, and Attempt facts.

Remove wording that says Harness blocks native Plan Mode or parses a fenced JSON Task Tree manifest.

- [ ] **Step 5: Add the black-box Claude acceptance procedure**

In `docs/acceptance.md`, specify:

```bash
cd /tmp/pinbean-harness-acceptance
claude --plugin-dir '/mnt/d/code/创业/Agent-Harness/plugin'
```

Then use the full PinBean prompt from the design spec and verify visible discussion, persisted Task Tree revisions, one native approval, Skeleton-first execution, branch-local progression, node-bound Trace/Artifact/Attempt facts, restart recovery, and a direct small edit.

- [ ] **Step 6: Run all verification commands**

Run:

```bash
npm run typecheck
npm test
npm run plugin:validate
```

Expected: all commands exit 0; the plugin validates against Claude Code's official validator.

- [ ] **Step 7: Inspect the final diff for stale architecture**

Run:

```bash
rg -n "native_plan_mode_bypasses_task_tree|harness-task-tree.*JSON|extractTaskTreeManifest|manifest_json|parse_status" src plugin tests README.md docs/acceptance.md docs/Self-Evolving-Agent-Harness-需求文档.md
git diff --check
```

Expected: no active implementation or documentation depends on the superseded JSON-manifest bridge; `git diff --check` is clean.

- [ ] **Step 8: Commit Task 9**

```bash
git add tests/e2e/structured-coding-runtime.test.ts tests/plugin/plugin-contract.test.ts docs/acceptance.md README.md docs/Self-Evolving-Agent-Harness-需求文档.md
git commit -m "test: verify structured coding lifecycle"
```

### Task 10: Final Review and Release Readiness

**Files:**
- Modify only if review finds a defect in files from Tasks 1–9.

**Interfaces:**
- Consumes: all plan deliverables.
- Produces: a verified implementation with no known lifecycle, privacy, concurrency, or packaging regression.

- [ ] **Step 1: Review spec coverage**

Map every section of `docs/superpowers/specs/2026-10-01-native-plan-task-tree-bridge-design.md` to a passing test. Pay special attention to Profile recovery, reference expiry, multi-session revision conflict, direct execution, and fail-open Hook behavior.

- [ ] **Step 2: Run the five Review Focus regressions directly**

Run:

```bash
npm test -- --run \
  tests/unit/jev-request-router.test.ts \
  tests/integration/runtime-profile-service.test.ts \
  tests/integration/task-tree-draft-service.test.ts \
  tests/integration/native-plan-binding-service.test.ts \
  tests/integration/hook-ingestion.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run final repository verification**

Run: `npm run check`

Expected: typecheck, complete test suite, runtime bundles, plugin contract, and official Claude plugin validation all pass.

- [ ] **Step 4: Perform the manual PinBean black-box test**

Use the globally installed plugin path, not source-only mocks. Save the resulting Project ID, route decision ID, affiliation decision ID, Tree/Revision IDs, approval reference status, Workflow revision, first Skeleton Attempt ID, and first branch Attempt ID as the acceptance evidence list. Do not store API keys or full model request/response bodies.

- [ ] **Step 5: Commit only review fixes, if any**

```bash
git add <only-files-changed-by-review>
git commit -m "fix: close structured runtime review gaps"
```

If no files changed, do not create an empty commit.
