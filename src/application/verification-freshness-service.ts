import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { hasUsableNodeProof, isPriorEvaluationUsable, iterationForRevision, type EvidenceReuseGrant } from "./evidence-reuse-policy.js";
import { ArtifactEvidenceBaselineService } from "./artifact-evidence-baseline-service.js";

interface WorkflowRow {
  id: string;
  tree_id: string;
  stage: string;
  revision: number;
  active_branch_node_id: string | null;
  selected_node_id: string | null;
  current_revision_id: string;
}

const freshnessStages = new Set([
  "skeleton_pass", "skeleton_gate", "branch_implementation", "branch_verification", "root_verification", "final_report",
]);
const stageRank = new Map([
  ["skeleton_pass", 0], ["skeleton_gate", 0], ["branch_implementation", 1],
  ["branch_verification", 2], ["root_verification", 3], ["final_report", 4],
]);
const executionPhaseRank = new Map([["skeleton", 0], ["implementation", 1], ["verification", 2]]);

interface CurrentNodeRow {
  id: string;
  parent_id: string | null;
  status: string;
  body_json: string;
}

interface VerificationInvalidationRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  source_trace_event_id: string;
  artifact_id: string | null;
  workflow_revision: number;
  prior_stage: string;
  next_stage: string;
  affected_node_ids_json: string;
  invalidated_evaluation_ids_json: string;
  invalidated_gate_result_ids_json: string;
  created_at: string;
}

export class VerificationFreshnessService {
  constructor(private readonly database: RuntimeDatabase) {}

  /** Explicit Gate/finalize operations reconcile observed stale reuse. Read-only
   * queries and scheduler.next deliberately never call this method. */
  reconcileIterationBaselinesWithinTransaction(input: { projectId: string; treeId: string }) {
    const workflow = this.database.get<{ stage: string; revision: number; current_revision_id: string }>(`SELECT w.stage, w.revision, t.current_revision_id FROM workflow_states w JOIN task_trees t ON t.id = w.tree_id WHERE w.project_id = ? AND w.tree_id = ? AND w.active = 1`, input.projectId, input.treeId);
    const iteration = workflow ? iterationForRevision(this.database, workflow.current_revision_id) : null;
    if (!workflow || !iteration || !freshnessStages.has(workflow.stage)) return null;
    const staleNodeIds: string[] = [];
    for (const grant of JSON.parse(iteration.reuse_json) as EvidenceReuseGrant[]) {
      if (!grant.evaluationId || !grant.attemptId) continue;
      const node = this.database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ? AND tree_id = ?", grant.nodeId, input.treeId);
      if (node?.status !== "succeeded" || hasUsableNodeProof(this.database, { ...input, targetRevisionId: workflow.current_revision_id, nodeId: grant.nodeId })) continue;
      const changes = new ArtifactEvidenceBaselineService(this.database).changedAttemptInputs({ projectId: input.projectId, attemptId: grant.attemptId });
      const artifact = changes.flatMap(item => this.database.all<{ id: string }>("SELECT id FROM artifacts WHERE project_id = ? AND kind = ? AND locator = ?", input.projectId, item.kind, item.locator)).at(0);
      const traceId = newId(); const timestamp = nowIso();
      this.database.run(`INSERT INTO trace_events (id, project_id, tree_id, node_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, 'runtime:verification-freshness', 'verification_baseline_stale', ?, '{}', ?, ?)`,
        traceId, input.projectId, input.treeId, grant.nodeId, canonicalJson({ reason: "reusable_proof_no_longer_available", evaluationId: grant.evaluationId, attemptId: grant.attemptId, changedInputs: changes, ...(artifact ? { artifactRefs: [artifact.id] } : {}) }), timestamp,
        `verification-baseline-stale:${workflow.current_revision_id}:${workflow.revision}:${grant.nodeId}:${traceId}`);
      this.invalidateMutationWithinTransaction({ ...input, sourceTraceEventId: traceId, fallbackNodeId: grant.nodeId, ...(artifact ? { artifactId: artifact.id } : {}) });
      staleNodeIds.push(grant.nodeId);
    }
    if (!staleNodeIds.length) return null;
    const current = this.database.get<{ stage: string; revision: number; active_branch_node_id: string | null }>("SELECT stage, revision, active_branch_node_id FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1", input.projectId, input.treeId)!;
    return { staleNodeIds, workflow: { stage: current.stage, revision: current.revision, activeBranchNodeId: current.active_branch_node_id } };
  }

  list(projectId: string, options: { treeId?: string; invalidationId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.invalidationId) { clauses.push("id = ?"); params.push(options.invalidationId); }
    return this.database.all<VerificationInvalidationRow>(`
      SELECT * FROM verification_invalidations WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => ({
      invalidationId: row.id,
      projectId: row.project_id,
      treeId: row.tree_id,
      treeRevisionId: row.tree_revision_id,
      sourceTraceEventId: row.source_trace_event_id,
      artifactId: row.artifact_id,
      workflowRevision: row.workflow_revision,
      priorStage: row.prior_stage,
      nextStage: row.next_stage,
      affectedNodeIds: JSON.parse(row.affected_node_ids_json) as string[],
      invalidatedEvaluationIds: JSON.parse(row.invalidated_evaluation_ids_json) as string[],
      invalidatedGateResultIds: JSON.parse(row.invalidated_gate_result_ids_json) as string[],
      createdAt: row.created_at,
    }));
  }

  invalidateMutationWithinTransaction(input: {
    projectId: string;
    treeId: string;
    sourceTraceEventId: string;
    artifactId?: string;
    fallbackNodeId?: string;
  }) {
    const workflow = this.database.get<WorkflowRow>(`
      SELECT w.id, w.tree_id, w.stage, w.revision, w.active_branch_node_id,
             r.selected_node_id, t.current_revision_id
      FROM workflow_states w
      JOIN task_trees t ON t.id = w.tree_id AND t.project_id = w.project_id
      LEFT JOIN runtime_states r ON r.project_id = w.project_id
      WHERE w.project_id = ? AND w.tree_id = ? AND w.active = 1
    `, input.projectId, input.treeId);
    if (!workflow || !freshnessStages.has(workflow.stage)) return null;

    const relatedArtifactIds = new Set(input.artifactId ? [input.artifactId] : []);
    if (input.artifactId) {
      const relations = this.database.all<{ from_artifact_id: string; to_artifact_id: string }>(`
        SELECT from_artifact_id, to_artifact_id FROM artifact_graph_relations
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
      `, input.projectId, input.treeId, workflow.current_revision_id);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const relation of relations) {
          if (relatedArtifactIds.has(relation.from_artifact_id) && !relatedArtifactIds.has(relation.to_artifact_id)) {
            relatedArtifactIds.add(relation.to_artifact_id);
            expanded = true;
          }
          if (relatedArtifactIds.has(relation.to_artifact_id) && !relatedArtifactIds.has(relation.from_artifact_id)) {
            relatedArtifactIds.add(relation.from_artifact_id);
            expanded = true;
          }
        }
      }
    }
    const artifactPlaceholders = [...relatedArtifactIds].map(() => "?").join(", ");
    const linkedNodeIds = relatedArtifactIds.size ? this.database.all<{ task_node_id: string }>(`
      SELECT DISTINCT task_node_id FROM task_node_artifact_links
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
        AND artifact_id IN (${artifactPlaceholders})
      ORDER BY task_node_id
    `, input.projectId, input.treeId, workflow.current_revision_id,
    ...relatedArtifactIds).map((row) => row.task_node_id) : [];
    const candidateNodeIds = linkedNodeIds.length
      ? linkedNodeIds
      : [input.fallbackNodeId ?? workflow.selected_node_id].filter((value): value is string => Boolean(value));
    if (!candidateNodeIds.length) return null;

    const nodes = this.database.all<CurrentNodeRow>(`
      SELECT n.id, n.parent_id, n.status, nr.body_json
      FROM task_nodes n
      JOIN runtime_task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      WHERE n.tree_id = ? ORDER BY n.id
    `, workflow.current_revision_id, input.treeId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const rootId = nodes.find((node) => node.parent_id === null)?.id ?? null;
    const branchFor = (nodeId: string): string | null => {
      let current = byId.get(nodeId);
      while (current?.parent_id && current.parent_id !== rootId) current = byId.get(current.parent_id);
      return current?.parent_id === rootId ? current.id : null;
    };
    const mutationNode = input.fallbackNodeId ? byId.get(input.fallbackNodeId) : undefined;
    const mutationBody = mutationNode ? JSON.parse(mutationNode.body_json) as TaskNodeInput : undefined;
    const changedArtifact = input.artifactId
      ? this.database.get<{ kind: string; locator: string }>("SELECT kind, locator FROM artifacts WHERE id = ? AND project_id = ?", input.artifactId, input.projectId)
      : undefined;
    const mutationBranch = mutationNode ? branchFor(mutationNode.id) : null;
    // Only an actual file-tool mutation bound to this revision's running writer
    // can preserve skeleton proof. External observations, another session, and
    // writes during verification must not borrow the implementation exemption.
    const writerTrace = mutationBody?.executionPhase === "implementation" && changedArtifact?.kind === "file" && mutationBranch
      ? this.database.get<{ payload_json: string }>(`
          SELECT t.payload_json FROM trace_events t
          JOIN execution_attempts a ON a.project_id = t.project_id AND a.tree_id = t.tree_id
            AND a.task_node_id = t.node_id AND a.session_id = t.session_id
          WHERE t.id = ? AND t.project_id = ? AND t.tree_id = ? AND t.node_id = ?
            AND t.event_name = 'PostToolUse' AND a.status = 'running'
            AND a.tree_revision_id = ? AND t.occurred_at >= a.started_at
        `, input.sourceTraceEventId, input.projectId, input.treeId, mutationNode!.id, workflow.current_revision_id)
      : undefined;
    const writerPayload = writerTrace ? JSON.parse(writerTrace.payload_json) as { toolName?: string; artifactRefs?: string[] } : undefined;
    const boundFileMutation = Boolean(writerPayload && ["Write", "Edit", "MultiEdit"].includes(writerPayload.toolName ?? "")
      && writerPayload.artifactRefs?.includes(input.artifactId!));
    const plannedWriteLink = boundFileMutation && this.database.get(`
      SELECT id FROM task_node_artifact_links
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
        AND task_node_id = ? AND artifact_id = ? AND relation_type IN ('implements', 'modifies')
    `, input.projectId, input.treeId, workflow.current_revision_id, mutationNode!.id, input.artifactId!);
    const extendsPlannedSkeleton = mutationBody?.executionPhase === "implementation" && changedArtifact?.kind === "file"
      && boundFileMutation && (Boolean(plannedWriteLink)
        || (mutationBody.expectedOutputs ?? []).some((output) => output.replaceAll("\\", "/") === changedArtifact.locator));
    const skeletonCreators = extendsPlannedSkeleton ? new Set(this.database.all<{ task_node_id: string }>(`
      SELECT task_node_id FROM task_node_artifact_links
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND artifact_id = ? AND relation_type = 'creates'
    `, input.projectId, input.treeId, workflow.current_revision_id, input.artifactId!).map((row) => row.task_node_id)) : new Set<string>();
    // Filling a planned implementation into a created skeleton file is normal
    // forward progress, not evidence that the shared skeleton was broken. A
    // contract change or an out-of-scope mutation still invalidates its owners.
    const impact = new Set(candidateNodeIds.filter((nodeId) => {
      const node = byId.get(nodeId);
      if (!node) return false;
      const body = JSON.parse(node.body_json) as TaskNodeInput;
      return !(skeletonCreators.has(nodeId) && body.executionPhase === "skeleton"
        && branchFor(nodeId) === mutationBranch);
    }));
    const taskRelations = this.database.all<{ from_node_id: string; to_node_id: string; kind: string }>(`
      SELECT from_node_id, to_node_id, kind FROM task_relation_edges
      WHERE tree_revision_id = ?
    `, workflow.current_revision_id);
    const document = JSON.parse(this.database.get<{ document_json: string }>("SELECT document_json FROM runtime_task_tree_revisions WHERE id = ?", workflow.current_revision_id)!.document_json) as TaskTreeDocument;
    for (const node of nodes) {
      const body = JSON.parse(node.body_json) as TaskNodeInput;
      for (const dependency of body.dependencies ?? []) {
        taskRelations.push({ from_node_id: node.id, to_node_id: dependency, kind: "depends_on" });
      }
    }
    let taskImpactExpanded = true;
    while (taskImpactExpanded) {
      taskImpactExpanded = false;
      for (const relation of taskRelations) {
        // Communication edges describe topology, not evidence dependencies. Shared
        // assets/contracts propagate through their actual Artifact links instead.
        if (relation.kind === "depends_on" && impact.has(relation.to_node_id) && !impact.has(relation.from_node_id)) {
          impact.add(relation.from_node_id);
          taskImpactExpanded = true;
        }
      }
      // Contract declarations carry evidence dependencies even without a
      // redundant consumes-link or depends_on edge in the planning document.
      for (const contract of document.artifactContracts ?? []) {
        const providerAffected = relatedArtifactIds.has(contract.artifactId) || contract.providerNodeIds.some(id => impact.has(id)
          || candidateNodeIds.includes(id) || (changedArtifact?.kind === "file" && (JSON.parse(byId.get(id)?.body_json ?? "{}") as TaskNodeInput).expectedOutputs?.some(output => output.replaceAll("\\", "/") === changedArtifact.locator)));
        if (!providerAffected) continue;
        for (const consumer of contract.consumerNodeIds) if (!impact.has(consumer)) { impact.add(consumer); taskImpactExpanded = true; }
      }
    }
    for (const nodeId of [...impact]) {
      let parentId = byId.get(nodeId)?.parent_id ?? null;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent) break;
        const body = JSON.parse(parent.body_json) as { executionPhase?: string };
        if (body.executionPhase) impact.add(parent.id);
        parentId = parent.parent_id;
      }
    }
    const initiallyImpactedBranches = new Set([...impact].map(branchFor).filter((value): value is string => Boolean(value)));
    const initiallyImpactedPhases = new Set([...impact].map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return body.executionPhase;
    }));
    if (initiallyImpactedPhases.has("skeleton") || initiallyImpactedPhases.has("implementation")) {
      for (const node of nodes) {
        const body = JSON.parse(node.body_json) as { executionPhase?: string };
        const downstreamPhase = body.executionPhase === "verification"
          || (initiallyImpactedPhases.has("skeleton") && body.executionPhase === "implementation");
        if (downstreamPhase && initiallyImpactedBranches.has(branchFor(node.id) ?? "")) impact.add(node.id);
      }
    }
    const earliestImpactedPhaseRank = Math.min(...[...impact].map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return executionPhaseRank.get(body.executionPhase ?? "") ?? Number.POSITIVE_INFINITY;
    }));
    const forcedInvalidatedNodeIds = new Set<string>();
    const impactPlaceholders = [...impact].map(() => "?").join(", ");
    const staleActiveAttempts = impact.size && Number.isFinite(earliestImpactedPhaseRank)
      ? this.database.all<{ id: string; task_node_id: string; body_json: string }>(`
          SELECT a.id, a.task_node_id, nr.body_json
          FROM execution_attempts a
          JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id
          WHERE a.project_id = ? AND a.tree_id = ? AND a.status IN ('running', 'verifying')
            AND a.task_node_id IN (${impactPlaceholders})
        `, input.projectId, input.treeId, ...impact).filter((attempt) => {
          const body = JSON.parse(attempt.body_json) as { executionPhase?: string };
          const staleDependency = taskRelations.some((relation) => relation.kind === "depends_on"
            && relation.from_node_id === attempt.task_node_id
            && relation.to_node_id !== attempt.task_node_id
            && impact.has(relation.to_node_id)
            && byId.get(relation.to_node_id)?.status === "succeeded");
          return staleDependency || (executionPhaseRank.get(body.executionPhase ?? "") ?? -1) > earliestImpactedPhaseRank;
        })
      : [];
    const createdAt = nowIso();
    for (const attempt of staleActiveAttempts) {
      this.database.run(
        "UPDATE execution_attempts SET status = 'aborted', completed_at = ? WHERE id = ?",
        createdAt, attempt.id,
      );
      this.database.run(
        "UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = ?",
        attempt.task_node_id,
      );
      forcedInvalidatedNodeIds.add(attempt.task_node_id);
    }
    const affectedNodeIds = [...impact]
      .filter((nodeId) => byId.get(nodeId)?.status === "succeeded" || forcedInvalidatedNodeIds.has(nodeId))
      .sort();
    if (!affectedNodeIds.length) return null;

    const phases = new Set(affectedNodeIds.map((nodeId) => {
      const body = JSON.parse(byId.get(nodeId)!.body_json) as { executionPhase?: string };
      return body.executionPhase;
    }));
    const branchIds = new Set<string>();
    for (const nodeId of affectedNodeIds) {
      const branchId = branchFor(nodeId);
      if (branchId) branchIds.add(branchId);
    }
    const branchStates = this.database.all<{ branch_node_id: string; branch_order: number }>(`
      SELECT branch_node_id, branch_order FROM workflow_branch_states
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
      ORDER BY branch_order
    `, input.projectId, input.treeId, workflow.current_revision_id);
    const affectedBranches = branchStates.filter((branch) => branchIds.has(branch.branch_node_id));
    const requiredStage = phases.has("skeleton")
      ? "skeleton_pass"
      : phases.has("implementation") && affectedBranches.length
        ? "branch_implementation"
        : phases.has("verification") && affectedBranches.length
          ? "branch_verification"
          : "root_verification";
    const nextStage = (stageRank.get(workflow.stage) ?? 4) <= (stageRank.get(requiredStage) ?? 4)
      ? workflow.stage === "skeleton_gate" ? "skeleton_pass" : workflow.stage
      : requiredStage;
    const activeAttempt = this.database.get<{ id: string }>(`
      SELECT id FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying')
      ORDER BY started_at, id LIMIT 1
    `, input.projectId, input.treeId);
    const preserveActiveBranch = Boolean(activeAttempt && workflow.active_branch_node_id
      && (nextStage === "branch_implementation" || nextStage === "branch_verification"));
    const nextBranchNodeId = nextStage === "branch_implementation" || nextStage === "branch_verification"
      ? preserveActiveBranch ? workflow.active_branch_node_id : affectedBranches[0]?.branch_node_id ?? null
      : null;

    const affectedPlaceholders = affectedNodeIds.map(() => "?").join(", ");
    const iteration = iterationForRevision(this.database, workflow.current_revision_id);
    const grantedEvaluationIds = new Set(iteration ? (JSON.parse(iteration.reuse_json) as EvidenceReuseGrant[]).map(grant => grant.evaluationId) : []);
    const invalidatedEvaluationIds = this.database.all<{ id: string; task_node_id: string; tree_revision_id: string }>(`
      SELECT e.id, e.task_node_id, nr.tree_revision_id FROM evaluations e
      JOIN runtime_task_node_revisions nr ON nr.id = e.task_node_revision_id
      WHERE e.project_id = ? AND e.tree_id = ?
        AND e.task_node_id IN (${affectedPlaceholders}) AND e.verdict = 'succeeded'
      ORDER BY e.created_at, e.id
    `, input.projectId, input.treeId, ...affectedNodeIds).filter(row => row.tree_revision_id === workflow.current_revision_id
      || grantedEvaluationIds.has(row.id)
      || isPriorEvaluationUsable(this.database, { ...input, targetRevisionId: workflow.current_revision_id, nodeId: row.task_node_id, evaluationId: row.id })).map(row => row.id);
    const invalidatedGateResultIds = this.database.all<{ id: string }>(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND status = 'passed'
      ORDER BY created_at, id
    `, input.projectId, input.treeId, workflow.current_revision_id).map((row) => row.id);

    const invalidationId = newId();
    this.database.run(`
      INSERT INTO verification_invalidations (
        id, project_id, tree_id, tree_revision_id, source_trace_event_id, artifact_id,
        workflow_revision, prior_stage, next_stage, affected_node_ids_json,
        invalidated_evaluation_ids_json, invalidated_gate_result_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, invalidationId, input.projectId, input.treeId, workflow.current_revision_id,
    input.sourceTraceEventId, input.artifactId ?? null, workflow.revision,
    workflow.stage, nextStage,
    canonicalJson(affectedNodeIds), canonicalJson(invalidatedEvaluationIds),
    canonicalJson(invalidatedGateResultIds), createdAt);
    this.database.run(`
      UPDATE task_nodes SET status = 'needs_revalidation'
      WHERE tree_id = ? AND id IN (${affectedPlaceholders})
    `, input.treeId, ...affectedNodeIds);
    if (nextStage === "skeleton_pass") {
      this.database.run(
        "DELETE FROM workflow_branch_states WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?",
        input.projectId, input.treeId, workflow.current_revision_id,
      );
    } else if (nextBranchNodeId) {
      this.database.run(`
        UPDATE workflow_branch_states SET status = 'pending', updated_at = ?
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
          AND status = 'active' AND branch_node_id <> ?
      `, createdAt, input.projectId, input.treeId, workflow.current_revision_id, nextBranchNodeId);
      for (const branch of affectedBranches) {
        this.database.run(`
          UPDATE workflow_branch_states SET status = ?, updated_at = ?
          WHERE tree_revision_id = ? AND branch_node_id = ?
        `, branch.branch_node_id === nextBranchNodeId ? "active" : "pending", createdAt,
        workflow.current_revision_id, branch.branch_node_id);
      }
    }
    this.database.run(`
      UPDATE workflow_states
      SET stage = ?, active_branch_node_id = ?,
          revision = revision + 1, updated_at = ?
      WHERE id = ?
    `, nextStage, nextBranchNodeId, createdAt, workflow.id);
    return {
      invalidationId, projectId: input.projectId, treeId: input.treeId,
      treeRevisionId: workflow.current_revision_id, sourceTraceEventId: input.sourceTraceEventId,
      artifactId: input.artifactId ?? null, workflowRevision: workflow.revision,
      priorStage: workflow.stage, nextStage, nextBranchNodeId,
      affectedNodeIds, invalidatedEvaluationIds, invalidatedGateResultIds, createdAt,
    };
  }
}
