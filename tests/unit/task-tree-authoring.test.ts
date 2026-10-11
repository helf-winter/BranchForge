import { describe, expect, it } from "vitest";
import {
  hashTaskTreeAuthoringPayload,
  requireSingleTaskTreePatchOperation,
  type TaskTreePatchOperation,
} from "../../src/domain/task-tree-authoring.js";

const document = {
  planningVersion: 1 as const,
  nodes: [{ id: "root", parentId: null, title: "Root", children: [] }],
  relations: [],
  artifacts: [],
};

const decision = {
  discussionTopic: "Scope",
  currentUnderstanding: "One page",
  consideredOptions: ["React", "Vue"],
  agentRecommendation: "React",
  userDecision: "Use React",
};

function operation(overrides: Partial<TaskTreePatchOperation> = {}): TaskTreePatchOperation {
  return {
    op: "replace_document",
    document,
    sourceUserMessageTraceEventId: "trace-1",
    decision,
    ...overrides,
  };
}

describe("Task Tree authoring", () => {
  it("hashes canonical payloads independently of object key order", () => {
    expect(hashTaskTreeAuthoringPayload({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(hashTaskTreeAuthoringPayload({ a: { x: 1, y: 2 }, b: 2 }));
    expect(hashTaskTreeAuthoringPayload({ value: 1 })).not.toBe(hashTaskTreeAuthoringPayload({ value: 2 }));
  });

  it("requires exactly one replace_document operation", () => {
    expect(() => requireSingleTaskTreePatchOperation([])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => requireSingleTaskTreePatchOperation([operation(), operation()]))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("requires a user-visible source Trace and complete Decision Record", () => {
    expect(() => requireSingleTaskTreePatchOperation([operation({ sourceUserMessageTraceEventId: "" })]))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(() => requireSingleTaskTreePatchOperation([operation({
      decision: { ...decision, userDecision: "" },
    })])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(requireSingleTaskTreePatchOperation([operation()])).toEqual(operation());
  });
});
