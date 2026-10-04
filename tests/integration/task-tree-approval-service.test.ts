import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTreeApprovalService, APPROVAL_REFERENCE_TTL_MS } from "../../src/application/task-tree-approval-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { TaskTreeValidationService } from "../../src/application/task-tree-validation-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function document(): TaskTreeDocument {
  return {
    planningVersion: 1,
    planningContext: {
      goal: "Build editor", scopeBoundaries: ["browser"], exclusions: ["server"],
      unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
    },
    nodes: [
      { id: "root", parentId: null, title: "Editor", children: ["canvas"] },
      {
        id: "canvas", parentId: "root", title: "Canvas", children: [], objectives: ["Render beads"],
        expectedOutputs: ["canvas.ts"], acceptanceCriteria: ["canvas test passes"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "test", description: "Canvas test" }],
        executionPhase: "implementation", stopDecompositionReason: "One verifiable feature",
      },
    ],
    relations: [], artifacts: [],
    skeletonCriteria: [{
      id: "canvas-skeleton", branchNodeId: "canvas", expectedArtifacts: ["canvas.ts"],
      requiredContracts: ["canvas-api"], verificationCommands: ["npm test"], readinessConditions: ["module imports"],
    }],
  };
}

async function fixture(now = new Date("2030-01-02T03:04:05.000Z")) {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-approval-"));
  dirs.push(directory);
  const filename = path.join(directory, "runtime.db");
  const database = new RuntimeDatabase(filename);
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/b', 'now', 'now')");
  const trees = new TaskTreeService(database);
  const root = await trees.createTaskRoot({ projectId: "p1", title: "Editor" });
  const revision = trees.saveDraftRevision({ projectId: "p1", treeId: root.treeId, baseRevisionId: root.revisionId, document: document() });
  const readiness = new TaskTreeValidationService(database, trees).validate({
    projectId: "p1", treeId: revision.treeId, treeRevisionId: revision.revisionId,
  });
  return {
    filename, database, trees, revision, readiness,
    approvals: new TaskTreeApprovalService(database, trees, () => now),
  };
}

describe("TaskTreeApprovalService", () => {
  it("prepares an opaque exact-revision reference and internal confirmation for 24 hours", async () => {
    const f = await fixture();
    const prepared = f.approvals.prepare({
      projectId: "p1", sessionId: "session-1", treeId: f.revision.treeId,
      treeRevisionId: f.revision.revisionId, readinessResultId: f.readiness.resultId,
    });
    expect(prepared.approvalRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.canonicalBlock).toContain(`approval_ref="${prepared.approvalRef}"`);
    expect(prepared.canonicalBlockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.treeRevisionId).toBe(f.revision.revisionId);
    expect(prepared.expiresAt).toBe(new Date(Date.parse("2030-01-02T03:04:05.000Z") + APPROVAL_REFERENCE_TTL_MS).toISOString());
    const row = f.database.get<{ status: string; confirmation_prompt_id: string; workflow_revision: number }>(
      "SELECT status, confirmation_prompt_id, workflow_revision FROM task_tree_approval_references WHERE approval_ref = ?",
      prepared.approvalRef,
    );
    expect(row).toMatchObject({ status: "prepared", workflow_revision: 3 });
    expect(f.database.get<{ status: string; tree_revision_id: string }>(
      "SELECT status, tree_revision_id FROM runtime_confirmation_prompts WHERE id = ?", row!.confirmation_prompt_id,
    )).toEqual({ status: "pending", tree_revision_id: f.revision.revisionId });
    const columns = f.database.all<{ name: string }>("PRAGMA table_info(task_tree_approval_references)").map((r) => r.name);
    expect(columns).not.toEqual(expect.arrayContaining(["prompt", "api_key", "raw_response"]));
    f.database.close();
  });

  it("rejects stale, not-ready, wrong-tree, cross-Project, archived, and completed inputs", async () => {
    const f = await fixture();
    const input = {
      projectId: "p1", sessionId: "session-1", treeId: f.revision.treeId,
      treeRevisionId: f.revision.revisionId, readinessResultId: f.readiness.resultId,
    };
    expect(() => f.approvals.prepare({ ...input, treeRevisionId: "stale" }))
      .toThrow(expect.objectContaining({ code: "revision_conflict" }));
    f.database.run("UPDATE plan_readiness_results SET ready = 0 WHERE id = ?", f.readiness.resultId);
    expect(() => f.approvals.prepare(input)).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));
    f.database.run("UPDATE plan_readiness_results SET ready = 1 WHERE id = ?", f.readiness.resultId);
    expect(() => f.approvals.prepare({ ...input, projectId: "p2" })).toThrow();
    f.database.run("UPDATE task_trees SET status = 'archived' WHERE id = ?", f.revision.treeId);
    expect(() => f.approvals.prepare(input)).toThrow(expect.objectContaining({ code: "task_tree_transition_rejected" }));
    f.database.run("UPDATE task_trees SET status = 'completed' WHERE id = ?", f.revision.treeId);
    expect(() => f.approvals.prepare(input)).toThrow(expect.objectContaining({ code: "task_tree_transition_rejected" }));
    f.database.close();
  });

  it("supersedes a prior unconsumed reference and terminal references cannot be reused", async () => {
    const f = await fixture();
    const input = {
      projectId: "p1", sessionId: "session-1", treeId: f.revision.treeId,
      treeRevisionId: f.revision.revisionId, readinessResultId: f.readiness.resultId,
    };
    const first = f.approvals.prepare(input);
    const second = f.approvals.prepare(input);
    expect(second.approvalRef).not.toBe(first.approvalRef);
    expect(f.database.get<{ status: string }>(
      "SELECT status FROM task_tree_approval_references WHERE approval_ref = ?", first.approvalRef,
    )).toEqual({ status: "superseded" });
    expect(() => f.database.run(
      "UPDATE task_tree_approval_references SET status = 'consumed', resolved_at = 'later' WHERE approval_ref = ?",
      first.approvalRef,
    )).toThrow();
    expect(f.database.all("SELECT id FROM runtime_confirmation_prompts WHERE tree_id = ?", f.revision.treeId)).toHaveLength(2);
    f.database.close();
  });

  it("recovers the persisted pending reference after restart", async () => {
    const f = await fixture();
    const prepared = f.approvals.prepare({
      projectId: "p1", sessionId: "session-1", treeId: f.revision.treeId,
      treeRevisionId: f.revision.revisionId, readinessResultId: f.readiness.resultId,
    });
    f.database.close();
    const reopened = new RuntimeDatabase(f.filename);
    const recovered = new TaskTreeApprovalService(reopened, new TaskTreeService(reopened), () => new Date("2030-01-02T04:00:00.000Z"))
      .getPending({ projectId: "p1", sessionId: "session-1", treeId: f.revision.treeId });
    expect(recovered).toMatchObject({
      approvalRef: prepared.approvalRef, canonicalBlockHash: prepared.canonicalBlockHash,
      treeRevisionId: f.revision.revisionId, status: "prepared",
    });
    reopened.close();
  });
});
