import { HarnessError } from "../domain/errors.js";
import { loadNodeCompletion } from "./node-completion.js";
import { newId, nowIso } from "../domain/ids.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import { taskNodeEvidenceContext } from "../domain/task-node-evidence-context.js";

interface FinalReportRow {
  id: string;
  project_id: string;
  tree_id: string;
  tree_revision_id: string;
  workflow_revision: number;
  root_phase_gate_result_id: string;
  status: "completed";
  summary_json: string;
  evidence_refs_json: string;
  idempotency_key: string;
  created_at: string;
}

interface StatusCountRow {
  status: string;
  count: number;
}

interface VerificationInvalidationRow {
  id: string;
  invalidated_evaluation_ids_json: string;
  invalidated_gate_result_ids_json: string;
}

interface CompletionSessionProfileRow {
  session_id: string;
  source_route_decision_id: string | null;
  source_affiliation_decision_id: string | null;
}

export class FinalReportService {
  constructor(private readonly database: RuntimeDatabase) {}

  finalize(input: {
    projectId: string;
    treeId: string;
    workflowRevision: number;
    idempotencyKey: string;
  }) {
    if (!input.idempotencyKey.trim()) {
      throw new HarnessError("invalid_input", "final report idempotency key is required");
    }
    return this.database.transaction(() => this.finalizeWithinTransaction(input));
  }

  list(projectId: string, options: { treeId?: string; reportId?: string } = {}) {
    const clauses = ["project_id = ?"];
    const params: string[] = [projectId];
    if (options.treeId) { clauses.push("tree_id = ?"); params.push(options.treeId); }
    if (options.reportId) { clauses.push("id = ?"); params.push(options.reportId); }
    return this.database.all<FinalReportRow>(`
      SELECT * FROM final_reports WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT 200
    `, ...params).map((row) => this.view(row, false));
  }

  private finalizeWithinTransaction(input: {
    projectId: string;
    treeId: string;
    workflowRevision: number;
    idempotencyKey: string;
  }) {
    const existing = this.database.get<FinalReportRow>(
      "SELECT * FROM final_reports WHERE project_id = ? AND idempotency_key = ?",
      input.projectId, input.idempotencyKey,
    );
    if (existing) {
      if (existing.tree_id !== input.treeId || existing.workflow_revision !== input.workflowRevision) {
        throw new HarnessError("invalid_input", "final report idempotency key was already used for another completion");
      }
      return this.view(existing, false);
    }

    const tree = this.database.get<{
      id: string; title: string; status: string; current_revision_id: string;
    }>(
      "SELECT id, title, status, current_revision_id FROM task_trees WHERE id = ? AND project_id = ?",
      input.treeId, input.projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current Project");
    if (tree.status === "completed") {
      throw new HarnessError("task_tree_transition_rejected", "Task Tree already has a completed final report");
    }
    if (tree.status === "archived") {
      throw new HarnessError("task_tree_transition_rejected", "an archived Task Tree cannot be completed");
    }

    const workflow = this.database.get<{ id: string; stage: string; revision: number; active: number }>(`
      SELECT id, stage, revision, active FROM workflow_states
      WHERE project_id = ? AND tree_id = ? ORDER BY active DESC, updated_at DESC, id DESC LIMIT 1
    `, input.projectId, input.treeId);
    if (!workflow) throw new HarnessError("not_found", "Task Tree Workflow was not found");
    if (workflow.revision !== input.workflowRevision) {
      throw new HarnessError("revision_conflict", "workflow revision does not match current state");
    }
    if (workflow.active !== 1 || workflow.stage !== "final_report") {
      throw new HarnessError("workflow_transition_rejected", "Task Tree is not at the active final_report stage");
    }

    const rootGate = this.database.get<{ id: string }>(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
        AND workflow_revision = ? AND stage = 'root_verification'
        AND status = 'passed' AND next_stage = 'final_report'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, input.projectId, input.treeId, tree.current_revision_id, workflow.revision - 1);

    const complete = loadNodeCompletion(this.database, input.treeId);
    const taskNodes = new Map<string, number>();
    for (const node of this.database.all<{ id: string; status: string }>(`
      SELECT n.id, n.status FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id
      WHERE n.tree_id = ? AND nr.tree_revision_id = ?
    `, input.treeId, tree.current_revision_id)) {
      const status = complete(node.id) ? "succeeded" : node.status === "succeeded" ? "needs_revalidation" : node.status;
      taskNodes.set(status, (taskNodes.get(status) ?? 0) + 1);
    }
    const branches = this.statusCounts(`
      SELECT status, count(*) AS count FROM workflow_branch_states
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? GROUP BY status
    `, input.projectId, input.treeId, tree.current_revision_id);
    const activeAttempts = this.count(`
      SELECT count(*) AS count FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying')
    `, input.projectId, input.treeId);
    const blockingDrifts = this.count(`
      SELECT count(*) AS count FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation'
    `, input.projectId, input.treeId);
    const pendingConfirmations = this.count(`
      SELECT count(*) AS count FROM runtime_confirmation_prompts
      WHERE project_id = ? AND tree_id = ? AND status = 'pending'
    `, input.projectId, input.treeId);
    const pendingChanges = this.count(`
      SELECT count(*) AS count FROM user_change_requests
      WHERE project_id = ? AND tree_id = ? AND status IN ('proposed', 'pending_confirmation', 'paused')
    `, input.projectId, input.treeId);

    const blockers: Array<{ code: string; ref: string }> = [];
    if (!rootGate) blockers.push({ code: "root_verification_gate_missing", ref: tree.current_revision_id });
    for (const [status, count] of taskNodes) {
      if (status !== "succeeded") blockers.push({ code: "task_node_incomplete", ref: `${status}:${count}` });
    }
    for (const [status, count] of branches) {
      if (status !== "verified") blockers.push({ code: "branch_not_verified", ref: `${status}:${count}` });
    }
    if (activeAttempts) blockers.push({ code: "active_attempt", ref: String(activeAttempts) });
    if (blockingDrifts) blockers.push({ code: "blocking_drift", ref: String(blockingDrifts) });
    if (pendingConfirmations) blockers.push({ code: "pending_confirmation", ref: String(pendingConfirmations) });
    if (pendingChanges) blockers.push({ code: "pending_change", ref: String(pendingChanges) });
    if (blockers.length) {
      throw new HarnessError("workflow_transition_rejected", "Task Tree cannot be finalized while lifecycle blockers remain", { blockers });
    }

    const phaseGates = this.statusCounts(`
      SELECT status, count(*) AS count FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? GROUP BY status
    `, input.projectId, input.treeId, tree.current_revision_id);
    const artifacts = this.statusCounts(`
      SELECT status, count(*) AS count FROM artifacts WHERE project_id = ? AND tree_id = ? GROUP BY status
    `, input.projectId, input.treeId);
    const document = JSON.parse(this.database.get<{ document_json: string }>(
      "SELECT document_json FROM task_tree_revisions WHERE id = ?", tree.current_revision_id,
    )!.document_json) as TaskTreeDocument;
    const matchesCurrentContext = (nodeId: string, priorDocument: string) =>
      taskNodeEvidenceContext(document, nodeId) === taskNodeEvidenceContext(JSON.parse(priorDocument) as TaskTreeDocument, nodeId);
    const evaluationRows = this.database.all<{ id: string; status: string; task_node_id: string; execution_attempt_id: string; document_json: string }>(`
      SELECT e.id, e.verdict AS status, e.task_node_id, e.execution_attempt_id, prior.document_json FROM evaluations e
      JOIN task_node_revisions nr ON nr.id = e.task_node_revision_id
      JOIN task_tree_revisions prior ON prior.id = nr.tree_revision_id
      JOIN task_node_revisions current ON current.node_id = e.task_node_id AND current.tree_revision_id = ?
      WHERE e.project_id = ? AND e.tree_id = ? AND nr.body_json = current.body_json ORDER BY e.created_at, e.id
    `, tree.current_revision_id, input.projectId, input.treeId).filter((row) => matchesCurrentContext(row.task_node_id, row.document_json));
    const evaluations = new Map<string, number>();
    for (const row of evaluationRows) evaluations.set(row.status, (evaluations.get(row.status) ?? 0) + 1);
    const traceCount = this.count(
      "SELECT count(*) AS count FROM trace_events WHERE project_id = ? AND tree_id = ?",
      input.projectId, input.treeId,
    );

    const invalidations = this.database.all<VerificationInvalidationRow>(`
      SELECT id, invalidated_evaluation_ids_json, invalidated_gate_result_ids_json
      FROM verification_invalidations
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
      ORDER BY created_at, id
    `, input.projectId, input.treeId, tree.current_revision_id);
    const invalidatedEvaluationIds = new Set(this.database.all<{ invalidated_evaluation_ids_json: string }>(
      "SELECT invalidated_evaluation_ids_json FROM verification_invalidations WHERE project_id = ? AND tree_id = ?",
      input.projectId, input.treeId,
    ).flatMap((row) => JSON.parse(row.invalidated_evaluation_ids_json) as string[]));
    const invalidatedGateResultIds = new Set(invalidations.flatMap((row) => JSON.parse(row.invalidated_gate_result_ids_json) as string[]));
    const phaseGateResultIds = this.ids(`
      SELECT id FROM workflow_phase_gate_results
      WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND status = 'passed'
      ORDER BY created_at, id
    `, input.projectId, input.treeId, tree.current_revision_id).filter((id) => !invalidatedGateResultIds.has(id));
    const validEvaluations = evaluationRows.filter((row) => row.status === "succeeded" && !invalidatedEvaluationIds.has(row.id));
    const evaluationIds = validEvaluations.map((row) => row.id);
    const validAttemptIds = new Set(validEvaluations.map((row) => row.execution_attempt_id));
    const traceEventIds = [...new Set(this.database.all<{ id: string; attempt_id: string }>(`
      SELECT DISTINCT ae.trace_event_id AS id, ae.attempt_id FROM execution_attempt_evidence ae
      JOIN execution_attempts a ON a.id = ae.attempt_id
      WHERE a.project_id = ? AND a.tree_id = ?
      ORDER BY id
    `, input.projectId, input.treeId).filter((row) => validAttemptIds.has(row.attempt_id)).map((row) => row.id))];
    const artifactIds = this.ids(`
      SELECT id FROM artifacts WHERE project_id = ? AND tree_id = ?
        AND status IN ('created', 'modified', 'verified', 'observed') ORDER BY id
    `, input.projectId, input.treeId);

    const summary = {
      tree: { title: tree.title, revisionId: tree.current_revision_id },
      taskNodes: {
        total: this.total(taskNodes), succeeded: taskNodes.get("succeeded") ?? 0,
        failed: taskNodes.get("failed") ?? 0, blocked: taskNodes.get("blocked") ?? 0,
      },
      branches: { total: this.total(branches), verified: branches.get("verified") ?? 0 },
      phaseGates: {
        total: this.total(phaseGates), passed: phaseGates.get("passed") ?? 0,
        failed: phaseGates.get("failed") ?? 0, uncertain: phaseGates.get("uncertain") ?? 0,
      },
      artifacts: { total: this.total(artifacts), verified: artifacts.get("verified") ?? 0 },
      evaluations: {
        total: this.total(evaluations), succeeded: evaluations.get("succeeded") ?? 0,
        failed: evaluations.get("failed") ?? 0, blocked: evaluations.get("blocked") ?? 0,
        uncertain: evaluations.get("uncertain") ?? 0,
      },
      traces: { total: traceCount },
      verificationFreshness: { invalidationCount: invalidations.length },
      unresolved: { activeAttempts, blockingDrifts, pendingConfirmations, pendingChanges },
    };
    const evidenceRefs = {
      phaseGateResultIds, evaluationIds, traceEventIds, artifactIds,
      verificationInvalidationIds: invalidations.map((row) => row.id),
    };
    const reportId = newId();
    const createdAt = nowIso();
    this.database.run(`
      INSERT INTO final_reports (
        id, project_id, tree_id, tree_revision_id, workflow_revision,
        root_phase_gate_result_id, status, summary_json, evidence_refs_json,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
    `, reportId, input.projectId, input.treeId, tree.current_revision_id, workflow.revision,
    rootGate!.id, canonicalJson(summary), canonicalJson(evidenceRefs), input.idempotencyKey, createdAt);
    this.database.run(
      "UPDATE task_trees SET status = 'completed', updated_at = ? WHERE id = ?",
      createdAt, input.treeId,
    );
    this.database.run(
      "UPDATE workflow_states SET active = 0, updated_at = ? WHERE id = ?",
      createdAt, workflow.id,
    );
    this.completeSessionProfiles(input.projectId, input.treeId, createdAt);
    return {
      reportId, projectId: input.projectId, treeId: input.treeId,
      treeRevisionId: tree.current_revision_id, workflowRevision: workflow.revision,
      rootPhaseGateResultId: rootGate!.id, status: "completed" as const,
      summary, evidenceRefs, idempotencyKey: input.idempotencyKey, createdAt, created: true,
    };
  }

  private completeSessionProfiles(projectId: string, treeId: string, timestamp: string): void {
    // Completion ends the policy of this work, not the Task Tree's history.
    // A later, independent request must not be cleared by an earlier tree.
    const profiles = this.database.all<CompletionSessionProfileRow>(`
      SELECT p.session_id, p.source_route_decision_id, p.source_affiliation_decision_id
      FROM runtime_profile_states p
      WHERE p.project_id = ? AND p.profile = 'structured_coding' AND (
        EXISTS (
          SELECT 1 FROM task_affiliation_decisions d
          WHERE d.id = p.source_affiliation_decision_id AND d.project_id = p.project_id
            AND d.resolved_tree_id = ? AND d.status IN ('new_tree', 'merged')
        ) OR (p.source_affiliation_decision_id IS NULL AND (
          EXISTS (
            SELECT 1 FROM task_tree_approval_references a
            WHERE a.project_id = p.project_id AND a.tree_id = ? AND a.session_id = p.session_id
              AND a.status = 'consumed' AND a.resolved_at >= p.updated_at
          ) OR EXISTS (
            SELECT 1 FROM execution_attempts a
            WHERE a.project_id = p.project_id AND a.tree_id = ? AND a.session_id = p.session_id
              AND a.started_at >= p.updated_at
          )
        ))
      )
    `, projectId, treeId, treeId, treeId);
    // A cached route points to its first Trace, possibly in an older tree.
    // Bind continuation to the latest received prompt, using routing's trim()
    // normalization (including Unicode whitespace), not SQL's space-only trim.
    const continuations = this.database.all<CompletionSessionProfileRow & {
      source_prompt: unknown; latest_prompt: unknown;
    }>(`
      SELECT p.session_id, p.source_route_decision_id, p.source_affiliation_decision_id,
        json_extract(source.payload_json, '$.prompt') AS source_prompt,
        json_extract(latest.payload_json, '$.prompt') AS latest_prompt
      FROM runtime_profile_states p
      JOIN request_route_decisions r ON r.id = p.source_route_decision_id
        AND r.project_id = p.project_id AND r.session_id = p.session_id
      JOIN trace_events source ON source.id = r.prompt_trace_event_id
        AND source.project_id = p.project_id AND source.session_id = p.session_id AND source.event_name = 'UserPromptSubmit'
      JOIN trace_events latest ON latest.id = (
        SELECT id FROM trace_events
        WHERE project_id = p.project_id AND session_id = p.session_id AND event_name = 'UserPromptSubmit'
        ORDER BY rowid DESC LIMIT 1
      )
      WHERE p.project_id = ? AND p.profile = 'structured_coding'
        AND p.source_affiliation_decision_id IS NULL AND p.reason_code = 'active_approved_workflow'
        AND latest.tree_id = ?
        AND (r.tree_relation IN ('continue_existing_tree', 'change_existing_tree') OR r.fallback_reason IS NOT NULL)
    `, projectId, treeId);
    const sessions = new Map(profiles.map((profile) => [profile.session_id, profile]));
    for (const profile of continuations) {
      if (typeof profile.source_prompt === "string" && typeof profile.latest_prompt === "string"
        && profile.latest_prompt.trim() === profile.source_prompt.trim()) sessions.set(profile.session_id, profile);
    }
    for (const profile of sessions.values()) {
      this.database.run(`
        INSERT INTO runtime_profile_transitions (
          id, project_id, session_id, prior_profile, next_profile, source_route_decision_id,
          source_affiliation_decision_id, reason_code, created_at
        ) VALUES (?, ?, ?, 'structured_coding', 'conversation', ?, ?, 'task_tree:completed', ?)
      `, newId(), projectId, profile.session_id, profile.source_route_decision_id,
      profile.source_affiliation_decision_id, timestamp);
      this.database.run(`
        UPDATE runtime_profile_states
        SET profile = 'conversation', reason_code = 'task_tree:completed', updated_at = ?
        WHERE project_id = ? AND session_id = ?
      `, timestamp, projectId, profile.session_id);
    }
  }

  private count(sql: string, ...params: string[]): number {
    return this.database.get<{ count: number }>(sql, ...params)?.count ?? 0;
  }

  private ids(sql: string, ...params: string[]): string[] {
    return this.database.all<{ id: string }>(sql, ...params).map((row) => row.id);
  }

  private statusCounts(sql: string, ...params: string[]): Map<string, number> {
    return new Map(this.database.all<StatusCountRow>(sql, ...params).map((row) => [row.status, row.count]));
  }

  private total(counts: Map<string, number>): number {
    return [...counts.values()].reduce((total, count) => total + count, 0);
  }

  private view(row: FinalReportRow, created: boolean) {
    return {
      reportId: row.id, projectId: row.project_id, treeId: row.tree_id,
      treeRevisionId: row.tree_revision_id, workflowRevision: row.workflow_revision,
      rootPhaseGateResultId: row.root_phase_gate_result_id, status: row.status,
      summary: JSON.parse(row.summary_json) as Record<string, unknown>,
      evidenceRefs: JSON.parse(row.evidence_refs_json) as Record<string, unknown>,
      idempotencyKey: row.idempotency_key, createdAt: row.created_at, created,
    };
  }
}
