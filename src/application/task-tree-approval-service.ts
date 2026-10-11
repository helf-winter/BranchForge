import { HarnessError } from "../domain/errors.js";
import { newId } from "../domain/ids.js";
import { hashNativePlanBlock, renderCanonicalTaskTreeBlock } from "../domain/native-plan.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { TaskTreeService } from "./task-tree-service.js";

export const APPROVAL_REFERENCE_TTL_MS = 86_400_000;

export interface TaskTreeApprovalPreparation {
  approvalRef: string;
  canonicalBlock: string;
  canonicalBlockHash: string;
  treeId: string;
  treeRevisionId: string;
  readinessResultId: string;
  expiresAt: string;
}

interface ApprovalRow {
  approval_ref: string;
  tree_id: string;
  tree_revision_id: string;
  readiness_result_id: string;
  canonical_block_hash: string;
  status: "prepared" | "consumed" | "rejected" | "expired" | "superseded";
  expires_at: string;
  confirmation_prompt_id: string;
  source_trace_event_id: string | null;
}

export class TaskTreeApprovalService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly trees = new TaskTreeService(database),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  prepare(input: {
    projectId: string;
    sessionId: string;
    treeId: string;
    treeRevisionId: string;
    readinessResultId: string;
    sourceTraceEventId?: string;
  }): TaskTreeApprovalPreparation {
    if (!input.sessionId.trim()) throw new HarnessError("invalid_input", "Session provenance is required for native Plan approval");
    const tree = this.database.get<{ status: string; current_revision_id: string }>(
      "SELECT status, current_revision_id FROM task_trees WHERE id = ? AND project_id = ?",
      input.treeId, input.projectId,
    );
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in the current project");
    if (tree.status === "archived" || tree.status === "completed") {
      throw new HarnessError("task_tree_transition_rejected", `${tree.status} Task Trees cannot be prepared for execution approval`);
    }
    if (tree.current_revision_id !== input.treeRevisionId) {
      throw new HarnessError("revision_conflict", "approval preparation requires the exact current Task Tree revision");
    }
    const readiness = this.database.get<{
      id: string; tree_id: string; revision_id: string; ready: number; scope_kind: string; scope_root_node_id: string | null;
    }>(`
      SELECT id, tree_id, revision_id, ready, scope_kind, scope_root_node_id
      FROM plan_readiness_results WHERE id = ?
    `, input.readinessResultId);
    if (!readiness || readiness.tree_id !== input.treeId || readiness.revision_id !== input.treeRevisionId
      || readiness.ready !== 1 || readiness.scope_kind !== "tree" || readiness.scope_root_node_id !== null) {
      throw new HarnessError("workflow_transition_rejected", "a ready whole-tree result for the exact current revision is required");
    }
    const workflow = this.database.get<{ id: string; revision: number; stage: string }>(`
      SELECT id, revision, stage FROM workflow_states
      WHERE project_id = ? AND tree_id = ? AND active = 1
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `, input.projectId, input.treeId);
    if (!workflow || workflow.stage !== "branch_confirmation") {
      throw new HarnessError("workflow_transition_rejected", "Task Tree approval requires an active branch-confirmation Workflow revision");
    }
    const treeView = this.trees.getRevisionById(input.projectId, input.treeId, input.treeRevisionId);
    if (input.sourceTraceEventId) {
      const existing = this.database.get<ApprovalRow>(`
        SELECT approval_ref, tree_id, tree_revision_id, readiness_result_id, canonical_block_hash,
               status, expires_at, confirmation_prompt_id, source_trace_event_id
        FROM task_tree_approval_references
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?
          AND readiness_result_id = ? AND source_trace_event_id = ?
      `, input.projectId, input.treeId, input.treeRevisionId, input.readinessResultId, input.sourceTraceEventId);
      if (existing) {
        return {
          approvalRef: existing.approval_ref,
          canonicalBlock: renderCanonicalTaskTreeBlock({
            approvalRef: existing.approval_ref,
            tree: treeView,
            readiness: {
              resultId: existing.readiness_result_id, ready: true, scopeKind: "tree",
              coveredNodeIds: treeView.document.nodes.map((node) => node.id),
            },
          }),
          canonicalBlockHash: existing.canonical_block_hash,
          treeId: existing.tree_id,
          treeRevisionId: existing.tree_revision_id,
          readinessResultId: existing.readiness_result_id,
          expiresAt: existing.expires_at,
        };
      }
    }
    const timestamp = this.clock().toISOString();
    const expiresAt = new Date(Date.parse(timestamp) + APPROVAL_REFERENCE_TTL_MS).toISOString();
    const approvalRef = newId();
    const canonicalBlock = renderCanonicalTaskTreeBlock({
      approvalRef,
      tree: treeView,
      readiness: {
        resultId: readiness.id, ready: true, scopeKind: "tree",
        coveredNodeIds: treeView.document.nodes.map((node) => node.id),
      },
    });
    const canonicalBlockHash = hashNativePlanBlock(canonicalBlock);
    const confirmationId = newId();

    this.database.transaction(() => {
      const prior = this.database.all<{ approval_ref: string; confirmation_prompt_id: string; expires_at: string }>(`
        SELECT approval_ref, confirmation_prompt_id, expires_at
        FROM task_tree_approval_references
        WHERE project_id = ? AND session_id = ? AND tree_id = ? AND status = 'prepared'
        ORDER BY created_at, approval_ref
      `, input.projectId, input.sessionId, input.treeId);
      for (const row of prior) {
        const nextStatus = row.expires_at <= timestamp ? "expired" : "superseded";
        this.database.run(
          "UPDATE task_tree_approval_references SET status = ?, resolved_at = ? WHERE approval_ref = ?",
          nextStatus, timestamp, row.approval_ref,
        );
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'cancelled', answer = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
          nextStatus, timestamp, row.confirmation_prompt_id,
        );
      }
      this.database.run(`
        INSERT INTO runtime_confirmation_prompts (
          id, project_id, tree_id, scope_id, prompt, status, created_at,
          tree_revision_id, readiness_result_id, scope_kind, scope_root_node_id,
          prompt_type, related_artifact_ids_json, options_json
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'tree', NULL, 'branch_confirmation', '[]', '["yes","no"]')
      `, confirmationId, input.projectId, input.treeId, input.treeId,
      "Approve this exact Task Tree revision through the native Plan confirmation", timestamp,
      input.treeRevisionId, input.readinessResultId);
      this.database.run(`
        INSERT INTO task_tree_approval_references (
          approval_ref, project_id, session_id, tree_id, tree_revision_id, readiness_result_id,
          workflow_id, workflow_revision, confirmation_prompt_id, canonical_block_hash,
          status, expires_at, created_at, source_trace_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)
      `, approvalRef, input.projectId, input.sessionId, input.treeId, input.treeRevisionId,
      input.readinessResultId, workflow.id, workflow.revision, confirmationId, canonicalBlockHash,
      expiresAt, timestamp, input.sourceTraceEventId ?? null);
    });
    return {
      approvalRef, canonicalBlock, canonicalBlockHash, treeId: input.treeId,
      treeRevisionId: input.treeRevisionId, readinessResultId: input.readinessResultId, expiresAt,
    };
  }

  getPending(input: { projectId: string; sessionId: string; treeId: string }) {
    const row = this.database.get<ApprovalRow>(`
      SELECT approval_ref, tree_id, tree_revision_id, readiness_result_id, canonical_block_hash,
             status, expires_at, confirmation_prompt_id, source_trace_event_id
      FROM task_tree_approval_references
      WHERE project_id = ? AND session_id = ? AND tree_id = ? AND status = 'prepared'
      ORDER BY created_at DESC, approval_ref DESC LIMIT 1
    `, input.projectId, input.sessionId, input.treeId);
    if (!row) return null;
    const timestamp = this.clock().toISOString();
    if (row.expires_at <= timestamp) {
      this.database.transaction(() => {
        this.database.run(
          "UPDATE task_tree_approval_references SET status = 'expired', resolved_at = ? WHERE approval_ref = ?",
          timestamp, row.approval_ref,
        );
        this.database.run(
          "UPDATE runtime_confirmation_prompts SET status = 'cancelled', answer = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
          timestamp, row.confirmation_prompt_id,
        );
      });
      return null;
    }
    return {
      approvalRef: row.approval_ref,
      treeId: row.tree_id,
      treeRevisionId: row.tree_revision_id,
      readinessResultId: row.readiness_result_id,
      canonicalBlockHash: row.canonical_block_hash,
      status: row.status,
      expiresAt: row.expires_at,
    };
  }
}
