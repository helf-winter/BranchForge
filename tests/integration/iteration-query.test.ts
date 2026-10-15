import { afterEach, describe, expect, it } from "vitest";
import { affiliation, completedTreeFixture, iterationDocument } from "../helpers/completed-tree-fixture.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
const fixtures: Awaited<ReturnType<typeof completedTreeFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
describe("current versus historical completion", () => {
  it("exposes the full immutable planning document only in explicit detail, without changing runtime", async () => {
    const f = await completedTreeFixture(); fixtures.push(f);
    const stored = f.runtime.database.get<{ document_json: string }>("SELECT document_json FROM runtime_task_tree_revisions WHERE id = ?", f.revisionId)!;
    const before = f.runtime.queries.getRuntimeSnapshot(f.projectId);
    const detail = f.runtime.queries.getTreeView(f.projectId, { treeId: f.treeId, depth: "detail", branchRootNodeId: "base" });
    expect(detail).toHaveProperty("planningDocument", JSON.parse(stored.document_json));
    expect(f.runtime.queries.getTreeView(f.projectId, { treeId: f.treeId, depth: "summary" })).not.toHaveProperty("planningDocument");
    expect(f.runtime.queries.getTreeView(f.projectId, { treeId: f.treeId, depth: "snapshot" })).not.toHaveProperty("planningDocument");
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId)).toEqual(before);
    expect(f.runtime.database.all("SELECT id FROM task_tree_iteration_records")).toEqual([]);
    expect(() => f.runtime.queries.getTreeView("other-project", { treeId: f.treeId, depth: "detail" })).toThrow();
  });
  it("advertises additive merge and never presents the old report as current completion", async () => {
    const f = await completedTreeFixture(); fixtures.push(f);
    expect(f.runtime.taskTrees.listTaskTreeCandidates({ projectId: f.projectId, query: f.treeId })[0]).toMatchObject({ supportsIncrementalMerge: true });
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId)).toMatchObject({ currentRevisionFinalReport: { reportId: f.report.reportId } });
    const d = await affiliation(f, "merge");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "query-iteration" });
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId)).toMatchObject({ currentRevisionFinalReport: null, latestIteration: { baseReportId: f.report.reportId, resultRevisionId: draft.revisionId } });
    expect(f.runtime.queries.getTaskTreeSummary(f.projectId, f.treeId)).toMatchObject({ currentRevisionFinalReport: null });
    expect(f.runtime.finalReports.list(f.projectId, { reportId: f.report.reportId })[0]).toMatchObject({ status: "completed", treeRevisionId: f.revisionId });
  });
  it("does not reopen a completed tree on selection, query, or bare continue", async () => {
    const f = await completedTreeFixture(); fixtures.push(f);
    await f.runtime.taskTrees.selectTaskTree({ projectId: f.projectId, treeId: f.treeId });
    f.runtime.queries.getTaskTreeSummary(f.projectId, f.treeId);
    await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: f.sessionId, cwd: f.projectDir, prompt: "继续" }));
    expect(f.runtime.database.all("SELECT id FROM task_tree_iteration_records")).toEqual([]);
    expect(f.runtime.queries.getRuntimeSnapshot(f.projectId).workflow).toBeNull();
  });
});
