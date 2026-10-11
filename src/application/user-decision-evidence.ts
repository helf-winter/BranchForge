import type { RuntimeDatabase } from "../storage/database.js";

export interface UserDecisionEvidence {
  id: string;
  session_id: string;
  tree_id: string | null;
  occurred_at: string;
  event_name: string;
  payload_json: string;
}

// Native question answers are human input too. A question being asked, a failed
// tool call, or an arbitrary tool result is not evidence of a human decision.
export function hasNativeQuestionAnswer(payload: Record<string, unknown>): boolean {
  if (payload.toolName !== "AskUserQuestion") return false;
  const response = payload.toolResponse;
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const answers = (response as Record<string, unknown>).answers;
  return Boolean(answers && typeof answers === "object" && !Array.isArray(answers)
    && Object.values(answers).some((answer) => typeof answer === "string" && answer.trim().length > 0));
}

export function findUserDecisionEvidence(database: RuntimeDatabase, projectId: string, traceId: string): UserDecisionEvidence | undefined {
  const trace = database.get<UserDecisionEvidence>(`
    SELECT id, session_id, tree_id, occurred_at, event_name, payload_json
    FROM trace_events WHERE id = ? AND project_id = ?
  `, traceId, projectId);
  if (!trace) return undefined;
  if (trace.event_name === "UserPromptSubmit") return trace;
  if (trace.event_name !== "PostToolUse") return undefined;
  return hasNativeQuestionAnswer(JSON.parse(trace.payload_json) as Record<string, unknown>) ? trace : undefined;
}
