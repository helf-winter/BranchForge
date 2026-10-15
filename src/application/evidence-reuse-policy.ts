import { canonicalJson } from "../domain/trace.js";
import { taskNodeEvidenceContext } from "../domain/task-node-evidence-context.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { ArtifactEvidenceBaselineService } from "./artifact-evidence-baseline-service.js";

export interface EvidenceReuseGrant { nodeId: string; evaluationId: string | null; attemptId: string | null; gateIds: string[] }
export function iterationForRevision(database: RuntimeDatabase, revisionId: string) {
  return database.get<{ id: string; project_id: string; tree_id: string; base_revision_id: string; result_revision_id: string; result_order: number; reuse_json: string; impact_json: string }>(`
    SELECT i.*, result.revision AS result_order FROM task_tree_iteration_records i
    JOIN task_tree_revisions result ON result.id = i.result_revision_id
    JOIN task_tree_revisions target ON target.tree_id = i.tree_id AND target.id = ?
    WHERE result.revision <= target.revision ORDER BY result.revision DESC LIMIT 1
  `, revisionId);
}
export function isPriorEvaluationUsable(database: RuntimeDatabase, input: { projectId: string; treeId: string; targetRevisionId: string; nodeId: string; evaluationId: string }): boolean {
  const row = database.get<{ source_revision: string; source_order: number; target_order: number; source_body: string; target_body: string; prior_document: string; current_document: string; attempt_id: string }>(`
    SELECT nr.tree_revision_id AS source_revision, nr.body_json AS source_body, current.body_json AS target_body,
      prior.document_json AS prior_document, prior.revision AS source_order, target.revision AS target_order, target.document_json AS current_document, e.execution_attempt_id AS attempt_id
    FROM evaluations e JOIN runtime_task_node_revisions nr ON nr.id = e.task_node_revision_id
    JOIN runtime_task_tree_revisions prior ON prior.id = nr.tree_revision_id
    JOIN runtime_task_node_revisions current ON current.node_id = e.task_node_id AND current.tree_revision_id = ?
    JOIN runtime_task_tree_revisions target ON target.id = current.tree_revision_id
    JOIN lifecycle_transition_records l ON l.evaluation_id = e.id AND l.applied = 1 AND l.target_status = 'succeeded'
    WHERE e.id = ? AND e.project_id = ? AND e.tree_id = ? AND e.task_node_id = ? AND e.verdict = 'succeeded'
  `, input.targetRevisionId, input.evaluationId, input.projectId, input.treeId, input.nodeId);
  if (!row || row.source_order > row.target_order || canonicalJson(JSON.parse(row.source_body)) !== canonicalJson(JSON.parse(row.target_body))) return false;
  if (database.get(`SELECT v.id FROM verification_invalidations v, json_each(v.invalidated_evaluation_ids_json) j WHERE v.project_id = ? AND v.tree_id = ? AND j.value = ? LIMIT 1`, input.projectId, input.treeId, input.evaluationId)) return false;
  if (row.source_revision === input.targetRevisionId) return true;
  const iteration = iterationForRevision(database, input.targetRevisionId);
  if (iteration && row.source_order < iteration.result_order && !(JSON.parse(iteration.reuse_json) as EvidenceReuseGrant[]).some(grant => grant.nodeId === input.nodeId && grant.evaluationId === input.evaluationId && grant.attemptId === row.attempt_id)) return false;
  if (iteration && !new ArtifactEvidenceBaselineService(database).isAttemptBaselineCurrent({ projectId: input.projectId, attemptId: row.attempt_id })) return false;
  return taskNodeEvidenceContext(JSON.parse(row.prior_document) as TaskTreeDocument, input.nodeId) === taskNodeEvidenceContext(JSON.parse(row.current_document) as TaskTreeDocument, input.nodeId);
}

export function hasUsableNodeProof(database: RuntimeDatabase, input: { projectId: string; treeId: string; targetRevisionId: string; nodeId: string }): boolean {
  return database.all<{ id: string }>("SELECT id FROM evaluations WHERE project_id = ? AND tree_id = ? AND task_node_id = ? AND verdict = 'succeeded'", input.projectId, input.treeId, input.nodeId)
    .some(row => isPriorEvaluationUsable(database, { ...input, evaluationId: row.id }));
}
