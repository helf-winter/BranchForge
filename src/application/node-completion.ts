import type { TaskNodeInput } from "../domain/task-tree.js";
import type { RuntimeDatabase } from "../storage/database.js";

/** Containers aggregate current descendant facts; they never need a fabricated Attempt. */
export function loadNodeCompletion(database: RuntimeDatabase, treeId: string): (nodeId: string) => boolean {
  const rows = database.all<{ id: string; status: string; body_json: string }>(`
    SELECT n.id, n.status, nr.body_json FROM task_nodes n
    JOIN task_trees t ON t.id = n.tree_id
    JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = t.current_revision_id
    WHERE n.tree_id = ?
  `, treeId);
  const nodes = new Map(rows.map((row) => [row.id, { ...row, body: JSON.parse(row.body_json) as TaskNodeInput }]));
  const branches = new Map(database.all<{ branch_node_id: string; status: string }>(`
    SELECT b.branch_node_id, b.status FROM workflow_branch_states b
    JOIN task_trees t ON t.current_revision_id = b.tree_revision_id WHERE b.tree_id = ?
  `, treeId).map((row) => [row.branch_node_id, row.status]));
  const visiting = new Set<string>();
  const complete = (id: string): boolean => {
    const node = nodes.get(id);
    if (!node || visiting.has(id)) return false;
    const children = node.body.children ?? [];
    if ((node.body.executionPhase || !children.length) && node.status !== "succeeded") return false;
    if (["failed", "blocked", "cancelled", "needs_revalidation", "pending_user_confirmation"].includes(node.status)) return false;
    if (!node.body.executionPhase && branches.has(id) && branches.get(id) !== "verified") return false;
    visiting.add(id);
    const result = children.every(complete);
    visiting.delete(id);
    return result;
  };
  return complete;
}
