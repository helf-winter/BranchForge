import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve("plugin");
const repositoryRoot = path.resolve(".");

describe("Claude plugin contract", () => {
  it("can be installed globally from the repository as a local marketplace", async () => {
    const marketplace = JSON.parse(
      await readFile(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as {
      name: string;
      plugins: Array<{ name: string; source: string }>;
    };

    expect(marketplace.name).toBe("agent-harness-local");
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "agent-harness", source: "./plugin" }),
    ]);
  });

  it("has valid metadata and self-contained MCP and hook commands", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name: string };
    expect(manifest.name).toBe("agent-harness");
    const mcp = JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers["agent-harness"]?.args.join(" ")).toContain("${CLAUDE_PLUGIN_ROOT}/runtime/mcp.mjs");
    const hooksText = await readFile(path.join(root, "hooks", "hooks.json"), "utf8");
    const hooks = JSON.parse(hooksText) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostModelSwitch", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptExpansion", "UserPromptSubmit"].sort());
    for (const registrations of Object.values(hooks.hooks)) {
      for (const registration of registrations) for (const hook of registration.hooks) {
        expect(hook.command).toContain("${CLAUDE_PLUGIN_ROOT}/runtime/hook.mjs");
        expect(hook.command).not.toContain("../");
      }
    }
  });

  it("ships six discoverable, narrowly triggered Skills", async () => {
    const expected = ["branch-execution", "drift-handling", "plugin-composition", "task-tree-planning", "taskroot", "verification-reporting"];
    expect((await readdir(path.join(root, "skills"))).sort()).toEqual(expected);
    for (const name of expected) {
      const source = await readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
      const match = source.match(/^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---/);
      expect(match?.[1]).toBe(name);
      expect(match?.[2]).toMatch(/^Use when /);
    }
    const planning = await readFile(path.join(root, "skills", "task-tree-planning", "SKILL.md"), "utf8");
    expect(planning.match(/^description: ([^\r\n]+)/m)?.[1]).toContain("complex, multi-stage, cross-module");
    expect(planning.match(/^description: ([^\r\n]+)/m)?.[1]).toContain("execute directly without a Task Tree");
    for (const required of [
      "AskUserQuestion", "harness_create_task_tree_draft", "harness_patch_task_tree",
      "harness_validate_task_tree", "harness_prepare_task_tree_approval",
    ]) expect(planning).toContain(required);
    expect(planning).toContain("canonical block unchanged");
    expect(planning).toContain("native Plan approval exactly once");
    expect(planning).toContain("Never write a JSON manifest");
    expect(planning).toContain("Never ask for a second Harness confirmation");
  });

  it("binds branch execution to the deterministic scheduler and Attempt lifecycle", async () => {
    const source = await readFile(path.join(root, "skills", "branch-execution", "SKILL.md"), "utf8");
    expect(source).toContain("harness_get_next_executable_node");
    expect(source).toContain("harness_start_node_attempt");
    expect(source).toContain("harness_begin_node_verification");
    expect(source).toContain("harness_attach_attempt_evidence");
    expect(source).toContain("harness_evaluate_node_attempt");
    expect(source).toContain("Never invent a cross-branch order");
  });

  it("runs the compiled CLI from a non-ASCII plugin path", () => {
    const result = spawnSync(process.execPath, [path.join(root, "runtime", "cli.mjs"), "doctor", "--json"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sqlite: { ok: true } });
  });

  it("runs a compiled inactive hook silently and without creating project state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness compiled hook "));
    try {
      const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd, prompt: "explain" });
      const result = spawnSync(process.execPath, [path.join(root, "runtime", "hook.mjs")], {
        input, encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(cwd, "data") },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      await expect(readFile(path.join(cwd, ".agent-harness-project.json"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps SessionStart silent instead of forcing generic Task Tree activation context", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness compiled session "));
    try {
      const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd, source: "startup" });
      const result = spawnSync(process.execPath, [path.join(root, "runtime", "hook.mjs")], {
        input, encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(cwd, "data") },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      await expect(readFile(path.join(cwd, ".agent-harness-project.json"))).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not impose Task Tree gates when no Task Tree workflow is active", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "harness compiled guard "));
    try {
      for (const input of [
        {
          hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "Write", tool_use_id: "write-1",
          tool_input: { file_path: path.join(cwd, "src", "app.ts") },
        },
        {
          hook_event_name: "PreToolUse", session_id: "s1", cwd, tool_name: "EnterPlanMode", tool_use_id: "plan-1",
          tool_input: {},
        },
      ]) {
        const result = spawnSync(process.execPath, [path.join(root, "runtime", "hook.mjs")], {
          input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(cwd, "data") },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
