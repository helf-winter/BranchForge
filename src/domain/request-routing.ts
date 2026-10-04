import { HarnessError } from "./errors.js";

export type RequestRouteClassification =
  | "direct_response"
  | "direct_execution"
  | "task_tree_workflow";

export type TaskTreeRelationSuggestion =
  | "continue_existing_tree"
  | "change_existing_tree"
  | "create_new_tree"
  | "unclear";

export type RuntimeProfile = "conversation" | "direct_coding" | "structured_coding";

export type RouteDisposition =
  | "accepted"
  | "advisory"
  | "native_fallback"
  | "explicit_override";

export type JevRequestRoutingReadiness = "disabled" | "ready" | "misconfigured";

export interface JevRequestRoutingConfiguration {
  enabled: boolean;
  readiness: JevRequestRoutingReadiness;
  apiKey: string | null;
  endpoint: string;
  model: string;
  timeoutMs: number;
  acceptedConfidence: number;
  advisoryConfidence: number;
}

export interface RequestRouteResult {
  classification: RequestRouteClassification;
  treeRelation: TaskTreeRelationSuggestion;
  confidence: number;
  probabilities: Partial<Record<RequestRouteClassification, number>>;
  reasonCodes: string[];
  provider: string;
  model: string;
  fallbackReason: string | null;
}

export interface RuntimeProfileResolutionInput {
  route: RequestRouteResult | null;
  config: Pick<JevRequestRoutingConfiguration, "acceptedConfidence" | "advisoryConfidence">;
  previousProfile?: RuntimeProfile;
  explicitProfile?: RuntimeProfile;
  activeApprovedWorkflow?: boolean;
}

export interface RuntimeProfileResolution {
  profile: RuntimeProfile;
  disposition: RouteDisposition;
  reasonCode: string;
}

type Environment = Record<string, string | undefined>;

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";

function optionalNumber(environment: Environment, key: string, defaultValue: number): number {
  const raw = environment[key]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new HarnessError("invalid_configuration", `${key} must be a finite number`);
  }
  return value;
}

function confidence(environment: Environment, key: string, defaultValue: number): number {
  const value = optionalNumber(environment, key, defaultValue);
  if (value < 0 || value > 1) {
    throw new HarnessError("invalid_configuration", `${key} must be between zero and one`);
  }
  return value;
}

export function resolveJevRequestRoutingConfiguration(
  environment: Environment,
): JevRequestRoutingConfiguration {
  const enabled = environment.HARNESS_JEV_ROUTING_ENABLED?.trim().toLowerCase() === "true";
  const apiKey = environment.TYPESAFE_API_KEY?.trim() || null;
  const timeoutMs = optionalNumber(environment, "HARNESS_JEV_ROUTING_TIMEOUT_MS", 2_000);
  const acceptedConfidence = confidence(
    environment,
    "HARNESS_JEV_ROUTING_ACCEPTED_CONFIDENCE",
    0.8,
  );
  const advisoryConfidence = confidence(
    environment,
    "HARNESS_JEV_ROUTING_ADVISORY_CONFIDENCE",
    0.5,
  );

  if (timeoutMs < 100 || timeoutMs > 60_000) {
    throw new HarnessError(
      "invalid_configuration",
      "HARNESS_JEV_ROUTING_TIMEOUT_MS must be between 100 and 60000",
    );
  }
  if (acceptedConfidence < advisoryConfidence) {
    throw new HarnessError(
      "invalid_configuration",
      "accepted routing confidence must be greater than or equal to advisory confidence",
    );
  }

  return {
    enabled,
    readiness: enabled ? (apiKey ? "ready" : "misconfigured") : "disabled",
    apiKey,
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    timeoutMs,
    acceptedConfidence,
    advisoryConfidence,
  };
}

function profileForClassification(classification: RequestRouteClassification): RuntimeProfile {
  switch (classification) {
    case "direct_response":
      return "conversation";
    case "direct_execution":
      return "direct_coding";
    case "task_tree_workflow":
      return "structured_coding";
  }
}

export function resolveRuntimeProfile(input: RuntimeProfileResolutionInput): RuntimeProfileResolution {
  if (input.explicitProfile) {
    return {
      profile: input.explicitProfile,
      disposition: "explicit_override",
      reasonCode: `explicit_profile:${input.explicitProfile}`,
    };
  }

  if (input.activeApprovedWorkflow) {
    return {
      profile: "structured_coding",
      disposition: "accepted",
      reasonCode: "active_approved_workflow",
    };
  }

  const fallbackProfile = input.previousProfile ?? "conversation";
  if (!input.route || input.route.fallbackReason) {
    return {
      profile: fallbackProfile,
      disposition: "native_fallback",
      reasonCode: input.route?.fallbackReason ?? "route_unavailable",
    };
  }

  if (input.route.confidence >= input.config.acceptedConfidence) {
    return {
      profile: profileForClassification(input.route.classification),
      disposition: "accepted",
      reasonCode: `route:${input.route.classification}`,
    };
  }

  if (input.route.confidence >= input.config.advisoryConfidence) {
    return {
      profile: fallbackProfile,
      disposition: "advisory",
      reasonCode: "route_confidence:advisory",
    };
  }

  return {
    profile: fallbackProfile,
    disposition: "native_fallback",
    reasonCode: "route_confidence:native_fallback",
  };
}
