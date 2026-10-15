import { HarnessError } from "../domain/errors.js";
import path from "node:path";
import { analyzeIncrementalStructure } from "../domain/task-tree-increment.js";
import { taskNodeEvidenceContext } from "../domain/task-node-evidence-context.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import { newId, nowIso } from "../domain/ids.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { ArtifactEvidenceBaselineService } from "./artifact-evidence-baseline-service.js";
import { normalizeDocumentNodeIdentity } from "./task-tree-identity.js";
import { isPriorEvaluationUsable, type EvidenceReuseGrant } from "./evidence-reuse-policy.js";
import { findUserDecisionEvidence } from "./user-decision-evidence.js";
import { TaskTreeService, type TaskTreeRevisionView } from "./task-tree-service.js";

export interface TaskTreeIterationView extends TaskTreeRevisionView {
  iterationId: string; baseRevisionId: string; baseReportId: string;
  addedNodeIds: string[]; reusedNodeIds: string[]; revalidationNodeIds: string[];
}
export interface IncrementalRevisionInput {
  projectId: string; treeId: string; baseRevisionId: string; document: TaskTreeDocument; affiliationDecisionId: string; sessionId: string;
}
export function requireIncrementalAuthority(database: RuntimeDatabase, input: IncrementalRevisionInput): string {
  const decision = database.get<{ answer_trace_event_id: string | null; created_at: string }>("SELECT answer_trace_event_id, created_at FROM task_affiliation_decisions WHERE id = ? AND project_id = ? AND status = 'merged' AND resolved_tree_id = ?", input.affiliationDecisionId, input.projectId, input.treeId);
  const trace = decision?.answer_trace_event_id ? findUserDecisionEvidence(database, input.projectId, decision.answer_trace_event_id) : null;
  if (!trace || trace.session_id !== input.sessionId) throw new HarnessError("evidence_scope_mismatch", "Incremental reopen requires an explicit same-Session merge answer");
  const tree = database.get<{ status: string; current_revision_id: string }>("SELECT status, current_revision_id FROM task_trees WHERE id = ? AND project_id = ?", input.treeId, input.projectId);
  if (!tree || tree.status !== "completed") throw new HarnessError("task_tree_transition_rejected", "Only a completed nonarchived Task Tree can open an iteration");
  if (tree.current_revision_id !== input.baseRevisionId) throw new HarnessError("revision_conflict", "Incremental planning requires the exact completed revision");
  const report = database.get<{ created_at: string }>("SELECT created_at FROM final_reports WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?", input.projectId, input.treeId, input.baseRevisionId);
  if (!report) throw new HarnessError("task_tree_transition_rejected", "Completed revision requires its immutable Final Report");
  if (decision!.created_at < report.created_at || trace.occurred_at < report.created_at) throw new HarnessError("confirmation_required", "Incremental merge requires a new choice after the completed delivery");
  if (database.get("SELECT id FROM execution_attempts WHERE project_id = ? AND status IN ('running', 'verifying') LIMIT 1", input.projectId)
    || database.get("SELECT id FROM workflow_states WHERE project_id = ? AND active = 1 LIMIT 1", input.projectId)
    || database.get("SELECT id FROM runtime_confirmation_prompts WHERE project_id = ? AND status = 'pending' LIMIT 1", input.projectId)
    || database.get("SELECT id FROM task_affiliation_decisions WHERE project_id = ? AND status = 'pending' LIMIT 1", input.projectId)
    || database.get("SELECT id FROM user_change_requests WHERE project_id = ? AND status IN ('proposed', 'pending_confirmation', 'paused') LIMIT 1", input.projectId)) throw new HarnessError("task_tree_transition_rejected", "Finish pending work before opening an incremental iteration");
  if (input.document.planningVersion !== 1) throw new HarnessError("invalid_input", "Incremental planning requires a full planningVersion 1 document");
  return trace.id;
}

export function iterationRevisionView(database: RuntimeDatabase, revision: TaskTreeRevisionView): TaskTreeRevisionView | TaskTreeIterationView {
  const row = database.get<{ id: string; base_revision_id: string; base_report_id: string; impact_json: string; reuse_json: string }>("SELECT * FROM task_tree_iteration_records WHERE result_revision_id = ?", revision.revisionId);
  if (!row) return revision;
  const impact = JSON.parse(row.impact_json) as { addedNodeIds: string[]; revalidationNodeIds: string[] };
  return { ...revision, iterationId: row.id, baseRevisionId: row.base_revision_id, baseReportId: row.base_report_id, ...impact, reusedNodeIds: (JSON.parse(row.reuse_json) as EvidenceReuseGrant[]).map(item => item.nodeId) };
}

export class TaskTreeIterationService {
  constructor(private readonly database: RuntimeDatabase, private readonly trees = new TaskTreeService(database)) {}
  reopenWithinTransaction(input: { projectId: string; sessionId: string; affiliationDecisionId: string; treeId: string; expectedTreeRevisionId: string; document: TaskTreeDocument; inputHash: string; cwd?: string }): TaskTreeIterationView {
    const args = { ...input, baseRevisionId: input.expectedTreeRevisionId };
    const answerTraceId = requireIncrementalAuthority(this.database, args);
    const document = normalizeDocumentNodeIdentity(this.database, input);
    const base = this.trees.getRevisionById(input.projectId, input.treeId, input.expectedTreeRevisionId);
    const structure = analyzeIncrementalStructure(base.document, document);
    if (!structure.allowed) throw new HarnessError("invalid_tree_structure", "Incremental planning must append branches without rewriting history", structure.blockers);
    const report = this.database.get<{ id: string; created_at: string }>("SELECT id, created_at FROM final_reports WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?", input.projectId, input.treeId, base.revisionId)!;
    const compared = new ArtifactEvidenceBaselineService(this.database).compareReport({ projectId: input.projectId, reportId: report.id, ...(input.cwd ? { cwd: input.cwd } : {}) });
    const affectedArtifacts = new Set([...compared.changedArtifactIds, ...compared.unknownArtifactIds]);
    const affected = new Set<string>([structure.rootNodeId]);
    const projectRoot = this.database.get<{ canonical_path: string }>("SELECT canonical_path FROM projects WHERE id = ?", input.projectId)!.canonical_path;
    const pathKey = (locator: string): string => path.resolve(projectRoot, locator.replaceAll("\\", "/"));
    const priorOutputPaths = new Set(base.document.nodes.flatMap(node => node.expectedOutputs ?? []).map(pathKey));
    for (const node of document.nodes) if (structure.addedNodeIds.includes(node.id) && ["skeleton", "implementation"].includes(node.executionPhase ?? "")) {
      for (const output of node.expectedOutputs ?? []) if (priorOutputPaths.has(pathKey(output))) {
        for (const old of base.document.nodes) for (const previous of old.expectedOutputs ?? []) if (pathKey(previous) === pathKey(output)) affectedArtifacts.add(`output:${previous}`);
        for (const artifact of base.document.artifacts) if (artifact.kind === "file" && pathKey(artifact.locator) === pathKey(output)) affectedArtifacts.add(artifact.id);
      }
    }
    for (const link of document.artifactLinks ?? []) if (structure.addedNodeIds.includes(link.taskNodeId) && ["modifies", "deletes"].includes(link.relationType)) affectedArtifacts.add(link.artifactId);
    for (const row of this.database.all<{ artifact_id: string; locator: string }>(`
      SELECT DISTINCT a.id AS artifact_id, a.locator FROM trace_events te, json_each(te.payload_json, '$.artifactRefs') ref JOIN artifacts a ON a.id = ref.value AND a.project_id = te.project_id
      WHERE te.project_id = ? AND te.occurred_at > ? AND te.event_name = 'PostToolUse' AND json_extract(te.payload_json, '$.toolName') IN ('Write', 'Edit', 'MultiEdit')
    `, input.projectId, report.created_at)) {
      for (const artifact of document.artifacts) if (artifact.id === row.artifact_id || artifact.locator === row.locator) affectedArtifacts.add(artifact.id);
      affectedArtifacts.add(`output:${row.locator}`);
    }
    for (const node of base.document.nodes) {
      if (!compared.environmentCompatible || taskNodeEvidenceContext(base.document, node.id) !== taskNodeEvidenceContext(document, node.id)) affected.add(node.id);
      if ((node.expectedOutputs ?? []).some(output => affectedArtifacts.has(`output:${output}`) || document.artifacts.some(artifact => artifact.locator === output && affectedArtifacts.has(artifact.id)))) affected.add(node.id);
    }
    const expandImpact = (): void => {
    let expanded = true;
    while (expanded) {
      const size = affected.size + affectedArtifacts.size;
      for (const relation of document.artifactRelations ?? []) if (affectedArtifacts.has(relation.fromArtifactId) || affectedArtifacts.has(relation.toArtifactId)) { affectedArtifacts.add(relation.fromArtifactId); affectedArtifacts.add(relation.toArtifactId); }
      for (const contract of document.artifactContracts ?? []) if (affectedArtifacts.has(contract.artifactId) || contract.providerNodeIds.some(id => affected.has(id))) { affectedArtifacts.add(contract.artifactId); for (const id of [...contract.providerNodeIds, ...contract.consumerNodeIds]) affected.add(id); }
      for (const link of document.artifactLinks ?? []) if (affectedArtifacts.has(link.artifactId)) affected.add(link.taskNodeId);
      for (const node of document.nodes) {
        if ((node.dependencies ?? []).some(id => affected.has(id)) || document.relations.some(relation => relation.kind === "depends_on" && relation.fromNodeId === node.id && affected.has(relation.toNodeId))) affected.add(node.id);
        if (affected.has(node.id) && node.parentId) affected.add(node.parentId);
      }
      expanded = size !== affected.size + affectedArtifacts.size;
    }
    };
    expandImpact();
    const grants: EvidenceReuseGrant[] = [];
    for (const node of base.document.nodes) {
      const source = this.database.all<{ id: string; execution_attempt_id: string }>("SELECT id, execution_attempt_id FROM evaluations WHERE project_id = ? AND tree_id = ? AND task_node_id = ? AND verdict = 'succeeded' ORDER BY created_at DESC, rowid DESC", input.projectId, input.treeId, node.id)
        .find(value => isPriorEvaluationUsable(this.database, { projectId: input.projectId, treeId: input.treeId, targetRevisionId: base.revisionId, nodeId: node.id, evaluationId: value.id }));
      if (!node.executionPhase && node.children.length) continue;
      if (affected.has(node.id) || !source || !new ArtifactEvidenceBaselineService(this.database).isAttemptBaselineCurrent({ projectId: input.projectId, attemptId: source.execution_attempt_id })) { affected.add(node.id); continue; }
      const gateIds = this.database.all<{ id: string }>("SELECT id FROM workflow_phase_gate_results WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND branch_node_id = ? AND status = 'passed'", input.projectId, input.treeId, base.revisionId, node.id).map(value => value.id);
      grants.push({ nodeId: node.id, evaluationId: source.id, attemptId: source.execution_attempt_id, gateIds });
    }
    // Unknown source proof is impact too, including its dependency consumers.
    expandImpact();
    for (const node of base.document.nodes) if (!node.executionPhase && node.children.length && !affected.has(node.id)) {
      const gateIds = this.database.all<{ id: string }>("SELECT id FROM workflow_phase_gate_results WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND branch_node_id = ? AND stage = 'branch_verification' AND status = 'passed'", input.projectId, input.treeId, base.revisionId, node.id).map(row => row.id);
      if (gateIds.length) grants.push({ nodeId: node.id, evaluationId: null, attemptId: null, gateIds });
    }
    const reused = grants.filter(grant => !affected.has(grant.nodeId));
    const result = this.trees.saveIncrementalRevisionWithinTransaction({ ...args, document });
    const revalidationNodeIds = base.document.nodes.filter(node => affected.has(node.id)).map(node => node.id);
    const iterationId = newId(); const timestamp = nowIso();
    this.database.run(`INSERT INTO task_tree_iteration_records (id, project_id, tree_id, base_revision_id, base_report_id, result_revision_id, affiliation_decision_id, answer_trace_event_id, input_hash, impact_json, reuse_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, iterationId, input.projectId, input.treeId, base.revisionId, report.id, result.revisionId, input.affiliationDecisionId, answerTraceId, input.inputHash, canonicalJson({ addedNodeIds: structure.addedNodeIds, revalidationNodeIds }), canonicalJson(reused), timestamp);
    for (const id of revalidationNodeIds) this.database.run("UPDATE task_nodes SET status = ? WHERE id = ? AND tree_id = ?", document.nodes.find(node => node.id === id)?.executionPhase ? "needs_revalidation" : "ready", id, input.treeId);
    this.database.run("UPDATE workflow_states SET active = 1, stage = 'task_tree_refinement', active_branch_node_id = NULL, revision = revision + 1, updated_at = ? WHERE project_id = ? AND tree_id = ?", timestamp, input.projectId, input.treeId);
    this.database.run("UPDATE runtime_states SET selected_tree_id = ?, selected_node_id = ?, updated_at = ? WHERE project_id = ?", input.treeId, structure.rootNodeId, timestamp, input.projectId);
    return { ...result, iterationId, baseRevisionId: base.revisionId, baseReportId: report.id, addedNodeIds: structure.addedNodeIds, reusedNodeIds: reused.map(grant => grant.nodeId), revalidationNodeIds };
  }
}
