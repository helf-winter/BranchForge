import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { RequestRoutingService } from "../../src/application/request-routing-service.js";
import { RuntimeProfileService } from "../../src/application/runtime-profile-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { resolveJevRequestRoutingConfiguration, type RequestRouteClassification } from "../../src/domain/request-routing.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function providerResult(classification: RequestRouteClassification, confidence: number) {
  return {
    classification,
    treeRelation: "create_new_tree" as const,
    confidence,
    probabilities: { [classification]: confidence },
    reasonCodes: [`route:${classification}`],
    model: "jev-1.13.0",
    usage: { inputTokens: 20, outputTokens: 5 },
    latencyMs: 3,
  };
}

async function fixture(classification: RequestRouteClassification, confidence: number) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-runtime-profile-"));
  dirs.push(root);
  const projectDirectory = path.join(root, "project");
  await import("node:fs/promises").then((fs) => fs.mkdir(projectDirectory));
  const database = new RuntimeDatabase(path.join(root, "runtime.db"));
  const projects = new ProjectIdentityService(database);
  const config = resolveJevRequestRoutingConfiguration({
    HARNESS_JEV_ROUTING_ENABLED: "true",
    TYPESAFE_API_KEY: "secret",
  });
  const provider = { route: vi.fn(async () => providerResult(classification, confidence)) };
  const routes = new RequestRoutingService(database, config, provider);
  const profiles = new RuntimeProfileService(database, projects, routes, config);
  return { root, projectDirectory, database, projects, provider, profiles };
}

describe("RuntimeProfileService", () => {
  it("keeps an accepted direct response transient in a new directory", async () => {
    const { projectDirectory, database, profiles } = await fixture("direct_response", 0.95);
    await expect(profiles.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "session-1",
      prompt: "解释一下 React context",
    })).resolves.toMatchObject({
      projectId: null,
      profile: "conversation",
      disposition: "accepted",
      nextAction: "respond_normally",
      additionalContext: null,
    });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(projectDirectory, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("persists accepted direct execution and an idempotent profile transition", async () => {
    const { projectDirectory, database, profiles, provider } = await fixture("direct_execution", 0.95);
    const first = await profiles.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "session-1",
      prompt: "删除一个无用文件",
    });
    const repeated = await profiles.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "session-1",
      prompt: "删除一个无用文件",
    });
    expect(first).toMatchObject({ profile: "direct_coding", disposition: "accepted", nextAction: "execute_directly" });
    expect(repeated).toMatchObject({ projectId: first.projectId, profile: "direct_coding" });
    expect(first.projectId).toEqual(expect.any(String));
    expect(provider.route).toHaveBeenCalledTimes(1);
    expect(database.all("SELECT * FROM runtime_profile_states")).toHaveLength(1);
    expect(database.all("SELECT * FROM runtime_profile_transitions")).toHaveLength(1);
    expect(database.all("SELECT * FROM request_route_decisions")).toHaveLength(1);
    database.close();
  });

  it("returns minimal structured-coding context without dumping Task or Artifact state", async () => {
    const { projectDirectory, database, profiles } = await fixture("task_tree_workflow", 0.95);
    const result = await profiles.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "session-1",
      prompt: "实现一个完整的拼豆设计器",
    });
    expect(result).toMatchObject({
      profile: "structured_coding",
      disposition: "accepted",
      nextAction: "establish_task_tree",
      additionalContext: [
        "Harness runtime profile: structured_coding.",
        "Establish and obtain native approval for a first-class Task Tree revision before project mutation.",
      ].join("\n"),
    });
    expect(result.additionalContext).not.toContain("artifactIds");
    expect(result.additionalContext).not.toContain("nodes");
    expect(result.additionalContext!.length).toBeLessThan(240);
    database.close();
  });

  it.each([
    [0.7, "advisory"],
    [0.4, "native_fallback"],
  ] as const)("does not accept a structured lifecycle at confidence %s", async (confidence, disposition) => {
    const { projectDirectory, database, profiles } = await fixture("task_tree_workflow", confidence);
    await expect(profiles.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "session-1",
      prompt: "也许改一些代码",
    })).resolves.toMatchObject({
      projectId: null,
      profile: "conversation",
      disposition,
      nextAction: "respond_normally",
      additionalContext: null,
    });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    database.close();
  });

  it("restores structured coding from an active confirmed Workflow after restart", async () => {
    const { projectDirectory, database, projects } = await fixture("direct_response", 0.95);
    const project = await projects.resolve(projectDirectory, "persist");
    const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "拼豆网页" });
    database.run("UPDATE task_trees SET status = 'confirmed' WHERE id = ?", tree.treeId);
    database.run("UPDATE workflow_states SET stage = 'skeleton_pass' WHERE project_id = ?", project.projectId);

    const disabled = resolveJevRequestRoutingConfiguration({});
    const restarted = new RuntimeProfileService(
      database,
      new ProjectIdentityService(database),
      new RequestRoutingService(database, disabled, { route: vi.fn() }),
      disabled,
    );
    await expect(restarted.resolveForPrompt({
      cwd: projectDirectory,
      sessionId: "new-session",
      prompt: "继续实现",
    })).resolves.toMatchObject({
      projectId: project.projectId,
      profile: "structured_coding",
      reasonCode: "active_approved_workflow",
      nextAction: "continue_task_tree",
    });
    expect(restarted.current(project.projectId, "new-session")).toMatchObject({ profile: "structured_coding" });
    database.close();
  });
});
