import { HarnessError } from "../domain/errors.js";
import { findUserDecisionEvidence } from "./user-decision-evidence.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  hashTaskTreeAuthoringPayload,
  requireSingleTaskTreePatchOperation,
  type TaskTreePatchOperation,
} from "../domain/task-tree-authoring.js";
import type { TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { TaskTreeService, type TaskTreeRevisionView } from "./task-tree-service.js";
import { TaskTreeIterationService, iterationRevisionView, type TaskTreeIterationView } from "./task-tree-iteration-service.js";

interface AffiliationRow {
  id: string;
  status: string;
  answer_trace_event_id: string | null;
  resolved_tree_id: string | null;
}

interface CommandRow {
  input_hash: string;
  tree_id: string;
  result_revision_id: string;
}

interface TreeRow {
  id: string;
  status: string;
  current_revision_id: string;
  document_json: string;
}

export class TaskTreeDraftService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly trees = new TaskTreeService(database),
  ) {}

  createDraft(input: {
    projectId: string;
    sessionId: string;
    affiliationDecisionId: string;
    expectedTreeRevisionId?: string;
    document: TaskTreeDocument;
    idempotencyKey: string;
  }): TaskTreeRevisionView | TaskTreeIterationView {
    if (input.document.planningVersion !== 1) {
      throw new HarnessError("invalid_input", "first-class Task Tree drafts require planningVersion 1");
    }
    const affiliation = this.database.get<AffiliationRow>(`
      SELECT id, status, answer_trace_event_id, resolved_tree_id
      FROM task_affiliation_decisions WHERE id = ? AND project_id = ?
    `, input.affiliationDecisionId, input.projectId);
    if (!affiliation) throw new HarnessError("not_found", "Task affiliation decision was not found in this Project");
    if (!affiliation.resolved_tree_id || !["new_tree", "merged"].includes(affiliation.status)) {
      throw new HarnessError("confirmation_required", "Task Tree authoring requires a resolved new-tree or merge affiliation");
    }
    const trace = affiliation.answer_trace_event_id
      ? findUserDecisionEvidence(this.database, input.projectId, affiliation.answer_trace_event_id)
      : undefined;
    if (!trace || trace.session_id !== input.sessionId) {
      throw new HarnessError("evidence_scope_mismatch", "authoring Session must match the confirmed affiliation answer");
    }
    const tree = this.currentTree(input.projectId, affiliation.resolved_tree_id);
    const inputHash = hashTaskTreeAuthoringPayload({
      kind: "create_draft",
      sessionId: input.sessionId,
      affiliationDecisionId: input.affiliationDecisionId,
      expectedTreeRevisionId: input.expectedTreeRevisionId ?? null,
      document: input.document,
    });
    const existing = this.idempotent(input.projectId, input.idempotencyKey, inputHash);
    if (existing) return existing;

    if (affiliation.status === "merged" && !input.expectedTreeRevisionId) {
      throw new HarnessError("revision_conflict", "merged Task Tree authoring requires the exact current revision");
    }
    if (input.expectedTreeRevisionId && input.expectedTreeRevisionId !== tree.current_revision_id) {
      throw new HarnessError("revision_conflict", "Task Tree draft is based on a stale revision");
    }
    if (!input.expectedTreeRevisionId && !this.isBlankRoot(JSON.parse(tree.document_json) as TaskTreeDocument)) {
      throw new HarnessError("revision_conflict", "expectedTreeRevisionId may be omitted only for the auto-created blank root");
    }

    return this.database.transaction(() => {
      const result = tree.status === "completed" ? new TaskTreeIterationService(this.database, this.trees).reopenWithinTransaction({
        projectId: input.projectId, sessionId: input.sessionId, affiliationDecisionId: affiliation.id,
        treeId: tree.id, expectedTreeRevisionId: tree.current_revision_id, document: input.document, inputHash,
      }) : this.trees.saveDraftRevisionWithinTransaction({
        projectId: input.projectId,
        treeId: tree.id,
        baseRevisionId: tree.current_revision_id,
        document: input.document,
      });
      this.insertCommand({
        projectId: input.projectId,
        treeId: tree.id,
        affiliationDecisionId: affiliation.id,
        kind: "create_draft",
        idempotencyKey: input.idempotencyKey,
        inputHash,
        baseRevisionId: tree.current_revision_id,
        resultRevisionId: result.revisionId,
        sessionId: input.sessionId,
        traceEventId: affiliation.answer_trace_event_id,
      });
      return result;
    });
  }

  patch(input: {
    projectId: string;
    sessionId: string;
    treeId: string;
    expectedTreeRevisionId: string;
    operations: TaskTreePatchOperation[];
    idempotencyKey: string;
  }): TaskTreeRevisionView {
    const operation = requireSingleTaskTreePatchOperation(input.operations);
    const inputHash = hashTaskTreeAuthoringPayload({
      kind: "patch",
      sessionId: input.sessionId,
      treeId: input.treeId,
      expectedTreeRevisionId: input.expectedTreeRevisionId,
      operations: input.operations,
    });
    const existing = this.idempotent(input.projectId, input.idempotencyKey, inputHash);
    if (existing) return existing;
    const trace = findUserDecisionEvidence(this.database, input.projectId, operation.sourceUserMessageTraceEventId);
    if (!trace || trace.tree_id !== input.treeId || trace.session_id !== input.sessionId) {
      throw new HarnessError("evidence_scope_mismatch", "patch source Trace must belong to the authoring Session and Task Tree");
    }

    return this.database.transaction(() => {
      const result = this.trees.applyRefinementChangeSetWithinTransaction({
        projectId: input.projectId,
        treeId: input.treeId,
        baseRevisionId: input.expectedTreeRevisionId,
        operations: [{ op: "replace_document", document: operation.document }],
        sourceUserMessageTraceEventId: operation.sourceUserMessageTraceEventId,
        ...(operation.previewId ? { previewId: operation.previewId } : {}),
        decision: operation.decision,
      });
      this.insertCommand({
        projectId: input.projectId,
        treeId: input.treeId,
        affiliationDecisionId: null,
        kind: "patch",
        idempotencyKey: input.idempotencyKey,
        inputHash,
        baseRevisionId: input.expectedTreeRevisionId,
        resultRevisionId: result.revisionId,
        sessionId: input.sessionId,
        traceEventId: operation.sourceUserMessageTraceEventId,
      });
      return result;
    });
  }

  private currentTree(projectId: string, treeId: string): TreeRow {
    const row = this.database.get<TreeRow>(`
      SELECT t.id, t.status, t.current_revision_id, r.document_json
      FROM task_trees t JOIN runtime_task_tree_revisions r ON r.id = t.current_revision_id
      WHERE t.id = ? AND t.project_id = ?
    `, treeId, projectId);
    if (!row) throw new HarnessError("not_found", "resolved Task Tree was not found in this Project");
    return row;
  }

  private idempotent(projectId: string, key: string, inputHash: string): TaskTreeRevisionView | null {
    if (!key.trim()) throw new HarnessError("invalid_input", "authoring idempotency key is required");
    const existing = this.database.get<CommandRow>(`
      SELECT input_hash, tree_id, result_revision_id
      FROM task_tree_authoring_commands WHERE project_id = ? AND idempotency_key = ?
    `, projectId, key);
    if (!existing) return null;
    if (existing.input_hash !== inputHash) {
      throw new HarnessError("revision_conflict", "authoring idempotency key was already used with a different payload");
    }
    return iterationRevisionView(this.database, this.trees.getRevisionById(projectId, existing.tree_id, existing.result_revision_id));
  }

  private isBlankRoot(document: TaskTreeDocument): boolean {
    return document.nodes.length === 1
      && document.nodes[0]?.parentId === null
      && document.nodes[0].children.length === 0
      && document.relations.length === 0
      && document.artifacts.length === 0
      && document.planningVersion === undefined;
  }

  private insertCommand(input: {
    projectId: string;
    treeId: string;
    affiliationDecisionId: string | null;
    kind: "create_draft" | "patch";
    idempotencyKey: string;
    inputHash: string;
    baseRevisionId: string;
    resultRevisionId: string;
    sessionId: string;
    traceEventId: string | null;
  }): void {
    this.database.run(`
      INSERT INTO task_tree_authoring_commands (
        id, project_id, tree_id, affiliation_decision_id, command_kind, idempotency_key,
        input_hash, base_revision_id, result_revision_id, source_session_id,
        source_trace_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, newId(), input.projectId, input.treeId, input.affiliationDecisionId, input.kind,
    input.idempotencyKey, input.inputHash, input.baseRevisionId, input.resultRevisionId,
    input.sessionId, input.traceEventId, nowIso());
  }
}
