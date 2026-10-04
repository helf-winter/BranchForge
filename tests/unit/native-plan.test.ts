import { describe, expect, it } from "vitest";
import {
  extractCanonicalTaskTreeBlock,
  hashNativePlanBlock,
  renderCanonicalTaskTreeBlock,
} from "../../src/domain/native-plan.js";
import type { TaskTreeRevisionView } from "../../src/application/task-tree-service.js";
import type { PlanReadinessView } from "../../src/application/task-tree-validation-service.js";

const tree: TaskTreeRevisionView = {
  treeId: "tree-1",
  revisionId: "revision-2",
  revision: 2,
  title: "Bead editor",
  status: "draft",
  document: {
    planningVersion: 1,
    planningContext: {
      goal: "Build the editor",
      scopeBoundaries: ["browser"],
      exclusions: ["server"],
      unresolvedQuestions: [],
      unresolvedDecisions: ["Choose export scale"],
      plannedEffects: [],
    },
    nodes: [
      { id: "root", parentId: null, title: "Editor", children: ["canvas"] },
      {
        id: "canvas", parentId: "root", title: "Canvas", children: [], objectives: ["Render beads"],
        expectedOutputs: ["canvas.ts"], acceptanceCriteria: ["renders 200x200"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "test", description: "Canvas test" }],
        executionPhase: "implementation", stopDecompositionReason: "One verifiable feature",
      },
    ],
    artifacts: [{ id: "canvas-file", kind: "file", locator: "src/canvas.ts", status: "draft" }],
    relations: [{
      fromNodeId: "root", toNodeId: "canvas", kind: "coordinates_with",
      coordinationKind: "schedule_only", description: "Root coordinates the branch",
    }],
    skeletonCriteria: [{
      id: "canvas-skeleton", branchNodeId: "canvas", expectedArtifacts: ["src/canvas.ts"],
      requiredContracts: ["canvas-api"], verificationCommands: ["npm test"],
      readinessConditions: ["module imports"],
    }],
  },
};

const readiness = {
  resultId: "ready-1", treeId: "tree-1", revisionId: "revision-2", ready: true,
  blockers: [], blockingIssues: [], warnings: [], recommendedNextIssue: null,
  scopeKind: "tree", scopeRootNodeId: null, coveredNodeIds: ["root", "canvas"],
} as PlanReadinessView;

describe("native Plan canonical Task Tree block", () => {
  it("renders byte-identically in document order without embedding a JSON manifest", () => {
    const first = renderCanonicalTaskTreeBlock({ approvalRef: "opaque-ref", tree, readiness });
    const second = renderCanonicalTaskTreeBlock({ approvalRef: "opaque-ref", tree, readiness });
    expect(second).toBe(first);
    expect(first.match(/agent-harness-task-tree:start/g)).toHaveLength(1);
    expect(first.match(/agent-harness-task-tree:end/g)).toHaveLength(1);
    expect(first).toContain('[implementation] canvas: Canvas');
    expect(first).toContain("canvas-file [file/draft]: src/canvas.ts");
    expect(first).toContain("root -coordinates_with-> canvas");
    expect(first).toContain("Acceptance: renders 200x200");
    expect(first).toContain("Unresolved decisions: Choose export scale");
    expect(first).toContain("Skeleton acceptance canvas-skeleton");
    expect(first).not.toMatch(/```json|"planningVersion"|"nodes"\s*:/);
    expect(first.indexOf("root: Editor")).toBeLessThan(first.indexOf("canvas: Canvas"));
  });

  it("extracts one exact block and rejects missing, duplicate, nested, or malformed markers", () => {
    const block = renderCanonicalTaskTreeBlock({ approvalRef: "opaque-ref", tree, readiness });
    expect(extractCanonicalTaskTreeBlock(`Before\n${block}\nAfter`)).toEqual({ approvalRef: "opaque-ref", block });
    for (const invalid of [
      "no canonical block",
      `${block}\n${block}`,
      block.replace("## Task Tree", `${block}\n## Task Tree`),
      block.replace('approval_ref="opaque-ref"', "approval_ref=opaque-ref"),
      block.replace("agent-harness-task-tree:end", "agent-harness-task-tree:finish"),
    ]) expect(() => extractCanonicalTaskTreeBlock(invalid)).toThrow();
  });

  it("normalizes line endings for hashing while preserving visible changes", () => {
    const block = renderCanonicalTaskTreeBlock({ approvalRef: "opaque-ref", tree, readiness });
    expect(hashNativePlanBlock(block.replaceAll("\n", "\r\n"))).toBe(hashNativePlanBlock(block));
    expect(hashNativePlanBlock(block.replace("Canvas", "Canvas renderer"))).not.toBe(hashNativePlanBlock(block));
  });
});
