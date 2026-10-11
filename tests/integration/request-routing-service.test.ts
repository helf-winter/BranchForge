import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestRoutingService } from "../../src/application/request-routing-service.js";
import { HarnessError } from "../../src/domain/errors.js";
import { resolveJevRequestRoutingConfiguration, type RequestRouteClassification } from "../../src/domain/request-routing.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture(environment: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-request-routing-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/work', '2026', '2026')");
  const config = resolveJevRequestRoutingConfiguration(environment);
  return { database, config };
}

function providerResult(classification: RequestRouteClassification, confidence: number) {
  return {
    classification,
    treeRelation: "create_new_tree" as const,
    confidence,
    probabilities: { [classification]: confidence },
    reasonCodes: ["provider:test"],
    model: "jev-1.13.0",
    usage: { inputTokens: 40, outputTokens: 8 },
    latencyMs: 12,
  };
}

const input = {
  projectId: "p1",
  sessionId: "session-1",
  prompt: "实现一个完整的拼豆网页",
  hasActiveWorkflow: false,
};

describe("RequestRoutingService", () => {
  it("accepts explicit structured intent deterministically when Jev routing is disabled", async () => {
    const { database, config } = await fixture();
    const provider = { route: vi.fn() };
    const service = new RequestRoutingService(database, config, provider);
    await expect(service.route({
      ...input,
      prompt: "请先和我讨论并完善需求，确认规划之后再开始实现。",
    })).resolves.toMatchObject({
      classification: "task_tree_workflow",
      disposition: "accepted",
      provider: "deterministic_rules",
      confidence: 1,
      fallbackReason: null,
      reasonCodes: ["explicit_intent:discussion_before_implementation"],
    });
    expect(provider.route).not.toHaveBeenCalled();
    database.close();
  });

  it("lets explicit direct execution override an available Jev provider", async () => {
    const { database, config } = await fixture({ HARNESS_JEV_ROUTING_ENABLED: "true", TYPESAFE_API_KEY: "secret" });
    const provider = { route: vi.fn(async () => providerResult("task_tree_workflow", 0.99)) };
    const service = new RequestRoutingService(database, config, provider);
    await expect(service.route({
      ...input,
      prompt: "不用建立或修改任务树，直接执行这个小改动。",
    })).resolves.toMatchObject({
      classification: "direct_execution",
      disposition: "accepted",
      provider: "deterministic_rules",
    });
    expect(provider.route).not.toHaveBeenCalled();
    database.close();
  });

  it.each([
    [{}, "disabled"],
    [{ HARNESS_JEV_ROUTING_ENABLED: "true" }, "misconfigured"],
  ])("uses native fallback when routing is %s", async (environment, readiness) => {
    const { database, config } = await fixture(environment);
    const provider = { route: vi.fn() };
    const result = await new RequestRoutingService(database, config, provider).route(input);
    expect(result).toMatchObject({
      disposition: "native_fallback",
      fallbackReason: `routing_${readiness}`,
      persisted: true,
    });
    expect(provider.route).not.toHaveBeenCalled();
    expect(database.all("SELECT * FROM request_route_decisions")).toHaveLength(1);
    database.close();
  });

  it.each([
    ["task_tree_workflow", 0.9, "accepted"],
    ["direct_execution", 0.7, "advisory"],
    ["direct_response", 0.4, "native_fallback"],
  ] as const)("persists %s at confidence %s as %s", async (classification, confidence, disposition) => {
    const { database, config } = await fixture({ HARNESS_JEV_ROUTING_ENABLED: "true", TYPESAFE_API_KEY: "secret" });
    const service = new RequestRoutingService(database, config, { async route() { return providerResult(classification, confidence); } });
    await expect(service.route(input)).resolves.toMatchObject({ classification, confidence, disposition, persisted: true });
    expect(database.get<{ disposition: string }>("SELECT disposition FROM request_route_decisions"))
      .toEqual({ disposition });
    expect(JSON.stringify(database.all("SELECT * FROM request_route_decisions"))).not.toContain("secret");
    database.close();
  });

  it("persists only a bounded provider failure code", async () => {
    const { database, config } = await fixture({ HARNESS_JEV_ROUTING_ENABLED: "true", TYPESAFE_API_KEY: "secret" });
    const service = new RequestRoutingService(database, config, {
      async route() { throw new HarnessError("provider_rate_limited", "secret provider response"); },
    });
    await expect(service.route(input)).resolves.toMatchObject({
      disposition: "native_fallback",
      fallbackReason: "provider_rate_limited",
    });
    expect(JSON.stringify(database.all("SELECT * FROM request_route_decisions"))).not.toContain("secret provider response");
    database.close();
  });

  it("returns a transient decision and writes nothing without a Project", async () => {
    const { database, config } = await fixture({ HARNESS_JEV_ROUTING_ENABLED: "true", TYPESAFE_API_KEY: "secret" });
    const service = new RequestRoutingService(database, config, {
      async route() { return providerResult("direct_response", 0.9); },
    });
    await expect(service.route({ ...input, projectId: null })).resolves.toMatchObject({
      id: null,
      projectId: null,
      persisted: false,
      classification: "direct_response",
    });
    expect(database.all("SELECT * FROM request_route_decisions")).toEqual([]);
    database.close();
  });

  it("is idempotent for the same prompt and policy but creates new decisions for changed inputs", async () => {
    const { database, config } = await fixture({ HARNESS_JEV_ROUTING_ENABLED: "true", TYPESAFE_API_KEY: "secret" });
    const provider = { route: vi.fn(async () => providerResult("task_tree_workflow", 0.9)) };
    const service = new RequestRoutingService(database, config, provider, "request-routing-v1");
    const first = await service.route(input);
    const repeated = await service.route(input);
    const changed = await service.route({ ...input, prompt: `${input.prompt}，支持移动端` });
    const changedPolicy = await new RequestRoutingService(database, config, provider, "request-routing-v2").route(input);
    expect(repeated.id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
    expect(changedPolicy.id).not.toBe(first.id);
    expect(provider.route).toHaveBeenCalledTimes(3);
    expect(database.all("SELECT id FROM request_route_decisions")).toHaveLength(3);
    database.close();
  });
});
