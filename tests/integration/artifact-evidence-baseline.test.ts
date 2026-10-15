import { mkdtemp, mkdir, writeFile, utimes, symlink, truncate, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDatabase } from "../../src/storage/database.js";
import { ArtifactEvidenceBaselineService } from "../../src/application/artifact-evidence-baseline-service.js";
import { NodeExecutionService } from "../../src/application/node-execution-service.js";
import { EvaluationService } from "../../src/application/evaluation-service.js";

const databases: RuntimeDatabase[] = [];
const directories: string[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(locator = "counter.js") {
  const dir = await mkdtemp(path.join(tmpdir(), "harness-proof-baseline-"));
  directories.push(dir);
  const projectDir = path.join(dir, "project"); await mkdir(projectDir);
  await writeFile(path.join(projectDir, "counter.js"), "export const count = 1;");
  const db = new RuntimeDatabase(path.join(dir, "runtime.db")); databases.push(db);
  db.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p', ?, '2026', '2026')", projectDir);
  db.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('t', 'p', 'Tree', 'confirmed', 'r', '2026', '2026')");
  const node = { id: "n", parentId: null, title: "Verify", children: [], executionPhase: "verification", expectedOutputs: [locator], requiredEvidence: [{ key: "test", description: "test" }] };
  db.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('r', 't', 1, ?, '2026')", JSON.stringify({ nodes: [node], relations: [], artifacts: [{ id: "file", kind: "file", locator }] }));
  db.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('n', 't', NULL, 'Verify', 'ready')");
  db.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('nr', 'n', 'r', ?, '2026')", JSON.stringify(node));
  db.run("INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES ('p', 't', 'r', 'n', 'confirmed', '2026')");
  db.run("INSERT INTO workflow_states (id, project_id, tree_id, stage, revision, active, updated_at) VALUES ('w', 'p', 't', 'root_verification', 1, 1, '2026')");
  const executions = new NodeExecutionService(db);
  const attempt = executions.startAttempt({ projectId: "p", nodeId: "n", expectedTreeRevisionId: "r" });
  return { db, dir, projectDir, executions, attempt, baselines: new ArtifactEvidenceBaselineService(db) };
}
describe("proof-time artifact baselines", () => {
  it("hashes project-local bytes, not mtime, and keeps immutable start/end records", async () => {
    const f = await fixture();
    const original = await stat(path.join(f.projectDir, "counter.js"));
    const start = f.baselines.captureStartWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId });
    expect(start.artifacts).toEqual([expect.objectContaining({ artifactId: "file", status: "known", hash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    await writeFile(path.join(f.projectDir, "counter.js"), "export const count = 2;");
    await utimes(path.join(f.projectDir, "counter.js"), original.atime, original.mtime);
    expect(f.baselines.captureEndWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId }).changedArtifactIds).toEqual(["file"]);
    expect(() => f.db.run("DELETE FROM execution_attempt_artifact_baselines")).toThrow(/immutable/);
  });
  it.each(["missing.js", "../outside.js", "large.js"])("marks %s unknown instead of minting proof", async locator => {
    const f = await fixture(locator);
    await writeFile(path.join(f.dir, "outside.js"), "secret");
    if (locator === "large.js") { await writeFile(path.join(f.projectDir, locator), ""); await truncate(path.join(f.projectDir, locator), 17 * 1024 * 1024); }
    expect(f.baselines.captureStartWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId }).artifacts[0]).toMatchObject({ status: "unknown", hash: null });
  });
  it("rejects a symlink outside the registered project before reading it", async () => {
    const f = await fixture("escape.js"); await writeFile(path.join(f.dir, "outside.js"), "secret");
    await symlink(path.join(f.dir, "outside.js"), path.join(f.projectDir, "escape.js"));
    expect(f.baselines.captureStartWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId }).artifacts[0]).toMatchObject({ status: "unknown", reason: "outside_project" });
  });
  it("refuses success if known inputs changed during actual verification", async () => {
    const f = await fixture();
    f.executions.beginVerification({ projectId: "p", attemptId: f.attempt.attemptId, expectedStatus: "running" });
    await writeFile(path.join(f.projectDir, "counter.js"), "changed during proof");
    f.db.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('proof', 'p', 't', 'n', 's', 'PostToolUse', '{}', '2099', 'proof')");
    f.executions.attachEvidence({ projectId: "p", attemptId: f.attempt.attemptId, requiredEvidenceKey: "test", traceEventId: "proof" });
    const result = new EvaluationService(f.db).evaluateAttempt({ projectId: "p", attemptId: f.attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(result.evaluation.verdict).toBe("uncertain"); expect(result.transition.applied).toBe(false);
  });
  it("does not reuse a cached end snapshot to approve a later changed verification window", async () => {
    const f = await fixture(); f.executions.beginVerification({ projectId: "p", attemptId: f.attempt.attemptId, expectedStatus: "running" });
    const evaluations = new EvaluationService(f.db);
    expect(evaluations.evaluateAttempt({ projectId: "p", attemptId: f.attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null }).evaluation.verdict).toBe("uncertain");
    await writeFile(path.join(f.projectDir, "counter.js"), "changed after first evaluation");
    f.db.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('retry-proof', 'p', 't', 'n', 's', 'PostToolUse', '{}', '2099', 'retry-proof')");
    f.executions.attachEvidence({ projectId: "p", attemptId: f.attempt.attemptId, requiredEvidenceKey: "test", traceEventId: "retry-proof" });
    expect(evaluations.evaluateAttempt({ projectId: "p", attemptId: f.attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null }).evaluation.verdict).toBe("uncertain");
  });
  it("does not mint reusable proof for a test run before the captured verification window", async () => {
    const f = await fixture();
    f.db.run("INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('earlier-proof', 'p', 't', 'n', 's', 'PostToolUse', '{}', '2026-01-01', 'earlier-proof')");
    // Fixture attaches controlled historic evidence directly; the lifecycle
    // still accepts existing evidence semantics, but reuse must be conservative.
    f.db.run("INSERT INTO execution_attempt_evidence (attempt_id, required_evidence_key, trace_event_id, created_at) VALUES (?, 'test', 'earlier-proof', '2026-01-01')", f.attempt.attemptId);
    f.executions.beginVerification({ projectId: "p", attemptId: f.attempt.attemptId, expectedStatus: "running" });
    expect(new EvaluationService(f.db).evaluateAttempt({ projectId: "p", attemptId: f.attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null }).transition.applied).toBe(true);
    expect(f.baselines.isAttemptBaselineCurrent({ projectId: "p", attemptId: f.attempt.attemptId })).toBe(false);
  });
  it("marks permission failures unknown and leaves source permissions unchanged", async () => {
    const f = await fixture(); const file = path.join(f.projectDir, "counter.js");
    await chmod(file, 0);
    try { expect(f.baselines.captureStartWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId }).artifacts[0]).toMatchObject({ status: "unknown", hash: null }); }
    finally { await chmod(file, 0o600); }
  });
  it("stops at the total 64 MiB capture budget", async () => {
    const f = await fixture(); const artifacts = [];
    for (let i = 0; i < 5; i++) {
      const locator = `part-${i}.js`; await writeFile(path.join(f.projectDir, locator), ""); await truncate(path.join(f.projectDir, locator), 16 * 1024 * 1024);
      artifacts.push({ id: `part-${i}`, kind: "file", locator });
    }
    f.db.run("UPDATE task_tree_revisions SET document_json = ? WHERE id = 'r'", JSON.stringify({ nodes: [{ id: "n", parentId: null, children: [] }], relations: [], artifacts }));
    const baseline = f.baselines.captureStartWithinTransaction({ projectId: "p", attemptId: f.attempt.attemptId });
    expect(baseline.artifacts.slice(0, 4).every(item => item.status === "known")).toBe(true);
    expect(baseline.artifacts[4]).toMatchObject({ status: "unknown", reason: "size_budget_exceeded" });
  });
});
