import { describe, expect, it } from "vitest";
import {
  analyzeDraftImpact,
  analyzePlanReadiness,
  validateDraftStructure,
} from "../../src/domain/task-refinement.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const leaf = (id: string, parentId: string, title = id, executionPhase: "skeleton" | "implementation" | "verification" = "implementation") => ({
  id, parentId, title, children: [], objectives: [`Implement ${title}`], expectedOutputs: [`src/${id}.ts`],
  acceptanceCriteria: [`${title} passes`], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
  requiredEvidence: [{ key: `${id}-test`, description: `${title} test` }], executionPhase,
  stopDecompositionReason: "one independently testable output",
});

function document(): TaskTreeDocument {
  return {
    planningVersion: 1,
    planningContext: {
      goal: "Build feature", scopeBoundaries: ["runtime only"], exclusions: ["no UI"],
      unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
    },
    nodes: [
      { id: "root", parentId: null, title: "Build feature", children: ["branch-a", "branch-b"], executionPhase: "verification", requiredEvidence: [{ key: "root-test", description: "full test" }] },
      { id: "branch-a", parentId: "root", title: "Branch A", children: ["a-skeleton", "a-impl"], executionPhase: "verification", requiredEvidence: [{ key: "a-verify", description: "A integration" }] },
      leaf("a-skeleton", "branch-a", "A Skeleton", "skeleton"), leaf("a-impl", "branch-a", "A Implementation"),
      { id: "branch-b", parentId: "root", title: "Branch B", children: ["b-skeleton", "b-impl"], executionPhase: "verification", requiredEvidence: [{ key: "b-verify", description: "B integration" }] },
      leaf("b-skeleton", "branch-b", "B Skeleton", "skeleton"), leaf("b-impl", "branch-b", "B Implementation"),
    ],
    relations: [], artifacts: [],
    skeletonCriteria: [
      { id: "s-a", branchNodeId: "branch-a", expectedArtifacts: ["src/branch-a.ts"], requiredContracts: ["a-contract"], verificationCommands: ["npm test -- a"], readinessConditions: ["A wired"] },
      { id: "s-b", branchNodeId: "branch-b", expectedArtifacts: ["src/branch-b.ts"], requiredContracts: ["b-contract"], verificationCommands: ["npm test -- b"], readinessConditions: ["B wired"] },
    ],
  };
}

describe("Task refinement domain", () => {
  it("accepts incomplete drafts structurally but rejects broken topology", () => {
    const incomplete = document();
    incomplete.nodes[3] = { ...incomplete.nodes[3]!, acceptanceCriteria: [], unresolvedQuestions: ["Which API?"] };
    expect(validateDraftStructure(incomplete)).toEqual([]);
    expect(validateDraftStructure({
      ...incomplete, nodes: incomplete.nodes.map((node) => node.id === "branch-a" ? { ...node, parentId: "missing" } : node),
    })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid_tree_structure" })]));
    expect(validateDraftStructure({
      ...incomplete,
      relations: [{ fromNodeId: "branch-a", toNodeId: "branch-b", kind: "calls", artifactId: "unknown-contract" }],
    })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "artifact_reference_invalid", path: "relations[0].artifactId" })]));
  });

  it("ranks deterministic scoped blockers and does not let a sibling-only issue block a ready branch", () => {
    const draft = document();
    draft.nodes[6] = { ...draft.nodes[6]!, acceptanceCriteria: [], unresolvedQuestions: ["Choose B storage"] };
    draft.skeletonCriteria![1] = { ...draft.skeletonCriteria![1]!, verificationCommands: [] };
    const whole = analyzePlanReadiness(draft);
    expect(whole.ready).toBe(false);
    expect(whole.recommendedNextIssue).toMatchObject({ affectedRefs: expect.arrayContaining(["branch-b"]) });
    expect(whole.blockingIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "leaf_contract_incomplete", "skeleton_criteria_incomplete",
    ]));

    const branchA = analyzePlanReadiness(draft, "branch-a");
    expect(branchA).toMatchObject({ ready: true, blockingIssues: [], recommendedNextIssue: null });
  });

  it("keeps semantic conjunction detection as a warning rather than a blocker", () => {
    const draft = document();
    draft.nodes[3] = { ...draft.nodes[3]!, objectives: ["Implement A and update unrelated B"] };
    const result = analyzePlanReadiness(draft, "branch-a");
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([expect.objectContaining({ code: "semantic_cohesion_warning", severity: "warning" })]);
  });

  it("rejects a ready-looking tree whose lifecycle topology cannot be scheduled", () => {
    const draft = document();
    draft.nodes = draft.nodes
      .filter((node) => node.id !== "a-skeleton")
      .map((node) => node.id === "branch-a" ? { ...node, children: ["a-impl"] } : node);
    const implementationIndex = draft.nodes.findIndex((node) => node.id === "a-impl");
    draft.nodes[implementationIndex] = { ...draft.nodes[implementationIndex]!, executionPhase: "implementation", children: ["nested"] };
    draft.nodes.push(leaf("nested", "a-impl"));
    const result = analyzePlanReadiness(draft);
    expect(result.ready).toBe(false);
    expect(result.blockingIssues.map((item) => item.code)).toEqual(expect.arrayContaining([
      "skeleton_task_missing", "implementation_container_not_executable",
    ]));
  });

  it("classifies one-branch changes as direct and multi-branch/root changes as preview-required", () => {
    const base = document();
    const local = document();
    local.nodes[1] = { ...local.nodes[1]!, title: "Branch A refined" };
    expect(analyzeDraftImpact(base, local)).toMatchObject({
      impactLevel: "local", applyMode: "direct_draft_apply", affectedBranchIds: ["branch-a"], affectedNodeIds: ["branch-a"],
    });

    const broad = document();
    broad.nodes[1] = { ...broad.nodes[1]!, title: "A2" };
    broad.nodes[4] = { ...broad.nodes[4]!, title: "B2" };
    expect(analyzeDraftImpact(base, broad)).toMatchObject({
      impactLevel: "cross_branch", applyMode: "preview_required", affectedBranchIds: ["branch-a", "branch-b"],
    });
    const planning = document();
    planning.planningContext = { ...planning.planningContext!, goal: "Build and publish feature" };
    expect(analyzeDraftImpact(base, planning)).toMatchObject({
      impactLevel: "cross_branch", applyMode: "preview_required", affectedBranchIds: ["branch-a", "branch-b"],
    });
    expect(analyzeDraftImpact(base, document()).hasStructuralChange).toBe(false);
  });
});
