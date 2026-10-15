import { describe, expect, it } from "vitest";
import { analyzeIncrementalStructure } from "../../src/domain/task-tree-increment.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

function base(): TaskTreeDocument {
  return {
    planningVersion: 1,
    planningContext: { goal: "Counter", scopeBoundaries: ["browser"], exclusions: ["cloud"], unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [] },
    nodes: [
      { id: "root", parentId: null, title: "Counter", children: ["base"], executionPhase: "verification", requiredEvidence: [{ key: "root-acceptance", description: "Verify one branch" }] },
      { id: "base", parentId: "root", title: "Counter", children: [], objectives: ["Count"], expectedOutputs: ["counter.js"], acceptanceCriteria: ["Count test"], dependencies: [], unresolvedQuestions: [], unresolvedDecisions: [], executionPhase: "implementation", requiredEvidence: [{ key: "count", description: "Count test" }], stopDecompositionReason: "One counter" },
    ],
    relations: [], artifacts: [{ id: "api", kind: "contract", locator: "counter-api" }],
    artifactContracts: [{ id: "api-v1", artifactId: "api", name: "Counter", version: "1", compatibilityPolicy: "exact", schemaOrSignature: "count():number", providerNodeIds: ["base"], consumerNodeIds: [], validationRefs: ["count"] }],
  };
}
function proposed(): TaskTreeDocument {
  const doc = base();
  doc.nodes[0]!.children.push("snapshots");
  doc.nodes[0]!.requiredEvidence![0]!.description = "Verify both branches";
  doc.nodes.push({ ...doc.nodes[1]!, id: "snapshots", title: "Snapshots", objectives: ["Save snapshots"], expectedOutputs: ["snapshots.js"], dependencies: ["base"] });
  return doc;
}

describe("additive completed-tree planning", () => {
  it("keeps old nodes and evidence keys while expanding root coverage", () => {
    const before = base(); const json = JSON.stringify(before);
    expect(analyzeIncrementalStructure(before, proposed())).toEqual({ allowed: true, rootNodeId: "root", addedNodeIds: ["snapshots"], addedBranchIds: ["snapshots"], blockers: [] });
    expect(JSON.stringify(before)).toBe(json);
  });
  it("permits a new contract consumer without rewriting the provider", () => {
    const next = proposed(); next.artifactContracts![0]!.consumerNodeIds.push("snapshots");
    expect(analyzeIncrementalStructure(base(), next).allowed).toBe(true);
  });
  it.each([
    ["old acceptance", (doc: TaskTreeDocument) => { doc.nodes[1]!.acceptanceCriteria = ["No test"]; }, "existing_node_changed"],
    ["root proof key", (doc: TaskTreeDocument) => { doc.nodes[0]!.requiredEvidence = []; }, "root_evidence_removed"],
    ["goal", (doc: TaskTreeDocument) => { doc.planningContext!.goal = "Unrelated app"; }, "goal_changed"],
    ["exclusion", (doc: TaskTreeDocument) => { doc.planningContext!.exclusions = []; }, "constraint_removed"],
    ["contract signature", (doc: TaskTreeDocument) => { doc.artifactContracts![0]!.schemaOrSignature = "reset():void"; }, "contract_changed"],
    ["contract provider", (doc: TaskTreeDocument) => { doc.artifactContracts![0]!.providerNodeIds = ["snapshots"]; }, "contract_changed"],
    ["old node", (doc: TaskTreeDocument) => { doc.nodes = doc.nodes.filter(n => n.id !== "base"); doc.nodes[0]!.children = ["snapshots"]; }, "existing_node_removed"],
  ] as const)("rejects a change to %s", (_, change, code) => {
    const next = proposed(); change(next);
    const result = analyzeIncrementalStructure(base(), next);
    expect(result.allowed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
  it("rejects an empty iteration", () => {
    expect(analyzeIncrementalStructure(base(), base())).toMatchObject({ allowed: false, blockers: [{ code: "no_added_branch", ref: "root" }] });
  });
  it("rejects additions that replace an old leaf rather than append root branches", () => {
    const next = proposed(); next.nodes[0]!.children = ["base"]; next.nodes[1]!.children = ["snapshots"]; next.nodes[2]!.parentId = "base";
    expect(analyzeIncrementalStructure(base(), next).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "no_added_branch" })]));
  });
});
