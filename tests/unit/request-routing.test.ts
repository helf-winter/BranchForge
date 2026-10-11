import { describe, expect, it } from "vitest";
import {
  detectExplicitRequestRoute,
  resolveJevRequestRoutingConfiguration,
  resolveRuntimeProfile,
  type RequestRouteResult,
} from "../../src/domain/request-routing.js";

function route(
  classification: RequestRouteResult["classification"],
  confidence: number,
): RequestRouteResult {
  return {
    classification,
    treeRelation: "unclear",
    confidence,
    probabilities: { [classification]: confidence },
    reasonCodes: ["test"],
    provider: "typesafe_jev",
    model: "jev-1.13.0",
    fallbackReason: null,
  };
}

describe("request routing", () => {
  it("detects an explicit discuss-confirm-implement contract without an external router", () => {
    expect(detectExplicitRequestRoute(`
      我想从零开发一个拼豆图案设计网页。
      请先和我讨论并完善需求，确认规划之后再开始实现。
    `)).toEqual({
      classification: "task_tree_workflow",
      treeRelation: "unclear",
      reasonCode: "explicit_intent:discussion_before_implementation",
    });
  });

  it("gives an explicit direct-execution escape priority over planning language", () => {
    expect(detectExplicitRequestRoute("不用建立或修改任务树，直接执行这个小改动。"))
      .toEqual({
        classification: "direct_execution",
        treeRelation: "unclear",
        reasonCode: "explicit_intent:direct_execution",
      });
  });

  it("leaves ambiguous requests to Jev or native Agent judgment", () => {
    expect(detectExplicitRequestRoute("实现一个拼豆网页")).toBeNull();
    expect(detectExplicitRequestRoute("解释一下 React Context")).toBeNull();
  });

  it("defaults request routing to disabled without an explicit flag", () => {
    expect(resolveJevRequestRoutingConfiguration({})).toEqual({
      enabled: false,
      readiness: "disabled",
      apiKey: null,
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      timeoutMs: 2_000,
      acceptedConfidence: 0.8,
      advisoryConfidence: 0.5,
    });
  });

  it("accepts an enabled routing configuration with a TypeSafe key", () => {
    expect(resolveJevRequestRoutingConfiguration({
      HARNESS_JEV_ROUTING_ENABLED: "true",
      TYPESAFE_API_KEY: "secret",
      HARNESS_JEV_ROUTING_TIMEOUT_MS: "2500",
      HARNESS_JEV_ROUTING_ACCEPTED_CONFIDENCE: "0.9",
      HARNESS_JEV_ROUTING_ADVISORY_CONFIDENCE: "0.6",
    })).toMatchObject({
      enabled: true,
      readiness: "ready",
      apiKey: "secret",
      timeoutMs: 2_500,
      acceptedConfidence: 0.9,
      advisoryConfidence: 0.6,
    });
  });

  it("rejects routing thresholds outside zero to one", () => {
    expect(() => resolveJevRequestRoutingConfiguration({
      HARNESS_JEV_ROUTING_ACCEPTED_CONFIDENCE: "1.1",
    })).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
    expect(() => resolveJevRequestRoutingConfiguration({
      HARNESS_JEV_ROUTING_ACCEPTED_CONFIDENCE: "0.4",
      HARNESS_JEV_ROUTING_ADVISORY_CONFIDENCE: "0.5",
    })).toThrow(expect.objectContaining({ code: "invalid_configuration" }));
  });

  it("resolves accepted high-confidence routes to their matching profiles", () => {
    const config = resolveJevRequestRoutingConfiguration({});
    expect(resolveRuntimeProfile({ route: route("direct_response", 0.9), config }))
      .toEqual({ profile: "conversation", disposition: "accepted", reasonCode: "route:direct_response" });
    expect(resolveRuntimeProfile({ route: route("direct_execution", 0.9), config }))
      .toEqual({ profile: "direct_coding", disposition: "accepted", reasonCode: "route:direct_execution" });
    expect(resolveRuntimeProfile({ route: route("task_tree_workflow", 0.9), config }))
      .toEqual({ profile: "structured_coding", disposition: "accepted", reasonCode: "route:task_tree_workflow" });
  });

  it("keeps medium-confidence routes advisory and low-confidence routes native fallback", () => {
    const config = resolveJevRequestRoutingConfiguration({});
    expect(resolveRuntimeProfile({ route: route("task_tree_workflow", 0.7), config }))
      .toEqual({ profile: "conversation", disposition: "advisory", reasonCode: "route_confidence:advisory" });
    expect(resolveRuntimeProfile({ route: route("direct_execution", 0.4), config, previousProfile: "direct_coding" }))
      .toEqual({ profile: "direct_coding", disposition: "native_fallback", reasonCode: "route_confidence:native_fallback" });
  });

  it("lets an explicit direct execution decision override a structured suggestion", () => {
    const config = resolveJevRequestRoutingConfiguration({});
    expect(resolveRuntimeProfile({
      route: route("task_tree_workflow", 0.99),
      config,
      explicitProfile: "direct_coding",
      activeApprovedWorkflow: true,
    })).toEqual({ profile: "direct_coding", disposition: "explicit_override", reasonCode: "explicit_profile:direct_coding" });
  });

  it("keeps an active approved Workflow in structured coding unless the user records a new affiliation decision", () => {
    const config = resolveJevRequestRoutingConfiguration({});
    expect(resolveRuntimeProfile({
      route: route("direct_response", 0.99),
      config,
      activeApprovedWorkflow: true,
    })).toEqual({ profile: "structured_coding", disposition: "accepted", reasonCode: "active_approved_workflow" });
  });
});
