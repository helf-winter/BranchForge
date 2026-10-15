import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runCli } from "../../src/cli/main.js";
import { backupRuntimeDatabase } from "../../src/storage/backup.js";
import { openRuntime } from "../../src/application/runtime.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function legacyFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-identity-repair-"));
  directories.push(directory);
  const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: directory };
  const runtime = openRuntime(environment);
  const db = runtime.database;
  const projectDirectory = path.join(directory, "counter");
  await mkdir(projectDirectory);
  const plan: TaskTreeDocument = { nodes: [
    { id: "root", parentId: null, title: "Counter acceptance", children: ["branch"], executionPhase: "verification", requiredEvidence: [{ key: "root-test", description: "Root acceptance test" }] },
    { id: "branch", parentId: "root", title: "Counter branch", children: ["leaf"] },
    { id: "leaf", parentId: "branch", title: "Counter implementation", children: [], executionPhase: "implementation", requiredEvidence: [{ key: "test", description: "Test" }] },
  ], relations: [], artifacts: [] };
  db.run("INSERT INTO projects (id,canonical_path,created_at,updated_at) VALUES ('old-p','/old','now','now'),('counter-p',?,'now','now')", projectDirectory);
  db.run("INSERT INTO task_trees (id,project_id,title,status,current_revision_id,created_at,updated_at) VALUES ('old-tree','old-p','Archived beads','archived','old-r','now','now'),('counter-tree','counter-p','Counter','confirmed','counter-r','now','now')");
  db.run("INSERT INTO task_tree_revisions (id,tree_id,revision,document_json,created_at) VALUES ('old-r','old-tree',1,?,'now'),('counter-r','counter-tree',4,?,'now')", JSON.stringify({ nodes: [plan.nodes[0]], relations: [], artifacts: [] }), JSON.stringify(plan));
  db.run("INSERT INTO task_nodes (id,tree_id,parent_id,title,status) VALUES ('root','old-tree',NULL,'Original beads root','succeeded'),('branch','counter-tree','root','Counter branch','succeeded'),('leaf','counter-tree','branch','Counter implementation','succeeded')");
  db.run("INSERT INTO task_node_revisions (id,node_id,tree_revision_id,body_json,created_at) VALUES ('old-root-r','root','old-r',?,'now')", JSON.stringify(plan.nodes[0]));
  for (const node of plan.nodes) {
    db.run("INSERT INTO task_node_revisions (id,node_id,tree_revision_id,body_json,created_at) VALUES (?,?, 'counter-r',?,'now')", `counter-${node.id}-r`, node.id, JSON.stringify(node));
    db.run("INSERT INTO task_node_confirmation_states (project_id,tree_id,tree_revision_id,task_node_id,state,updated_at) VALUES ('counter-p','counter-tree','counter-r',?,'confirmed','now')", node.id);
  }
  db.run("INSERT INTO workflow_states (id,project_id,tree_id,stage,revision,active,updated_at) VALUES ('counter-w','counter-p','counter-tree','root_verification',39,1,'now')");
  db.run("INSERT INTO workflow_branch_states (project_id,tree_id,tree_revision_id,branch_node_id,branch_order,status,updated_at) VALUES ('counter-p','counter-tree','counter-r','branch',0,'verified','now')");
  return { runtime, db, plan, environment, directory, projectDirectory };
}

describe("audited legacy node identity recovery", () => {
  it("exposes preview separately from explicit revision-bound CLI apply with a non-overwriting backup", async () => {
    const f = await legacyFixture();
    f.runtime.close();
    const legacy = new DatabaseSync(path.join(f.directory, "runtime.db"));
    legacy.exec("DROP TABLE task_tree_iteration_records; DROP TABLE final_report_artifact_baselines; DROP TABLE execution_attempt_artifact_baselines; DROP VIEW runtime_task_tree_revisions; DROP VIEW runtime_task_node_revisions; DROP TABLE task_node_revision_identity_projections; DROP TABLE task_tree_revision_identity_projections; DROP TABLE task_node_identity_repairs; DELETE FROM schema_migrations WHERE version>=26;");
    legacy.close();
    const previousDataHome = process.env.AGENT_HARNESS_DATA_HOME;
    process.env.AGENT_HARNESS_DATA_HOME = f.directory;
    let output = "";
    const writer = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    const backup = path.join(f.directory, "before-recovery.db");
    try {
      const args = ["tree", "repair-identities", "counter-tree", "--cwd", f.projectDirectory, "--json"];
      expect(await runCli(args)).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ canApply: true, conflicts: [{ logicalNodeId: "root" }] });
      const inspected = new DatabaseSync(path.join(f.directory, "runtime.db"), { readOnly: true });
      expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 25 });
      inspected.close();
      output = "";
      expect(await runCli([...args, "--apply", "--expected-revision", "counter-r", "--backup", backup])).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ status: "applied", backupPath: backup });
      const snapshot = new DatabaseSync(backup, { readOnly: true });
      expect(snapshot.prepare("SELECT COUNT(*) AS count FROM task_node_identity_repairs").get()).toMatchObject({ count: 0 });
      expect(snapshot.prepare("SELECT parent_id FROM task_nodes WHERE id='branch'").get()).toMatchObject({ parent_id: "root" });
      snapshot.close();
      expect(() => backupRuntimeDatabase(path.join(f.directory, "runtime.db"), backup)).toThrow(expect.objectContaining({ code: "invalid_input" }));
      expect(() => backupRuntimeDatabase(path.join(f.directory, "runtime.db"), path.join(f.directory, "runtime.db"))).toThrow(expect.objectContaining({ code: "invalid_input" }));
      output = "";
      expect(await runCli([...args, "--apply", "--expected-revision", "counter-r", "--backup", backup])).toBe(1);
    } finally {
      writer.mockRestore();
      if (previousDataHome === undefined) delete process.env.AGENT_HARNESS_DATA_HOME;
      else process.env.AGENT_HARNESS_DATA_HOME = previousDataHome;
    }
  });
  it("restores root scheduling without rewriting revision facts or stealing the archived root", async () => {
    const f = await legacyFixture();
    try {
      expect(f.runtime.scheduler.next({ projectId: "counter-p", treeId: "counter-tree" })).toBeNull();
      expect(f.runtime).toHaveProperty("nodeIdentities");
      const input = { projectId: "counter-p", treeId: "counter-tree" };
      const originalPlan = f.db.get<{ document_json: string }>("SELECT document_json FROM task_tree_revisions WHERE id='counter-r'")!.document_json;
      const preview = f.runtime.nodeIdentities.preview(input);
      expect(preview).toMatchObject({ canApply: true, treeRevisionId: "counter-r", conflicts: [{ logicalNodeId: "root", ownerTreeId: "old-tree", canonicalNodeId: "node:counter-tree:root" }] });
      const applied = f.runtime.nodeIdentities.apply({ ...input, expectedTreeRevisionId: "counter-r" });
      expect(applied).toMatchObject({ status: "applied", treeRevisionId: "counter-r" });
      expect(f.db.get("SELECT document_json FROM task_tree_revisions WHERE id='counter-r'")).toEqual({ document_json: originalPlan });
      expect(f.db.get("SELECT node_id,body_json FROM task_node_revisions WHERE id='counter-root-r'")).toEqual({ node_id: "root", body_json: JSON.stringify(f.plan.nodes[0]) });
      expect(f.db.get("SELECT tree_id,title,status FROM task_nodes WHERE id='root'")).toEqual({ tree_id: "old-tree", title: "Original beads root", status: "succeeded" });
      expect(f.runtime.scheduler.next(input)).toMatchObject({ nodeId: "node:counter-tree:root", treeRevisionId: "counter-r", stage: "root_verification" });
      const root = f.runtime.executions.startAttempt({ projectId: "counter-p", nodeId: "node:counter-tree:root", expectedTreeRevisionId: "counter-r" });
      expect(root).toMatchObject({ nodeId: "node:counter-tree:root", treeRevisionId: "counter-r", workflowRevision: 39, status: "running" });
      expect(f.db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally { f.runtime.close(); }
  });

  it("refuses stale revisions and cross-project requests without changing state", async () => {
    const f = await legacyFixture();
    try {
      expect(f.runtime).toHaveProperty("nodeIdentities");
      expect(() => f.runtime.nodeIdentities.apply({ projectId: "counter-p", treeId: "counter-tree", expectedTreeRevisionId: "old-r" })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
      expect(() => f.runtime.nodeIdentities.preview({ projectId: "old-p", treeId: "counter-tree" })).toThrow(expect.objectContaining({ code: "not_found" }));
      expect(f.db.get("SELECT COUNT(*) AS count FROM task_node_identity_repairs")).toEqual({ count: 0 });
      expect(f.db.get("SELECT tree_id FROM task_nodes WHERE id='root'")).toEqual({ tree_id: "old-tree" });
    } finally { f.runtime.close(); }
  });

  it.each(["active", "executed", "contract"])("refuses unsafe legacy recovery (%s)", async (reason) => {
    const f = await legacyFixture();
    try {
      if (reason === "active") f.db.run("INSERT INTO execution_attempts (id,project_id,tree_id,task_node_id,task_node_revision_id,attempt_number,status,started_at) VALUES ('unsafe','counter-p','counter-tree','leaf','counter-leaf-r',1,'running','now')");
      if (reason === "executed") f.db.run("INSERT INTO execution_attempts (id,project_id,tree_id,task_node_id,task_node_revision_id,attempt_number,status,started_at) VALUES ('unsafe','counter-p','counter-tree','root','counter-root-r',1,'aborted','now')");
      if (reason === "contract") {
        const plan = structuredClone(f.plan);
        plan.artifactContracts = [{ id: "root-contract", artifactId: "a", name: "Root contract", version: "1", compatibilityPolicy: "exact", schemaOrSignature: "root(): void", providerNodeIds: ["root"], consumerNodeIds: ["leaf"], validationRefs: ["root-test"] }];
        f.db.run("UPDATE task_tree_revisions SET document_json=? WHERE id='counter-r'", JSON.stringify(plan));
      }
      expect(f.runtime.nodeIdentities.preview({ projectId: "counter-p", treeId: "counter-tree" }).canApply).toBe(false);
      expect(() => f.runtime.nodeIdentities.apply({ projectId: "counter-p", treeId: "counter-tree", expectedTreeRevisionId: "counter-r" })).toThrow(expect.objectContaining({ code: "runtime_action_rejected" }));
      expect(f.db.get("SELECT COUNT(*) AS count FROM task_node_identity_repairs")).toEqual({ count: 0 });
    } finally { f.runtime.close(); }
  });

  it("rolls back every identity change when projection persistence fails", async () => {
    const f = await legacyFixture();
    try {
      f.db.run("CREATE TRIGGER injected_projection_failure BEFORE INSERT ON task_node_revision_identity_projections BEGIN SELECT RAISE(ABORT,'injected failure'); END");
      expect(() => f.runtime.nodeIdentities.apply({ projectId: "counter-p", treeId: "counter-tree", expectedTreeRevisionId: "counter-r" })).toThrow();
      expect(f.db.get("SELECT COUNT(*) AS count FROM task_node_identity_repairs")).toEqual({ count: 0 });
      expect(f.db.get("SELECT id FROM task_nodes WHERE id='node:counter-tree:root'")).toBeUndefined();
      expect(f.db.get("SELECT parent_id FROM task_nodes WHERE id='branch'")).toEqual({ parent_id: "root" });
      expect(f.db.get("SELECT task_node_id FROM task_node_confirmation_states WHERE tree_revision_id='counter-r' AND task_node_id='root'")).toEqual({ task_node_id: "root" });
    } finally { f.runtime.close(); }
  });

  it("refuses recovery when the same historical alias was a non-root node", async () => {
    const f = await legacyFixture();
    try {
      const prior = structuredClone(f.plan);
      prior.nodes[0]!.parentId = "different-root";
      prior.nodes.push({ id: "different-root", parentId: null, title: "Historical owner", children: ["root"] });
      f.db.run("INSERT INTO task_tree_revisions (id,tree_id,revision,document_json,created_at) VALUES ('unsafe-history','counter-tree',3,?,'before')", JSON.stringify(prior));
      const preview = f.runtime.nodeIdentities.preview({ projectId: "counter-p", treeId: "counter-tree" });
      expect(preview.canApply).toBe(false);
      expect(preview.blockers).toContain("historical_non_root_collision:root");
      expect(() => f.runtime.nodeIdentities.apply({ projectId: "counter-p", treeId: "counter-tree", expectedTreeRevisionId: "counter-r" })).toThrow(expect.objectContaining({ code: "runtime_action_rejected" }));
      expect(f.db.get("SELECT COUNT(*) AS count FROM task_tree_revision_identity_projections")).toEqual({ count: 0 });
    } finally { f.runtime.close(); }
  });

  it("persists immutable, idempotent recovery and resumes root verification after restart", async () => {
    const f = await legacyFixture();
    const input = { projectId: "counter-p", treeId: "counter-tree", expectedTreeRevisionId: "counter-r" };
    const applied = f.runtime.nodeIdentities.apply(input);
    expect(f.runtime.nodeIdentities.apply(input)).toMatchObject({ repairId: applied.repairId, reused: true });
    expect(() => f.db.run("UPDATE task_node_identity_repairs SET mapping_json='[]' WHERE id=?", applied.repairId)).toThrow();
    f.runtime.close();
    const reopened = openRuntime(f.environment);
    try {
      expect(reopened.scheduler.next(input)).toMatchObject({ nodeId: "node:counter-tree:root" });
      expect(reopened.taskTrees.getRevision("counter-p", "counter-tree").document.nodes[0]?.id).toBe("node:counter-tree:root");
      expect(reopened.queries.getTaskTreeSummary("counter-p", "counter-tree")).toMatchObject({ revision: 4, confirmationCounts: { confirmed: 3 } });
      const attempt = reopened.executions.startAttempt({ projectId: "counter-p", nodeId: "node:counter-tree:root", expectedTreeRevisionId: "counter-r" });
      const occurredAt = new Date(Date.now() + 1).toISOString();
      reopened.database.run("INSERT INTO trace_events (id,project_id,tree_id,node_id,session_id,event_name,payload_json,occurred_at,idempotency_key) VALUES ('root-proof','counter-p','counter-tree','node:counter-tree:root','test','PostToolUse',?,?,'root-proof')", JSON.stringify({ toolName: "Bash", toolInput: { command: "npm test" }, toolResponse: { exitCode: 0 } }), occurredAt);
      reopened.executions.attachEvidence({ projectId: "counter-p", attemptId: attempt.attemptId, requiredEvidenceKey: "root-test", traceEventId: "root-proof" });
      reopened.executions.beginVerification({ projectId: "counter-p", attemptId: attempt.attemptId, expectedStatus: "running" });
      reopened.evaluations.evaluateAttempt({ projectId: "counter-p", attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
      expect(reopened.workflowPhases.evaluate({ projectId: "counter-p", treeId: "counter-tree", workflowRevision: 39 })).toMatchObject({ status: "passed", nextStage: "final_report" });
      expect(reopened.finalReports.finalize({ projectId: "counter-p", treeId: "counter-tree", workflowRevision: 40, idempotencyKey: "identity-final" })).toMatchObject({ status: "completed" });
      expect(reopened.database.get("SELECT current_revision_id FROM task_trees WHERE id='counter-tree'")).toEqual({ current_revision_id: "counter-r" });
      expect(reopened.database.get("SELECT status FROM workflow_branch_states WHERE tree_id='counter-tree'")).toEqual({ status: "verified" });
    } finally { reopened.close(); }
  });
});
