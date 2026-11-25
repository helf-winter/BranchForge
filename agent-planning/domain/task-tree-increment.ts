import type { TaskTreeDocument } from "./task-tree.js";

export interface IncrementalStructureAnalysis {
  allowed: boolean;
  rootNodeId: string;
  addedNodeIds: string[];
  addedBranchIds: string[];
  blockers: Array<{ code: string; ref: string }>;
}

// Compare values, not object insertion order. Inputs have already been normalized.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function analyzeIncrementalStructure(base: TaskTreeDocument, proposed: TaskTreeDocument): IncrementalStructureAnalysis {
  const root = base.nodes.find(node => node.parentId === null);
  const blockers: IncrementalStructureAnalysis["blockers"] = [];
  const reject = (code: string, ref: string): void => { blockers.push({ code, ref }); };
  const oldIds = new Set(base.nodes.map(node => node.id));
  const next = new Map(proposed.nodes.map(node => [node.id, node]));
  const addedNodeIds = proposed.nodes.filter(node => !oldIds.has(node.id)).map(node => node.id);
  const addedBranchIds = root ? proposed.nodes.filter(node => !oldIds.has(node.id) && node.parentId === root.id).map(node => node.id) : [];
  if (!root || proposed.nodes.filter(node => node.parentId === null).length !== 1 || next.get(root.id)?.parentId !== null) reject("root_changed", root?.id ?? "nodes");
  if (!addedBranchIds.length) reject("no_added_branch", root?.id ?? "nodes");
  for (const node of base.nodes) {
    const after = next.get(node.id);
    if (!after) { reject("existing_node_removed", node.id); continue; }
    if (node !== root) {
      if (canonical(node) !== canonical(after)) reject("existing_node_changed", node.id);
      continue;
    }
    // Root identity/goal and execution purpose are stable; acceptance text may
    // expand coverage under a new native approval, but old proof keys remain.
    const { children: beforeChildren, requiredEvidence: beforeEvidence, acceptanceCriteria: beforeCriteria, ...beforeBody } = node;
    const { children: afterChildren, requiredEvidence: afterEvidence, acceptanceCriteria: afterCriteria, ...afterBody } = after;
    if (canonical(beforeBody) !== canonical(afterBody)) reject("root_changed", node.id);
    if (canonical(afterChildren.slice(0, beforeChildren.length)) !== canonical(beforeChildren)
      || afterChildren.slice(beforeChildren.length).some(id => !addedBranchIds.includes(id))) reject("root_children_changed", node.id);
    if ((beforeEvidence ?? []).some(item => !(afterEvidence ?? []).some(value => value.key === item.key))) reject("root_evidence_removed", node.id);
    if ((beforeCriteria ?? []).some(item => !(afterCriteria ?? []).includes(item))) reject("root_criteria_removed", node.id);
  }
  // Every added node belongs to an appended branch, never an existing leaf.
  for (const id of addedNodeIds) {
    let cursor = next.get(id); const seen = new Set<string>();
    while (cursor && !addedBranchIds.includes(cursor.id) && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = cursor.parentId && !oldIds.has(cursor.parentId) ? next.get(cursor.parentId) : undefined;
    }
    if (!cursor || !addedBranchIds.includes(cursor.id)) reject("addition_outside_new_branch", id);
  }
  if (base.planningVersion !== proposed.planningVersion || base.planningContext?.goal !== proposed.planningContext?.goal) reject("goal_changed", "planningContext.goal");
  const preserve = (before: readonly unknown[], after: readonly unknown[], ref: string, code = "constraint_removed"): void => {
    for (const item of before) if (!after.some(value => canonical(item) === canonical(value))) reject(code, ref);
  };
  for (const key of ["scopeBoundaries", "exclusions", "plannedEffects", "unresolvedQuestions", "unresolvedDecisions"] as const) {
    preserve(base.planningContext?.[key] ?? [], proposed.planningContext?.[key] ?? [], `planningContext.${key}`);
  }
  for (const key of ["relations", "artifacts", "artifactLinks", "artifactRelations", "skeletonCriteria"] as const) {
    preserve(base[key] ?? [], proposed[key] ?? [], key, "existing_definition_changed");
  }
  for (const contract of base.artifactContracts ?? []) {
    const after = proposed.artifactContracts?.find(value => value.id === contract.id);
    const { consumerNodeIds, ...definition } = contract;
    if (!after) { reject("contract_changed", contract.id); continue; }
    const { consumerNodeIds: consumers, ...newDefinition } = after;
    if (canonical(definition) !== canonical(newDefinition)
      || consumerNodeIds.some(id => !consumers.includes(id))
      || consumers.some(id => !consumerNodeIds.includes(id) && !addedNodeIds.includes(id))) reject("contract_changed", contract.id);
  }
  return { allowed: blockers.length === 0, rootNodeId: root?.id ?? "", addedNodeIds, addedBranchIds, blockers };
}
