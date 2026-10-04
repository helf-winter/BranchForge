import { createHash } from "node:crypto";
import type { RefinementDecisionInput } from "../application/task-tree-service.js";
import { HarnessError } from "./errors.js";
import type { TaskTreeDocument } from "./task-tree.js";
import { canonicalJson } from "./trace.js";

export type TaskTreePatchOperation = {
  op: "replace_document";
  document: TaskTreeDocument;
  sourceUserMessageTraceEventId: string;
  decision: RefinementDecisionInput;
  previewId?: string;
};

export function hashTaskTreeAuthoringPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function completeDecision(decision: RefinementDecisionInput): boolean {
  return Boolean(
    decision.discussionTopic.trim()
    && decision.currentUnderstanding.trim()
    && decision.consideredOptions.length
    && decision.consideredOptions.every((option) => option.trim())
    && decision.agentRecommendation.trim()
    && decision.userDecision.trim(),
  );
}

export function requireSingleTaskTreePatchOperation(
  operations: TaskTreePatchOperation[],
): TaskTreePatchOperation {
  const operation = operations[0];
  if (operations.length !== 1 || !operation || operation.op !== "replace_document") {
    throw new HarnessError("invalid_input", "exactly one replace_document operation is required");
  }
  if (!operation.sourceUserMessageTraceEventId.trim() || !completeDecision(operation.decision)) {
    throw new HarnessError(
      "invalid_input",
      "Task Tree patches require a user-visible source Trace and complete Decision Record",
    );
  }
  return operation;
}
