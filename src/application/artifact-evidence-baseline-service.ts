import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ArtifactEvidenceBaseline, ProofBaseline } from "../domain/artifact-evidence-baseline.js";
import { HarnessError } from "../domain/errors.js";
import { nowIso } from "../domain/ids.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

export class ArtifactEvidenceBaselineService {
  constructor(private readonly database: RuntimeDatabase) {}
  captureStartWithinTransaction(input: { projectId: string; attemptId: string }): ProofBaseline {
    return this.captureAttempt(input, "start");
  }
  captureEndWithinTransaction(input: { projectId: string; attemptId: string }) {
    const baseline = this.captureAttempt(input, "end");
    const attempt = this.database.get<{ revision_id: string; task_node_id: string }>(`SELECT nr.tree_revision_id AS revision_id, a.task_node_id FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ? AND a.project_id = ?`, input.attemptId, input.projectId)!;
    // The immutable end row is not a cache authorizing later changed retries.
    const current = this.captureDocument(input.projectId, this.document(attempt.revision_id), attempt.task_node_id);
    const start = this.readAttempt(input.attemptId, "start");
    const changedArtifactIds = [...new Set([...(start?.artifacts ?? []), ...baseline.artifacts].filter(before => before.status === "known"
      && !current.artifacts.some(after => after.artifactId === before.artifactId && after.status === "known" && after.hash === before.hash)).map(item => item.artifactId))];
    return { baseline, changedArtifactIds };
  }
  saveReportBaselineWithinTransaction(input: { projectId: string; reportId: string; rootAttemptId: string | null }): void {
    const report = this.database.get<{ tree_id: string; tree_revision_id: string }>("SELECT tree_id, tree_revision_id FROM final_reports WHERE id = ? AND project_id = ?", input.reportId, input.projectId);
    if (!report) throw new HarnessError("not_found", "Report baseline requires a same-Project report");
    const attempt = input.rootAttemptId ? this.database.get<{ body_json: string }>(
      `SELECT nr.body_json FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ? AND a.project_id = ? AND a.tree_id = ? AND nr.tree_revision_id = ? AND a.status = 'succeeded'`, input.rootAttemptId, input.projectId, report.tree_id, report.tree_revision_id) : null;
    if (input.rootAttemptId && (!attempt || (JSON.parse(attempt.body_json) as { parentId?: string | null }).parentId !== null)) throw new HarnessError("evidence_scope_mismatch", "Report baseline requires this revision's successful root Attempt");
    let baseline = attempt && input.rootAttemptId ? this.readAttempt(input.rootAttemptId, "end") : null;
    if (baseline && input.rootAttemptId && !this.evidenceWithinWindow(input.rootAttemptId)) baseline = { artifacts: baseline.artifacts.map(item => ({ ...item, status: "unknown", hash: null, reason: "proof_window_unproven" })), environment: null };
    this.database.run("INSERT INTO final_report_artifact_baselines (report_id, root_attempt_id, baseline_json, created_at) VALUES (?, ?, ?, ?)",
      input.reportId, attempt ? input.rootAttemptId : null, canonicalJson(baseline ?? { artifacts: [], environment: null }), nowIso());
  }
  compareReport(input: { projectId: string; reportId: string; cwd?: string }) {
    const report = this.database.get<{ tree_revision_id: string; baseline_json: string | null }>(
      `SELECT r.tree_revision_id, b.baseline_json FROM final_reports r LEFT JOIN final_report_artifact_baselines b ON b.report_id = r.id WHERE r.id = ? AND r.project_id = ?`, input.reportId, input.projectId);
    if (!report) throw new HarnessError("not_found", "Final Report was not found in this Project");
    const document = this.document(report.tree_revision_id);
    const current = this.captureDocument(input.projectId, document, undefined, input.cwd);
    const prior = report.baseline_json ? JSON.parse(report.baseline_json) as ProofBaseline : null;
    const result = { unchangedArtifactIds: [] as string[], changedArtifactIds: [] as string[], unknownArtifactIds: [] as string[], environmentCompatible: Boolean(prior?.environment && canonicalJson(prior.environment) === canonicalJson(current.environment)) };
    for (const after of current.artifacts) {
      const before = prior?.artifacts.find(item => item.artifactId === after.artifactId);
      if (!before || before.status !== "known" || after.status !== "known") result.unknownArtifactIds.push(after.artifactId);
      else if (before.hash !== after.hash) result.changedArtifactIds.push(after.artifactId);
      else result.unchangedArtifactIds.push(after.artifactId);
    }
    return result;
  }
  private document(revisionId: string): TaskTreeDocument {
    return JSON.parse(this.database.get<{ document_json: string }>("SELECT document_json FROM runtime_task_tree_revisions WHERE id = ?", revisionId)?.document_json ?? "{}") as TaskTreeDocument;
  }
  isAttemptBaselineCurrent(input: { projectId: string; attemptId: string }): boolean {
    const attempt = this.database.get<{ revision_id: string; task_node_id: string }>(`SELECT nr.tree_revision_id AS revision_id, a.task_node_id FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ? AND a.project_id = ?`, input.attemptId, input.projectId);
    const prior = this.readAttempt(input.attemptId, "end");
    if (!attempt || !prior?.environment || !this.evidenceWithinWindow(input.attemptId)) return false;
    const current = this.captureDocument(input.projectId, this.document(attempt.revision_id), attempt.task_node_id);
    return canonicalJson(prior.environment) === canonicalJson(current.environment)
      && current.artifacts.every(after => after.status === "known" && prior.artifacts.some(before => before.artifactId === after.artifactId && before.status === "known" && before.hash === after.hash));
  }
  changedAttemptInputs(input: { projectId: string; attemptId: string }) {
    const attempt = this.database.get<{ revision_id: string; task_node_id: string }>(`SELECT nr.tree_revision_id AS revision_id, a.task_node_id FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ? AND a.project_id = ?`, input.attemptId, input.projectId);
    const prior = this.readAttempt(input.attemptId, "end");
    if (!attempt || !prior) return [];
    const current = this.captureDocument(input.projectId, this.document(attempt.revision_id), attempt.task_node_id);
    return current.artifacts.flatMap(after => {
      const before = prior.artifacts.find(item => item.artifactId === after.artifactId);
      return before?.status === "known" && (after.status !== "known" || after.hash !== before.hash) ? [{ ...after, previousHash: before.hash }] : [];
    });
  }
  private evidenceWithinWindow(attemptId: string): boolean {
    const rows = this.database.all<{ stage: string; created_at: string }>("SELECT stage, created_at FROM execution_attempt_artifact_baselines WHERE attempt_id = ?", attemptId);
    const start = rows.find(row => row.stage === "start")?.created_at;
    const end = rows.find(row => row.stage === "end")?.created_at;
    const node = this.database.get<{ body_json: string }>("SELECT nr.body_json FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ?", attemptId);
    const keys = node ? (JSON.parse(node.body_json) as { requiredEvidence?: Array<{ key: string }> }).requiredEvidence ?? [] : [];
    if (!start || !end || !keys.length) return false;
    return keys.every(key => this.database.get(`SELECT e.trace_event_id FROM execution_attempt_evidence e JOIN trace_events t ON t.id = e.trace_event_id WHERE e.attempt_id = ? AND e.required_evidence_key = ? AND t.occurred_at >= ? AND t.occurred_at <= ? LIMIT 1`, attemptId, key.key, start, end));
  }
  private readAttempt(attemptId: string, stage: "start" | "end"): ProofBaseline | null {
    const row = this.database.get<{ baseline_json: string }>("SELECT baseline_json FROM execution_attempt_artifact_baselines WHERE attempt_id = ? AND stage = ?", attemptId, stage);
    return row ? JSON.parse(row.baseline_json) as ProofBaseline : null;
  }
  private captureAttempt(input: { projectId: string; attemptId: string }, stage: "start" | "end"): ProofBaseline {
    const attempt = this.database.get<{ revision_id: string; task_node_id: string }>(
      `SELECT nr.tree_revision_id AS revision_id, a.task_node_id FROM execution_attempts a JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id WHERE a.id = ? AND a.project_id = ?`, input.attemptId, input.projectId);
    if (!attempt) throw new HarnessError("not_found", "Proof baseline requires a same-Project Attempt");
    const existing = this.readAttempt(input.attemptId, stage);
    if (existing) return existing;
    const baseline = this.captureDocument(input.projectId, this.document(attempt.revision_id), attempt.task_node_id);
    this.database.run("INSERT INTO execution_attempt_artifact_baselines (attempt_id, stage, baseline_json, created_at) VALUES (?, ?, ?, ?)", input.attemptId, stage, canonicalJson(baseline), nowIso());
    return baseline;
  }
  private captureDocument(projectId: string, document: TaskTreeDocument, nodeId?: string, cwd?: string): ProofBaseline {
    const project = this.database.get<{ canonical_path: string }>("SELECT canonical_path FROM projects WHERE id = ?", projectId);
    if (!project) throw new HarnessError("not_found", "Project was not found");
    // Never accept an arbitrary caller-supplied root in place of project identity.
    let root: string | null = null;
    try {
      root = realpathSync(project.canonical_path);
      if (cwd && realpathSync(cwd) !== root) throw new Error("unregistered cwd");
    } catch { root = null; }
    const nodes = document.nodes ?? [];
    const node = nodes.find(value => value.id === nodeId);
    const all = !nodeId || node?.parentId === null;
    const relevant = new Set<string>();
    const contractInputs = new Set<string>();
    const visit = (id: string): void => {
      if (relevant.has(id)) return; relevant.add(id);
      for (const dependency of nodes.find(value => value.id === id)?.dependencies ?? []) visit(dependency);
      for (const contract of document.artifactContracts ?? []) if (contract.consumerNodeIds.includes(id) || contract.providerNodeIds.includes(id)) {
        contractInputs.add(contract.artifactId);
        if (contract.consumerNodeIds.includes(id)) for (const provider of contract.providerNodeIds) visit(provider);
      }
    };
    if (nodeId) visit(nodeId);
    const linked = new Set((document.artifactLinks ?? []).filter(link => relevant.has(link.taskNodeId)).map(link => link.artifactId));
    for (const artifactId of contractInputs) linked.add(artifactId);
    const outputs = nodes.filter(value => all || relevant.has(value.id)).flatMap(value => value.expectedOutputs ?? []);
    const artifacts = (document.artifacts ?? []).filter(value => (value.kind === "file" || value.kind === "contract") && (all || linked.has(value.id) || outputs.includes(value.locator)));
    // Outputs not declared as Artifacts are still evidence inputs, not invisible files.
    const sources = [...artifacts, ...outputs.filter(locator => !artifacts.some(value => value.locator === locator)).map(locator => ({ id: `output:${locator}`, kind: "file" as const, locator }))];
    let budget = 64 * 1024 * 1024;
    const seen = new Set<string>();
    const captured: ArtifactEvidenceBaseline[] = [];
    for (const artifact of sources) {
      if (seen.has(artifact.id)) continue; seen.add(artifact.id);
      const item: ArtifactEvidenceBaseline = { artifactId: artifact.id, kind: artifact.kind as "file" | "contract", locator: artifact.locator, status: "unknown", hash: null, reason: "unreadable_or_missing" };
      try {
        let bytes: Buffer;
        if (artifact.kind === "contract") {
          const contract = document.artifactContracts?.find(value => value.artifactId === artifact.id);
          if (!contract) throw new Error("missing contract");
          bytes = Buffer.from(canonicalJson({ name: contract.name, version: contract.version, signature: contract.schemaOrSignature,
            policy: contract.compatibilityPolicy, providers: contract.providerNodeIds.map(id => nodes.find(value => value.id === id) ?? null), validationRefs: contract.validationRefs }));
        } else {
          if (!root) { item.reason = "project_root_unknown"; captured.push(item); continue; }
          const target = realpathSync(path.resolve(root, artifact.locator));
          const relative = path.relative(root, target);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { item.reason = "outside_project"; captured.push(item); continue; }
          const expected = statSync(target);
          const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fstatSync(fd);
            if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("path changed during capture");
            if (!stat.isFile()) throw new Error("not a regular file");
            if (stat.size > 16 * 1024 * 1024 || stat.size > budget) { item.reason = "size_budget_exceeded"; captured.push(item); continue; }
            // Opening the resolved path before hashing also fixes the identity of
            // the file read; it cannot follow a subsequently swapped symlink.
            bytes = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < bytes.length) {
              const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
              if (!read) throw new Error("file changed during capture"); offset += read;
            }
            const after = fstatSync(fd);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("file changed during capture");
            budget -= bytes.length;
          } finally { closeSync(fd); }
        }
        item.status = "known"; item.hash = createHash("sha256").update(bytes).digest("hex"); item.reason = null;
      } catch { /* Unknown is intentionally not reusable proof. */ }
      captured.push(item);
    }
    return { artifacts: captured, environment: { platform: process.platform, architecture: process.arch, nodeVersion: process.version } };
  }
}
