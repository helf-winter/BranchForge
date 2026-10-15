import { afterEach, describe, expect, it } from "vitest";
import { affiliation, completedTreeFixture, iterationDocument } from "../helpers/completed-tree-fixture.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
const fixtures: Awaited<ReturnType<typeof completedTreeFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() { const f = await completedTreeFixture(); fixtures.push(f); return f; }
describe("explicit completed-tree iteration", () => {
  it("appends under the same tree, preserves history and requires new root proof", async () => {
    const f = await fixture(); const d = await affiliation(f, "merge");
    const before = f.runtime.database.all("SELECT * FROM final_reports");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "append" });
    expect(draft).toMatchObject({ treeId: f.treeId, revision: 3, baseReportId: f.report.reportId, reusedNodeIds: expect.arrayContaining(["base-skeleton", "base-impl", "base"]), revalidationNodeIds: ["root"] });
    expect(f.runtime.database.all("SELECT * FROM final_reports")).toEqual(before);
    expect(f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId })).toBeNull();
  });
  it("degrades missing legacy baselines to revalidation, not automatic success", async () => {
    const f = await fixture();
    // Remove only the new test fixture baseline to simulate a pre-migration report.
    f.runtime.database.run("DROP TRIGGER report_baselines_no_delete"); f.runtime.database.run("DELETE FROM final_report_artifact_baselines");
    const d = await affiliation(f, "merge");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "legacy" });
    expect(draft).toMatchObject({ reusedNodeIds: [], revalidationNodeIds: expect.arrayContaining(["root", "base-skeleton", "base-impl", "base"]) });
  });
  it.each(["stale", "session", "project", "no_addition", "old_node", "active", "pending", "archived", "running", "no_report"])("refuses %s without touching any revision or projection", async reason => {
    const f = await fixture(); const d = await affiliation(f, "merge");
    const document = iterationDocument(["base", "snapshots"]);
    if (reason === "old_node") document.nodes.find(node => node.id === "base-impl")!.title = "rewrite";
    if (reason === "active") f.runtime.database.run("UPDATE workflow_states SET active = 1 WHERE tree_id = ?", f.treeId);
    if (reason === "pending") f.runtime.affiliations.propose({ projectId: f.projectId, requestTitle: "Unanswered", recommendation: "pause" });
    if (reason === "archived") f.runtime.database.run("UPDATE task_trees SET status = 'archived' WHERE id = ?", f.treeId);
    if (reason === "running") f.runtime.database.run("INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) SELECT 'unexpected-running', project_id, tree_id, task_node_id, task_node_revision_id, 99, 'running', started_at FROM execution_attempts LIMIT 1");
    if (reason === "no_report") {
      f.runtime.database.run("DROP TRIGGER report_baselines_no_delete"); f.runtime.database.run("DROP TRIGGER final_reports_no_delete");
      f.runtime.database.run("DELETE FROM final_report_artifact_baselines"); f.runtime.database.run("DELETE FROM final_reports");
    }
    const before = ["task_trees", "task_tree_revisions", "task_nodes", "workflow_states", "task_node_confirmation_states", "runtime_states"].map(table => f.runtime.database.all(`SELECT * FROM ${table}`));
    expect(() => f.runtime.taskTreeDrafts.createDraft({ projectId: reason === "project" ? "foreign-project" : f.projectId, sessionId: reason === "session" ? "foreign" : f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: reason === "stale" ? "stale" : f.revisionId, document: reason === "no_addition" ? iterationDocument() : document, idempotencyKey: reason })).toThrow();
    expect(["task_trees", "task_tree_revisions", "task_nodes", "workflow_states", "task_node_confirmation_states", "runtime_states"].map(table => f.runtime.database.all(`SELECT * FROM ${table}`))).toEqual(before);
  });
  it("detects changed bytes after delivery and invalidates dependent verification", async () => {
    const f = await fixture(); await writeFile(path.join(f.projectDir, "base.js"), "changed outside Harness");
    const d = await affiliation(f, "merge");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "changed" });
    expect(draft).toMatchObject({ reusedNodeIds: [], revalidationNodeIds: expect.arrayContaining(["root", "base", "base-skeleton", "base-impl"]) });
  });
  it("rolls back new revisions when audit persistence fails", async () => {
    const f = await fixture(); const d = await affiliation(f, "merge");
    const before = ["task_tree_revisions", "task_node_revisions", "task_nodes", "workflow_states", "runtime_states"].map(table => f.runtime.database.all(`SELECT * FROM ${table}`));
    f.runtime.database.run("CREATE TRIGGER fail_iteration BEFORE INSERT ON task_tree_iteration_records BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
    expect(() => f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "rollback" })).toThrow(/injected/);
    expect(["task_tree_revisions", "task_node_revisions", "task_nodes", "workflow_states", "runtime_states"].map(table => f.runtime.database.all(`SELECT * FROM ${table}`))).toEqual(before);
  });
  it("returns the same iteration after restart and rejects changed idempotency payloads", async () => {
    const f = await fixture(); const d = await affiliation(f, "merge");
    const input = { projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "retry" };
    const first = f.runtime.taskTreeDrafts.createDraft(input);
    f.runtime.close(); f.runtime = openRuntime(f.environment);
    expect(f.runtime.taskTreeDrafts.createDraft(input)).toEqual(first);
    expect(() => f.runtime.taskTreeDrafts.createDraft({ ...input, document: iterationDocument(["base", "other"]) })).toThrow(/different payload/);
  });
  it("propagates unknown prior proof to old dependency consumers", async () => {
    const document = iterationDocument(["base", "consumer"]);
    document.nodes.find(node => node.id === "consumer-impl")!.dependencies!.push("base-impl");
    const f = await completedTreeFixture({ document }); fixtures.push(f);
    const attemptId = f.runtime.database.get<{ id: string }>("SELECT id FROM execution_attempts WHERE task_node_id = 'base-impl'")!.id;
    f.runtime.database.run("DROP TRIGGER attempt_baselines_no_delete");
    f.runtime.database.run("DELETE FROM execution_attempt_artifact_baselines WHERE attempt_id = ?", attemptId);
    const d = await affiliation(f, "merge");
    const next = iterationDocument(["base", "consumer", "snapshots"]);
    next.nodes.find(node => node.id === "consumer-impl")!.dependencies!.push("base-impl");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: next, idempotencyKey: "unknown-dependency" });
    expect(draft).toMatchObject({ revalidationNodeIds: expect.arrayContaining(["base-impl", "consumer-impl", "consumer"]) });
  });
  it("includes new unlinked output paths in planned impact on old modules", async () => {
    const f = await fixture(); const d = await affiliation(f, "merge");
    const document = iterationDocument(["base", "snapshots"]);
    document.nodes.find(node => node.id === "snapshots-impl")!.expectedOutputs!.push("base.js");
    const result = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document, idempotencyKey: "shared-unlinked-path" });
    expect(result).toMatchObject({ revalidationNodeIds: expect.arrayContaining(["base-skeleton", "base-impl", "base"]) });
  });
  it("uses project-level post-delivery mutation facts even if bytes were restored", async () => {
    const f = await fixture(); const file = path.join(f.projectDir, "base.js");
    await writeFile(file, "intermediate direct edit"); await writeFile(file, "export const value = 1;\n");
    const trace = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Edit", tool_use_id: "direct-after-delivery", tool_input: { file_path: "base.js" }, tool_response: { ok: true } }));
    expect(trace).toMatchObject({ recorded: true });
    const d = await affiliation(f, "merge");
    const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "direct-mutated" });
    expect(draft).toMatchObject({ revalidationNodeIds: expect.arrayContaining(["base-impl", "base-skeleton"]) });
  });
  it("cannot borrow an affiliation answer from work before this delivery completed", async () => {
    let oldDecision = "";
    const f = await completedTreeFixture({ beforeRoot: async current => { oldDecision = (await affiliation(current, "merge")).decisionId; } }); fixtures.push(f);
    expect(() => f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: oldDecision, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "borrowed-old-answer" })).toThrow(/completed delivery/);
  });
});
