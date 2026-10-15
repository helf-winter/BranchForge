import { HarnessError } from "../domain/errors.js";
import { remapTaskTreeNodeIds } from "../domain/task-node-identity.js";
import { normalizeTaskTreeDocument, type TaskTreeDocument } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";

export function normalizeDocumentNodeIdentity(database: RuntimeDatabase, input: { projectId: string; treeId: string; document: TaskTreeDocument }): TaskTreeDocument {
  if (!database.get("SELECT id FROM task_trees WHERE id = ? AND project_id = ?", input.treeId, input.projectId)) throw new HarnessError("not_found", "Task Tree was not found in this Project");
  const ids = new Map<string, string>();
  for (const node of input.document.nodes) {
    const owner = database.get<{ tree_id: string }>("SELECT tree_id FROM task_nodes WHERE id = ?", node.id);
    if (owner?.tree_id === input.treeId) continue;
    const canonicalId = `node:${input.treeId}:${node.id}`;
    const canonicalOwner = database.get<{ tree_id: string }>("SELECT tree_id FROM task_nodes WHERE id = ?", canonicalId);
    if (owner || canonicalOwner?.tree_id === input.treeId) {
      if (canonicalOwner && canonicalOwner.tree_id !== input.treeId) throw new HarnessError("storage_failure", "canonical Task Tree node ID belongs to another tree", { nodeId: canonicalId, treeId: input.treeId });
      ids.set(node.id, canonicalId);
    }
  }
  const normalized = normalizeTaskTreeDocument(remapTaskTreeNodeIds(input.document, ids));
  if (new Set(normalized.nodes.map(node => node.id)).size !== normalized.nodes.length) throw new HarnessError("invalid_tree_structure", "Task Tree logical aliases resolve to duplicate node IDs");
  return normalized;
}
