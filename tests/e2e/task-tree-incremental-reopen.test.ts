import { afterEach, describe, expect, it } from "vitest";
import { affiliation, approveIteration, completedTreeFixture, executeToReport, iterationDocument } from "../helpers/completed-tree-fixture.js";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
const fixtures: Awaited<ReturnType<typeof completedTreeFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

describe("two native-approved deliveries in one tree", () => {
  it.each([false, true])("preserves immutable history through restart (identity projection: %s)", async repairRoot => {
    const f = await completedTreeFixture({ repairRoot }); fixtures.push(f);
    const immutable = ["task_tree_revisions", "task_node_revisions", "evaluations", "execution_attempts", "workflow_phase_gate_results", "skeleton_gate_results", "trace_events", "final_reports", "task_node_identity_repairs", "task_tree_revision_identity_projections", "task_node_revision_identity_projections"];
    const before = new Map(immutable.map(table => [table, f.runtime.database.all<Record<string, unknown>>(`SELECT * FROM ${table}`)]));
    const decision = await affiliation(f, "merge");
    const input = { projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: decision.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "new-feature" };
    const draft = f.runtime.taskTreeDrafts.createDraft(input); f.revisionId = draft.revisionId;
    const denied = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PreToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Write", tool_use_id: "unapproved-write", tool_input: { file_path: "snapshots.js" } }));
    expect(denied).toMatchObject({ blocked: true });
    expect(f.runtime.finalReports.finalize({ projectId: f.projectId, treeId: f.treeId, workflowRevision: f.report.workflowRevision, idempotencyKey: "first-report" })).toMatchObject({ reportId: f.report.reportId, created: false });
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId).currentRevisionFinalReport).toBeNull();
    f.runtime.close(); f.runtime = openRuntime(f.environment);
    expect(f.runtime.taskTreeDrafts.createDraft(input).revisionId).toBe(draft.revisionId);
    await approveIteration(f);
    f.runtime.close(); f.runtime = openRuntime(f.environment);
    const second = await executeToReport(f, "second-delivery");
    expect(second).toMatchObject({ status: "completed", treeId: f.treeId, treeRevisionId: draft.revisionId });
    expect(f.runtime.database.all("SELECT approval_ref FROM task_tree_approval_references WHERE tree_id = ? AND status = 'consumed'", f.treeId)).toHaveLength(2);
    expect(f.runtime.finalReports.list(f.projectId, { treeId: f.treeId })).toHaveLength(2);
    expect(f.runtime.database.all("SELECT id FROM execution_attempts WHERE task_node_id = 'base-impl'")).toHaveLength(1);
    expect(() => f.runtime.finalReports.finalize({ projectId: f.projectId, treeId: f.treeId, workflowRevision: second.workflowRevision, idempotencyKey: "first-report" })).toThrow(/another completion/);
    for (const table of immutable) {
      const rows = f.runtime.database.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      for (const original of before.get(table)!) expect(rows).toContainEqual(original);
    }
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId)).toMatchObject({ workflow: null, currentRevisionFinalReport: { reportId: second.reportId } });
    if (repairRoot) {
      expect(f.runtime.taskTrees.getRevisionById(f.projectId, f.treeId, draft.revisionId).document.nodes.find(node => node.parentId === null)?.id).toBe(`node:${f.treeId}:root`);
      expect(f.runtime.database.get<{ document_json: string }>("SELECT document_json FROM task_tree_revisions WHERE id = ?", f.report.treeRevisionId)!.document_json).toContain('"id":"root"');
    }
  });
});
