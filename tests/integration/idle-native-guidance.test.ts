import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDatabase } from "../../src/storage/database.js";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { RuntimeQueryService } from "../../src/application/runtime-query-service.js";
import { RuntimeProfileService } from "../../src/application/runtime-profile-service.js";
import { RequestRoutingService } from "../../src/application/request-routing-service.js";
import { HookIngestionService } from "../../src/application/hook-ingestion-service.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { resolveJevRequestRoutingConfiguration } from "../../src/domain/request-routing.js";

const fixtures: Array<{ directory: string; database: RuntimeDatabase }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fixture(status = "completed") {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-idle-guidance-"));
  const database = new RuntimeDatabase(path.join(directory, "data", "runtime.db"));
  fixtures.push({ directory, database });
  const projects = new ProjectIdentityService(database);
  const project = await projects.resolve(directory, "persist");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Counter" });
  database.run("UPDATE task_trees SET status = ? WHERE id = ?", status, tree.treeId);
  database.run("UPDATE workflow_states SET active = 0 WHERE tree_id = ?", tree.treeId);
  const configuration = resolveJevRequestRoutingConfiguration({});
  const profiles = new RuntimeProfileService(database, projects,
    new RequestRoutingService(database, configuration, { route: async () => { throw new Error("JEV must remain disabled"); } }), configuration);
  const hooks = new HookIngestionService(database, projects, undefined, undefined, profiles);
  const queries = new RuntimeQueryService(database);
  return { directory, database, project, tree, hooks, profiles, queries };
}

describe("native work after a Task Tree ends", () => {
  it.each(["completed", "archived"])("does not present %s tree actions as project-wide permissions", async (status) => {
    const f = await fixture(status);
    const before = f.database.all("SELECT * FROM task_trees");
    const snapshot = f.queries.getRuntimeSnapshot(f.project.projectId);
    expect(snapshot).toMatchObject({
      workflow: null,
      availableActionsScope: "task_tree_workflow",
      nativeAgentGuidance: {
        inactiveTreeBlocksNativeExecution: false,
        recordedWarningsArePendingWork: false,
        message: expect.stringMatching(/small self-contained[\s\S]*without[\s\S]*affiliation/i),
      },
    });
    expect(f.database.all("SELECT * FROM task_trees")).toEqual(before);
  });

  it("supplies idle guidance for a bare continuation without generating new work", async () => {
    const f = await fixture();
    const result = await f.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "continuation", cwd: f.directory, prompt: "继续",
    }));
    expect(result).toMatchObject({ directive: {
      kind: "context", context: expect.stringMatching(/no unfinished[\s\S]*report completion and stop/i),
    } });
    expect(f.database.all("SELECT id FROM task_affiliation_decisions")).toEqual([]);
    expect(f.database.all("SELECT id FROM task_trees")).toHaveLength(1);
    expect(await f.hooks.ingest(mapClaudeHook({ hook_event_name: "Stop", session_id: "continuation", cwd: f.directory })))
      .toEqual({ recorded: false, reason: "inactive" });
  });

  it("allows a title edit after pause and gives guidance without asking for affiliation", async () => {
    const f = await fixture();
    f.database.run("INSERT INTO runtime_profile_states (project_id,session_id,profile,reason_code,updated_at) VALUES (?,'title','conversation','affiliation:pause','now')", f.project.projectId);
    const event = mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "title", cwd: f.directory,
      prompt: "把浏览器标签页标题改成「计数器回归测试」。",
    });
    const prompt = await f.hooks.ingest(event);
    expect(prompt).toMatchObject({ directive: { kind: "context",
      context: expect.stringMatching(/small self-contained[\s\S]*without[\s\S]*affiliation/i),
    } });
    expect(await f.hooks.ingest(event)).toMatchObject({ reason: "duplicate", directive: { kind: "context" } });
    expect(await f.hooks.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "title", cwd: f.directory,
      tool_name: "Edit", tool_use_id: "title-edit", tool_input: { file_path: path.join(f.directory, "index.html") },
    }))).toMatchObject({ blocked: false, violation: false });
    expect(f.database.all("SELECT id FROM task_affiliation_decisions")).toEqual([]);
    expect(f.database.all("SELECT id FROM task_trees")).toHaveLength(1);
  });

  it("keeps a paused request stopped rather than suggesting direct work", async () => {
    const f = await fixture();
    f.database.run("INSERT INTO runtime_profile_states (project_id,session_id,profile,reason_code,updated_at) VALUES (?,'pause','conversation','affiliation:pause','now')", f.project.projectId);
    expect(f.profiles.current(f.project.projectId, "pause")).toMatchObject({
      nextAction: "await_user_direction",
      additionalContext: expect.stringMatching(/paused[\s\S]*stop/i),
    });
  });

  it("does not relax native approval for a new explicit structured request", async () => {
    const f = await fixture();
    const result = await f.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "structured", cwd: f.directory,
      prompt: "先讨论方案，确认后再实现。",
    }));
    expect(result).toMatchObject({ directive: { kind: "context", context: expect.stringContaining("task-tree-planning") } });
    expect(f.queries.getRuntimeSnapshot(f.project.projectId)).toMatchObject({
      nativeAgentGuidance: {
        requiresRequestProfileCheck: true,
        message: expect.stringMatching(/structured_coding[\s\S]*approval/),
      },
    });
    expect(await f.hooks.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "structured", cwd: f.directory,
      tool_name: "Edit", tool_use_id: "unapproved-edit", tool_input: { file_path: path.join(f.directory, "index.html") },
    }))).toMatchObject({ blocked: true, violation: true });
  });

  it("delivers the idle guidance through the installed-format compiled hook", async () => {
    const f = await fixture();
    const result = spawnSync(process.execPath, [path.resolve("plugin/runtime/hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "compiled-title", cwd: f.directory,
        prompt: "把浏览器标签页标题改成「计数器回归测试」。" }),
      encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(f.directory, "data"),
        HARNESS_JEV_ROUTING_ENABLED: "false", TYPESAFE_API_KEY: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: expect.stringMatching(/small self-contained[\s\S]*without[\s\S]*affiliation/i),
    } });
    expect(f.database.all("SELECT id FROM task_affiliation_decisions")).toEqual([]);
  });
});
