import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionSchedulerService } from "../../src/application/execution-scheduler-service.js";
import { NodeExecutionService } from "../../src/application/node-execution-service.js";
import { EvaluationService } from "../../src/application/evaluation-service.js";
import { WorkflowPhaseService } from "../../src/application/workflow-phase-service.js";
import { FinalReportService } from "../../src/application/final-report-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function plan(): TaskTreeDocument {
  const leaf = (id: string, parentId: string, phase: "skeleton" | "implementation" | "verification", dependencies: string[] = []) => ({
    id, parentId, title: id, children: [], objectives: [`Complete ${id}`], expectedOutputs: [`${id}.ts`],
    acceptanceCriteria: [`${id} passes`], unresolvedQuestions: [], unresolvedDecisions: [], dependencies,
    requiredEvidence: [{ key: `${id}-test`, description: `${id} test` }], executionPhase: phase,
    stopDecompositionReason: "One independently verifiable task",
  });
  return {
    planningVersion: 1,
    planningContext: {
      goal: "Build runtime", scopeBoundaries: ["package"], exclusions: ["deployment"],
      unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
    },
    nodes: [
      {
        id: "root", parentId: null, title: "Root verification", children: ["branch-a", "branch-b"],
        executionPhase: "verification", requiredEvidence: [{ key: "root-test", description: "Root test" }],
      },
      { id: "branch-a", parentId: "root", title: "Branch A", children: ["a-skeleton", "a-group", "a-verify"] },
      leaf("a-skeleton", "branch-a", "skeleton"),
      { id: "a-group", parentId: "branch-a", title: "A group", children: ["a-impl"] },
      leaf("a-impl", "a-group", "implementation", ["a-skeleton"]),
      leaf("a-verify", "branch-a", "verification", ["a-impl"]),
      { id: "branch-b", parentId: "root", title: "Branch B", children: ["b-skeleton", "b-impl", "b-verify"] },
      leaf("b-skeleton", "branch-b", "skeleton"),
      leaf("b-impl", "branch-b", "implementation", ["b-skeleton"]),
      leaf("b-verify", "branch-b", "verification", ["b-impl"]),
    ],
    relations: [], artifacts: [],
    skeletonCriteria: [
      { id: "a", branchNodeId: "branch-a", expectedArtifacts: ["a.ts"], requiredContracts: ["a"], verificationCommands: ["npm test"], readinessConditions: ["ready"] },
      { id: "b", branchNodeId: "branch-b", expectedArtifacts: ["b.ts"], requiredContracts: ["b"], verificationCommands: ["npm test"], readinessConditions: ["ready"] },
    ],
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-scheduler-"));
  dirs.push(directory);
  const filename = path.join(directory, "runtime.db");
  const database = new RuntimeDatabase(filename);
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  const trees = new TaskTreeService(database);
  const root = await trees.createTaskRoot({ projectId: "p1", title: "Runtime" });
  const revision = trees.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: plan() });
  database.run("UPDATE task_tree_revisions SET document_json = document_json WHERE id = ?", revision.revisionId);
  database.run("UPDATE task_node_confirmation_states SET state = 'confirmed' WHERE tree_revision_id = ?", revision.revisionId);
  database.run("UPDATE task_nodes SET status = 'ready' WHERE tree_id = ?", revision.treeId);
  database.run("UPDATE task_trees SET status = 'confirmed' WHERE id = ?", revision.treeId);
  database.run("UPDATE workflow_states SET stage = 'skeleton_pass', revision = 4 WHERE tree_id = ?", revision.treeId);
  return { filename, database, revision, scheduler: new ExecutionSchedulerService(database) };
}

describe("ExecutionSchedulerService", () => {
  it("closes verified container branches without fabricated branch Attempts", async () => {
    const f = await fixture();
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id IN ('a-skeleton', 'b-skeleton', 'a-impl', 'a-verify', 'b-impl', 'b-verify')");
    f.database.run("UPDATE workflow_states SET stage = 'root_verification', active_branch_node_id = NULL WHERE tree_id = ?", f.revision.treeId);
    for (const [id, order] of [["branch-a", 0], ["branch-b", 1]] as const) {
      f.database.run("INSERT INTO workflow_branch_states (project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at) VALUES ('p1', ?, ?, ?, ?, 'verified', 'now')", f.revision.treeId, f.revision.revisionId, id, order);
    }
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({ nodeId: "root" });
    const attempt = new NodeExecutionService(f.database).startAttempt({ projectId: "p1", nodeId: "root", expectedTreeRevisionId: f.revision.revisionId });
    expect(attempt.status).toBe("running");
    expect(f.database.all("SELECT id FROM execution_attempts")).toHaveLength(1);
    const executions = new NodeExecutionService(f.database);
    f.database.run(`INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name,
      payload_json, execution_context_json, occurred_at, idempotency_key)
      VALUES ('root-evidence', 'p1', ?, 'root', 'run', 'PostToolUse', '{}', '{}', '9999-01-01', 'root-evidence')`, f.revision.treeId);
    executions.attachEvidence({ projectId: "p1", attemptId: attempt.attemptId, requiredEvidenceKey: "root-test", traceEventId: "root-evidence" });
    executions.beginVerification({ projectId: "p1", attemptId: attempt.attemptId, expectedStatus: "running" });
    expect(new EvaluationService(f.database).evaluateAttempt({ projectId: "p1", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null }))
      .toMatchObject({ transition: { applied: true, targetStatus: "succeeded" } });
    const gate = new WorkflowPhaseService(f.database).evaluate({ projectId: "p1", treeId: f.revision.treeId, workflowRevision: 4 });
    expect(gate).toMatchObject({ status: "passed", nextStage: "final_report" });
    expect(new FinalReportService(f.database).finalize({ projectId: "p1", treeId: f.revision.treeId, workflowRevision: gate.workflow.revision, idempotencyKey: "finish" }))
      .toMatchObject({ status: "completed", summary: { taskNodes: { total: 10, succeeded: 10 } } });
    expect(f.database.all("SELECT id FROM execution_attempts")).toHaveLength(1);
    f.database.close();
  });

  it("does not treat a verified container as complete after a descendant loses validation", async () => {
    const f = await fixture();
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE tree_id = ? AND id <> 'root'", f.revision.treeId);
    f.database.run("UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = 'a-impl'");
    f.database.run("UPDATE workflow_states SET stage = 'root_verification' WHERE tree_id = ?", f.revision.treeId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    f.database.close();
  });
  it("selects Skeleton nodes breadth-first by depth and stable document order", async () => {
    const f = await fixture();
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({
      nodeId: "a-skeleton", phase: "skeleton", stage: "skeleton_pass", treeRevisionId: f.revision.revisionId,
    });
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id = 'a-skeleton'");
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({ nodeId: "b-skeleton" });
    f.database.close();
  });

  it("rejects starting an eligible node that is not the deterministic scheduler result", async () => {
    const f = await fixture();
    expect(() => new NodeExecutionService(f.database).startAttempt({
      projectId: "p1", nodeId: "b-skeleton", expectedTreeRevisionId: f.revision.revisionId,
    })).toThrow(expect.objectContaining({
      code: "attempt_not_executable", message: expect.stringContaining("deterministic next scheduled node"),
    }));
    expect(new NodeExecutionService(f.database).startAttempt({
      projectId: "p1", nodeId: "a-skeleton", expectedTreeRevisionId: f.revision.revisionId,
    })).toMatchObject({ nodeId: "a-skeleton", treeRevisionId: f.revision.revisionId });
    f.database.close();
  });

  it("selects the deepest eligible implementation leaf only in the active branch", async () => {
    const f = await fixture();
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id IN ('a-skeleton', 'b-skeleton')");
    f.database.run("UPDATE workflow_states SET stage = 'branch_implementation', active_branch_node_id = 'branch-a', revision = 5 WHERE tree_id = ?", f.revision.treeId);
    f.database.run("INSERT INTO workflow_branch_states (project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at) VALUES ('p1', ?, ?, 'branch-a', 0, 'active', 'now')", f.revision.treeId, f.revision.revisionId);
    f.database.run("INSERT INTO workflow_branch_states (project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at) VALUES ('p1', ?, ?, 'branch-b', 1, 'pending', 'now')", f.revision.treeId, f.revision.revisionId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({
      nodeId: "a-impl", activeBranchNodeId: "branch-a", depth: 3,
    });
    f.database.close();
  });

  it("schedules branch verification and root verification only in their exact scopes", async () => {
    const f = await fixture();
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id IN ('a-skeleton', 'b-skeleton', 'a-impl')");
    f.database.run("UPDATE workflow_states SET stage = 'branch_verification', active_branch_node_id = 'branch-a', revision = 6 WHERE tree_id = ?", f.revision.treeId);
    f.database.run("INSERT INTO workflow_branch_states (project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at) VALUES ('p1', ?, ?, 'branch-a', 0, 'implemented', 'now')", f.revision.treeId, f.revision.revisionId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({ nodeId: "a-verify", phase: "verification" });
    f.database.run("UPDATE task_nodes SET status = 'succeeded' WHERE id <> 'root'");
    f.database.run("UPDATE workflow_branch_states SET status = 'verified'");
    f.database.run("UPDATE workflow_states SET stage = 'root_verification', active_branch_node_id = NULL, revision = 9 WHERE tree_id = ?", f.revision.treeId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({ nodeId: "root", phase: "verification" });
    f.database.run("UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = 'branch-b'");
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    f.database.close();
  });

  it("returns no node for unresolved gates, stale branch state, blocking Drift, or an active Attempt", async () => {
    const f = await fixture();
    f.database.run("UPDATE task_node_confirmation_states SET state = 'draft' WHERE tree_revision_id = ? AND task_node_id = 'a-skeleton'", f.revision.revisionId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toMatchObject({ nodeId: "b-skeleton" });
    f.database.run("UPDATE task_node_confirmation_states SET state = 'draft' WHERE tree_revision_id = ? AND task_node_id = 'b-skeleton'", f.revision.revisionId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    f.database.run("UPDATE task_node_confirmation_states SET state = 'confirmed' WHERE tree_revision_id = ?", f.revision.revisionId);
    f.database.run("UPDATE task_nodes SET status = 'ready' WHERE id = 'a-skeleton'");
    f.database.run("UPDATE task_nodes SET status = 'ready' WHERE id = 'b-skeleton'");
    f.database.run(`
      INSERT INTO trace_events (
        id, project_id, tree_id, node_id, session_id, event_name, payload_json,
        execution_context_json, occurred_at, idempotency_key
      ) VALUES ('drift-trace', 'p1', ?, 'a-skeleton', 's1', 'PostToolUse', '{}', '{}', 'now', 'drift-trace')
    `, f.revision.treeId);
    f.database.run(`
      INSERT INTO plan_drift_records (
        id, project_id, tree_id, task_node_id, planned_artifact_id, actual_artifact_id,
        drift_type, severity, trace_event_id, drift_explanation, agent_recommendation,
        resolution_status, user_decision, description, created_at
      ) VALUES ('drift', 'p1', ?, 'a-skeleton', NULL, NULL, 'unexpected_artifact', 'blocking',
        'drift-trace', 'blocked', NULL, 'pending_user_confirmation', NULL, 'blocked', 'now')
    `, f.revision.treeId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    f.database.run("UPDATE plan_drift_records SET resolution_status = 'accepted' WHERE id = 'drift'");
    const nodeRevisionId = f.database.get<{ id: string }>(
      "SELECT id FROM task_node_revisions WHERE tree_revision_id = ? AND node_id = 'b-skeleton'", f.revision.revisionId,
    )!.id;
    f.database.run(`
      INSERT INTO execution_attempts (
        id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at
      ) VALUES ('active', 'p1', ?, 'b-skeleton', ?, 1, 'running', 'now')
    `, f.revision.treeId, nodeRevisionId);
    expect(f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    f.database.close();
  });

  it("is deterministic across restart and rejects a branch state from another revision", async () => {
    const f = await fixture();
    const first = f.scheduler.next({ projectId: "p1", treeId: f.revision.treeId });
    f.database.close();
    const reopened = new RuntimeDatabase(f.filename);
    expect(new ExecutionSchedulerService(reopened).next({ projectId: "p1", treeId: f.revision.treeId })).toEqual(first);
    reopened.run("UPDATE workflow_states SET stage = 'branch_implementation', active_branch_node_id = 'branch-a' WHERE tree_id = ?", f.revision.treeId);
    const older = reopened.get<{ id: string }>("SELECT id FROM task_tree_revisions WHERE tree_id = ? AND id <> ?", f.revision.treeId, f.revision.revisionId)!.id;
    reopened.run("INSERT INTO workflow_branch_states (project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at) VALUES ('p1', ?, ?, 'branch-a', 0, 'active', 'now')", f.revision.treeId, older);
    expect(new ExecutionSchedulerService(reopened).next({ projectId: "p1", treeId: f.revision.treeId })).toBeNull();
    reopened.close();
  });
});
