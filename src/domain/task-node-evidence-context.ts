import type { TaskTreeDocument } from "./task-tree.js";
import { canonicalJson } from "./trace.js";

/** Planned evidence is reusable only while the node's verification context is unchanged. */
export function taskNodeEvidenceContext(document: TaskTreeDocument, nodeId: string): string {
  const nodes = document.nodes ?? [];
  const node = nodes.find((value) => value.id === nodeId);
  if (!node) return canonicalJson({ missingNode: nodeId });
  const byId = new Map(nodes.map((value) => [value.id, value]));
  let branch = node;
  while (branch.parentId && byId.get(branch.parentId)?.parentId) branch = byId.get(branch.parentId)!;
  const criterion = node.executionPhase === "skeleton"
    ? document.skeletonCriteria?.find((value) => value.branchNodeId === branch.id) ?? null : null;
  const links = (document.artifactLinks ?? []).filter((value) => value.taskNodeId === nodeId);
  const relations = (document.relations ?? []).filter((value) => value.fromNodeId === nodeId || value.toNodeId === nodeId);
  const dependencies = new Set(node.dependencies ?? []);
  for (const relation of relations) if (relation.kind === "depends_on" && relation.fromNodeId === nodeId) dependencies.add(relation.toNodeId);
  const artifactRefs = new Set([...links.map((value) => value.artifactId), ...(criterion?.expectedArtifacts ?? []),
    ...relations.flatMap((value) => value.artifactId ? [value.artifactId] : [])]);
  const contracts = (document.artifactContracts ?? []).filter((value) => artifactRefs.has(value.artifactId)
    || value.providerNodeIds.includes(nodeId) || value.consumerNodeIds.includes(nodeId)
    || (criterion?.requiredContracts ?? []).includes(value.id));
  for (const contract of contracts) artifactRefs.add(contract.artifactId);
  const sorted = <T>(values: T[]) => values.map((value) => canonicalJson(value)).sort();
  return canonicalJson({ node, criterion, links: sorted(links), relations: sorted(relations), contracts: sorted(contracts),
    dependencyNodes: sorted([...dependencies].map((id) => byId.get(id) ?? { missingNode: id })),
    artifacts: sorted((document.artifacts ?? []).filter((value) => artifactRefs.has(value.id) || artifactRefs.has(value.locator))),
    artifactRelations: sorted((document.artifactRelations ?? []).filter((value) => artifactRefs.has(value.fromArtifactId) || artifactRefs.has(value.toArtifactId))),
  });
}
