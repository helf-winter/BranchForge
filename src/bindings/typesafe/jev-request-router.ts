import { HarnessError, type HarnessErrorCode } from "../../domain/errors.js";
import type {
  JevRequestRoutingConfiguration,
  RequestRouteClassification,
  TaskTreeRelationSuggestion,
} from "../../domain/request-routing.js";
import { redactSecrets } from "../../domain/trace.js";

export interface RequestRouteSnapshot {
  prompt: string;
  hasActiveTree: boolean;
  activeTreeTitle: string | null;
  currentNodeTitle: string | null;
  hasActiveWorkflow: boolean;
}

export interface JevRequestRouteResponse {
  classification: RequestRouteClassification;
  treeRelation: TaskTreeRelationSuggestion;
  confidence: number;
  probabilities: Partial<Record<RequestRouteClassification, number>>;
  reasonCodes: string[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

const classifications: RequestRouteClassification[] = [
  "direct_response",
  "direct_execution",
  "task_tree_workflow",
];

const treeRelations: TaskTreeRelationSuggestion[] = [
  "continue_existing_tree",
  "change_existing_tree",
  "create_new_tree",
  "unclear",
];

function providerErrorCode(status: number): HarnessErrorCode {
  if (status === 401) return "provider_authentication_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 529) return "provider_overloaded";
  if (status === 422) return "provider_request_invalid";
  return "provider_http_error";
}

function parseChoice(
  value: unknown,
  allowedChoices: readonly string[],
  answerName: string,
): ChoiceAnswer {
  if (!value || typeof value !== "object") {
    throw new HarnessError("provider_response_invalid", `Jev response is missing ${answerName}`);
  }
  const answer = value as Record<string, unknown>;
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !allowedChoices.includes(answer.choice)) {
    throw new HarnessError("provider_response_invalid", `Jev response contains an invalid ${answerName} choice`);
  }
  if (!answer.probabilities || typeof answer.probabilities !== "object") {
    throw new HarnessError("provider_response_invalid", `Jev response is missing ${answerName} probabilities`);
  }
  const probabilities = answer.probabilities as Record<string, unknown>;
  for (const [choice, probability] of Object.entries(probabilities)) {
    if (!allowedChoices.includes(choice) || typeof probability !== "number"
      || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new HarnessError("provider_response_invalid", `Jev response contains an invalid ${answerName} probability`);
    }
  }
  if (!Object.hasOwn(probabilities, answer.choice)) {
    throw new HarnessError("provider_response_invalid", `Jev response omits the selected ${answerName} probability`);
  }
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1) {
    throw new HarnessError("provider_response_invalid", `Jev response contains an invalid ${answerName} confidence`);
  }
  return {
    type: "choice",
    choice: answer.choice,
    probabilities: probabilities as Record<string, number>,
    confidence: answer.confidence,
  };
}

function questions(hasActiveTree: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    request_kind: {
      type: "choice",
      instructions: {
        question: "Which bounded runtime profile best fits this single user request?",
      },
      criteria: {
        direct_response: "Answer or discuss without changing project assets.",
        direct_execution: "Make a small, bounded project change without a structured Task Tree workflow.",
        task_tree_workflow: "Use collaborative planning and a confirmed Task Tree before implementation.",
      },
    },
  };
  if (hasActiveTree) {
    result.tree_relation = {
      type: "choice",
      instructions: {
        question: "How does this request relate to the active Task Tree?",
      },
      criteria: {
        continue_existing_tree: "Continue the active tree without changing its planned structure.",
        change_existing_tree: "Revise or extend the active tree before continuing.",
        create_new_tree: "The request is a separate goal and needs a new tree.",
        unclear: "The bounded request does not establish a safe relation.",
      },
    };
  }
  return result;
}

function sanitizeRoutingText(value: string, limit: number, omitSource: boolean): string {
  let result = String(redactSecrets(value));
  if (omitSource) {
    result = result.replace(/```[\s\S]*?```/g, "[CODE OMITTED]");
    result = result.split(/\r?\n/).map((line) => (
      /^\s*(?:import|export|const|let|var|function|class|interface|type|def|public|private|#include|package|using)\b/.test(line)
        ? "[CODE OMITTED]"
        : line
    )).filter((line, index, lines) => line !== "[CODE OMITTED]" || lines[index - 1] !== line).join("\n");
  }
  return result.slice(0, limit);
}

export function sanitizeRequestRouteSnapshot(snapshot: RequestRouteSnapshot): RequestRouteSnapshot {
  return {
    prompt: sanitizeRoutingText(snapshot.prompt, 2_000, true),
    hasActiveTree: snapshot.hasActiveTree,
    activeTreeTitle: snapshot.activeTreeTitle === null ? null : sanitizeRoutingText(snapshot.activeTreeTitle, 160, false),
    currentNodeTitle: snapshot.currentNodeTitle === null ? null : sanitizeRoutingText(snapshot.currentNodeTitle, 160, false),
    hasActiveWorkflow: snapshot.hasActiveWorkflow,
  };
}

export class JevRequestRouter {
  constructor(
    private readonly config: JevRequestRoutingConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async route(snapshot: RequestRouteSnapshot): Promise<JevRequestRouteResponse> {
    if (!this.config.enabled) {
      throw new HarnessError("provider_disabled", "Jev request routing is disabled");
    }
    if (!this.config.apiKey) {
      throw new HarnessError("provider_misconfigured", "TYPESAFE_API_KEY is not configured");
    }

    const outboundSnapshot = sanitizeRequestRouteSnapshot(snapshot);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: outboundSnapshot,
          model: this.config.model,
          questions: questions(outboundSnapshot.hasActiveTree),
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof Error && error.name === "TimeoutError"
        ? "provider_timeout"
        : "provider_connection_failed";
      throw new HarnessError(code, "Jev request routing did not complete");
    }

    if (!response.ok) {
      throw new HarnessError(providerErrorCode(response.status), "Jev request routing was rejected", {
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HarnessError("provider_response_invalid", "Jev request routing returned invalid JSON");
    }
    if (!body || typeof body !== "object") {
      throw new HarnessError("provider_response_invalid", "Jev request routing returned an invalid response");
    }

    const value = body as Record<string, unknown>;
    const answers = value.answers as Record<string, unknown> | undefined;
    const usage = value.usage as Record<string, unknown> | undefined;
    if (typeof value.model !== "string" || !answers || !usage
      || !Number.isInteger(usage.input_tokens) || (usage.input_tokens as number) < 0
      || !Number.isInteger(usage.output_tokens) || (usage.output_tokens as number) < 0) {
      throw new HarnessError("provider_response_invalid", "Jev request routing response does not match the required schema");
    }

    const requestKind = parseChoice(answers.request_kind, classifications, "request_kind");
    const treeRelation = outboundSnapshot.hasActiveTree
      ? parseChoice(answers.tree_relation, treeRelations, "tree_relation").choice as TaskTreeRelationSuggestion
      : "create_new_tree";
    const classification = requestKind.choice as RequestRouteClassification;
    return {
      classification,
      treeRelation,
      confidence: requestKind.confidence,
      probabilities: requestKind.probabilities as Partial<Record<RequestRouteClassification, number>>,
      reasonCodes: [`route:${classification}`, `tree_relation:${treeRelation}`],
      model: value.model,
      usage: {
        inputTokens: usage.input_tokens as number,
        outputTokens: usage.output_tokens as number,
      },
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }
}
