import { HarnessError } from "../domain/errors.js";
import { commandArtifactLocator } from "../domain/artifact.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  evaluateSkeletonGate,
  type SkeletonGateBranchObservation,
  type SkeletonGateCheck,
  type SkeletonGateStatus,
} from "../domain/skeleton-gate.js";
import type { SkeletonAcceptanceInput, TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import { taskNodeEvidenceContext } from "../domain/task-node-evidence-context.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { isPriorEvaluationUsable, hasUsableNodeProof, iterationForRevision } from "./evidence-reuse-policy.js";

interface WorkflowRow {
  id: string;
  stage: string;
  revision: number;
}

interface CurrentNodeRow {
  id: string;
  status: string;
  body_json: string;
  node_revision_id: string;
  confirmation_state: string;
}

interface AttemptRow {
  id: string;
  evaluation_id: string | null;
  task_node_id: string;
  document_json: string;
  started_at: string;
}

interface ArtifactRow {
  id: string;
  locator: string;
  status: string;
  source_trace_event_id: string | null;
  source_node_id: string | null;
}

interface ContractRow {
  contract_id: string;
  artifact_id: string;
  artifact_status: string;
  source_trace_event_id: string | null;
  source_node_id: string | null;
  validation_refs_json: string;
}

interface GateResultRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  workflow_revision: number;
  policy_version: string;
  status: SkeletonGateStatus;
  branch_results_json: string;
  blockers_json: string;
  attempt_ids_json: string;
  evidence_trace_ids_json: string;
  created_at: string;
}

const actualArtifactStatuses = new Set(["created", "modified", "verified"]);

export class SkeletonGateService {
  constructor(private readonly database: RuntimeDatabase) {}

  evaluate(input: { projectId: string; treeId: string; workflowRevision: number }) {
    return this.database.transaction(() => this.evaluateWithinTransaction(input));
  }

  private evaluateWithinTransaction(input: { projectId: string; treeId: string; workflowRevision: number }) {
    const workflow = this.database.get<WorkflowRow>(
      "SELECT id, stage, revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      input.projectId, input.treeId,
    );
    if (!workflow) throw new HarnessError("not_found", "active Workflow was not found");
    if (workflow.revision !== input.workflowRevision) {
      throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    }
    if (workflow.stage !== "skeleton_pass") {
      throw new HarnessError("workflow_transition_rejected", "Skeleton Gate can only be evaluated during skeleton_pass");
    }
    const tree = this.database.get<{ current_revision_id: string; document_json: string }>(`
      SELECT t.current_revision_id, r.document_json
      FROM task_trees t JOIN runtime_task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ? AND t.archived_at IS NULL
    `, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "current Task Tree revision was not found");
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const structured = document.planningVersion === 1;
    const nodes = this.database.all<CurrentNodeRow>(`
      SELECT n.id, n.status, nr.body_json, nr.id AS node_revision_id,
             COALESCE(cs.state, 'draft') AS confirmation_state
      FROM task_nodes n
      JOIN runtime_task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      LEFT JOIN task_node_confirmation_states cs
        ON cs.tree_revision_id = ? AND cs.task_node_id = n.id
      WHERE n.tree_id = ?
      ORDER BY n.id
    `, tree.current_revision_id, tree.current_revision_id, input.treeId);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const root = document.nodes.find((node) => node.parentId === null);
    const confirmedBranches = structured
      ? (root?.children ?? []).filter((nodeId) => nodeById.get(nodeId)?.confirmation_state === "confirmed")
      : root ? [root.id] : [];
    const invalidatedAttemptIds = new Set(this.database.all<{ execution_attempt_id: string }>(`
      SELECT DISTINCT e.execution_attempt_id FROM evaluations e
      JOIN verification_invalidations v ON v.project_id = e.project_id AND v.tree_id = e.tree_id
      JOIN json_each(v.invalidated_evaluation_ids_json) invalidated ON invalidated.value = e.id
      WHERE e.project_id = ? AND e.tree_id = ?
    `, input.projectId, input.treeId).map((row) => row.execution_attempt_id));
    const attempts = this.database.all<AttemptRow>(`
      SELECT a.id, a.task_node_id, a.started_at, prior.document_json,
        (SELECT e.id FROM evaluations e JOIN lifecycle_transition_records l ON l.evaluation_id = e.id AND l.applied = 1 WHERE e.execution_attempt_id = a.id AND e.verdict = 'succeeded' ORDER BY e.rowid DESC LIMIT 1) AS evaluation_id
      FROM execution_attempts a
      JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id
      JOIN runtime_task_tree_revisions prior ON prior.id = nr.tree_revision_id
      JOIN runtime_task_node_revisions current ON current.node_id = a.task_node_id AND current.tree_revision_id = ?
      WHERE a.project_id = ? AND a.tree_id = ? AND nr.body_json = current.body_json AND a.status = 'succeeded'
      ORDER BY prior.revision DESC, a.attempt_number DESC, a.started_at DESC, a.id DESC
    `, tree.current_revision_id, input.projectId, input.treeId).filter((attempt) =>
      !invalidatedAttemptIds.has(attempt.id)
      && (!iterationForRevision(this.database, tree.current_revision_id)
        || (attempt.evaluation_id && isPriorEvaluationUsable(this.database, { ...input, targetRevisionId: tree.current_revision_id, nodeId: attempt.task_node_id, evaluationId: attempt.evaluation_id })))
      && taskNodeEvidenceContext(JSON.parse(attempt.document_json) as TaskTreeDocument, attempt.task_node_id)
        === taskNodeEvidenceContext(document, attempt.task_node_id));
    const attemptByNode = new Map<string, string>();
    for (const attempt of attempts) if (!attemptByNode.has(attempt.task_node_id)) attemptByNode.set(attempt.task_node_id, attempt.id);
    const supportingAttemptsByNode = new Map<string, string[]>();
    // Keep the recovery boundary stable across repeated evaluations. Moving it
    // to the newest failure would drop proofs from earlier repair Attempts.
    const failedGate = this.database.get<{ created_at: string }>(`
      SELECT created_at FROM skeleton_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND workflow_revision = ? AND status = 'failed'
      ORDER BY rowid ASC LIMIT 1
    `, input.projectId, input.treeId, tree.current_revision_id, workflow.revision);
    for (const attempt of attempts) {
      const primary = attempts.find((candidate) => candidate.id === attemptByNode.get(attempt.task_node_id));
      if (attempt.id !== primary?.id && (!failedGate || !primary || primary.started_at < failedGate.created_at)) continue;
      const ids = supportingAttemptsByNode.get(attempt.task_node_id) ?? [];
      ids.push(attempt.id);
      supportingAttemptsByNode.set(attempt.task_node_id, ids);
    }
    const evidenceRows = this.database.all<{ attempt_id: string; required_evidence_key: string; trace_event_id: string; event_name: string; payload_json: string }>(`
      SELECT e.attempt_id, e.required_evidence_key, e.trace_event_id, te.event_name, te.payload_json
      FROM execution_attempt_evidence e
      JOIN execution_attempts a ON a.id = e.attempt_id
      JOIN trace_events te ON te.id = e.trace_event_id AND te.project_id = a.project_id AND te.tree_id = a.tree_id AND te.node_id = a.task_node_id
      JOIN runtime_task_node_revisions nr ON nr.id = a.task_node_revision_id
      JOIN runtime_task_node_revisions current ON current.node_id = a.task_node_id AND current.tree_revision_id = ?
      WHERE a.project_id = ? AND a.tree_id = ? AND nr.body_json = current.body_json AND a.status = 'succeeded'
      ORDER BY e.attempt_id, e.trace_event_id
    `, tree.current_revision_id, input.projectId, input.treeId);
    const evidenceByAttempt = new Map<string, Set<string>>();
    const evidenceKeysByAttempt = new Map<string, Set<string>>();
    const commandsByTrace = new Map<string, string>();
    for (const row of evidenceRows) {
      const payload = JSON.parse(row.payload_json) as { toolName?: string; commandFingerprint?: string; toolInput?: { command?: string }; toolResponse?: { exitCode?: number; exit_code?: number; is_error?: boolean } };
      const exitCode = payload.toolResponse?.exitCode ?? payload.toolResponse?.exit_code;
      if (row.event_name !== "PostToolUse" || (exitCode !== undefined && exitCode !== 0) || payload.toolResponse?.is_error) continue;
      if (payload.toolName === "Bash" && typeof payload.toolInput?.command === "string") commandsByTrace.set(row.trace_event_id,
        payload.commandFingerprint ?? commandArtifactLocator(payload.toolInput.command));
      const values = evidenceByAttempt.get(row.attempt_id) ?? new Set<string>();
      values.add(row.trace_event_id);
      evidenceByAttempt.set(row.attempt_id, values);
      const keys = evidenceKeysByAttempt.get(row.attempt_id) ?? new Set<string>();
      keys.add(row.required_evidence_key);
      evidenceKeysByAttempt.set(row.attempt_id, keys);
    }
    const artifacts = this.database.all<ArtifactRow>(`
      SELECT a.id, a.locator, a.status, a.source_trace_event_id, te.node_id AS source_node_id
      FROM artifacts a LEFT JOIN trace_events te ON te.id = a.source_trace_event_id
      WHERE a.project_id = ? AND a.tree_id = ?
    `, input.projectId, input.treeId);
    const contracts = this.database.all<ContractRow>(`
      SELECT c.contract_id, c.artifact_id, a.status AS artifact_status,
             a.source_trace_event_id, te.node_id AS source_node_id, c.validation_refs_json
      FROM artifact_contracts c
      JOIN artifacts a ON a.id = c.artifact_id
      LEFT JOIN trace_events te ON te.id = a.source_trace_event_id
      WHERE c.project_id = ? AND c.tree_id = ? AND c.tree_revision_id = ?
    `, input.projectId, input.treeId, tree.current_revision_id);
    const blockingDriftIds = this.database.all<{ id: string }>(`
      SELECT id FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
      ORDER BY created_at, id
    `, input.projectId, input.treeId).map((row) => row.id);

    const branches = confirmedBranches.map((branchNodeId) => this.observeBranch({
      branchNodeId, structured, document, nodes, attemptByNode, supportingAttemptsByNode, evidenceByAttempt, evidenceKeysByAttempt, commandsByTrace, artifacts, contracts,
    }));
    const evaluated = evaluateSkeletonGate({ structured, branches, blockingDriftIds });
    const resultId = newId();
    const createdAt = nowIso();
    const attemptIds = [...new Set(branches.flatMap((branch) => [...branch.succeededAttemptIds, ...(branch.supportingAttemptIds ?? [])]))].sort();
    const traceIds = [...new Set(branches.flatMap((branch) => [
      ...branch.expectedArtifacts, ...branch.requiredContracts,
      ...branch.verificationCommands, ...branch.readinessConditions,
    ]).flatMap((check) => check.evidenceRefs))].sort();
    this.database.run(`
      INSERT INTO skeleton_gate_results (
        id, project_id, tree_id, tree_revision_id, workflow_revision, policy_version,
        status, branch_results_json, blockers_json, attempt_ids_json, evidence_trace_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, resultId, input.projectId, input.treeId, tree.current_revision_id, workflow.revision,
    structured ? "skeleton-gate-v2" : "skeleton-gate-legacy-v1", evaluated.status,
    canonicalJson(branches), canonicalJson(evaluated.blockers), canonicalJson(attemptIds), canonicalJson(traceIds), createdAt);
    const iteration = iterationForRevision(this.database, tree.current_revision_id);
    const inherited = new Set(confirmedBranches.filter(branchId => iteration
      && this.database.get("SELECT branch_node_id FROM workflow_branch_states WHERE tree_revision_id = ? AND branch_node_id = ? AND status = 'verified'", iteration.base_revision_id, branchId)
      && document.nodes.filter(node => this.descendants(document, branchId).has(node.id) && node.executionPhase).every(node => hasUsableNodeProof(this.database, { ...input, targetRevisionId: tree.current_revision_id, nodeId: node.id }))));
    const activeBranch = confirmedBranches.find(id => !inherited.has(id)) ?? null;
    if (evaluated.status === "passed") {
      confirmedBranches.forEach((branchNodeId, index) => this.database.run(`
        INSERT INTO workflow_branch_states (
          project_id, tree_id, tree_revision_id, branch_node_id, branch_order, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tree_revision_id, branch_node_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
      `, input.projectId, input.treeId, tree.current_revision_id, branchNodeId, index,
      inherited.has(branchNodeId) ? "verified" : branchNodeId === activeBranch ? "active" : "pending", createdAt));
      this.database.run(
        "UPDATE workflow_states SET stage = ?, active_branch_node_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        activeBranch ? "branch_implementation" : "root_verification", activeBranch, createdAt, workflow.id,
      );
    }
    return {
      resultId, projectId: input.projectId, treeId: input.treeId, treeRevisionId: tree.current_revision_id,
      workflowRevision: workflow.revision, policyVersion: structured ? "skeleton-gate-v2" : "skeleton-gate-legacy-v1",
      status: evaluated.status, branches, blockers: evaluated.blockers, attemptIds, evidenceTraceIds: traceIds,
      workflow: {
        stage: evaluated.status === "passed" ? activeBranch ? "branch_implementation" : "root_verification" : "skeleton_pass",
        revision: workflow.revision + (evaluated.status === "passed" ? 1 : 0),
        activeBranchNodeId: evaluated.status === "passed" ? activeBranch : null,
      },
      createdAt,
    };
  }

  list(projectId: string, options: { treeId?: string; resultId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.resultId) { clauses.push("id = ?"); params.push(options.resultId); }
    return this.database.all<GateResultRow>(`
      SELECT * FROM skeleton_gate_results WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => this.view(row));
  }

  private observeBranch(input: {
    branchNodeId: string;
    structured: boolean;
    document: TaskTreeDocument;
    nodes: CurrentNodeRow[];
    attemptByNode: Map<string, string>;
    supportingAttemptsByNode: Map<string, string[]>;
    evidenceByAttempt: Map<string, Set<string>>;
    evidenceKeysByAttempt: Map<string, Set<string>>;
    commandsByTrace: Map<string, string>;
    artifacts: ArtifactRow[];
    contracts: ContractRow[];
  }): SkeletonGateBranchObservation {
    const scope = this.descendants(input.document, input.branchNodeId);
    const skeletonNodes = input.nodes.filter((node) => {
      if (!scope.has(node.id)) return false;
      return (JSON.parse(node.body_json) as TaskNodeInput).executionPhase === "skeleton";
    });
    const succeededAttemptIds = skeletonNodes.flatMap((node) => {
      const attemptId = input.attemptByNode.get(node.id);
      return node.status === "succeeded" && attemptId ? [attemptId] : [];
    });
    const supportingAttemptIds = skeletonNodes.flatMap((node) => node.status === "succeeded" && input.attemptByNode.has(node.id)
      ? input.supportingAttemptsByNode.get(node.id) ?? [] : []);
    const branchEvidence = new Set(supportingAttemptIds.flatMap((attemptId) => [...(input.evidenceByAttempt.get(attemptId) ?? [])]));
    const branchEvidenceKeys = new Set(supportingAttemptIds.flatMap((attemptId) => [...(input.evidenceKeysByAttempt.get(attemptId) ?? [])]));
    const skeletonNodeIds = new Set(skeletonNodes.map((node) => node.id));
    const criterion = input.structured
      ? input.document.skeletonCriteria?.find((value) => value.branchNodeId === input.branchNodeId)
      : undefined;
    const artifactCheck = (ref: string): SkeletonGateCheck => {
      const artifact = input.artifacts.find((value) => value.id === ref || value.locator === ref);
      // A later authorized implementation can change the mutable Artifact's
      // last-writer projection. Its original creation is still an immutable
      // fact; fresh skeleton verification must not rewrite a delivered file
      // just to become that projection's latest writer again.
      const historicalCreation = artifact && skeletonNodeIds.size
        && iterationForRevision(this.database, this.database.get<{ current_revision_id: string }>("SELECT current_revision_id FROM task_trees WHERE id = (SELECT tree_id FROM task_nodes WHERE id = ?)", input.branchNodeId)!.current_revision_id)
        ? this.database.get<{ id: string }>(`
          SELECT t.id FROM trace_events t, json_each(t.payload_json, '$.artifactRefs') ref
          WHERE t.project_id = (SELECT project_id FROM artifacts WHERE id = ?) AND t.tree_id = (SELECT tree_id FROM task_nodes WHERE id = ?)
            AND t.node_id IN (${[...skeletonNodeIds].map(() => "?").join(",")}) AND ref.value = ?
            AND t.event_name = 'PostToolUse' AND json_extract(t.payload_json, '$.toolName') = 'Write'
          ORDER BY t.rowid ASC LIMIT 1
        `, artifact.id, input.branchNodeId, ...skeletonNodeIds, artifact.id) : null;
      const evidenceRefs = artifact?.source_trace_event_id ? [artifact.source_trace_event_id] : [];
      if (historicalCreation) evidenceRefs.push(historicalCreation.id);
      return {
        ref,
        satisfied: Boolean(artifact && actualArtifactStatuses.has(artifact.status)
          && (historicalCreation || (artifact.source_trace_event_id && artifact.source_node_id && skeletonNodeIds.has(artifact.source_node_id)))),
        evidenceRefs,
      };
    };
    const contractCheck = (ref: string): SkeletonGateCheck => {
      const contract = input.contracts.find((value) => value.contract_id === ref);
      const evidenceRefs = contract?.source_trace_event_id ? [contract.source_trace_event_id] : [];
      const validationRefs = contract ? JSON.parse(contract.validation_refs_json) as string[] : [];
      const validationRefSatisfied = (validationRef: string) => {
        if (branchEvidenceKeys.has(validationRef) || branchEvidence.has(validationRef)) return true;
        const evidenceArtifact = input.artifacts.find((artifact) => artifact.id === validationRef || artifact.locator === validationRef);
        return Boolean(evidenceArtifact?.source_trace_event_id && branchEvidence.has(evidenceArtifact.source_trace_event_id));
      };
      const missingValidationRefs = validationRefs.filter((ref) => !validationRefSatisfied(ref));
      const validationSatisfied = validationRefs.length > 0 && missingValidationRefs.length === 0;
      return {
        ref,
        satisfied: Boolean(contract && (validationSatisfied || (actualArtifactStatuses.has(contract.artifact_status)
          && contract.source_trace_event_id && contract.source_node_id && skeletonNodeIds.has(contract.source_node_id)))),
        evidenceRefs: validationSatisfied ? [...branchEvidence].sort() : evidenceRefs,
        failureCode: contract ? "contract_validation_missing" : "required_contract_missing",
        validationRefs,
        missingValidationRefs,
      };
    };
    const commandCheck = (ref: string): SkeletonGateCheck => {
      // Projections are mutable and shared across branches; attached Traces
      // retain the exact invocation and its successful outcome.
      const signature = commandArtifactLocator(ref);
      const evidenceRefs = [...branchEvidence].filter((traceId) => input.commandsByTrace.get(traceId) === signature).sort();
      return { ref, satisfied: evidenceRefs.length > 0, evidenceRefs };
    };
    const readinessCheck = (ref: string): SkeletonGateCheck => ({
      ref,
      satisfied: succeededAttemptIds.length > 0 && succeededAttemptIds.length === skeletonNodes.length,
      evidenceRefs: [...branchEvidence].sort(),
    });
    return {
      branchNodeId: input.branchNodeId,
      criterionId: criterion?.id ?? null,
      criterionComplete: input.structured ? this.criterionComplete(criterion) : true,
      skeletonNodeIds: [...skeletonNodeIds].sort(),
      succeededAttemptIds: [...succeededAttemptIds].sort(),
      supportingAttemptIds: supportingAttemptIds.filter((id) => !succeededAttemptIds.includes(id)).sort(),
      expectedArtifacts: (criterion?.expectedArtifacts ?? []).map(artifactCheck),
      requiredContracts: (criterion?.requiredContracts ?? []).map(contractCheck),
      verificationCommands: (criterion?.verificationCommands ?? []).map(commandCheck),
      readinessConditions: (criterion?.readinessConditions ?? []).map(readinessCheck),
    };
  }

  private descendants(document: TaskTreeDocument, rootId: string): Set<string> {
    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    const result = new Set<string>();
    const visit = (id: string) => {
      if (result.has(id)) return;
      result.add(id);
      for (const child of byId.get(id)?.children ?? []) visit(child);
    };
    visit(rootId);
    return result;
  }

  private criterionComplete(value: SkeletonAcceptanceInput | undefined): boolean {
    return Boolean(value && value.expectedArtifacts.length && value.requiredContracts.length
      && value.verificationCommands.length && value.readinessConditions.length);
  }

  private view(row: GateResultRow) {
    return {
      resultId: row.id, projectId: row.project_id, treeId: row.tree_id, treeRevisionId: row.tree_revision_id,
      workflowRevision: row.workflow_revision, policyVersion: row.policy_version, status: row.status,
      branches: JSON.parse(row.branch_results_json) as SkeletonGateBranchObservation[],
      blockers: JSON.parse(row.blockers_json) as unknown[],
      attemptIds: JSON.parse(row.attempt_ids_json) as string[],
      evidenceTraceIds: JSON.parse(row.evidence_trace_ids_json) as string[], createdAt: row.created_at,
    };
  }
}
