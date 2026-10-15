import { afterEach, describe, expect, it } from "vitest";
import { affiliation, approveIteration, completedTreeFixture, executeToReport, iterationDocument } from "../helpers/completed-tree-fixture.js";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
const fixtures: Awaited<ReturnType<typeof completedTreeFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function reopened(changed = false) {
  const f = await completedTreeFixture(); fixtures.push(f);
  if (changed) await writeFile(path.join(f.projectDir, "base.js"), "external mutation");
  const d = await affiliation(f, "merge");
  const draft = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"]), idempotencyKey: "increment" });
  f.revisionId = draft.revisionId;
  return f;
}
describe("iteration execution eligibility", () => {
  it("inherits proven branches while executing only new leaves and a new root", async () => {
    const f = await reopened();
    expect(f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId })).toBeNull();
    await approveIteration(f);
    expect(f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId })?.nodeId).toBe("snapshots-skeleton");
    const report = await executeToReport(f, "second-report");
    expect(report.summary).toMatchObject({ taskNodes: { succeeded: 7 } });
    expect(f.runtime.database.all("SELECT id FROM execution_attempts WHERE task_node_id = 'base-impl'")).toHaveLength(1);
    expect(f.runtime.database.all("SELECT id FROM workflow_phase_gate_results WHERE tree_revision_id = ? AND branch_node_id = 'base'", f.revisionId)).toHaveLength(0);
  });
  it("schedules changed old inputs explicitly for revalidation and can finish", async () => {
    const f = await reopened(true); await approveIteration(f);
    expect(f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId })).toMatchObject({ nodeId: "base-skeleton", executionPurpose: "revalidation" });
    expect((await executeToReport(f, "changed-report")).status).toBe("completed");
  });
  it("does not accept old success when the current iteration has no grant", async () => {
    const f = await reopened();
    f.runtime.database.run("DROP TRIGGER tree_iterations_no_update"); f.runtime.database.run("UPDATE task_tree_iteration_records SET reuse_json = '[]'");
    await approveIteration(f);
    const gate = f.runtime.skeletonGates.evaluate({ projectId: f.projectId, treeId: f.treeId, workflowRevision: f.runtime.database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE tree_id = ?", f.treeId)!.revision });
    expect(gate.branches.find(branch => branch.branchNodeId === "base")?.succeededAttemptIds).toEqual([]);
  });
  it("finishes a legacy iteration whose branches are aggregate containers, without a fabricated container Attempt", async () => {
    const f = await completedTreeFixture({ containers: true }); fixtures.push(f);
    f.runtime.database.run("DROP TRIGGER report_baselines_no_delete"); f.runtime.database.run("DELETE FROM final_report_artifact_baselines");
    const d = await affiliation(f, "merge");
    f.revisionId = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document: iterationDocument(["base", "snapshots"], true), idempotencyKey: "container-legacy" }).revisionId;
    await approveIteration(f);
    expect((await executeToReport(f, "container-second")).status).toBe("completed");
    expect(f.runtime.database.all("SELECT id FROM execution_attempts WHERE task_node_id = 'base'")).toEqual([]);
  });
  it("does not lose the reuse boundary after normal refinement of an active iteration", async () => {
    const f = await reopened();
    f.runtime.database.run("DROP TRIGGER tree_iterations_no_update"); f.runtime.database.run("UPDATE task_tree_iteration_records SET reuse_json = '[]'");
    const document = iterationDocument(["base", "snapshots"]); document.nodes.find(node => node.id === "snapshots")!.title = "Snapshot storage";
    f.revisionId = f.runtime.taskTrees.saveDraftRevision({ projectId: f.projectId, treeId: f.treeId, baseRevisionId: f.revisionId, document }).revisionId;
    await approveIteration(f);
    const gate = f.runtime.skeletonGates.evaluate({ projectId: f.projectId, treeId: f.treeId, workflowRevision: f.runtime.database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE tree_id = ?", f.treeId)!.revision });
    expect(gate.branches.find(branch => branch.branchNodeId === "base")?.succeededAttemptIds).toEqual([]);
  });
  it("notices a file changed after reopen but before approval", async () => {
    const f = await reopened(); await writeFile(path.join(f.projectDir, "base.js"), "changed after draft");
    await approveIteration(f);
    expect(f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId })).toMatchObject({ nodeId: "base-skeleton", executionPurpose: "revalidation" });
    expect((await executeToReport(f, "late-mutation")).status).toBe("completed");
  });
  it("records invalidation of a reused source even after changed bytes make its baseline stale", async () => {
    const f = await reopened(); await approveIteration(f);
    const old = f.runtime.database.get<{ id: string }>("SELECT id FROM evaluations WHERE task_node_id = 'base-impl' AND verdict = 'succeeded'")!.id;
    await writeFile(path.join(f.projectDir, "base.js"), "mutation after approval");
    await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Edit", tool_use_id: "late-file-edit", tool_input: { file_path: "base.js" }, tool_response: { ok: true } }));
    expect(f.runtime.freshness.list(f.projectId, { treeId: f.treeId }).flatMap(item => item.invalidatedEvaluationIds)).toContain(old);
  });
  it("can append a feature that modifies an old artifact and revalidate without overwriting that feature", async () => {
    const f = await completedTreeFixture(); fixtures.push(f); const d = await affiliation(f, "merge");
    const document = iterationDocument(["base", "snapshots"]);
    document.nodes.find(node => node.id === "snapshots-impl")!.expectedOutputs!.push("base.js");
    document.artifactLinks!.push({ taskNodeId: "snapshots-impl", artifactId: "base-file", relationType: "modifies" });
    f.revisionId = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: d.decisionId, expectedTreeRevisionId: f.revisionId, document, idempotencyKey: "shared-file" }).revisionId;
    await approveIteration(f);
    let changed = false;
    const report = await executeToReport(f, "shared-file-report", { onNode: async nodeId => {
      if (nodeId !== "snapshots-impl" || changed) return; changed = true;
      await writeFile(path.join(f.projectDir, "base.js"), "export const value = 2;\n");
      await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Edit", tool_use_id: "feature-modifies-existing-module", tool_input: { file_path: "base.js" }, tool_response: { ok: true } }));
    } });
    expect(report.status).toBe("completed");
    expect(await readFile(path.join(f.projectDir, "base.js"), "utf8")).toBe("export const value = 2;\n");
  });
  it.each(["root_verification", "final_report"])("reconciles a late external edit at %s without mutating read-only scheduling", async stage => {
    const f = await reopened(); await approveIteration(f);
    const mutate = async () => {
      await writeFile(path.join(f.projectDir, "base.js"), "export const value = 3;\n");
      const before = f.runtime.database.all("SELECT * FROM workflow_states");
      f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId });
      expect(f.runtime.database.all("SELECT * FROM workflow_states")).toEqual(before);
    };
    const report = await executeToReport(f, `external-${stage}`, stage === "root_verification" ? { beforeRoot: mutate } : { beforeFinalize: mutate });
    expect(report.status).toBe("completed");
    const observations = f.runtime.database.all<{ event_name: string }>("SELECT event_name FROM trace_events WHERE event_name = 'verification_baseline_stale'");
    expect(observations.length).toBeGreaterThan(0);
    expect(await readFile(path.join(f.projectDir, "base.js"), "utf8")).toBe("export const value = 3;\n");
  });
  it("revalidates implicit contract consumers after a later provider write", async () => {
    const initial = iterationDocument(["base", "consumer"]);
    initial.artifactContracts!.find(contract => contract.id === "base-contract")!.consumerNodeIds.push("consumer-impl");
    const f = await completedTreeFixture({ document: initial }); fixtures.push(f);
    const decision = await affiliation(f, "merge");
    const document = iterationDocument(["base", "consumer", "snapshots"]);
    document.artifactContracts!.find(contract => contract.id === "base-contract")!.consumerNodeIds.push("consumer-impl");
    document.nodes.find(node => node.id === "snapshots-impl")!.expectedOutputs!.push("base.js");
    document.artifactLinks!.push({ taskNodeId: "snapshots-impl", artifactId: "base-file", relationType: "modifies" });
    f.revisionId = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: decision.decisionId, expectedTreeRevisionId: f.revisionId, document, idempotencyKey: "implicit-contract" }).revisionId;
    await approveIteration(f); let changed = false;
    await executeToReport(f, "consumer-current-report", { onNode: async nodeId => {
      if (nodeId !== "snapshots-impl" || changed) return; changed = true;
      await writeFile(path.join(f.projectDir, "base.js"), "export const value = 4;\n");
      await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Edit", tool_use_id: "provider-file-edited", tool_input: { file_path: "base.js" }, tool_response: { ok: true } }));
    } });
    expect(f.runtime.database.all("SELECT id FROM execution_attempts WHERE task_node_id = 'consumer-impl'")).toHaveLength(3);
  });
});
