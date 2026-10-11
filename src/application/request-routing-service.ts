import { createHash } from "node:crypto";
import type {
  JevRequestRouteResponse,
  RequestRouteSnapshot,
} from "../bindings/typesafe/jev-request-router.js";
import type { HarnessErrorCode } from "../domain/errors.js";
import { HarnessError } from "../domain/errors.js";
import { newId, nowIso } from "../domain/ids.js";
import {
  detectExplicitRequestRoute,
  resolveRuntimeProfile,
  type JevRequestRoutingConfiguration,
  type RequestRouteClassification,
  type RouteDisposition,
  type TaskTreeRelationSuggestion,
} from "../domain/request-routing.js";
import { canonicalJson } from "../domain/trace.js";
import type { RuntimeDatabase } from "../storage/database.js";

export interface RequestRouter {
  route(snapshot: RequestRouteSnapshot): Promise<JevRequestRouteResponse>;
}

type RouteResponse = Omit<JevRequestRouteResponse, "usage"> & {
  usage: JevRequestRouteResponse["usage"] | null;
};

export interface RequestRouteDecisionView {
  id: string | null;
  projectId: string | null;
  sessionId: string;
  promptFingerprint: string;
  classification: RequestRouteClassification;
  treeRelation: TaskTreeRelationSuggestion;
  confidence: number;
  probabilities: Partial<Record<RequestRouteClassification, number>>;
  reasonCodes: string[];
  disposition: RouteDisposition;
  provider: "typesafe_jev" | "deterministic_rules";
  modelRequested: string;
  modelResolved: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number | null;
  fallbackReason: string | null;
  policyVersion: string;
  createdAt: string;
  persisted: boolean;
}

interface RouteRow {
  id: string;
  project_id: string;
  session_id: string;
  prompt_fingerprint: string;
  classification: RequestRouteClassification;
  tree_relation: TaskTreeRelationSuggestion;
  confidence: number;
  probabilities_json: string;
  reason_codes_json: string;
  disposition: RouteDisposition;
  provider: "typesafe_jev" | "deterministic_rules";
  model_requested: string;
  model_resolved: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  fallback_reason: string | null;
  policy_version: string;
  created_at: string;
}

const boundedProviderCodes = new Set<HarnessErrorCode>([
  "provider_disabled",
  "provider_misconfigured",
  "provider_authentication_failed",
  "provider_rate_limited",
  "provider_overloaded",
  "provider_request_invalid",
  "provider_connection_failed",
  "provider_timeout",
  "provider_response_invalid",
  "provider_http_error",
]);

function snapshotFingerprint(snapshot: RequestRouteSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

function viewFromRow(row: RouteRow): RequestRouteDecisionView {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    promptFingerprint: row.prompt_fingerprint,
    classification: row.classification,
    treeRelation: row.tree_relation,
    confidence: row.confidence,
    probabilities: JSON.parse(row.probabilities_json) as Partial<Record<RequestRouteClassification, number>>,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[],
    disposition: row.disposition,
    provider: row.provider,
    modelRequested: row.model_requested,
    modelResolved: row.model_resolved,
    usage: row.input_tokens === null || row.output_tokens === null
      ? null
      : { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    latencyMs: row.latency_ms,
    fallbackReason: row.fallback_reason,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    persisted: true,
  };
}

export class RequestRoutingService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly config: JevRequestRoutingConfiguration,
    private readonly router: RequestRouter,
    private readonly policyVersion = "request-routing-v2",
  ) {}

  async route(input: {
    projectId: string | null;
    sessionId: string;
    prompt: string;
    promptTraceEventId?: string;
    activeTree?: { treeId: string; title: string; currentNodeTitle: string | null };
    hasActiveWorkflow: boolean;
  }): Promise<RequestRouteDecisionView> {
    const prompt = input.prompt.trim();
    const sessionId = input.sessionId.trim();
    if (!prompt || !sessionId) {
      throw new HarnessError("invalid_input", "request routing requires a prompt and Session ID");
    }
    const snapshot: RequestRouteSnapshot = {
      prompt,
      hasActiveTree: Boolean(input.activeTree),
      activeTreeTitle: input.activeTree?.title ?? null,
      currentNodeTitle: input.activeTree?.currentNodeTitle ?? null,
      hasActiveWorkflow: input.hasActiveWorkflow,
    };
    const promptFingerprint = snapshotFingerprint(snapshot);
    if (input.projectId) {
      const existing = this.database.get<RouteRow>(`
        SELECT * FROM request_route_decisions
        WHERE project_id = ? AND session_id = ? AND prompt_fingerprint = ? AND policy_version = ?
      `, input.projectId, sessionId, promptFingerprint, this.policyVersion);
      if (existing) return viewFromRow(existing);
    }

    const explicitRoute = detectExplicitRequestRoute(prompt);
    let response: RouteResponse | null = explicitRoute
      ? {
          classification: explicitRoute.classification,
          treeRelation: explicitRoute.treeRelation,
          confidence: 1,
          probabilities: { [explicitRoute.classification]: 1 },
          reasonCodes: [explicitRoute.reasonCode],
          model: "deterministic-explicit-intent-v1",
          usage: null,
          latencyMs: 0,
        }
      : null;
    let fallbackReason: string | null = null;
    if (explicitRoute) {
      // Explicit user direction is authoritative and does not require an external classifier.
    } else if (!this.config.enabled) {
      fallbackReason = "routing_disabled";
    } else if (this.config.readiness !== "ready") {
      fallbackReason = "routing_misconfigured";
    } else {
      try {
        response = await this.router.route(snapshot);
      } catch (error) {
        fallbackReason = error instanceof HarnessError && boundedProviderCodes.has(error.code)
          ? error.code
          : "provider_connection_failed";
      }
    }

    const classification = response?.classification ?? "direct_response";
    const confidence = response?.confidence ?? 0;
    const resolution = fallbackReason
      ? { disposition: "native_fallback" as const }
      : resolveRuntimeProfile({
        route: {
          classification,
          treeRelation: response?.treeRelation ?? "unclear",
          confidence,
          probabilities: response?.probabilities ?? {},
          reasonCodes: response?.reasonCodes ?? [],
          provider: explicitRoute ? "deterministic_rules" : "typesafe_jev",
          model: response?.model ?? this.config.model,
          fallbackReason: null,
        },
        config: this.config,
      });
    const createdAt = nowIso();
    const decision: RequestRouteDecisionView = {
      id: input.projectId ? newId() : null,
      projectId: input.projectId,
      sessionId,
      promptFingerprint,
      classification,
      treeRelation: response?.treeRelation ?? "unclear",
      confidence,
      probabilities: response?.probabilities ?? {},
      reasonCodes: response?.reasonCodes ?? [fallbackReason ?? "routing_unavailable"],
      disposition: resolution.disposition,
      provider: explicitRoute ? "deterministic_rules" : "typesafe_jev",
      modelRequested: explicitRoute ? "deterministic-explicit-intent-v1" : this.config.model,
      modelResolved: response?.model ?? null,
      usage: response?.usage ?? null,
      latencyMs: response?.latencyMs ?? null,
      fallbackReason,
      policyVersion: this.policyVersion,
      createdAt,
      persisted: Boolean(input.projectId),
    };

    if (input.projectId) {
      this.database.run(`
        INSERT INTO request_route_decisions (
          id, project_id, session_id, prompt_trace_event_id, prompt_fingerprint,
          classification, tree_relation, confidence, probabilities_json, reason_codes_json,
          disposition, provider, model_requested, model_resolved, input_tokens, output_tokens,
          latency_ms, fallback_reason, policy_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, decision.id!, input.projectId, sessionId, input.promptTraceEventId ?? null, promptFingerprint,
      decision.classification, decision.treeRelation, decision.confidence,
      canonicalJson(decision.probabilities), canonicalJson(decision.reasonCodes), decision.disposition,
      decision.provider, decision.modelRequested, decision.modelResolved,
      decision.usage?.inputTokens ?? null, decision.usage?.outputTokens ?? null,
      decision.latencyMs, decision.fallbackReason, decision.policyVersion, decision.createdAt);
    }
    return decision;
  }

  persistTransient(input: {
    projectId: string;
    decision: RequestRouteDecisionView;
    promptTraceEventId?: string;
  }): RequestRouteDecisionView {
    if (input.decision.persisted) return input.decision;
    const existing = this.database.get<RouteRow>(`
      SELECT * FROM request_route_decisions
      WHERE project_id = ? AND session_id = ? AND prompt_fingerprint = ? AND policy_version = ?
    `, input.projectId, input.decision.sessionId, input.decision.promptFingerprint, input.decision.policyVersion);
    if (existing) return viewFromRow(existing);

    const id = newId();
    this.database.run(`
      INSERT INTO request_route_decisions (
        id, project_id, session_id, prompt_trace_event_id, prompt_fingerprint,
        classification, tree_relation, confidence, probabilities_json, reason_codes_json,
        disposition, provider, model_requested, model_resolved, input_tokens, output_tokens,
        latency_ms, fallback_reason, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, input.projectId, input.decision.sessionId, input.promptTraceEventId ?? null,
    input.decision.promptFingerprint, input.decision.classification, input.decision.treeRelation,
    input.decision.confidence, canonicalJson(input.decision.probabilities),
    canonicalJson(input.decision.reasonCodes), input.decision.disposition, input.decision.provider,
    input.decision.modelRequested, input.decision.modelResolved,
    input.decision.usage?.inputTokens ?? null, input.decision.usage?.outputTokens ?? null,
    input.decision.latencyMs, input.decision.fallbackReason, input.decision.policyVersion,
    input.decision.createdAt);
    return { ...input.decision, id, projectId: input.projectId, persisted: true };
  }
}
