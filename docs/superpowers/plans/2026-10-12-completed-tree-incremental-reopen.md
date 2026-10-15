# Completed Task Tree Incremental Reopen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development only if the user chooses that method. Complete the checkbox steps in order. No real project recovery or Git commit is authorized by this plan.

**Goal:** Append new branches to a completed tree under the same treeId and a new revision, preserve old delivery facts, and execute only new or unproven/affected work through a new approval and final report.

**Architecture:** An explicit, authorized merge/create-draft path calls a transactional iteration service. Additive structure analysis, proof-time artifact baselines, and one shared reuse policy feed current node/branch projections and all execution/report consumers. Ordinary completed-tree mutations remain forbidden.

**Tech Stack:** TypeScript; Node >=22.13.0; node:sqlite; Vitest; existing Claude MCP/Hook binding. Use the existing WSL Node 22.23.2 toolchain; add no external dependency.

**Spec:** `docs/superpowers/specs/2026-10-12-completed-tree-incremental-reopen-design.md` (user approved by “开始实施吧”).

## Global Constraints

- Preserve prior uncommitted 0.1.6–0.1.8 changes and unrelated `tmp/`/`resume-output/` files.
- Do not edit the counter source, reopen its real tree, clear live decisions, enable JEV, or migrate the real database as a diagnostic step.
- Do not update/delete original revision JSON, consumed approvals, Attempt/Evaluation/Gate/Trace facts, identity projections, or old Final Reports.
- Keep the same treeId and canonical node IDs; increment both planning and workflow revisions monotonically.
- Only explicit completed-tree merge plus a full additive planningVersion=1 document can open an iteration. One fresh native Plan approval is required before new execution.
- Unknown evidence requires revalidation, not invented success or mtime-based reuse. A new root verification is always required.
- Ordinary direct execution remains available; merely querying/selecting a completed tree, pausing, or saying “继续” must not reopen it.
- No commit/push, new worktree, or real-data recovery without separate user authorization. Tests use temporary SQLite/project fixtures.

## Review Focus

1. A previously repaired root must retain its canonical identity without rewriting its original JSON (Task 3/6).
2. A file changed with preserved mtime, or a symlink escaping the project, must not earn reusable proof (Task 2).
3. A completed tree without old baselines must degrade to explicit verification work, not deadlock or force reimplementation (Task 3/4).
4. Older report/idempotency queries must not make an active new iteration appear completed (Task 5/6).
5. Failure midway through reopen, retry after restart, and intervening direct mutations must not corrupt history or resurrect old approval (Task 3/6).

## File and Interface Map

- `src/domain/task-tree-increment.ts`: pure additive structure validation.
- `src/domain/artifact-evidence-baseline.ts`: baseline/decision types and comparison; hashes carry no file contents.
- `src/application/artifact-evidence-baseline-service.ts`: bounded project-local fingerprint capture and immutable proof/report baseline persistence.
- `src/application/task-tree-iteration-service.ts`: authorized completed-tree reopen and immutable iteration/reuse audit.
- `src/application/task-tree-identity.ts`: shared project/tree-checked canonical normalization for ordinary and incremental saves.
- `src/application/evidence-reuse-policy.ts`: shared eligibility checks for old Evaluations/Attempts in an iteration revision.
- Existing draft/tree, approval/execution, skeleton/phase, freshness/report/query services: integration, not a replacement engine.
- `tests/helpers/completed-tree-fixture.ts`: a temporary project driven through real service approval, Attempt, Evaluation, Gate and Final Report paths, rather than setting all statuses to succeeded.

## Task 1: Additive Structure Contract

**Files:** Create `src/domain/task-tree-increment.ts`, `tests/unit/task-tree-increment.test.ts`.

**Interfaces:**

```ts
interface IncrementalStructureAnalysis {
  allowed: boolean;
  rootNodeId: string;
  addedNodeIds: string[];
  addedBranchIds: string[];
  blockers: Array<{ code: string; ref: string }>;
}
function analyzeIncrementalStructure(base: TaskTreeDocument, proposed: TaskTreeDocument): IncrementalStructureAnalysis;
```

Inputs are already normalized using the existing tree identity mapping. Preserve base root ID, every old branch/leaf body, old relations/artifacts/links, old skeleton criteria and existing contract signature/version/providers. Root children may append; the root verification contract may extend coverage and update count-dependent descriptions, retaining its existing evidence keys and old required coverage. This explicit root-contract clarification requires plan review: an old root mentioning “four branches” cannot remain the acceptance wording for five branches. A contract may add new consumers; old consumers cannot disappear. Preserve planning goal/exclusions and existing scope constraints; new scope entries/effects may append. Reject no-addition documents, old-branch/leaf edits/removal/reparenting, root replacement or removed evidence keys, nested-only additions, contract rewrites, and removed exclusions.

- [x] Write literal-fixture tests: root `root` with branch `base` can append `snapshots`; expect `{allowed:true, rootNodeId:"root", addedBranchIds:["snapshots"]}` and added-node IDs in proposed document order. Removal of `base`, changed base acceptance criteria, changed root goal, or replaced contract returns `allowed:false` with a specific blocker. New consumers and root children appended without other edits remain allowed.
- [x] Run `npm test -- tests/unit/task-tree-increment.test.ts`; watch the missing behavior fail.
- [x] Implement the pure analysis, deriving expectations independently of production helpers.
- [x] Add a root-contract case retaining key `root-acceptance` but extending description to all five children; this is allowed. Removing that key is rejected. Re-run the same tests; require all pass before Task 2.

## Task 2: Fingerprints Bound to Actual Verification

**Files:** Create `src/domain/artifact-evidence-baseline.ts`, `src/application/artifact-evidence-baseline-service.ts`, `tests/integration/artifact-evidence-baseline.test.ts`. Modify `src/storage/migrations.ts`, `src/application/node-execution-service.ts`, `src/application/evaluation-service.ts`, `src/application/final-report-service.ts`.

**Interfaces:**

```ts
interface ArtifactEvidenceBaseline {
  artifactId: string;
  kind: "file" | "contract";
  locator: string;
  status: "known" | "unknown";
  hash: string | null;
  reason: string | null;
}
interface ProofBaseline {
  artifacts: ArtifactEvidenceBaseline[];
  environment: { platform: string; architecture: string; nodeVersion: string } | null;
}
class ArtifactEvidenceBaselineService {
  captureStartWithinTransaction(input: { projectId: string; attemptId: string }): ProofBaseline;
  captureEndWithinTransaction(input: { projectId: string; attemptId: string }): { baseline: ProofBaseline; changedArtifactIds: string[] };
  saveReportBaselineWithinTransaction(input: { projectId: string; reportId: string; rootAttemptId: string | null }): void;
  compareReport(input: { projectId: string; reportId: string; cwd?: string }): {
    unchangedArtifactIds: string[]; changedArtifactIds: string[]; unknownArtifactIds: string[]; environmentCompatible: boolean;
  };
}
```

Capture pre-verification baselines in beginVerification, end baselines when evaluating proof, and report baselines from the successful root proof. A root verification covers all planned file/contract inputs; other nodes cover their linked/expected artifacts and evidence dependencies. Current proof can succeed with unknown reusable baseline if required evidence is satisfied, but known before/after changes prevent a succeeded transition. Unknown baseline cannot be reused in a later iteration.

Resolve the real project root from registered identity/validated execution cwd. Check realpath containment before reading; hash bytes, not mtime. Missing/unreadable/escaping paths are unknown. Limit each file to 16 MiB and total capture to 64 MiB; budget overflow is unknown rather than read unbounded data. Contracts hash canonical name/version/signature/provider definition. Environment comparison uses platform/architecture/Node version, not model/session IDs or API secrets.

Add migration 27 with immutable `execution_attempt_artifact_baselines` (attempt, start/end stage, baseline JSON, timestamp) and `final_report_artifact_baselines` (report, root attempt, baseline JSON, timestamp). Unique keys prevent replacement; update/delete triggers preserve history. A legacy report has no row, which means unknown, not an automatically backfilled baseline.

- [x] Write tests: unchanged project-local bytes produce a known matching hash; rewritten bytes with restored mtime are changed; missing file, permission failure, oversized file and external symlink are unknown. Source files and parent/outside targets stay untouched.
- [x] Write verification-window tests: mutate a known artifact between beginVerification and evaluation; succeeded must not be applied. Stable actual proof saves a baseline; finalization associates that baseline with the new report. Legacy reports remain readable without fabricated baselines.
- [x] Run `npm test -- tests/integration/artifact-evidence-baseline.test.ts`; watch failures for the intended missing baseline behavior.
- [x] Implement bounded capture, additive immutable tables, and integration. Represent a known proof-window mismatch as an uncertain evaluation requiring revalidation; do not turn it into a fabricated tool failure. No fingerprint read creates files or changes source metadata.
- [x] Run that file plus `tests/integration/database.test.ts`, `tests/integration/node-execution-service.test.ts`, `tests/integration/evaluation-service.test.ts`, and `tests/integration/final-report-service.test.ts`; preserve current execution semantics outside the new baseline/reuse boundary.

## Task 3: Atomic Completed-Tree Iteration Entry

**Files:** Create `src/application/task-tree-iteration-service.ts`, `src/application/task-tree-identity.ts`, `src/application/evidence-reuse-policy.ts`, `tests/integration/task-tree-iteration-service.test.ts`, `tests/helpers/completed-tree-fixture.ts`. Modify `src/storage/migrations.ts`, `src/application/task-tree-draft-service.ts`, `src/application/task-tree-service.ts`, `src/application/runtime.ts`.

**Interfaces:**

```ts
interface TaskTreeIterationView extends TaskTreeRevisionView {
  iterationId: string;
  baseRevisionId: string;
  baseReportId: string;
  addedNodeIds: string[];
  reusedNodeIds: string[];
  revalidationNodeIds: string[];
}
class TaskTreeIterationService {
  reopenWithinTransaction(input: {
    projectId: string; sessionId: string; affiliationDecisionId: string;
    treeId: string; expectedTreeRevisionId: string; document: TaskTreeDocument;
    inputHash: string; cwd?: string;
  }): TaskTreeIterationView;
}
function isPriorEvaluationUsable(database: RuntimeDatabase, input: {
  projectId: string; treeId: string; targetRevisionId: string; nodeId: string; evaluationId: string;
}): boolean;
function normalizeDocumentNodeIdentity(database: RuntimeDatabase, input: {
  projectId: string; treeId: string; document: TaskTreeDocument;
}): TaskTreeDocument;
// Narrow internal TaskTreeService entry: independently verifies the merged
// affiliation and same-session answer before calling existing persistence.
// Ordinary saveDraftRevisionWithinTransaction remains completed-tree guarded.
interface IncrementalRevisionPersistence {
  saveIncrementalRevisionWithinTransaction(input: {
    projectId: string; treeId: string; baseRevisionId: string; document: TaskTreeDocument;
    affiliationDecisionId: string; sessionId: string;
  }): TaskTreeRevisionView;
}
```

Add immutable `task_tree_iteration_records` (project/tree, base revision/report, result revision, affiliation/answer Trace, input hash, impact/reuse JSON, timestamp). Reuse JSON names source Evaluation/Attempt/Gate IDs; no new succeeded Attempt or Gate is invented. Existing `task_tree_authoring_commands` retains idempotency-key ownership. Target-revision success remains normally usable; older success in iteration revisions requires an explicit, compatible audit grant. Outside iteration revisions retain existing compatibility behavior.

TaskTreeDraftService.createDraft keeps its current same-Project/session merge evidence and idempotency checks. Inside its transaction, if the target is completed call the iteration service; otherwise use the existing path. The service independently validates resolved merge answer, exact revision/report, no active Attempt/other workflow, no conflicting pending change/confirmation, and Task 1 structure rules. Reuse existing canonical normalization and persistence with a narrowly authorized internal entry; ordinary assertTreeMutable is unchanged.

Use Task 2 comparison, current invalidations, taskNodeEvidenceContext, planned modifies-links and post-delivery Artifact-linked mutation Traces to seed impact. Extend through artifact/contract links, depends_on and verification ancestors, not communication edges. Include unlinked expectedOutputs by path. Root always needs revalidation. No valid baseline/source Evaluation means verification required. Authorizations for unchanged node contracts can inherit independently of their execution freshness.

Persist the new revision and audit, set affected current nodes to needs_revalidation, leave proved-unaffected node statuses intact, select the same canonical root, and reactivate the existing workflow at task_tree_refinement with revision incremented. Ordinary save/patch/select still reject or leave completed history inactive. Transaction rollback restores every current projection if any insert/check fails.

- [x] Build a fixture with a real completed report, stable file baselines, and an actual merge answer Trace. Append `snapshots`; assert same treeId, next revision, old report/raw JSON unchanged, old branch reuse granted, root marked for new verification, and no new execution yet.
- [x] Add refusals: stale revision, wrong Project/session/Trace, no completed report, archived target, other active workflow, running Attempt, conflicting pending operation, unsupported structure and no addition. Assert no row-count/current-pointer change.
- [x] Add direct-after-delivery mutation and legacy-no-baseline cases; assert affected nodes require verification, not automatic success. Add an identity-projection fixture whose root is already `node:<treeId>:root`; assert old raw root JSON stays untouched.
- [x] Inject a failing audit insert in a temp DB; assert rollback of revision, statuses, workflow, selection and confirmations. Repeat identical createDraft after close/reopen and require the same result; same key/different input rejects.
- [x] Run `npm test -- tests/integration/task-tree-iteration-service.test.ts` and watch failures before implementation.
- [x] Implement the service, transaction path, audit/grants and pure impact traversal using existing refinement/freshness rules. Share canonical normalization with the existing persistence path rather than copy its identity algorithm.
- [x] Run `npm test -- tests/integration/task-tree-iteration-service.test.ts tests/integration/task-tree-draft-service.test.ts tests/integration/task-node-identity.test.ts tests/integration/node-identity-repair.test.ts`. Require no history-write regression.

## Task 4: One Eligibility Rule Across Execution and Gates

**Files:** Modify `src/application/skeleton-gate-service.ts`, `src/application/execution-scheduler-service.ts`, `src/application/node-completion.ts`, `src/application/node-execution-service.ts`, `src/application/workflow-phase-service.ts`, `src/application/verification-freshness-service.ts`, `src/application/final-report-service.ts`. Create `tests/integration/iteration-execution.test.ts`.

**Interfaces:** Consume Task 3 `isPriorEvaluationUsable`. Extend ScheduledTaskNodeView with optional `executionPurpose: "revalidation"` for affected old nodes; this is metadata, not permission to skip evidence or dependencies. Existing next/startAttempt/beginVerification/attachEvidence/evaluateAttempt signatures remain usable.

- [x] Write a stable two-branch fixture: after a fresh native Plan approval, the new skeleton runs, the old skeleton is observed through granted proof, the old branch is inherited verified, and only the new branch becomes active. Scheduler must not return a reused old leaf.
- [x] Write changed-file and legacy-baseline cases: an affected old leaf is scheduled with revalidation purpose; its current acceptance requires fresh evidence and its branch cannot inherit verified. New root is unreachable until both affected and added scopes pass.
- [x] Assert a structure-valid old success without a reuse grant fails Skeleton/phase/report eligibility consistently; a newly verified current-revision success is accepted. No consumer may make its own weaker cross-revision reuse decision.
- [x] Assert writes before the new exact-revision approval remain denied, even though the old approval is consumed. Restart the Runtime/Session and preserve scheduling/grants without borrowing another Session's running Attempt.
- [x] Run `npm test -- tests/integration/iteration-execution.test.ts`; watch missing branch initialization/reuse behavior fail.
- [x] Integrate the shared rule into prior-proof reads. Change skeleton branch initialization from resetting every branch to reusing only proven branch grants, activating the first nonverified branch. Gate records remain new/current-revision observations with source proof references.
- [x] Ensure node completion, dependency checks, invalidation, root Gate and Final Report all honor the same target-revision grants. Later mutations invalidate these grants through current revision invalidations; a persisted grant is not immunity to fresh changes.
- [x] Run `npm test -- tests/integration/iteration-execution.test.ts tests/integration/execution-scheduler-service.test.ts tests/integration/skeleton-gate-service.test.ts tests/integration/workflow-service.test.ts tests/integration/final-report-service.test.ts tests/integration/hook-ingestion.test.ts`. The new iteration-execution file owns phase/freshness cases; require all pass.

## Task 5: Native Tool Path and Current-vs-Historical Queries

**Files:** Modify `src/application/task-affiliation-service.ts`, `src/application/runtime-query-service.ts`, `src/application/final-report-service.ts`, `src/bindings/claude/mcp-server.ts`, `src/application/runtime-profile-service.ts`, `src/domain/native-execution-guidance.ts` only where necessary. Extend `tests/plugin/mcp.test.ts`; create `tests/integration/iteration-query.test.ts`.

**Interfaces:** Existing MCP tool names/inputs remain stable. create-draft may return TaskTreeIterationView for completed merge. Candidates add `supportsIncrementalMerge: true` for completed, nonarchived trees. Snapshot and tree summary add `currentRevisionFinalReport` (null until current revision completes) plus latest iteration summary; final report history remains accessible through existing list/reportId filters.

- [x] Write tool-boundary tests using the registered server: merge a completed candidate, submit a full draft with exact expected revision, receive the same treeId/new revision/iteration summary, and create no extra tree. Wrong affiliation or omitted/stale revision rejects.
- [x] Write read-only query tests: during the new draft/execution, currentRevisionFinalReport is null while the older report remains listed completed. After new finalization, list returns two reports for different revisions with original bytes intact.
- [x] Test bare “继续”, selecting/querying a completed tree, direct small edits and pause: no new iteration or workflow activation. Explicit structure still obtains new native approval. Preserve disabled-JEV fallback and 0.1.8 idle guidance.
- [x] Run `npm test -- tests/integration/iteration-query.test.ts tests/plugin/mcp.test.ts`; watch the missing fields/boundary behavior fail.
- [x] Integrate the existing tool path and query additions, document that the latest historical report cannot be used to declare the current revision complete. Do not automatically activate a selected completed tree or add a generic reopen-without-plan tool.
- [x] Run `npm test -- tests/integration/native-plan-binding-service.test.ts tests/integration/task-tree-approval-service.test.ts tests/integration/task-affiliation-service.test.ts tests/integration/idle-native-guidance.test.ts tests/plugin/plugin-contract.test.ts`.

## Task 6: Full Two-Delivery Regression and Release

**Files:** Create `tests/e2e/task-tree-incremental-reopen.test.ts`, `docs/task-tree-incremental-iterations.md`. Modify `README.md`, package/lock/plugin manifests and the version contract to `0.1.9`. If changing installed Skill instructions, use the writing-skills workflow; do not replace native discussion with a mandatory second approval prompt.

- [x] Write an end-to-end temp fixture: complete iteration 1 through real approval and execution services; explicitly merge an added branch; freeze a snapshot of all immutable history; approve revision 2 once; execute only required new/revalidation work; pass the new root Gate and finalize a second report. Check same treeId, monotonic revisions, exactly one report per revision, no extra old-leaf Attempt when reuse is justified, immutable facts unchanged and workflow inactive at completion.
- [x] Add retries/restart between draft, approval and execution, plus old report idempotency-key misuse. Old key returns only its original historical scope or rejects mismatched scope; it cannot complete the new workflow. A reused raw/identity-projected node ID cannot steal another tree's node.
- [x] Run `npm test -- tests/e2e/task-tree-incremental-reopen.test.ts`; watch the intended missing lifecycle behavior fail, then resolve integration issues within the preceding task interfaces.
- [x] Document original merge/create-draft flow, one approval per iteration, unknown-baseline revalidation, append-only limits, historical report semantics, and that plugin update does not reopen real projects.
- [x] Run fresh `npm run check` and `git diff --check`: require exit 0, full test-suite counts, TypeScript, built CLI/MCP/Hook and official manifest validation. Report any failure explicitly, including unrelated failures.
- [x] Request an independent read-only whole-patch review; address Important/Critical findings with failing regressions and rerun checks. Preserve all preexisting dirty changes.
- [x] Update the local marketplace/user plugin to 0.1.9 and verify installed version only after checks pass. Do not run real reopen; ask the user to restart Claude and separately test named snapshots by merging into the existing counter tree. Do not claim actual Claude adherence or live-data recovery from temporary-fixture results.

## Self-Review and Handoff

- Scope coverage: Tasks 1/3 enforce the explicit additive entry; Task 2 provides nonfabricated evidence baselines; Task 4 aligns execution/reuse; Task 5 separates current and historical delivery; Task 6 proves the complete loop and release.
- Existing mutable workflow/node projections may change only for the new revision. Tests compare immutable history, not all mutable table bytes.
- No background bulk migration, restore, tree reset, hidden intent classifier or commit step is included.
- Tests use actual registered services and temporary files/DBs. Controlled test proof fixtures are not presented as production counter acceptance.
- Recommended execution: native implementation in this conversation, tasks in order, then one independent review. This keeps the tightly coupled transaction and reuse interfaces in one implementation context; no separate user-owned task is needed.
- Execution was authorized by the user's “按计划直接实施”. Completed inline; retained the existing checkout and uncommitted work as explicitly required above.

## Execution Result

Released locally as 0.1.9 after fresh `npm run check` (568 tests / 78 files, TypeScript, CLI/MCP/Hook build, official manifests, separate plugin suite 13 tests) and `git diff --check`, all exit 0. One independent reviewer verified the whole patch and the fixes to both Important findings, then checked the detail-only planning-document read/append tool path. No Critical/Important finding remains; no Minor finding was deferred.

Tasks 1–5 and hardening fixes have behavioral RED→GREEN records. The root-count contract is tested generically as one→two children (same preserved-key expansion invariant), rather than a literal four→five fixture. Task 6 exercises the already-integrated lifecycle; its first fixture setup failure is not claimed as a production-behavior RED. Logs and the complete decision ledger remain under `.superpowers/sdd/2026-10-12-completed-tree-incremental-reopen/`.

`claude plugin update` reports 0.1.8→0.1.9 and `plugin list --json` confirms installed user version 0.1.9. No live Runtime/database migration, real counter/tree recovery, Git commit/push, or workspace cleanup was performed. Restart Claude Code to load the update; test a new explicitly authorized merge separately.
