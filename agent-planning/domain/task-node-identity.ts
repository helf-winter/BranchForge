import type { TaskTreeDocument } from "./task-tree.js";

/** Remap node identity fields only; artifact IDs, evidence keys and prose are independent identities. */
export function remapTaskTreeNodeIds(document: TaskTreeDocument, ids: ReadonlyMap<string, string>): TaskTreeDocument {
  const remap = (id: string): string => ids.get(id) ?? id;
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  return {
    ...document,
    nodes: document.nodes.map((node) => ({
      ...node, id: remap(node.id), parentId: node.parentId === null ? null : remap(node.parentId),
      children: node.children.map(remap),
      ...(node.dependencies ? { dependencies: node.dependencies.map(remap) } : {}),
    })),
    relations: document.relations.map((relation) => ({
      ...relation, fromNodeId: remap(relation.fromNodeId), toNodeId: remap(relation.toNodeId),
    })),
    ...(document.artifactLinks ? { artifactLinks: document.artifactLinks.map((link) => ({ ...link, taskNodeId: remap(link.taskNodeId) })) } : {}),
    ...(document.artifactContracts ? { artifactContracts: document.artifactContracts.map((contract) => ({
      ...contract, providerNodeIds: contract.providerNodeIds.map(remap), consumerNodeIds: contract.consumerNodeIds.map(remap),
    })) } : {}),
    ...(document.skeletonCriteria ? { skeletonCriteria: document.skeletonCriteria.map((criterion) => ({ ...criterion, branchNodeId: remap(criterion.branchNodeId) })) } : {}),
    ...(document.planningContext ? { planningContext: {
      ...document.planningContext,
      plannedEffects: document.planningContext.plannedEffects.map((effect) => ({
        ...effect, targetRef: nodeIds.has(effect.targetRef) ? remap(effect.targetRef) : effect.targetRef,
      })),
    } } : {}),
  };
}
