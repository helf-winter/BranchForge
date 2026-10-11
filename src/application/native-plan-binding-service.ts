import { HarnessError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { extractCanonicalTaskTreeBlock, hashNativePlanBlock, normalizeNativePlanText } from "../domain/native-plan.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { WorkflowService } from "./workflow-service.js";

interface ApprovalRow {
  approval_ref: string;
  project_id: string;
  session_id: string;
  tree_id: string;
  tree_revision_id: string;
  confirmation_prompt_id: string;
  canonical_block_hash: string;
  workflow_revision: number;
  status: string;
  expires_at: string;
}

interface SnapshotRow {
  id: string;
  approval_ref: string;
  plan_hash: string;
  canonical_block_hash: string;
}

export interface NativePlanPreExitView {
  snapshotId: string;
  approvalRef: string;
  treeId: string;
  treeRevisionId: string;
  planHash: string;
  canonicalBlockHash: string;
}

export interface NativePlanApprovalView {
  approvalRef: string;
  outcome: "approved" | "rejected";
  status: "consumed" | "rejected";
  treeId: string;
  treeRevisionId: string;
  stage: string;
  workflowRevision: number;
}

export class NativePlanBindingService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly workflows = new WorkflowService(database),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  preExit(input: {
    projectId: string;
    sessionId: string;
    toolUseId: string;
    planMarkdown: string;
    planFilePath?: string;
    traceEventId: string;
  }): NativePlanPreExitView {
    const normalizedPlan = normalizeNativePlanText(input.planMarkdown);
    const extracted = extractCanonicalTaskTreeBlock(normalizedPlan);
    const planHash = hashNativePlanBlock(normalizedPlan);
    const canonicalBlockHash = hashNativePlanBlock(extracted.block);
    const existing = this.database.get<SnapshotRow>(`
      SELECT id, approval_ref, plan_hash, canonical_block_hash FROM native_plan_snapshots
      WHERE project_id = ? AND session_id = ? AND tool_use_id = ?
    `, input.projectId, input.sessionId, input.toolUseId);
    if (existing) {
      if (existing.approval_ref !== extracted.approvalRef || existing.plan_hash !== planHash
        || existing.canonical_block_hash !== canonicalBlockHash) {
        throw new HarnessError("confirmation_not_applicable", "the ExitPlanMode tool use is already bound to a different native Plan snapshot");
      }
      const approval = this.requireApproval(input.projectId, input.sessionId, extracted.approvalRef);
      return this.preView(existing, approval);
    }
    const approval = this.requireApproval(input.projectId, input.sessionId, extracted.approvalRef);
    if (approval.status !== "prepared") {
      throw new HarnessError("confirmation_not_applicable", "native Plan approval reference is no longer available");
    }
    const timestamp = this.clock().toISOString();
    if (approval.expires_at <= timestamp) {
      this.database.transaction(() => {
        this.database.run(
          "UPDATE task_tree_approval_references SET status = 'expired', resolved_at = ? WHERE approval_ref = ?",
          timestamp, approval.approval_ref,
        );
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'cancelled', answer = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
          timestamp, approval.confirmation_prompt_id,
        );
      });
      throw new HarnessError("confirmation_not_applicable", "native Plan approval reference has expired");
    }
    const current = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?",
      approval.tree_id, input.projectId,
    );
    if (!current || current.current_revision_id !== approval.tree_revision_id) {
      throw new HarnessError("revision_conflict", "native Plan approval belongs to a stale Task Tree revision");
    }
    if (canonicalBlockHash !== approval.canonical_block_hash) {
      throw new HarnessError("confirmation_not_applicable", "canonical Task Tree block changed after approval preparation");
    }
    this.requireTrace({
      projectId: input.projectId, sessionId: input.sessionId, traceEventId: input.traceEventId,
      eventName: "PreToolUse", toolUseId: input.toolUseId,
    });
    const snapshotId = newId();
    this.database.run(`
      INSERT INTO native_plan_snapshots (
        id, approval_ref, project_id, session_id, tool_use_id, plan_hash,
        canonical_block_hash, plan_file_path, trace_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, snapshotId, approval.approval_ref, input.projectId, input.sessionId, input.toolUseId,
    planHash, canonicalBlockHash, input.planFilePath ?? null, input.traceEventId, timestamp);
    return this.preView({ id: snapshotId, approval_ref: approval.approval_ref, plan_hash: planHash, canonical_block_hash: canonicalBlockHash }, approval);
  }

  postExit(input: {
    projectId: string;
    sessionId: string;
    toolUseId: string;
    traceEventId: string;
    outcome: "approved" | "rejected";
  }): NativePlanApprovalView {
    const snapshot = this.database.get<SnapshotRow>(`
      SELECT id, approval_ref, plan_hash, canonical_block_hash FROM native_plan_snapshots
      WHERE project_id = ? AND session_id = ? AND tool_use_id = ?
    `, input.projectId, input.sessionId, input.toolUseId);
    if (!snapshot) throw new HarnessError("confirmation_not_applicable", "no validated native Plan snapshot exists for this tool use");
    const existing = this.database.get<{ outcome: "approved" | "rejected" }>(`
      SELECT outcome FROM native_plan_approval_events
      WHERE project_id = ? AND session_id = ? AND tool_use_id = ?
    `, input.projectId, input.sessionId, input.toolUseId);
    const approval = this.requireApproval(input.projectId, input.sessionId, snapshot.approval_ref);
    if (existing) {
      if (existing.outcome !== input.outcome) {
        throw new HarnessError("confirmation_not_applicable", "native Plan tool use was already resolved with a different outcome");
      }
      return this.approvalView(approval, input.outcome);
    }
    this.requireTrace({
      projectId: input.projectId, sessionId: input.sessionId, traceEventId: input.traceEventId,
      eventName: input.outcome === "approved" ? "PostToolUse" : "PostToolUseFailure",
      toolUseId: input.toolUseId,
    });
    if (approval.status !== "prepared") {
      throw new HarnessError("confirmation_not_applicable", "native Plan approval reference has already been resolved");
    }
    const timestamp = this.clock().toISOString();
    let expired = false;
    this.database.transaction(() => {
      const current = this.database.get<{ status: string; expires_at: string }>(
        "SELECT status, expires_at FROM task_tree_approval_references WHERE approval_ref = ?",
        approval.approval_ref,
      );
      if (current?.status === "prepared" && current.expires_at <= timestamp) {
        this.database.run(
          "UPDATE task_tree_approval_references SET status = 'expired', resolved_at = ? WHERE approval_ref = ?",
          timestamp, approval.approval_ref,
        );
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'cancelled', answer = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
          timestamp, approval.confirmation_prompt_id,
        );
        expired = true;
      }
    });
    if (expired) {
      throw new HarnessError("confirmation_not_applicable", "native Plan approval reference expired before the native approval completed");
    }
    if (input.outcome === "rejected") {
      this.database.transaction(() => {
        this.database.run(`
          INSERT INTO native_plan_approval_events (
            id, approval_ref, snapshot_id, project_id, session_id, tool_use_id,
            trace_event_id, outcome, plan_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?)
        `, newId(), approval.approval_ref, snapshot.id, input.projectId, input.sessionId,
        input.toolUseId, input.traceEventId, snapshot.plan_hash, timestamp);
        this.database.run(
          "UPDATE task_tree_approval_references SET status = 'rejected', resolved_at = ? WHERE approval_ref = ?",
          timestamp, approval.approval_ref,
        );
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'rejected', answer = 'no', answer_trace_event_id = ?, resolved_at = ? WHERE id = ?",
          input.traceEventId, timestamp, approval.confirmation_prompt_id,
        );
      });
      return this.approvalView({ ...approval, status: "rejected" }, "rejected");
    }

    let workflow!: ReturnType<WorkflowService["confirmNativePlan"]>;
    this.database.transaction(() => {
      workflow = this.workflows.confirmNativePlan({
        projectId: input.projectId,
        confirmationId: approval.confirmation_prompt_id,
        nativeApprovalTraceEventId: input.traceEventId,
        workflowRevision: approval.workflow_revision,
        withinTransaction: true,
      });
      this.database.run(`
        INSERT INTO native_plan_approval_events (
          id, approval_ref, snapshot_id, project_id, session_id, tool_use_id,
          trace_event_id, outcome, plan_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `, newId(), approval.approval_ref, snapshot.id, input.projectId, input.sessionId,
      input.toolUseId, input.traceEventId, snapshot.plan_hash, timestamp);
      this.database.run(`
        INSERT INTO native_plan_task_tree_links (
          id, snapshot_id, approval_ref, project_id, tree_id, tree_revision_id,
          confirmation_prompt_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, newId(), snapshot.id, approval.approval_ref, input.projectId, approval.tree_id,
      approval.tree_revision_id, approval.confirmation_prompt_id, timestamp);
      this.database.run(
        "UPDATE task_tree_approval_references SET status = 'consumed', resolved_at = ? WHERE approval_ref = ?",
        timestamp, approval.approval_ref,
      );
    });
    return {
      approvalRef: approval.approval_ref, outcome: "approved", status: "consumed",
      treeId: approval.tree_id, treeRevisionId: approval.tree_revision_id,
      stage: workflow.stage, workflowRevision: workflow.workflowRevision,
    };
  }

  private requireApproval(projectId: string, sessionId: string, approvalRef: string): ApprovalRow {
    const row = this.database.get<ApprovalRow>(`
      SELECT approval_ref, project_id, session_id, tree_id, tree_revision_id,
             confirmation_prompt_id, canonical_block_hash, workflow_revision, status, expires_at
      FROM task_tree_approval_references
      WHERE approval_ref = ? AND project_id = ? AND session_id = ?
    `, approvalRef, projectId, sessionId);
    if (!row) throw new HarnessError("confirmation_not_applicable", "native Plan approval reference does not belong to this Project and Session");
    return row;
  }

  private requireTrace(input: {
    projectId: string; sessionId: string; traceEventId: string; eventName: string; toolUseId: string;
  }): void {
    const row = this.database.get<{ payload_json: string }>(`
      SELECT payload_json FROM trace_events
      WHERE id = ? AND project_id = ? AND session_id = ? AND event_name = ?
    `, input.traceEventId, input.projectId, input.sessionId, input.eventName);
    let valid = false;
    try {
      const payload = row ? JSON.parse(row.payload_json) as { toolName?: unknown; toolUseId?: unknown } : {};
      valid = payload.toolName === "ExitPlanMode" && payload.toolUseId === input.toolUseId;
    } catch {
      valid = false;
    }
    if (!valid) throw new HarnessError("evidence_scope_mismatch", `${input.eventName}(ExitPlanMode) Trace does not match this tool use`);
  }

  private preView(snapshot: SnapshotRow, approval: ApprovalRow): NativePlanPreExitView {
    return {
      snapshotId: snapshot.id, approvalRef: snapshot.approval_ref, treeId: approval.tree_id,
      treeRevisionId: approval.tree_revision_id, planHash: snapshot.plan_hash,
      canonicalBlockHash: snapshot.canonical_block_hash,
    };
  }

  private approvalView(approval: ApprovalRow, outcome: "approved" | "rejected"): NativePlanApprovalView {
    const workflow = this.database.get<{ stage: string; revision: number }>(
      "SELECT stage, revision FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1",
      approval.project_id, approval.tree_id,
    );
    return {
      approvalRef: approval.approval_ref, outcome,
      status: outcome === "approved" ? "consumed" : "rejected",
      treeId: approval.tree_id, treeRevisionId: approval.tree_revision_id,
      stage: workflow?.stage ?? "unknown", workflowRevision: workflow?.revision ?? approval.workflow_revision,
    };
  }
}
