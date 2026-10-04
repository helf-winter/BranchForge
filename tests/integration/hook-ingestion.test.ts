import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookIngestionService } from "../../src/application/hook-ingestion-service.js";
import { ProjectIdentityService } from "../../src/application/project-identity-service.js";
import { TaskAffiliationService } from "../../src/application/task-affiliation-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { RequestRoutingService } from "../../src/application/request-routing-service.js";
import { RuntimeProfileService } from "../../src/application/runtime-profile-service.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import { resolveJevRequestRoutingConfiguration } from "../../src/domain/request-routing.js";
import { RuntimeDatabase } from "../../src/storage/database.js";
import { NativePlanBindingService } from "../../src/application/native-plan-binding-service.js";
import { TaskTreeApprovalService } from "../../src/application/task-tree-approval-service.js";
import { TaskTreeValidationService } from "../../src/application/task-tree-validation-service.js";
import { WorkflowService } from "../../src/application/workflow-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const dirs: string[] = [];
const databases: RuntimeDatabase[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-hook-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "data", "runtime.db"));
  databases.push(database);
  const service = new HookIngestionService(database, new ProjectIdentityService(database));
  return { directory, database, service };
}

async function activeTree(directory: string, database: RuntimeDatabase) {
  const identity = new ProjectIdentityService(database);
  const project = await identity.resolve(directory, "persist");
  const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
  const nodeId = tree.document.nodes[0]!.id;
  const nodeRevisionId = database.get<{ id: string }>(
    "SELECT id FROM task_node_revisions WHERE node_id = ? AND tree_revision_id = ?",
    nodeId, tree.revisionId,
  )!.id;
  database.run("UPDATE task_nodes SET status = 'running' WHERE id = ?", nodeId);
  database.run(
    "INSERT INTO execution_attempts (id, project_id, tree_id, task_node_id, task_node_revision_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?, 1, 'running', 'now')",
    `attempt-${nodeId}`, project.projectId, tree.treeId, nodeId, nodeRevisionId,
  );
  return { project, tree, nodeId, nodeRevisionId };
}

async function nativePlanTree(directory: string, database: RuntimeDatabase) {
  const identity = new ProjectIdentityService(database);
  const project = await identity.resolve(directory, "persist");
  const trees = new TaskTreeService(database);
  const root = await trees.createTaskRoot({ projectId: project.projectId, title: "Editor" });
  const document: TaskTreeDocument = {
    planningVersion: 1,
    planningContext: {
      goal: "Build editor", scopeBoundaries: ["browser"], exclusions: ["server"],
      unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
    },
    nodes: [
      { id: "root", parentId: null, title: "Editor", children: ["canvas"] },
      {
        id: "canvas", parentId: "root", title: "Canvas", children: [], objectives: ["Render beads"],
        expectedOutputs: ["canvas.ts"], acceptanceCriteria: ["test passes"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "test", description: "Canvas test" }],
        executionPhase: "implementation", stopDecompositionReason: "One verifiable feature",
      },
    ],
    relations: [], artifacts: [],
    skeletonCriteria: [{
      id: "canvas-skeleton", branchNodeId: "canvas", expectedArtifacts: ["canvas.ts"],
      requiredContracts: ["canvas-api"], verificationCommands: ["npm test"], readinessConditions: ["module imports"],
    }],
  };
  const revision = trees.saveDraftRevision({
    projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
  });
  const readiness = new TaskTreeValidationService(database, trees).validate({
    projectId: project.projectId, treeId: revision.treeId, treeRevisionId: revision.revisionId,
  });
  const approval = new TaskTreeApprovalService(database, trees).prepare({
    projectId: project.projectId, sessionId: "s1", treeId: revision.treeId,
    treeRevisionId: revision.revisionId, readinessResultId: readiness.resultId,
  });
  const workflows = new WorkflowService(database);
  const binding = new NativePlanBindingService(database, workflows);
  const service = new HookIngestionService(database, identity, undefined, undefined, undefined, binding);
  return { project, trees, revision, document, approval, service };
}

function linkPlannedFile(database: RuntimeDatabase, input: {
  projectId: string; treeId: string; treeRevisionId: string; nodeId: string; nodeRevisionId: string; artifactId: string; locator: string;
}) {
  database.run(
    "INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'file', ?, 'planned', '{}', 'now', 'now')",
    input.artifactId, input.projectId, input.treeId, input.locator,
  );
  database.run(
    `INSERT INTO task_node_artifact_links (
       id, project_id, tree_id, tree_revision_id, task_node_id, task_node_revision_id,
       artifact_id, relation_type, source_planning_revision_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'modifies', ?, 'now')`,
    `link-${input.artifactId}`, input.projectId, input.treeId, input.treeRevisionId, input.nodeId, input.nodeRevisionId,
    input.artifactId, input.treeRevisionId,
  );
}
afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // A test may have closed the database explicitly before teardown.
    }
  }
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Claude hook ingestion", () => {
  it("rejects malformed hook input at the binding boundary", () => {
    expect(() => mapClaudeHook({ hook_event_name: "PostToolUse" })).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("maps bounded Claude runtime context fields without retaining transcript paths or unknown environment data", () => {
    const event = mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "run-1", cwd: "/work/a", source: "resume",
      model: "glm-5.3", prompt_id: "prompt-1", permission_mode: "default", effort: { level: "high" },
      agent_id: "agent-1", agent_type: "reviewer", transcript_path: "/secret/transcript.jsonl",
      apiKey: "must-not-survive",
    });
    expect(event.runtimeContext).toEqual({
      promptId: "prompt-1", permissionMode: "default", effortLevel: "high", agentId: "agent-1",
      agentType: "reviewer", modelId: "glm-5.3", launchMethod: "resume",
    });
    expect(event).not.toHaveProperty("transcriptPath");

    expect(mapClaudeHook({
      hook_event_name: "PostModelSwitch", session_id: "run-1", cwd: "/work/a",
      from_model: "glm-5.3", to_model: "kimi-k3", source: "command",
    }).runtimeContext).toMatchObject({ modelId: "kimi-k3", modelSwitchSource: "command", previousModelId: "glm-5.3" });

    expect(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "run-1", cwd: "/work/a",
      permission_mode: "unknown", effort: { level: "extreme" },
    }).runtimeContext).toEqual({});
  });

  it("does not create project state for ordinary conversation without an active workflow", async () => {
    const { directory, database, service } = await fixture();
    const result = await service.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: directory, prompt: "explain this" }));
    expect(result).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(directory, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("does not inject generic lifecycle context at session start", async () => {
    const { directory, database, service } = await fixture();
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "s1", cwd: directory, source: "startup",
    }));

    expect(result).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    await expect(readFile(path.join(directory, ".agent-harness-project.json"))).rejects.toThrow();
    database.close();
  });

  it("records an existing Project prompt before routing and returns only structured Profile context", async () => {
    const { directory, database } = await fixture();
    const projects = new ProjectIdentityService(database);
    await projects.resolve(directory, "persist");
    const config = resolveJevRequestRoutingConfiguration({
      HARNESS_JEV_ROUTING_ENABLED: "true",
      TYPESAFE_API_KEY: "secret",
    });
    let observedPromptTrace = false;
    const provider = {
      async route() {
        observedPromptTrace = Boolean(database.get(`
          SELECT id FROM trace_events
          WHERE session_id = 'profile-session' AND event_name = 'UserPromptSubmit'
        `));
        return {
          classification: "task_tree_workflow" as const,
          treeRelation: "create_new_tree" as const,
          confidence: 0.95,
          probabilities: { task_tree_workflow: 0.95 },
          reasonCodes: ["route:task_tree_workflow"],
          model: "jev-1.13.0",
          usage: { inputTokens: 10, outputTokens: 2 },
          latencyMs: 1,
        };
      },
    };
    const profiles = new RuntimeProfileService(
      database,
      projects,
      new RequestRoutingService(database, config, provider),
      config,
    );
    const service = new HookIngestionService(database, projects, undefined, undefined, profiles);
    const event = mapClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "profile-session",
      cwd: directory,
      prompt: "实现一个完整的拼豆网页",
      timestamp: "2030-01-01T00:00:00.000Z",
    });
    const first = await service.ingest(event);
    expect(observedPromptTrace).toBe(true);
    expect(first).toMatchObject({
      recorded: true,
      blocked: false,
      directive: {
        kind: "context",
        context: [
          "Harness runtime profile: structured_coding.",
          "Establish and obtain native approval for a first-class Task Tree revision before project mutation.",
        ].join("\n"),
      },
    });
    expect(await service.ingest(event)).toMatchObject({
      recorded: false,
      reason: "duplicate",
      directive: { kind: "context" },
    });
    expect(database.all("SELECT id FROM trace_events WHERE session_id = 'profile-session'")).toHaveLength(1);
    expect(database.all("SELECT id FROM runtime_profile_transitions WHERE session_id = 'profile-session'")).toHaveLength(1);
    database.close();
  });

  it("records a user answer while Task affiliation confirmation is pending without an active tree", async () => {
    const { directory, database, service } = await fixture();
    const project = await new ProjectIdentityService(database).resolve(directory, "persist");
    const proposal = new TaskAffiliationService(database).propose({
      projectId: project.projectId,
      requestTitle: "Add an audit endpoint",
      recommendation: "new_tree",
    });

    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "affiliation-answer",
      cwd: directory,
      prompt: "Create a new tree",
    }));

    expect(result).toMatchObject({ recorded: true, violation: false, blocked: false });
    if (!result.recorded) throw new Error("answer Trace was not recorded");
    expect(database.get<{ tree_id: string | null; event_name: string }>(
      "SELECT tree_id, event_name FROM trace_events WHERE id = ?", result.eventId,
    )).toEqual({ tree_id: null, event_name: "UserPromptSubmit" });
    expect(database.get<{ status: string }>(
      "SELECT status FROM task_affiliation_decisions WHERE id = ?", proposal.decisionId,
    )?.status).toBe("pending");
    expect(database.all("SELECT id FROM task_trees")).toEqual([]);
    database.close();
  });

  it("persists an immutable Execution Context snapshot and carries model state across one Project run", async () => {
    const { directory, database, service } = await fixture();
    await activeTree(directory, database);

    await service.ingest(mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "run-context", cwd: directory,
      model: "glm-5.3", source: "resume", permission_mode: "plan", effort: { level: "high" },
    }));
    await service.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "run-context", cwd: directory,
      prompt_id: "prompt-2", prompt: "continue",
    }));
    await service.ingest(mapClaudeHook({
      hook_event_name: "PostModelSwitch", session_id: "run-context", cwd: directory,
      from_model: "glm-5.3", to_model: "kimi-k3", source: "command",
    }));
    await service.ingest(mapClaudeHook({
      hook_event_name: "Stop", session_id: "run-context", cwd: directory,
      agent_id: "agent-2", agent_type: "reviewer",
    }));
    await service.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "run-context", cwd: directory,
      prompt: "back in the main agent",
    }));

    const rows = database.all<{ event_name: string; execution_context_json: string }>(
      "SELECT event_name, execution_context_json FROM trace_events WHERE session_id = ? ORDER BY rowid",
      "run-context",
    );
    expect(rows.map((row) => ({ eventName: row.event_name, context: JSON.parse(row.execution_context_json) }))).toEqual([
      {
        eventName: "SessionStart",
        context: {
          runId: "run-context", agentType: "claude-code", runtimeBindingId: "claude-code-plugin",
          modelInfo: { id: "glm-5.3" }, cwd: directory, launchMethod: "resume",
          environment: {
            platform: process.platform, architecture: process.arch, nodeVersion: process.version,
            permissionMode: "plan", effortLevel: "high",
          },
        },
      },
      {
        eventName: "UserPromptSubmit",
        context: {
          runId: "run-context", agentType: "claude-code", runtimeBindingId: "claude-code-plugin",
          modelInfo: { id: "glm-5.3" }, cwd: directory, launchMethod: "resume",
          environment: {
            platform: process.platform, architecture: process.arch, nodeVersion: process.version,
            promptId: "prompt-2",
          },
        },
      },
      {
        eventName: "PostModelSwitch",
        context: {
          runId: "run-context", agentType: "claude-code", runtimeBindingId: "claude-code-plugin",
          modelInfo: { id: "kimi-k3" }, cwd: directory, launchMethod: "resume",
          environment: {
            platform: process.platform, architecture: process.arch, nodeVersion: process.version,
            previousModelId: "glm-5.3", modelSwitchSource: "command",
          },
        },
      },
      {
        eventName: "Stop",
        context: {
          runId: "run-context", agentType: "reviewer", runtimeBindingId: "claude-code-plugin",
          modelInfo: { id: "kimi-k3" }, cwd: directory, launchMethod: "resume",
          environment: {
            platform: process.platform, architecture: process.arch, nodeVersion: process.version,
            agentId: "agent-2",
          },
        },
      },
      {
        eventName: "UserPromptSubmit",
        context: {
          runId: "run-context", agentType: "claude-code", runtimeBindingId: "claude-code-plugin",
          modelInfo: { id: "kimi-k3" }, cwd: directory, launchMethod: "resume",
          environment: {
            platform: process.platform, architecture: process.arch, nodeVersion: process.version,
          },
        },
      },
    ]);
    database.close();
  });

  it("never inherits Execution Context model state across Project boundaries", async () => {
    const { directory: firstDirectory, database, service } = await fixture();
    const secondDirectory = await mkdtemp(path.join(tmpdir(), "harness-hook-second-"));
    dirs.push(secondDirectory);
    await activeTree(firstDirectory, database);
    await activeTree(secondDirectory, database);

    await service.ingest(mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "shared-run", cwd: firstDirectory,
      model: "glm-5.3", source: "startup",
    }));
    await service.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "shared-run", cwd: secondDirectory,
      prompt: "do not inherit",
    }));

    const secondProject = await new ProjectIdentityService(database).resolve(secondDirectory, "inspect");
    if (secondProject.status !== "same_project") throw new Error("second project was not resolved");
    const context = JSON.parse(database.get<{ execution_context_json: string }>(
      "SELECT execution_context_json FROM trace_events WHERE project_id = ? AND session_id = ?",
      secondProject.projectId, "shared-run",
    )!.execution_context_json);
    expect(context.modelInfo).toBeNull();
    expect(context.launchMethod).toBeNull();
    database.close();
  });

  it("inherits through synthetic Trace Events that have no Execution Context", async () => {
    const { directory, database, service } = await fixture();
    const { project, tree } = await activeTree(directory, database);
    await service.ingest(mapClaudeHook({
      hook_event_name: "SessionStart", session_id: "run-synthetic-gap", cwd: directory,
      model: "glm-5.3", source: "startup",
    }));
    database.run(
      "INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('synthetic-gap', ?, ?, 'run-synthetic-gap', 'planning', '{}', ?, 'synthetic-gap')",
      project.projectId, tree.treeId, new Date().toISOString(),
    );
    const prompt = await service.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: "run-synthetic-gap", cwd: directory,
      prompt: "continue after planning",
    }));
    if (!prompt.recorded) throw new Error("prompt Trace was not recorded");
    expect(JSON.parse(database.get<{ execution_context_json: string }>(
      "SELECT execution_context_json FROM trace_events WHERE id = ?", prompt.eventId,
    )!.execution_context_json)).toMatchObject({ modelInfo: { id: "glm-5.3" }, launchMethod: "startup" });
    database.close();
  });

  it("records and allows direct project mutation when no Task Tree workflow is active", async () => {
    const { directory, database, service } = await fixture();
    const event = mapClaudeHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts"), apiKey: "secret" } });
    expect(await service.ingest(event)).toMatchObject({
      recorded: true,
      violation: false,
      blocked: false,
    });
    expect(await service.ingest(event)).toEqual({ recorded: false, reason: "duplicate" });
    const trace = database.get<{ event_name: string; payload_json: string }>("SELECT event_name, payload_json FROM trace_events");
    expect(trace?.event_name).toBe("PreToolUse");
    expect(trace?.payload_json).not.toContain("secret");
    expect(trace?.payload_json).toContain("[REDACTED]");
    const bashMutation = mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2",
      tool_input: { command: "printf 'x' > src/a.ts" },
    });
    expect(await service.ingest(bashMutation)).toMatchObject({ recorded: true, violation: false, blocked: false });
    database.close();
  });

  it("records the outcome and Artifact of direct work without a Task Tree", async () => {
    const { directory, database, service } = await fixture();
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "direct-write",
      tool_input: { file_path: path.join(directory, "direct.txt") }, tool_response: { ok: true },
    }));

    expect(result).toMatchObject({ recorded: true, violation: false, blocked: false });
    if (!result.recorded) throw new Error("direct work outcome was not recorded");
    expect(database.get<{ tree_id: string | null; event_name: string }>(
      "SELECT tree_id, event_name FROM trace_events WHERE id = ?", result.eventId,
    )).toEqual({ tree_id: null, event_name: "PostToolUse" });
    expect(database.get<{ tree_id: string | null; status: string; source_trace_event_id: string }>(
      "SELECT tree_id, status, source_trace_event_id FROM artifacts WHERE locator = 'direct.txt'",
    )).toEqual({ tree_id: null, status: "created", source_trace_event_id: result.eventId });
    database.close();
  });

  it("blocks a project mutation while an active Task Tree is still awaiting confirmation", async () => {
    const { directory, database, service } = await fixture();
    await activeTree(directory, database);
    const event = mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1",
      tool_input: { file_path: path.join(directory, "a.ts") },
    });

    expect(await service.ingest(event)).toMatchObject({
      recorded: true,
      violation: true,
      blocked: true,
      directive: { kind: "deny", reason: expect.stringContaining("active Task Tree") },
    });
    expect(await service.ingest(event)).toMatchObject({ recorded: false, reason: "duplicate", directive: { kind: "deny" } });
    database.close();
  });

  it("keeps Claude native Plan Mode available while Task Tree planning is active", async () => {
    const { directory, database, service } = await fixture();
    await activeTree(directory, database);
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory,
      tool_name: "EnterPlanMode", tool_use_id: "plan-mode", tool_input: {},
    }));

    expect(result).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(database.get<{ event_name: string }>(
      "SELECT event_name FROM trace_events WHERE id = ?", result.recorded ? result.eventId : "",
    )).toEqual({ event_name: "PreToolUse" });
    database.close();
  });

  it("leaves native Plan Mode available when no Task Tree workflow is active", async () => {
    const { directory, database, service } = await fixture();
    expect(await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory,
      tool_name: "EnterPlanMode", tool_use_id: "plan-mode", tool_input: {},
    }))).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    database.close();
  });

  it("binds successful ExitPlanMode hooks to the exact prepared Task Tree revision once", async () => {
    const { directory, database } = await fixture();
    const native = await nativePlanTree(directory, database);
    const pre = mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-approved", tool_input: { plan: native.approval.canonicalBlock },
    });
    expect(await native.service.ingest(pre)).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(await native.service.ingest(pre)).toMatchObject({ recorded: false, reason: "duplicate" });
    expect(await native.service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-approved", tool_input: {}, tool_response: { approved: true },
    }))).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ?", native.revision.treeId))
      .toEqual({ stage: "skeleton_pass" });
    expect(database.all("SELECT id FROM native_plan_approval_events")).toHaveLength(1);
    database.close();
  });

  it("records failed ExitPlanMode as rejection without activating execution", async () => {
    const { directory, database } = await fixture();
    const native = await nativePlanTree(directory, database);
    await native.service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-rejected", tool_input: { plan: native.approval.canonicalBlock },
    }));
    expect(await native.service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUseFailure", session_id: "s1", cwd: directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-rejected", tool_input: {}, tool_response: { rejected: true },
    }))).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(database.get<{ status: string }>(
      "SELECT status FROM task_tree_approval_references WHERE approval_ref = ?", native.approval.approvalRef,
    )).toEqual({ status: "rejected" });
    expect(database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ?", native.revision.treeId))
      .toEqual({ stage: "branch_confirmation" });
    database.close();
  });

  it("denies malformed or stale canonical blocks with a recoverable native Plan action", async () => {
    const malformedFixture = await fixture();
    const malformed = await nativePlanTree(malformedFixture.directory, malformedFixture.database);
    expect(await malformed.service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: malformedFixture.directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-malformed",
      tool_input: { plan: malformed.approval.canonicalBlock.replace("Canvas", "Changed Canvas") },
    }))).toMatchObject({
      recorded: true, violation: true, blocked: true,
      directive: { kind: "deny", reason: expect.stringContaining("prepare a new approval block") },
    });
    malformedFixture.database.close();

    const staleFixture = await fixture();
    const stale = await nativePlanTree(staleFixture.directory, staleFixture.database);
    stale.trees.saveDraftRevision({
      projectId: stale.project.projectId, treeId: stale.revision.treeId,
      baseRevisionId: stale.revision.revisionId, document: stale.document,
    });
    expect(await stale.service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: staleFixture.directory,
      tool_name: "ExitPlanMode", tool_use_id: "exit-stale", tool_input: { plan: stale.approval.canonicalBlock },
    }))).toMatchObject({ recorded: true, violation: true, blocked: true });
    staleFixture.database.close();
  });

  it("does not treat project-external planning files or read-only tools as project mutations", async () => {
    const { directory, database, service } = await fixture();
    const externalPlan = path.join(tmpdir(), "claude-plan.md");

    expect(await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "plan",
      tool_input: { file_path: externalPlan },
    }))).toEqual({ recorded: false, reason: "inactive" });
    expect(await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Read", tool_use_id: "read",
      tool_input: { file_path: path.join(directory, "README.md") },
    }))).toEqual({ recorded: false, reason: "inactive" });
    expect(await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "tmp-log",
      tool_input: { command: "npm run dev > /tmp/project-dev.log 2>&1" },
    }))).toEqual({ recorded: false, reason: "inactive" });
    expect(database.all("SELECT id FROM projects")).toEqual([]);
    database.close();
  });

  it("allows project mutation after the Workflow reaches an executable stage", async () => {
    const { directory, database, service } = await fixture();
    const { project } = await activeTree(directory, database);
    database.run("UPDATE workflow_states SET stage = 'skeleton_pass' WHERE project_id = ? AND active = 1", project.projectId);

    expect(await service.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "allowed-write",
      tool_input: { file_path: path.join(directory, "src", "planned.ts") },
    }))).toMatchObject({ recorded: true, violation: false, blocked: false });
    database.close();
  });

  it("deduplicates deliveries and projects successful and failed tool outcomes", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const success = mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "u1", tool_input: { file_path: path.join(directory, "a.ts") }, tool_response: { ok: true } });
    const successResult = await service.ingest(success);
    if (!successResult.recorded) throw new Error("success hook was not recorded");
    expect(await service.ingest(success)).toEqual({ recorded: false, reason: "duplicate" });
    await service.ingest(mapClaudeHook({ hook_event_name: "PostToolUseFailure", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "u2", tool_input: { command: "npm test" }, tool_response: { exitCode: 1 } }));
    expect(database.all("SELECT id FROM trace_events")).toHaveLength(2);
    expect(database.get<{ status: string; source_trace_event_id: string }>("SELECT status, source_trace_event_id FROM artifacts WHERE kind = 'file'")).toEqual({
      status: "created", source_trace_event_id: successResult.eventId,
    });
    expect(database.get<{ status: string }>("SELECT status FROM artifacts WHERE kind = 'command'")?.status).toBe("failed");
    expect(JSON.parse(database.get<{ payload_json: string }>("SELECT payload_json FROM trace_events WHERE id = ?", successResult.eventId)!.payload_json))
      .toMatchObject({ artifactRefs: [expect.any(String)], toolInput: { file_path: path.join(directory, "a.ts") } });
    database.close();
  });

  it("updates a planned file as modified and preserves Trace provenance", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    const tree = await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    database.run(
      "INSERT INTO artifacts (id, project_id, tree_id, kind, locator, status, metadata_json, created_at, updated_at) VALUES ('planned-file', ?, ?, 'file', 'src/planned.ts', 'planned', '{}', 'now', 'now')",
      project.projectId, tree.treeId,
    );
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "planned-edit",
      tool_input: { file_path: path.join(directory, "src", "planned.ts") }, tool_response: { ok: true },
    }));
    if (!result.recorded) throw new Error("planned edit was not recorded");
    expect(database.get<{ status: string; source_trace_event_id: string; confidence: string }>(
      "SELECT status, source_trace_event_id, confidence FROM artifacts WHERE id = 'planned-file'",
    )).toEqual({ status: "modified", source_trace_event_id: result.eventId, confidence: "observed" });
    database.close();
  });

  it("marks successful verification commands as verified Artifacts", async () => {
    const { directory, database, service } = await fixture();
    const identity = new ProjectIdentityService(database);
    const project = await identity.resolve(directory, "persist");
    await new TaskTreeService(database).createTaskRoot({ projectId: project.projectId, title: "Runtime" });
    const result = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Bash", tool_use_id: "verify",
      tool_input: { command: "npm test" }, tool_response: { exitCode: 0 },
    }));
    if (!result.recorded) throw new Error("verification hook was not recorded");
    expect(database.get<{ status: string; confidence: string; source_trace_event_id: string }>(
      "SELECT status, confidence, source_trace_event_id FROM artifacts WHERE kind = 'command'",
    )).toEqual({ status: "verified", confidence: "verified", source_trace_event_id: result.eventId });
    database.close();
  });

  it("does not record Drift when a mutation matches the selected node plan", async () => {
    const { directory, database, service } = await fixture();
    const { project, tree, nodeId, nodeRevisionId } = await activeTree(directory, database);
    linkPlannedFile(database, {
      projectId: project.projectId, treeId: tree.treeId, treeRevisionId: tree.revisionId,
      nodeId, nodeRevisionId, artifactId: "own-file", locator: "src/owned.ts",
    });

    await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "owned-edit",
      tool_input: { file_path: path.join(directory, "src", "owned.ts") }, tool_response: { ok: true },
    }));

    expect(database.all("SELECT id FROM plan_drift_records")).toEqual([]);
  });

  it("records warning Drift for an unplanned mutation", async () => {
    const { directory, database, service } = await fixture();
    const { nodeId } = await activeTree(directory, database);

    const event = mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Write", tool_use_id: "unplanned-write",
      tool_input: { file_path: path.join(directory, "src", "surprise.ts") }, tool_response: { ok: true },
    });
    await service.ingest(event);
    expect(await service.ingest(event)).toEqual({ recorded: false, reason: "duplicate" });

    expect(database.get<{ severity: string; resolution_status: string; task_node_id: string }>(
      "SELECT severity, resolution_status, task_node_id FROM plan_drift_records",
    )).toEqual({ severity: "warning", resolution_status: "recorded", task_node_id: nodeId });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM plan_drift_records")).toEqual({ count: 1 });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM trace_events")).toEqual({ count: 2 });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE task_node_id = ?", nodeId)).toEqual({ status: "running" });
  });

  it("records blocking Drift when a mutation belongs to an unconfirmed sibling branch", async () => {
    const { directory, database, service } = await fixture();
    const { project, tree, nodeId } = await activeTree(directory, database);
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES ('sibling', ?, ?, 'Sibling', 'draft')", tree.treeId, nodeId);
    database.run("INSERT INTO task_node_revisions (id, node_id, tree_revision_id, body_json, created_at) VALUES ('sibling-r1', 'sibling', ?, '{}', 'now')", tree.revisionId);
    database.run(
      "INSERT INTO task_node_confirmation_states (project_id, tree_id, tree_revision_id, task_node_id, state, updated_at) VALUES (?, ?, ?, 'sibling', 'draft', 'now')",
      project.projectId, tree.treeId, tree.revisionId,
    );
    linkPlannedFile(database, {
      projectId: project.projectId, treeId: tree.treeId, treeRevisionId: tree.revisionId,
      nodeId: "sibling", nodeRevisionId: "sibling-r1", artifactId: "sibling-file", locator: "src/sibling.ts",
    });

    const source = await service.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "s1", cwd: directory, tool_name: "Edit", tool_use_id: "sibling-edit",
      tool_input: { file_path: path.join(directory, "src", "sibling.ts") }, tool_response: { ok: true },
    }));
    if (!source.recorded) throw new Error("sibling edit was not recorded");

    const drift = database.get<{ severity: string; resolution_status: string; trace_event_id: string; task_node_id: string }>(
      "SELECT severity, resolution_status, trace_event_id, task_node_id FROM plan_drift_records",
    );
    expect(drift).toMatchObject({ severity: "blocking", resolution_status: "pending_user_confirmation", task_node_id: nodeId });
    expect(database.get<{ status: string }>("SELECT status FROM task_nodes WHERE id = ?", nodeId)).toEqual({ status: "blocked" });
    expect(database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE task_node_id = ?", nodeId)).toEqual({ status: "blocked" });
    expect(JSON.parse(database.get<{ payload_json: string }>("SELECT payload_json FROM trace_events WHERE id = ?", drift!.trace_event_id)!.payload_json))
      .toMatchObject({ sourceTraceEventId: source.eventId, actualArtifactId: "sibling-file" });
  });
});
