import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativePlanBindingService } from "../../src/application/native-plan-binding-service.js";
import { TaskTreeApprovalService } from "../../src/application/task-tree-approval-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { TaskTreeValidationService } from "../../src/application/task-tree-validation-service.js";
import { WorkflowService } from "../../src/application/workflow-service.js";
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
        expectedOutputs: ["canvas.ts"], acceptanceCriteria: ["test passes"], unresolvedQuestions: [],
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

async function fixture(now = new Date("2030-01-02T04:00:00.000Z")) {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-native-plan-"));
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
  const prepared = new TaskTreeApprovalService(database, trees, () => new Date("2030-01-02T03:04:05.000Z")).prepare({
    projectId: "p1", sessionId: "session-1", treeId: revision.treeId,
    treeRevisionId: revision.revisionId, readinessResultId: readiness.resultId,
  });
  const workflows = new WorkflowService(database);
  return {
    filename, database, trees, revision, readiness, prepared, workflows,
    binding: new NativePlanBindingService(database, workflows, () => now),
  };
}

function trace(database: RuntimeDatabase, input: {
  id: string; treeId: string; sessionId?: string; eventName: "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  toolUseId: string;
}) {
  database.run(`
    INSERT INTO trace_events (
      id, project_id, tree_id, session_id, event_name, payload_json,
      execution_context_json, occurred_at, idempotency_key
    ) VALUES (?, 'p1', ?, ?, ?, ?, '{}', '2030-01-02T04:00:00.000Z', ?)
  `, input.id, input.treeId, input.sessionId ?? "session-1", input.eventName,
  JSON.stringify({ sourceEvent: input.eventName, toolName: "ExitPlanMode", toolUseId: input.toolUseId }), input.id);
}

describe("NativePlanBindingService", () => {
  it("persists a normalized PreToolUse snapshot and atomically approves the exact revision", async () => {
    const f = await fixture();
    const plan = `Implementation notes may vary\r\n\r\n${f.prepared.canonicalBlock.replaceAll("\n", "\r\n")}\r\n`;
    trace(f.database, { id: "pre", treeId: f.revision.treeId, eventName: "PreToolUse", toolUseId: "exit-1" });
    const pre = f.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-1", planMarkdown: plan,
      planFilePath: "/tmp/plan.md", traceEventId: "pre",
    });
    expect(pre).toMatchObject({ approvalRef: f.prepared.approvalRef, treeRevisionId: f.revision.revisionId });
    expect(pre.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-1", planMarkdown: plan,
      planFilePath: "/tmp/plan.md", traceEventId: "pre",
    })).toEqual(pre);
    trace(f.database, { id: "post", treeId: f.revision.treeId, eventName: "PostToolUse", toolUseId: "exit-1" });
    const approved = f.binding.postExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-1", traceEventId: "post", outcome: "approved",
    });
    expect(approved).toMatchObject({ status: "consumed", outcome: "approved", stage: "skeleton_pass" });
    expect(f.database.get<{ status: string }>(
      "SELECT status FROM task_tree_approval_references WHERE approval_ref = ?", f.prepared.approvalRef,
    )).toEqual({ status: "consumed" });
    expect(f.database.all("SELECT id FROM native_plan_snapshots")).toHaveLength(1);
    expect(f.database.all("SELECT id FROM native_plan_task_tree_links")).toHaveLength(1);
    expect(f.database.all("SELECT id FROM native_plan_approval_events")).toHaveLength(1);
    expect(f.binding.postExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-1", traceEventId: "post", outcome: "approved",
    })).toEqual(approved);
    f.database.close();
  });

  it("records native rejection without activating the Workflow", async () => {
    const f = await fixture();
    trace(f.database, { id: "pre", treeId: f.revision.treeId, eventName: "PreToolUse", toolUseId: "exit-2" });
    f.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-2",
      planMarkdown: f.prepared.canonicalBlock, traceEventId: "pre",
    });
    trace(f.database, { id: "failure", treeId: f.revision.treeId, eventName: "PostToolUseFailure", toolUseId: "exit-2" });
    expect(f.binding.postExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "exit-2", traceEventId: "failure", outcome: "rejected",
    })).toMatchObject({ status: "rejected", outcome: "rejected", stage: "branch_confirmation" });
    expect(f.database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ?", f.revision.treeId))
      .toEqual({ stage: "branch_confirmation" });
    expect(f.database.all("SELECT id FROM native_plan_task_tree_links")).toEqual([]);
    f.database.close();
  });

  it("rejects changed blocks, wrong scope, expiry, stale revisions, tool mismatch, and second use", async () => {
    const changed = await fixture();
    trace(changed.database, { id: "pre-change", treeId: changed.revision.treeId, eventName: "PreToolUse", toolUseId: "change" });
    expect(() => changed.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "change", traceEventId: "pre-change",
      planMarkdown: changed.prepared.canonicalBlock.replace("Canvas", "Changed Canvas"),
    })).toThrow(expect.objectContaining({ code: "confirmation_not_applicable" }));
    expect(() => changed.binding.preExit({
      projectId: "p2", sessionId: "session-1", toolUseId: "change", traceEventId: "pre-change",
      planMarkdown: changed.prepared.canonicalBlock,
    })).toThrow();
    expect(() => changed.binding.preExit({
      projectId: "p1", sessionId: "wrong-session", toolUseId: "change", traceEventId: "pre-change",
      planMarkdown: changed.prepared.canonicalBlock,
    })).toThrow();
    changed.database.close();

    const expired = await fixture(new Date("2030-01-03T04:00:00.000Z"));
    trace(expired.database, { id: "pre-expired", treeId: expired.revision.treeId, eventName: "PreToolUse", toolUseId: "expired" });
    expect(() => expired.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "expired", traceEventId: "pre-expired",
      planMarkdown: expired.prepared.canonicalBlock,
    })).toThrow(expect.objectContaining({ code: "confirmation_not_applicable" }));
    expired.database.close();

    const stale = await fixture();
    stale.trees.saveDraftRevision({
      projectId: "p1", treeId: stale.revision.treeId, baseRevisionId: stale.revision.revisionId, document: document(),
    });
    trace(stale.database, { id: "pre-stale", treeId: stale.revision.treeId, eventName: "PreToolUse", toolUseId: "stale" });
    expect(() => stale.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "stale", traceEventId: "pre-stale",
      planMarkdown: stale.prepared.canonicalBlock,
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    stale.database.close();

    const used = await fixture();
    trace(used.database, { id: "pre-used", treeId: used.revision.treeId, eventName: "PreToolUse", toolUseId: "used" });
    used.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "used", traceEventId: "pre-used",
      planMarkdown: `Different outside text\n${used.prepared.canonicalBlock}`,
    });
    trace(used.database, { id: "post-used", treeId: used.revision.treeId, eventName: "PostToolUse", toolUseId: "used" });
    used.binding.postExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "used", traceEventId: "post-used", outcome: "approved",
    });
    trace(used.database, { id: "post-other", treeId: used.revision.treeId, eventName: "PostToolUse", toolUseId: "other" });
    expect(() => used.binding.postExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "other", traceEventId: "post-other", outcome: "approved",
    })).toThrow(expect.objectContaining({ code: "confirmation_not_applicable" }));
    expect(() => used.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "second", traceEventId: "pre-used",
      planMarkdown: used.prepared.canonicalBlock,
    })).toThrow(expect.objectContaining({ code: "confirmation_not_applicable" }));
    used.database.close();
  });

  it("recovers a prepared snapshot after restart", async () => {
    const f = await fixture();
    trace(f.database, { id: "pre", treeId: f.revision.treeId, eventName: "PreToolUse", toolUseId: "restart" });
    f.binding.preExit({
      projectId: "p1", sessionId: "session-1", toolUseId: "restart",
      planMarkdown: f.prepared.canonicalBlock, traceEventId: "pre",
    });
    f.database.close();
    const reopened = new RuntimeDatabase(f.filename);
    trace(reopened, { id: "post", treeId: f.revision.treeId, eventName: "PostToolUse", toolUseId: "restart" });
    expect(new NativePlanBindingService(reopened, new WorkflowService(reopened), () => new Date("2030-01-02T04:01:00.000Z"))
      .postExit({
        projectId: "p1", sessionId: "session-1", toolUseId: "restart", traceEventId: "post", outcome: "approved",
      })).toMatchObject({ status: "consumed", stage: "skeleton_pass" });
    reopened.close();
  });
});
