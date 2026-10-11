import { describe, expect, it, vi } from "vitest";
import { JevRequestRouter, type RequestRouteSnapshot } from "../../src/bindings/typesafe/jev-request-router.js";
import { resolveJevRequestRoutingConfiguration } from "../../src/domain/request-routing.js";

const snapshot: RequestRouteSnapshot = {
  prompt: "实现可复用的登录表单",
  hasActiveTree: true,
  activeTreeTitle: "账户系统",
  currentNodeTitle: "登录页面",
  hasActiveWorkflow: false,
};

function enabledConfig() {
  return resolveJevRequestRoutingConfiguration({
    HARNESS_JEV_ROUTING_ENABLED: "true",
    TYPESAFE_API_KEY: "test-key",
  });
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      request_kind: {
        type: "choice",
        choice: "task_tree_workflow",
        probabilities: { direct_response: 0.03, direct_execution: 0.07, task_tree_workflow: 0.9 },
        confidence: 0.86,
      },
      tree_relation: {
        type: "choice",
        choice: "change_existing_tree",
        probabilities: {
          continue_existing_tree: 0.05,
          change_existing_tree: 0.8,
          create_new_tree: 0.1,
          unclear: 0.05,
        },
        confidence: 0.78,
      },
    },
    usage: { input_tokens: 80, output_tokens: 16 },
    ...overrides,
  };
}

describe("JevRequestRouter", () => {
  it("sends only the bounded routing snapshot and typed choice questions", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      const body = JSON.parse(serialized) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "jev-1.13.0", state: snapshot });
      expect(body.questions).toMatchObject({
        request_kind: { type: "choice" },
        tree_relation: { type: "choice" },
      });
      expect(Object.keys(body.state as object).sort()).toEqual([
        "activeTreeTitle", "currentNodeTitle", "hasActiveTree", "hasActiveWorkflow", "prompt",
      ]);
      expect(serialized).not.toContain("SECRET_ENV_VALUE");
      expect(serialized).not.toContain("source fixture text");
      expect(serialized).not.toContain("tool output fixture");
      expect(serialized).not.toContain("conversation history fixture");
      expect(serialized).not.toContain("test-key");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify(successBody()), { status: 200 });
    });
    const router = new JevRequestRouter(enabledConfig(), fetcher as typeof fetch);
    await expect(router.route(snapshot)).resolves.toMatchObject({
      classification: "task_tree_workflow",
      treeRelation: "change_existing_tree",
      confidence: 0.86,
      probabilities: { task_tree_workflow: 0.9 },
      model: "jev-1.13.0",
      usage: { inputTokens: 80, outputTokens: 16 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redacts secrets, omits pasted source, and bounds every outbound routing field", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const serialized = String(init?.body);
      const body = JSON.parse(serialized) as { state: RequestRouteSnapshot };
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain("const leakedSource");
      expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(body.state.prompt).toContain("[REDACTED]");
      expect(body.state.prompt).toContain("[CODE OMITTED]");
      expect(body.state.prompt.length).toBeLessThanOrEqual(2_000);
      expect(body.state.activeTreeTitle!.length).toBeLessThanOrEqual(160);
      expect(body.state.currentNodeTitle!.length).toBeLessThanOrEqual(160);
      return new Response(JSON.stringify(successBody()), { status: 200 });
    });
    const router = new JevRequestRouter(enabledConfig(), fetcher as typeof fetch);
    await router.route({
      prompt: `Implement login with token=super-secret-token\n\`\`\`ts\nconst leakedSource = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";\n\`\`\`\n${"x".repeat(3_000)}`,
      hasActiveTree: true,
      activeTreeTitle: `Tree apiKey=super-secret-token ${"t".repeat(300)}`,
      currentNodeTitle: `Node ghp_abcdefghijklmnopqrstuvwxyz1234567890 ${"n".repeat(300)}`,
      hasActiveWorkflow: false,
    });
  });

  it("omits the tree relation question when there is no active tree", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      expect(body.questions).not.toHaveProperty("tree_relation");
      const response = successBody();
      delete (response.answers as Record<string, unknown>).tree_relation;
      return new Response(JSON.stringify(response), { status: 200 });
    });
    await expect(new JevRequestRouter(enabledConfig(), fetcher as typeof fetch).route({
      prompt: snapshot.prompt,
      hasActiveTree: false,
      activeTreeTitle: null,
      currentNodeTitle: null,
      hasActiveWorkflow: false,
    })).resolves.toMatchObject({ treeRelation: "create_new_tree" });
  });

  it.each([
    [401, "provider_authentication_failed"],
    [422, "provider_request_invalid"],
    [429, "provider_rate_limited"],
    [529, "provider_overloaded"],
    [500, "provider_http_error"],
  ])("maps HTTP %i to %s without retaining the response", async (status, code) => {
    const router = new JevRequestRouter(enabledConfig(), vi.fn(async () =>
      new Response("provider-secret-body", { status })) as unknown as typeof fetch);
    const failure = await router.route(snapshot).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code });
    expect(JSON.stringify(failure)).not.toContain("provider-secret-body");
    expect(JSON.stringify(failure)).not.toContain("test-key");
  });

  it("maps timeout and network failures to bounded errors", async () => {
    const timeout = new JevRequestRouter(enabledConfig(), vi.fn(async () => {
      throw new DOMException("provider-secret-timeout", "TimeoutError");
    }) as unknown as typeof fetch);
    await expect(timeout.route(snapshot)).rejects.toMatchObject({ code: "provider_timeout" });
    const network = new JevRequestRouter(enabledConfig(), vi.fn(async () => {
      throw new Error("provider-secret-network");
    }) as unknown as typeof fetch);
    const failure = await network.route(snapshot).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "provider_connection_failed" });
    expect(JSON.stringify(failure)).not.toContain("provider-secret-network");
  });

  it.each([
    ["not-json", "malformed JSON"],
    [JSON.stringify(successBody({ answers: {} })), "missing answer"],
    [JSON.stringify(successBody({ answers: { request_kind: { type: "choice", choice: "unknown", probabilities: {}, confidence: 1 } } })), "unknown choice"],
    [JSON.stringify(successBody({ answers: { request_kind: { type: "choice", choice: "direct_response", probabilities: { direct_response: 2 }, confidence: 1 } } })), "invalid probability"],
    [JSON.stringify(successBody({ answers: { request_kind: { type: "choice", choice: "direct_response", probabilities: { direct_response: 1 }, confidence: -1 } } })), "invalid confidence"],
  ])("rejects %s as provider_response_invalid", async (body) => {
    const router = new JevRequestRouter(enabledConfig(), vi.fn(async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch);
    await expect(router.route(snapshot)).rejects.toMatchObject({ code: "provider_response_invalid" });
  });
});
