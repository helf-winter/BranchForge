import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { affiliation, approveIteration, completedTreeFixture, executeToReport, iterationDocument } from "../helpers/completed-tree-fixture.js";

const fixtures: Awaited<ReturnType<typeof completedTreeFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });

async function plannedImplementation(relation: "implements" | "modifies" | "reads" | "verifies" = "implements", literalOutput = false, sharedFile = false) {
  const f = await completedTreeFixture(); fixtures.push(f);
  const decision = await affiliation(f, "merge");
  const document = iterationDocument(["base", "snapshots"]);
  document.nodes.find(node => node.id === "snapshots-impl")!.expectedOutputs = [literalOutput ? "snapshots.js" : "snapshots.js 完整实现"];
  document.artifactLinks!.find(link => link.taskNodeId === "snapshots-impl")!.relationType = relation;
  document.artifactLinks!.push(
    { taskNodeId: "snapshots-skeleton", artifactId: "snapshots-api", relationType: "creates" },
    { taskNodeId: "snapshots-impl", artifactId: "snapshots-api", relationType: "implements" },
  );
  if (sharedFile) {
    document.nodes.find(node => node.id === "snapshots-impl")!.expectedOutputs!.push("base.js");
    document.artifactLinks!.push({ taskNodeId: "snapshots-impl", artifactId: "base-file", relationType: "modifies" });
  }
  f.revisionId = f.runtime.taskTreeDrafts.createDraft({ projectId: f.projectId, sessionId: f.sessionId, affiliationDecisionId: decision.decisionId, expectedTreeRevisionId: f.revisionId, document, idempotencyKey: "planned-implementation" }).revisionId;
  await approveIteration(f);
  return f;
}

async function mutate(f: Awaited<ReturnType<typeof plannedImplementation>>, filename = "snapshots.js", sessionId = f.sessionId) {
  await writeFile(path.join(f.projectDir, filename), "export const value = 2;\n");
  return f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: sessionId, cwd: f.projectDir, tool_name: "Write", tool_use_id: `implementation-write-${++f.sequence}`, tool_input: { file_path: filename }, tool_response: { ok: true } }));
}

function state(f: Awaited<ReturnType<typeof plannedImplementation>>) {
  return {
    stage: f.runtime.database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ?", f.treeId)!.stage,
    skeleton: f.runtime.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE tree_id = ? AND id = 'snapshots-skeleton'", f.treeId)!.status,
    attempt: f.runtime.database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE tree_id = ? AND task_node_id = 'snapshots-impl' ORDER BY rowid DESC LIMIT 1", f.treeId)!.status,
  };
}

// Stop a temp fixture exactly at the writer, without manufacturing successful
// evidence or letting the execution helper automatically repair an invalidation.
async function atWriter(f: Awaited<ReturnType<typeof plannedImplementation>>, action: () => Promise<void>) {
  const stopped = new Error("fixture paused at implementation");
  try {
    await executeToReport(f, "unused-report", { onNode: async nodeId => {
      if (nodeId !== "snapshots-impl") return;
      await action(); throw stopped;
    } });
    throw new Error("fixture never reached implementation");
  } catch (error) {
    if (error !== stopped) throw error;
  }
}

describe("same-branch planned implementation freshness", () => {
  it.each(["implements", "modifies"] as const)("uses approved %s links despite descriptive expectedOutputs, then verifies the implementation", async relation => {
    const f = await plannedImplementation(relation); let wrote = false;
    const report = await executeToReport(f, `report-${relation}`, { onNode: async nodeId => {
      if (nodeId !== "snapshots-impl" || wrote) return;
      wrote = true; expect(state(f)).toEqual({ stage: "branch_implementation", skeleton: "succeeded", attempt: "running" });
      await mutate(f);
      expect(state(f)).toEqual({ stage: "branch_implementation", skeleton: "succeeded", attempt: "running" });
      const nextEdit = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PreToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Edit", tool_use_id: "next-planned-edit", tool_input: { file_path: "snapshots.js" } }));
      expect(nextEdit).toMatchObject({ recorded: true, violation: false });
    } });
    expect(wrote).toBe(true);
    expect(report.status).toBe("completed");
    expect(f.runtime.database.all("SELECT id FROM execution_attempts WHERE tree_id = ? AND task_node_id = 'snapshots-skeleton'", f.treeId)).toHaveLength(1);
    expect(f.runtime.database.all("SELECT id FROM evaluations WHERE tree_id = ? AND task_node_id = 'snapshots-impl' AND verdict = 'succeeded'", f.treeId)).toHaveLength(1);
  });

  it("retains exact-path legacy output support for a bound running implementation", async () => {
    const f = await plannedImplementation("reads", true);
    await atWriter(f, async () => { await mutate(f); expect(state(f)).toEqual({ stage: "branch_implementation", skeleton: "succeeded", attempt: "running" }); });
  });

  it("does not replace new implementation evidence with preserved skeleton proof", async () => {
    const f = await plannedImplementation();
    await atWriter(f, async () => {
      await mutate(f);
      const attempt = f.runtime.database.get<{ id: string }>("SELECT id FROM execution_attempts WHERE tree_id = ? AND task_node_id = 'snapshots-impl' AND status = 'running'", f.treeId)!;
      f.runtime.executions.beginVerification({ projectId: f.projectId, attemptId: attempt.id, expectedStatus: "running" });
      const result = f.runtime.evaluations.evaluateAttempt({ projectId: f.projectId, attemptId: attempt.id, proposedVerdict: "succeeded", riskSummary: null });
      expect(result.evaluation).toMatchObject({ verdict: "uncertain", missingRequiredEvidence: ["snapshots-impl-test"] });
      expect(f.runtime.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE tree_id = ? AND id = 'snapshots-impl'", f.treeId)!.status).not.toBe("succeeded");
    });
  });

  it.each(["reads", "verifies"] as const)("does not treat %s links with descriptive outputs as write authority", async relation => {
    const f = await plannedImplementation(relation);
    await atWriter(f, async () => { await mutate(f); expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" }); });
  });

  it("does not lend an active implementation to another session, even with a literal output", async () => {
    const f = await plannedImplementation("implements", true);
    await atWriter(f, async () => { await mutate(f, "snapshots.js", "external-session"); expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" }); });
  });

  it("invalidates writes after beginVerification, even with a literal output", async () => {
    const f = await plannedImplementation("implements", true);
    await atWriter(f, async () => {
      const attempt = f.runtime.database.get<{ id: string }>("SELECT id FROM execution_attempts WHERE tree_id = ? AND task_node_id = 'snapshots-impl' AND status = 'running'", f.treeId)!;
      f.runtime.executions.beginVerification({ projectId: f.projectId, attemptId: attempt.id, expectedStatus: "running" });
      await mutate(f);
      expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" });
    });
  });

  it("does not exempt a selected implementation without a running Attempt", async () => {
    const f = await plannedImplementation("implements", true);
    await atWriter(f, async () => {
      const attempt = f.runtime.database.get<{ id: string }>("SELECT id FROM execution_attempts WHERE tree_id = ? AND task_node_id = 'snapshots-impl' AND status = 'running'", f.treeId)!;
      f.runtime.executions.abortAttempt({ projectId: f.projectId, attemptId: attempt.id, expectedStatus: "running" });
      await mutate(f);
      expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" });
    });
  });

  it("does not exempt a delayed Trace from before the current Attempt", async () => {
    const f = await plannedImplementation("implements", true);
    await atWriter(f, async () => {
      await writeFile(path.join(f.projectDir, "snapshots.js"), "export const value = 3;\n");
      await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, timestamp: "2000-01-01T00:00:00.000Z", tool_name: "Edit", tool_use_id: "old-write", tool_input: { file_path: "snapshots.js" }, tool_response: { ok: true } }));
      expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" });
    });
  });

  it("does not exempt baseline-stale observations just because the fallback names a running writer", async () => {
    const f = await plannedImplementation("implements", true);
    await atWriter(f, async () => {
      const artifact = f.runtime.database.get<{ artifact_id: string }>("SELECT artifact_id FROM task_node_artifact_links WHERE tree_revision_id = ? AND task_node_id = 'snapshots-skeleton' AND relation_type = 'creates'", f.revisionId)!;
      // Controlled observation fact in a temporary SQLite, not a file-tool Hook.
      f.runtime.database.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key) VALUES ('stale-observation', ?, ?, 'snapshots-impl', ?, 'verification_baseline_stale', '{}', '{}', ?, 'stale-observation')", f.projectId, f.treeId, f.sessionId, new Date().toISOString());
      f.runtime.database.transaction(() => f.runtime.freshness.invalidateMutationWithinTransaction({ projectId: f.projectId, treeId: f.treeId, sourceTraceEventId: "stale-observation", artifactId: artifact.artifact_id, fallbackNodeId: "snapshots-impl" }));
      expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" });
    });
  });

  it("does not apply file implementation authority to a contract Artifact", async () => {
    const f = await plannedImplementation();
    await atWriter(f, async () => {
      const trace = await mutate(f);
      if (!trace.recorded) throw new Error("File mutation Trace missing");
      const contract = f.runtime.database.get<{ artifact_id: string }>("SELECT l.artifact_id FROM task_node_artifact_links l JOIN artifacts a ON a.id = l.artifact_id WHERE l.tree_revision_id = ? AND l.task_node_id = 'snapshots-skeleton' AND a.kind = 'contract'", f.revisionId)!;
      f.runtime.database.transaction(() => f.runtime.freshness.invalidateMutationWithinTransaction({ projectId: f.projectId, treeId: f.treeId, sourceTraceEventId: trace.eventId, artifactId: contract.artifact_id, fallbackNodeId: "snapshots-impl" }));
      expect(state(f)).toEqual({ stage: "skeleton_pass", skeleton: "needs_revalidation", attempt: "aborted" });
    });
  });

  it("still invalidates other branches when their skeleton file is changed", async () => {
    const f = await plannedImplementation("implements", false, true);
    await atWriter(f, async () => {
      await mutate(f, "base.js");
      expect(f.runtime.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE tree_id = ? AND id = 'base-skeleton'", f.treeId)!.status).toBe("needs_revalidation");
      expect(state(f).stage).toBe("skeleton_pass");
      expect(state(f).attempt).toBe("aborted");
    });
  });
});
