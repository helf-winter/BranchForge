# Native Plan → Task Tree Bridge Implementation Plan

> **Status: SUPERSEDED — DO NOT EXECUTE.** The approved architecture now uses a first-class Task Tree Tool Provider and a canonical approval reference instead of parsing a full JSON Manifest from the native Plan. A replacement implementation plan will be written after review of `docs/superpowers/specs/2026-10-01-native-plan-task-tree-bridge-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Claude Code's native Plan Mode while deterministically persisting approved complex plans as Task Trees and executing project mutations through active Task Nodes.

**Architecture:** Claude's native Plan remains the planning and approval UI. Claude Binding hooks capture `EnterPlanMode` and `ExitPlanMode`, persist immutable plan snapshots, parse a fenced `harness-task-tree` manifest, bind the approved plan to an exact Task Tree revision, and then reuse the existing Workflow, Attempt, Evidence, Gate, Drift, and Final Report services. Hooks remain passive during reasoning and ordinary direct work; they enforce only the approved-plan-to-execution boundary and existing lifecycle invariants.

**Tech Stack:** TypeScript 7, Node.js 22, SQLite, Vitest 5, Claude Code plugin Skills/Hooks/MCP, esbuild

**Spec:** `docs/superpowers/specs/2026-10-01-native-plan-task-tree-bridge-design.md`

## Global Constraints

- Do not deny or replace Claude Code `EnterPlanMode`, `AskUserQuestion`, plan-file editing, or native approval UI.
- Do not call an LLM from a Hook to parse, repair, or regenerate a plan.
- `harness-task-tree` content must deserialize to the existing `TaskTreeDocument` domain type and pass existing deterministic validators.
- Native Plan snapshots, tree links, and approval events are append-only facts scoped by Project.
- A native approval confirms only the exact plan hash and Task Tree revision linked to that snapshot.
- A resolved `direct_execution` affiliation bypasses Task Tree execution gates while Hooks continue recording facts.
- Structured execution follows Skeleton breadth, then branch depth, then root verification and final reporting.
- A project mutation in structured execution requires an active Attempt for the selected Task Node.
- Preserve Bash/WSL support, non-ASCII project paths, Node.js `>=22.13.0`, and the public database location.
- Do not touch unrelated untracked `docs/assets/`, `resume-output/`, or `tmp/` content.

## Review Focus

- `ExitPlanMode` payloads with a missing, empty, malformed, duplicated, or differently newline-normalized plan must produce deterministic capture or recovery behavior; Task 2 pins this.
- A stale approval arriving after a newer plan snapshot or Task Tree revision must return `revision_conflict` without confirming either revision; Task 4 pins this.
- A Plan Mode session explicitly resolved as `direct_execution` must allow project mutation without a tree or active Attempt; Task 5 pins this.
- Replayed Pre/Post Hook deliveries must not duplicate snapshots, revisions, links, approvals, Attempts, or Trace facts; Tasks 2, 4, and 5 pin this.
- The globally installed cached plugin must behave like the repository build under a third-party Claude-compatible model even if Skill auto-selection is missed; Task 7 pins event-local guidance and recovery.

---

### Task 0: Preserve the Direct-Execution Baseline

**Files:**
- Modify: existing tracked changes already present in `README.md`, `docs/acceptance.md`, `docs/Self-Evolving-Agent-Harness-需求文档.md`, `package.json`, `plugin/`, `src/`, and `tests/`
- Create: `.claude-plugin/marketplace.json`
- Test: existing full suite

**Interfaces:**
- Consumes: current working-tree implementation of `direct_execution`, no-tree mutation recording, and local marketplace installation
- Produces: a clean committed baseline on which Native Plan work can be reviewed independently

- [ ] **Step 1: Verify the existing direct-execution slice**

Run: `npm run check`

Expected: typecheck passes; all Vitest suites pass; both official Claude plugin validations pass.

- [ ] **Step 2: Review the exact staged baseline**

Run: `git add README.md docs/acceptance.md docs/Self-Evolving-Agent-Harness-需求文档.md package.json plugin src tests .claude-plugin/marketplace.json && git diff --cached --check && git diff --cached --stat`

Expected: only Agent Harness product files are staged; `docs/assets/`, `resume-output/`, and `tmp/` are absent.

- [ ] **Step 3: Commit the verified baseline**

```bash
git commit -m "feat: allow direct work outside task tree workflows"
```

Expected: the Native Plan implementation starts from a clean tracked working tree while unrelated untracked directories remain untouched.

---

### Task 1: Native Plan Domain Contract and Storage

**Files:**
- Create: `src/domain/native-plan.ts`
- Modify: `src/storage/migrations.ts`
- Create: `tests/unit/native-plan.test.ts`
- Modify: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: `TaskTreeDocument`, `validateDraftStructure`, `canonicalJson`, SQLite migration conventions
- Produces: `normalizeNativePlanMarkdown(markdown: string): string`, `hashNativePlan(markdown: string): string`, `extractTaskTreeManifest(markdown: string): NativePlanManifestResult`, `NativePlanSnapshotView`, `NativePlanTreeLinkView`, and migration version 21

- [ ] **Step 1: Write failing manifest parser tests**

Add tests named:

- `extracts one fenced harness-task-tree document and normalizes CRLF`
- `reports missing manifest without throwing`
- `reports invalid JSON without repairing it`
- `rejects two task tree manifests as ambiguous`
- `uses normalized plan content for stable hashes`

Assert exact result variants:

```ts
type NativePlanManifestResult =
  | { status: "valid"; document: TaskTreeDocument; manifestJson: string }
  | { status: "missing"; manifestJson: null }
  | { status: "invalid"; manifestJson: string | null; error: string };
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npx vitest run tests/unit/native-plan.test.ts`

Expected: FAIL because `src/domain/native-plan.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser and hash contract**

In `src/domain/native-plan.ts`, export:

```ts
export function normalizeNativePlanMarkdown(markdown: string): string;
export function hashNativePlan(markdown: string): string;
export function extractTaskTreeManifest(markdown: string): NativePlanManifestResult;
```

Normalize CRLF/CR to LF and remove only trailing horizontal whitespace plus excess EOF blank lines. Accept exactly one ```` ```harness-task-tree ```` fenced block. Parse JSON without correction and validate only that it is an object at this layer; Task Tree structural validation remains in the application service.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `npx vitest run tests/unit/native-plan.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing migration tests**

Extend `tests/integration/database.test.ts` to assert migration version 21 and these constraints:

- duplicate `(project_id, session_id, plan_hash)` snapshots fail;
- duplicate `snapshot_id` tree links fail;
- approval policies accept only `task_tree`, `direct_execution`, and `sync_required`;
- Runtime Confirmation source accepts `runtime_prompt` and `native_plan`, with existing rows defaulting to `runtime_prompt`;
- deleting a Project cascades snapshots, links, and approvals according to the existing physical-deletion policy;
- snapshot content cannot be updated in place.

- [ ] **Step 6: Run migration tests and verify RED**

Run: `npx vitest run tests/integration/database.test.ts`

Expected: FAIL because migration 21 and the Native Plan tables do not exist.

- [ ] **Step 7: Add migration 21**

Create:

```text
native_plan_snapshots
native_plan_tree_links
native_plan_approval_events
```

Use the columns and append-only triggers from the approved spec. Add indexes for `(project_id, session_id, created_at DESC)`, `plan_hash`, and approval lookup. Add a non-null `confirmation_source` discriminator to Runtime Confirmation prompts with values `runtime_prompt` and `native_plan`; migrate existing rows as `runtime_prompt`. Foreign keys must restrict deletion of referenced Trace and Task Tree revisions while Project deletion cascades the Native Plan records.

- [ ] **Step 8: Run domain and migration tests**

Run: `npx vitest run tests/unit/native-plan.test.ts tests/integration/database.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/native-plan.ts src/storage/migrations.ts tests/unit/native-plan.test.ts tests/integration/database.test.ts
git commit -m "feat: persist immutable native plan facts"
```

---

### Task 2: Native Plan Capture and Tree Synchronization Service

**Files:**
- Create: `src/application/native-plan-service.ts`
- Modify: `src/application/runtime.ts`
- Create: `tests/integration/native-plan-service.test.ts`

**Interfaces:**
- Consumes: Task 1 parser/storage, `TaskTreeService.saveDraftRevision`, current Project selection, resolved Task affiliation
- Produces: `NativePlanService.capture`, `NativePlanService.sync`, `NativePlanService.getSnapshot`, and `NativePlanService.latestApprovedExecutionPolicy`

- [ ] **Step 1: Write failing capture tests**

Test these exact behaviors with a real `RuntimeDatabase`:

- `capture` stores one immutable snapshot for a missing manifest and returns `syncRequired: true`;
- duplicate capture returns the existing snapshot ID;
- `capture` followed by `sync` for a valid manifest and selected draft tree writes one new Task Tree revision and one immutable tree link;
- direct-execution affiliation captures the plan but creates no revision/link and returns `executionPolicy: "direct_execution"`;
- invalid `planningVersion: 1` manifest records `parseStatus: "invalid"` without changing the tree;
- same plan with CRLF and LF deduplicates to one snapshot.

Use these signatures:

```ts
capture(input: {
  projectId: string;
  sessionId: string;
  planFilePath: string;
  planMarkdown: string;
  sourceTraceEventId: string;
}): NativePlanCaptureResult;

sync(input: {
  projectId: string;
  snapshotId: string;
  document?: TaskTreeDocument;
  sourceTraceEventId: string;
}): NativePlanTreeLinkView;
```

- [ ] **Step 2: Run service tests and verify RED**

Run: `npx vitest run tests/integration/native-plan-service.test.ts`

Expected: FAIL because `NativePlanService` does not exist.

- [ ] **Step 3: Implement capture without tree mutation**

Implement `capture` first so it normalizes/hashes, inserts or reloads the immutable snapshot, and returns parse status. It must not create a Project, tree, or affiliation itself; callers provide an existing persisted Project.

- [ ] **Step 4: Run the capture-only tests**

Run: `npx vitest run tests/integration/native-plan-service.test.ts -t "capture|duplicate|CRLF"`

Expected: capture tests PASS; synchronization tests remain FAIL.

- [ ] **Step 5: Implement deterministic synchronization**

Construct `NativePlanService` with `RuntimeDatabase` and `TaskTreeService`. `sync` must:

- require a selected non-archived tree in the same Project;
- reject `direct_execution` affiliation;
- require snapshot parse status `valid` unless a replacement `document` is supplied;
- call the existing Task Tree validator and `saveDraftRevision` against the exact current revision ID;
- run whole-tree Plan Readiness for the saved revision so a ready native plan reaches `branch_confirmation` before approval;
- create exactly one `native_plan_tree_links` row;
- return the existing link on identical replay;
- return `revision_conflict` if the snapshot is already linked to a different revision.

- [ ] **Step 6: Wire `nativePlans` into `openRuntime`**

Add:

```ts
const taskTrees = new TaskTreeService(database);
const nativePlans = new NativePlanService(database, taskTrees);
```

Return both shared instances so Hook and MCP paths use the same service contracts.

- [ ] **Step 7: Run service and adjacent Task Tree tests**

Run: `npx vitest run tests/integration/native-plan-service.test.ts tests/integration/task-tree-service.test.ts tests/integration/task-affiliation-service.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/application/native-plan-service.ts src/application/runtime.ts tests/integration/native-plan-service.test.ts
git commit -m "feat: synchronize native plans into task trees"
```

---

### Task 3: Event-Local Hook Guidance Without Blocking Plan Mode

**Files:**
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/bindings/claude/hook-entry.ts`
- Modify: `tests/integration/hook-ingestion.test.ts`
- Modify: `tests/plugin/plugin-contract.test.ts`

**Interfaces:**
- Consumes: existing `ClaudeHookEvent`, `HookIngestionResult`, official Claude Hook `additionalContext`
- Produces: event-aware `HookDirective`, passive `EnterPlanMode` recording, and one `PostToolUse(EnterPlanMode)` planning hint

- [ ] **Step 1: Replace the old Plan Mode blocking test with failing passive-first tests**

Assert:

- `PreToolUse(EnterPlanMode)` is never denied, including when a draft or active Workflow exists;
- `PostToolUse(EnterPlanMode)` persists a Trace and returns a context directive whose event name is `PostToolUse`;
- the context says native Plan Mode remains available and references `agent-harness:task-tree-planning`;
- duplicate Post delivery returns the same context but no duplicate Trace;
- ordinary no-tree mutation remains allowed and does not receive Plan guidance.

- [ ] **Step 2: Run hook tests and verify RED**

Run: `npx vitest run tests/integration/hook-ingestion.test.ts tests/plugin/plugin-contract.test.ts`

Expected: FAIL because an active Workflow still denies `EnterPlanMode` and context directives are hard-coded to SessionStart.

- [ ] **Step 3: Generalize Hook directives**

Change the public type to:

```ts
export type HookDirective =
  | { kind: "deny"; eventName: "PreToolUse"; reason: string }
  | { kind: "context"; eventName: ClaudeHookEvent["eventName"]; context: string };
```

Remove `native_plan_mode_bypasses_task_tree` and `nativePlanModeReason`. Keep mutation gating for active, non-executable Task Tree stages.

- [ ] **Step 4: Emit event-local Plan guidance**

Record Pre/Post `EnterPlanMode` even without an active tree. Return the planning hint only after successful `PostToolUse(EnterPlanMode)`. Update `hook-entry.ts` to serialize `directive.eventName` rather than `SessionStart` for every context.

- [ ] **Step 5: Run hook tests and verify GREEN**

Run: `npx vitest run tests/integration/hook-ingestion.test.ts tests/plugin/plugin-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/hook-ingestion-service.ts src/bindings/claude/hook-entry.ts tests/integration/hook-ingestion.test.ts tests/plugin/plugin-contract.test.ts
git commit -m "feat: guide native plan mode through hooks"
```

---

### Task 4: ExitPlanMode Capture and Native Approval Bridge

**Files:**
- Modify: `src/bindings/claude/hook-mapper.ts`
- Modify: `src/application/native-plan-service.ts`
- Modify: `src/application/workflow-service.ts`
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/application/runtime.ts`
- Modify: `tests/integration/hook-ingestion.test.ts`
- Modify: `tests/integration/workflow-service.test.ts`
- Modify: `tests/integration/native-plan-service.test.ts`

**Interfaces:**
- Consumes: official `ExitPlanMode` input `{ plan, planFilePath }`, approved Post response `{ plan, filePath }`, Task 2 capture/link, current readiness result
- Produces: `NativePlanService.recordApproval`, `WorkflowService.confirmFromNativePlan`, and automatic `branch-execution` guidance

- [ ] **Step 1: Write failing mapper and capture tests using real Claude payloads**

Assert that `mapClaudeHook` preserves:

- Pre `tool_input.plan` and `tool_input.planFilePath`;
- Post `tool_response.plan` and `tool_response.filePath`;
- session ID, tool use ID, permission mode, and cwd.

Then assert Pre ExitPlanMode creates a snapshot/Tree Link but returns no deny decision, including missing/invalid manifests.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/integration/hook-ingestion.test.ts tests/integration/native-plan-service.test.ts -t "ExitPlanMode|native approval"`

Expected: FAIL because ExitPlanMode has no lifecycle integration.

- [ ] **Step 3: Add immutable approval recording**

Implement:

```ts
recordApproval(input: {
  projectId: string;
  sessionId: string;
  planMarkdown: string;
  approved: boolean;
  approvalTraceEventId: string;
}): NativePlanApprovalView;
```

Resolve the exact snapshot by normalized plan hash. Set policy to `direct_execution` only from a resolved direct affiliation; set `task_tree` only when a Tree Link exists; otherwise set `sync_required`. Replays return the same approval. A newer snapshot for the same session makes approval of an older hash fail with `revision_conflict`.

- [ ] **Step 4: Write failing native confirmation tests**

Add `WorkflowService.confirmFromNativePlan(input)` tests asserting:

- a current ready whole-tree revision is confirmed from an approved snapshot without a second pending prompt;
- the approval Trace must be a PostToolUse ExitPlanMode event in the same Project and session;
- stale plan hash, stale tree revision, non-ready plan, and partial Tree Link are rejected;
- all confirmed node/artifact/workflow projections match ordinary whole-tree confirmation.

- [ ] **Step 5: Run confirmation tests and verify RED**

Run: `npx vitest run tests/integration/workflow-service.test.ts -t "native plan"`

Expected: FAIL because `confirmFromNativePlan` does not exist.

- [ ] **Step 6: Refactor confirmation projection and implement native confirmation**

Extract the existing confirmation-state/artifact/workflow projection into one private transaction helper used by both `confirmScope` and:

```ts
confirmFromNativePlan(input: {
  projectId: string;
  snapshotId: string;
  treeId: string;
  treeRevisionId: string;
  approvalTraceEventId: string;
  workflowRevision: number;
}): NativePlanConfirmationView;
```

Persist an internal confirmed Runtime Confirmation record with source `native_plan`; do not create a pending user-visible prompt. Advance to `skeleton_pass` only for a ready whole-tree revision.

- [ ] **Step 7: Integrate ExitPlanMode Hooks transactionally**

Construct `HookIngestionService` with the shared `NativePlanService` and `WorkflowService`. After the Hook Trace exists:

- Pre ExitPlanMode always calls `capture`; it calls `sync` only when the capture is `valid`, the resolved execution policy is not `direct_execution`, and the Project already has one selected non-archived Task Tree. Missing/invalid manifests or unresolved affiliation remain `sync_required` and never trigger an implicit tree choice;
- Post ExitPlanMode calls `recordApproval` and `confirmFromNativePlan` for `task_tree` policy;
- `sync_required` returns non-blocking recovery context;
- `direct_execution` returns no Task Tree directive;
- successful confirmation returns one `branch-execution` context directive.

- [ ] **Step 8: Run integration tests**

Run: `npx vitest run tests/integration/native-plan-service.test.ts tests/integration/workflow-service.test.ts tests/integration/hook-ingestion.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/bindings/claude/hook-mapper.ts src/application/native-plan-service.ts src/application/workflow-service.ts src/application/hook-ingestion-service.ts src/application/runtime.ts tests/integration/native-plan-service.test.ts tests/integration/workflow-service.test.ts tests/integration/hook-ingestion.test.ts
git commit -m "feat: bind approved native plans to task trees"
```

---

### Task 5: Deterministic Next-Node Execution Cursor

**Files:**
- Modify: `src/application/node-execution-service.ts`
- Modify: `src/application/hook-ingestion-service.ts`
- Modify: `src/application/runtime-query-service.ts`
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `tests/integration/node-execution-service.test.ts`
- Modify: `tests/integration/hook-ingestion.test.ts`
- Modify: `tests/integration/runtime-query.test.ts`
- Modify: `tests/plugin/mcp.test.ts`

**Interfaces:**
- Consumes: confirmed Task Tree revision, Workflow stage/active branch, node phase/dependencies/status, existing `startAttempt`
- Produces: `NodeExecutionService.nextExecutableNode`, `NodeExecutionService.startNextAttempt`, and MCP `harness_start_next_task_node`

- [ ] **Step 1: Write failing scheduler tests**

Cover:

- `skeleton_pass` selects ready Skeleton leaves in breadth order and never implementation leaves;
- `branch_implementation` selects only implementation leaves below `active_branch_node_id` in deterministic depth order;
- `branch_verification` and `root_verification` select only their allowed verification node;
- unresolved dependencies, unconfirmed nodes, active Attempts, and failed phase gates exclude a node;
- replaying `startNextAttempt` while an Attempt is active returns that Attempt instead of creating another.

Use:

```ts
nextExecutableNode(input: { projectId: string; treeId: string }): ExecutableNodeView | null;
startNextAttempt(input: {
  projectId: string;
  treeId: string;
  expectedTreeRevisionId: string;
}): ExecutionAttemptView;
```

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `npx vitest run tests/integration/node-execution-service.test.ts -t "next executable|start next"`

Expected: FAIL because scheduler methods do not exist.

- [ ] **Step 3: Implement deterministic selection and combined start**

Use current revision node bodies and explicit `children` order. Skeleton traversal is level-order among eligible leaves; branch implementation is depth-first within the active branch. Reuse `startAttempt` for all final legality checks rather than duplicating them.

- [ ] **Step 4: Add the MCP start-next tool and query projection**

Register `harness_start_next_task_node` with `cwd`, `treeId`, and `expectedTreeRevisionId`. Include `nextExecutableNode` and active Attempt summary in the bounded Runtime Snapshot so the execution Skill does not need full-tree context.

- [ ] **Step 5: Write failing mutation-boundary tests**

Assert:

- any confirmed structured Task Tree Workflow in an executable stage with no active Attempt rejects project mutation with `mutation_without_active_task_node`;
- an active Attempt for the selected node allows in-scope mutation;
- `direct_execution` approval allows mutation without any Attempt;
- duplicate denials do not duplicate Trace;
- post-tool events bind tree/node only from the active Attempt, not a stale selected node.

- [ ] **Step 6: Run boundary tests and verify RED**

Run: `npx vitest run tests/integration/hook-ingestion.test.ts -t "active Task Node|direct execution"`

Expected: FAIL because executable-stage mutations currently rely only on Workflow stage and stale selection.

- [ ] **Step 7: Enforce the narrow active-Attempt boundary**

In `HookIngestionService`, resolve execution context from the active Attempt. Deny only when a confirmed structured Task Tree Workflow is in an executable stage and has no active Attempt. Continue to allow no-tree/direct work. Use the Attempt node ID for Trace and Artifact projection.

- [ ] **Step 8: Run scheduler, hook, query, and MCP tests**

Run: `npx vitest run tests/integration/node-execution-service.test.ts tests/integration/hook-ingestion.test.ts tests/integration/runtime-query.test.ts tests/plugin/mcp.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/application/node-execution-service.ts src/application/hook-ingestion-service.ts src/application/runtime-query-service.ts src/bindings/claude/mcp-server.ts tests/integration/node-execution-service.test.ts tests/integration/hook-ingestion.test.ts tests/integration/runtime-query.test.ts tests/plugin/mcp.test.ts
git commit -m "feat: execute approved plans through task nodes"
```

---

### Task 6: Recovery Tool and Native Planning Skills

**Files:**
- Modify: `src/bindings/claude/mcp-server.ts`
- Modify: `plugin/skills/task-tree-planning/SKILL.md`
- Modify: `plugin/skills/branch-execution/SKILL.md`
- Modify: `tests/plugin/mcp.test.ts`
- Modify: `tests/plugin/plugin-contract.test.ts`

**Interfaces:**
- Consumes: `NativePlanService.sync`, `harness_start_next_task_node`, native Plan approval context
- Produces: MCP `harness_sync_native_plan` and Skill behavior that composes with native Plan Mode

- [ ] **Step 1: Write failing MCP and Skill contract tests**

Assert:

- `harness_sync_native_plan` accepts `cwd`, `snapshotId`, `document`, and `sourceTraceEventId`;
- the tool description says recovery only and does not claim to generate a plan;
- `task-tree-planning` explicitly preserves native Plan Mode, uses native AskUserQuestion, emits `harness-task-tree`, and does not request a second plan confirmation;
- `branch-execution` starts/resumes the active node through `harness_start_next_task_node` and does not jump gates;
- neither Skill tells Claude to leave or avoid Plan Mode.

- [ ] **Step 2: Run plugin tests and verify RED**

Run: `npx vitest run tests/plugin/mcp.test.ts tests/plugin/plugin-contract.test.ts`

Expected: FAIL because the tool and revised instructions do not exist.

- [ ] **Step 3: Register the recovery MCP tool**

Validate the document with the existing Zod Task Tree schema used by `harness_save_draft_revision`. Delegate directly to `runtime.nativePlans.sync`; do not duplicate parsing or persistence in the binding.

- [ ] **Step 4: Rewrite planning and execution Skills**

Keep the existing frontmatter names and narrow trigger descriptions. Replace the workflow text so native Plan Mode owns exploration/questions/approval, the manifest owns durable structure, and Task Node execution owns code changes after approval.

- [ ] **Step 5: Run plugin tests and official validation**

Run: `npm run plugin:validate`

Expected: plugin build, official validation, MCP tests, and Skill contract tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bindings/claude/mcp-server.ts plugin/skills/task-tree-planning/SKILL.md plugin/skills/branch-execution/SKILL.md tests/plugin/mcp.test.ts tests/plugin/plugin-contract.test.ts
git commit -m "feat: compose task trees with native plan mode"
```

---

### Task 7: Documentation, Full Verification, and Global Claude Smoke Test

**Files:**
- Modify: `README.md`
- Modify: `docs/acceptance.md`
- Modify: `docs/Self-Evolving-Agent-Harness-需求文档.md`
- Modify: `plugin/.claude-plugin/plugin.json`
- Create: `tests/e2e/native-plan-task-tree-bridge.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6 complete runtime and plugin behavior
- Produces: versioned plugin `0.2.0`, executable acceptance documentation, end-to-end regression coverage, and a globally installed tested build

- [ ] **Step 1: Write the failing end-to-end lifecycle test**

Drive the application services with realistic Hook payloads:

1. SessionStart;
2. Pre/Post EnterPlanMode;
3. resolved new-tree affiliation;
4. Pre ExitPlanMode carrying a valid manifest;
5. Post ExitPlanMode carrying the approved plan;
6. start-next Skeleton Attempt;
7. node-scoped file mutation and evidence;
8. Skeleton Gate progression.

Assert one approval, immutable snapshot/link facts, exact Trace tree/node binding, and direct-execution exemption in a second Project.

- [ ] **Step 2: Run the E2E test and verify RED**

Run: `npx vitest run tests/e2e/native-plan-task-tree-bridge.test.ts`

Expected: FAIL until every previous task is integrated correctly.

- [ ] **Step 3: Fix only integration defects exposed by the E2E test**

Do not add new behavior. Keep corrections within the interfaces defined by Tasks 1–6.

- [ ] **Step 4: Update product documentation and acceptance criteria**

Document:

- passive-first positioning;
- Native Plan as interaction source and Task Tree revision as execution source;
- event-local Skill guidance;
- one native approval;
- recovery behavior;
- active Task Node execution;
- direct-execution exemption.

Bump the SRS version to the next revision and plugin version to `0.2.0` because the planning integration contract changes materially.

- [ ] **Step 5: Run the complete quality gate**

Run: `npm run check`

Expected: typecheck passes; all unit, integration, E2E, and plugin tests pass; both official plugin validations pass.

- [ ] **Step 6: Reinstall the global plugin from the local marketplace**

Run in WSL/bash from the repository:

```bash
claude plugin update agent-harness@agent-harness-local || {
  claude plugin uninstall agent-harness@agent-harness-local --scope user
  claude plugin install agent-harness@agent-harness-local --scope user
}
claude plugin list
```

Expected: `agent-harness@agent-harness-local`, version `0.2.0`, user scope, enabled.

- [ ] **Step 7: Run a black-box Claude Code smoke test in a temporary empty Project**

Use plain `claude`, not `--plugin-dir`. Submit a complex project prompt that asks for discussion and approval before implementation. Verify from transcript and Runtime queries:

- native Plan Mode entered successfully;
- Task Tree Skill guidance arrived after entry;
- `ExitPlanMode` plan contains a valid manifest;
- one native approval creates/links/confirms one revision;
- first mutation belongs to a running Skeleton Attempt;
- no duplicate Harness approval is shown.

Then submit a small explicit “不建树，直接执行” mutation and verify it succeeds without a new tree.

- [ ] **Step 8: Commit the verified vertical slice**

```bash
git add README.md docs/acceptance.md docs/Self-Evolving-Agent-Harness-需求文档.md plugin src tests
git commit -m "feat: ship native plan task tree bridge"
```

- [ ] **Step 9: Review final repository state**

Run: `git status --short && git log --oneline -8`

Expected: no tracked implementation changes remain; only previously identified unrelated untracked directories may remain.
