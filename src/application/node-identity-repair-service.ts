import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import { remapTaskTreeNodeIds } from "../domain/task-node-identity.js";
import type { TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface Conflict { logicalNodeId: string; ownerTreeId: string; canonicalNodeId: string }
interface Tree { current_revision_id: string; document_json: string; status: string }

// Explicit recovery of the observed legacy failure: an unexecuted root was
// saved using an ID owned by another tree. Execution-bearing collisions require
// a separate recovery design; guessing would corrupt immutable provenance.
export class NodeIdentityRepairService {
  constructor(private readonly database: RuntimeDatabase) {}

  preview(input: { projectId: string; treeId: string }) {
    const tree = this.requireTree(input);
    const document = JSON.parse(tree.document_json) as TaskTreeDocument;
    const conflicts: Conflict[] = [];
    const blockers: string[] = [];
    for (const node of document.nodes) {
      const owner = this.database.get<{ tree_id: string }>("SELECT tree_id FROM task_nodes WHERE id = ?", node.id);
      if (!owner || owner.tree_id === input.treeId) continue;
      const canonicalNodeId = `node:${input.treeId}:${node.id}`;
      conflicts.push({ logicalNodeId: node.id, ownerTreeId: owner.tree_id, canonicalNodeId });
      if (node.parentId !== null) blockers.push(`non_root_collision:${node.id}`);
      if (node.executionPhase !== "verification" || !node.requiredEvidence?.length) blockers.push(`root_contract_missing:${node.id}`);
      if (this.database.get("SELECT id FROM task_nodes WHERE id = ?", canonicalNodeId)) blockers.push(`canonical_id_in_use:${node.id}`);
      if (this.database.get("SELECT id FROM execution_attempts WHERE tree_id = ? AND task_node_id = ? LIMIT 1", input.treeId, node.id)) blockers.push(`execution_history_present:${node.id}`);
      if (this.database.get("SELECT id FROM task_node_effects WHERE tree_id = ? AND task_node_id = ? LIMIT 1", input.treeId, node.id)) blockers.push(`effect_history_present:${node.id}`);
      if (this.database.get("SELECT id FROM task_node_artifact_links WHERE tree_id = ? AND task_node_id = ? LIMIT 1", input.treeId, node.id)) blockers.push(`artifact_ownership_present:${node.id}`);
      if (document.artifactContracts?.some((contract) => [...contract.providerNodeIds, ...contract.consumerNodeIds].includes(node.id))) blockers.push(`contract_ownership_present:${node.id}`);
      const confirmation = this.database.get<{ state: string }>("SELECT state FROM task_node_confirmation_states WHERE tree_revision_id = ? AND task_node_id = ?", tree.current_revision_id, node.id);
      if (confirmation?.state !== "confirmed") blockers.push(`root_not_confirmed:${node.id}`);
    }
    for (const revision of this.database.all<{ document_json: string }>("SELECT document_json FROM task_tree_revisions WHERE tree_id = ?", input.treeId)) {
      const prior = JSON.parse(revision.document_json) as TaskTreeDocument;
      for (const conflict of conflicts) {
        const historicalNode = prior.nodes.find((node) => node.id === conflict.logicalNodeId);
        if (historicalNode && historicalNode.parentId !== null) blockers.push(`historical_non_root_collision:${conflict.logicalNodeId}`);
        if (prior.skeletonCriteria?.some((criterion) => criterion.branchNodeId === conflict.logicalNodeId)) blockers.push(`historical_branch_collision:${conflict.logicalNodeId}`);
        if (prior.artifactContracts?.some((contract) => [...contract.providerNodeIds, ...contract.consumerNodeIds].includes(conflict.logicalNodeId))) blockers.push(`historical_contract_ownership:${conflict.logicalNodeId}`);
      }
    }
    const workflow = this.database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE project_id = ? AND tree_id = ? AND active = 1", input.projectId, input.treeId);
    if (conflicts.length && workflow?.stage !== "root_verification") blockers.push("workflow_not_root_verification");
    if (this.database.get("SELECT id FROM execution_attempts WHERE tree_id = ? AND status IN ('running','verifying') LIMIT 1", input.treeId)) blockers.push("active_attempt");
    if (["archived", "completed"].includes(tree.status)) blockers.push("tree_not_active");
    return { projectId: input.projectId, treeId: input.treeId, treeRevisionId: tree.current_revision_id,
      conflicts, blockers: [...new Set(blockers)], canApply: conflicts.length > 0 && blockers.length === 0 };
  }

  apply(input: { projectId: string; treeId: string; expectedTreeRevisionId: string }) {
    return this.database.transaction(() => {
      const tree = this.requireTree(input);
      if (tree.current_revision_id !== input.expectedTreeRevisionId) throw new HarnessError("revision_conflict", "identity recovery requires the exact current revision");
      const existing = this.database.get<{ id: string }>("SELECT id FROM task_node_identity_repairs WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ?", input.projectId, input.treeId, input.expectedTreeRevisionId);
      if (existing) return { status: "applied" as const, repairId: existing.id, treeRevisionId: input.expectedTreeRevisionId, reused: true };
      const preview = this.preview(input);
      if (!preview.canApply) throw new HarnessError("runtime_action_rejected", "identity recovery is not safe for this tree", preview);
      const document = JSON.parse(tree.document_json) as TaskTreeDocument;
      const ids = new Map(preview.conflicts.map((value) => [value.logicalNodeId, value.canonicalNodeId]));
      const timestamp = nowIso();
      const repairId = newId();
      this.database.run("INSERT INTO task_node_identity_repairs (id,project_id,tree_id,tree_revision_id,mapping_json,created_at) VALUES (?,?,?,?,?,?)",
        repairId, input.projectId, input.treeId, input.expectedTreeRevisionId, canonicalJson(preview.conflicts), timestamp);
      for (const conflict of preview.conflicts) {
        const node = document.nodes.find((value) => value.id === conflict.logicalNodeId)!;
        this.database.run("INSERT INTO task_nodes (id,tree_id,parent_id,title,status) VALUES (?,?,NULL,?,'ready')", conflict.canonicalNodeId, input.treeId, node.title);
        this.database.run("UPDATE task_nodes SET parent_id = ? WHERE tree_id = ? AND parent_id = ?", conflict.canonicalNodeId, input.treeId, conflict.logicalNodeId);
        this.database.run("UPDATE task_node_confirmation_states SET task_node_id = ? WHERE tree_id = ? AND task_node_id = ?", conflict.canonicalNodeId, input.treeId, conflict.logicalNodeId);
        this.database.run("UPDATE runtime_states SET selected_node_id = ? WHERE project_id = ? AND selected_tree_id = ? AND selected_node_id = ?", conflict.canonicalNodeId, input.projectId, input.treeId, conflict.logicalNodeId);
      }
      // Only derived identity is repaired. Original approved JSON and node
      // revision facts retain their exact bytes and original identifiers.
      for (const revision of this.database.all<{ id: string; document_json: string }>("SELECT id,document_json FROM task_tree_revisions WHERE tree_id = ?", input.treeId)) {
        const resolved = remapTaskTreeNodeIds(JSON.parse(revision.document_json) as TaskTreeDocument, ids);
        this.database.run("INSERT INTO task_tree_revision_identity_projections (revision_id,repair_id,document_json) VALUES (?,?,?)", revision.id, repairId, canonicalJson(resolved));
        for (const nr of this.database.all<{ id: string; node_id: string; body_json: string }>("SELECT id,node_id,body_json FROM task_node_revisions WHERE tree_revision_id = ?", revision.id)) {
          const body = JSON.parse(nr.body_json) as TaskNodeInput;
          const projected = remapTaskTreeNodeIds({ nodes: [body], relations: [], artifacts: [] }, ids).nodes[0]!;
          this.database.run("INSERT INTO task_node_revision_identity_projections (node_revision_id,repair_id,node_id,body_json) VALUES (?,?,?,?)", nr.id, repairId, ids.get(nr.node_id) ?? nr.node_id, canonicalJson(projected));
        }
        for (const conflict of preview.conflicts) {
          this.database.run("UPDATE task_relation_edges SET from_node_id = ? WHERE tree_revision_id = ? AND from_node_id = ?", conflict.canonicalNodeId, revision.id, conflict.logicalNodeId);
          this.database.run("UPDATE task_relation_edges SET to_node_id = ? WHERE tree_revision_id = ? AND to_node_id = ?", conflict.canonicalNodeId, revision.id, conflict.logicalNodeId);
        }
      }
      if (this.database.all("PRAGMA foreign_key_check").length) throw new HarnessError("storage_failure", "identity recovery would break foreign-key references");
      return { status: "applied" as const, repairId, treeRevisionId: input.expectedTreeRevisionId, reused: false };
    });
  }

  private requireTree(input: { projectId: string; treeId: string }): Tree {
    // A preview may inspect v25 through a hardware-read-only connection. It
    // must not migrate the real database merely to diagnose the collision.
    const revisions = this.database.get("SELECT name FROM sqlite_master WHERE type='view' AND name='runtime_task_tree_revisions'")
      ? "runtime_task_tree_revisions" : "task_tree_revisions";
    const tree = this.database.get<Tree>(`SELECT t.current_revision_id,t.status,r.document_json FROM task_trees t
      JOIN ${revisions} r ON r.id=t.current_revision_id WHERE t.id=? AND t.project_id=?`, input.treeId, input.projectId);
    if (!tree) throw new HarnessError("not_found", "Task Tree was not found in this project");
    return tree;
  }
}
