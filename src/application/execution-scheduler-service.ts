import type { RequiredEvidence, TaskNodeInput, TaskTreeDocument } from "../domain/task-tree.js";
import type { WorkflowStage } from "../domain/workflow.js";
import type { RuntimeDatabase } from "../storage/database.js";

interface WorkflowRow {
  stage: WorkflowStage;
  active_branch_node_id: string | null;
  current_revision_id: string;
  document_json: string;
}

interface NodeFactRow {
  id: string;
  status: string;
  node_revision_id: string;
  confirmation_state: string;
}

export interface ScheduledTaskNodeView {
  projectId: string;
  treeId: string;
  treeRevisionId: string;
  nodeId: string;
  nodeRevisionId: string;
  title: string;
  phase: "skeleton" | "implementation" | "verification";
  stage: WorkflowStage;
  activeBranchNodeId: string | null;
  depth: number;
  documentOrder: number;
  dependencies: string[];
  requiredEvidence: RequiredEvidence[];
}

const executableStatuses = new Set(["ready", "failed", "needs_revalidation"]);

export class ExecutionSchedulerService {
  constructor(private readonly database: RuntimeDatabase) {}

  next(input: { projectId: string; treeId: string }): ScheduledTaskNodeView | null {
    const workflow = this.database.get<WorkflowRow>(`
      SELECT w.stage, w.active_branch_node_id, t.current_revision_id, r.document_json
      FROM workflow_states w
      JOIN task_trees t ON t.id = w.tree_id AND t.project_id = w.project_id
      JOIN task_tree_revisions r ON r.id = t.current_revision_id
      WHERE w.project_id = ? AND w.tree_id = ? AND w.active = 1
    `, input.projectId, input.treeId);
    if (!workflow || !["skeleton_pass", "branch_implementation", "branch_verification", "root_verification"].includes(workflow.stage)) {
      return null;
    }
    if (this.database.get(`
      SELECT id FROM execution_attempts
      WHERE project_id = ? AND tree_id = ? AND status IN ('running', 'verifying') LIMIT 1
    `, input.projectId, input.treeId)) return null;
    if (this.database.get(`
      SELECT id FROM plan_drift_records
      WHERE project_id = ? AND tree_id = ? AND severity = 'blocking'
        AND resolution_status = 'pending_user_confirmation' LIMIT 1
    `, input.projectId, input.treeId)) return null;

    const document = JSON.parse(workflow.document_json) as TaskTreeDocument;
    const facts = new Map(this.database.all<NodeFactRow>(`
      SELECT n.id, n.status, nr.id AS node_revision_id, cs.state AS confirmation_state
      FROM task_nodes n
      JOIN task_node_revisions nr ON nr.node_id = n.id AND nr.tree_revision_id = ?
      JOIN task_node_confirmation_states cs ON cs.task_node_id = n.id AND cs.tree_revision_id = ?
      WHERE n.tree_id = ?
    `, workflow.current_revision_id, workflow.current_revision_id, input.treeId).map((row) => [row.id, row]));
    const byId = new Map(document.nodes.map((node) => [node.id, node]));
    const order = new Map(document.nodes.map((node, index) => [node.id, index]));
    const depth = new Map<string, number>();
    const calculateDepth = (node: TaskNodeInput): number => {
      const known = depth.get(node.id);
      if (known !== undefined) return known;
      const value = node.parentId ? calculateDepth(byId.get(node.parentId)!) + 1 : 0;
      depth.set(node.id, value);
      return value;
    };
    document.nodes.forEach(calculateDepth);
    const descendants = (rootId: string): Set<string> => {
      const result = new Set<string>();
      const visit = (id: string) => {
        result.add(id);
        for (const child of byId.get(id)?.children ?? []) visit(child);
      };
      visit(rootId);
      return result;
    };
    const eligible = (node: TaskNodeInput) => {
      const fact = facts.get(node.id);
      if (!fact || !executableStatuses.has(fact.status) || fact.confirmation_state !== "confirmed") return false;
      if ((node.dependencies ?? []).some((dependency) => facts.get(dependency)?.status !== "succeeded")) return false;
      if (node.executionPhase === "verification"
        && node.children.some((child) => facts.get(child)?.status !== "succeeded")) return false;
      return true;
    };

    let candidates: TaskNodeInput[] = [];
    if (workflow.stage === "skeleton_pass") {
      candidates = document.nodes.filter((node) => node.executionPhase === "skeleton" && eligible(node))
        .sort((left, right) => depth.get(left.id)! - depth.get(right.id)! || order.get(left.id)! - order.get(right.id)!);
    } else if (workflow.stage === "root_verification") {
      const root = document.nodes.find((node) => node.parentId === null);
      if (root && root.executionPhase === "verification"
        && root.children.every((child) => facts.get(child)?.status === "succeeded") && eligible(root)) candidates = [root];
    } else {
      const branchId = workflow.active_branch_node_id;
      if (!branchId) return null;
      const branch = this.database.get<{ status: string }>(`
        SELECT status FROM workflow_branch_states
        WHERE project_id = ? AND tree_id = ? AND tree_revision_id = ? AND branch_node_id = ?
      `, input.projectId, input.treeId, workflow.current_revision_id, branchId);
      const requiredBranchStatus = workflow.stage === "branch_implementation" ? "active" : "implemented";
      if (!branch || branch.status !== requiredBranchStatus) return null;
      const scope = descendants(branchId);
      const phase = workflow.stage === "branch_implementation" ? "implementation" : "verification";
      candidates = document.nodes.filter((node) => scope.has(node.id) && node.executionPhase === phase
        && (phase !== "implementation" || node.children.length === 0) && eligible(node))
        .sort((left, right) => depth.get(right.id)! - depth.get(left.id)! || order.get(left.id)! - order.get(right.id)!);
    }
    const node = candidates[0];
    if (!node) return null;
    const fact = facts.get(node.id)!;
    return {
      projectId: input.projectId,
      treeId: input.treeId,
      treeRevisionId: workflow.current_revision_id,
      nodeId: node.id,
      nodeRevisionId: fact.node_revision_id,
      title: node.title,
      phase: node.executionPhase as ScheduledTaskNodeView["phase"],
      stage: workflow.stage,
      activeBranchNodeId: workflow.active_branch_node_id,
      depth: depth.get(node.id)!,
      documentOrder: order.get(node.id)!,
      dependencies: node.dependencies ?? [],
      requiredEvidence: node.requiredEvidence ?? [],
    };
  }
}
