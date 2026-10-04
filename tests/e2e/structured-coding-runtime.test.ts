import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { RequestRouteClassification } from "../../src/domain/request-routing.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function pinBeanDocument(branchTitle = "Canvas editor"): TaskTreeDocument {
  return {
    planningVersion: 1,
    planningContext: {
      goal: "Build a usable PinBean pattern editor",
      scopeBoundaries: ["React browser application"],
      exclusions: ["server persistence"],
      unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
    },
    nodes: [
      {
        id: "root", parentId: null, title: "PinBean acceptance", children: ["canvas"],
        executionPhase: "verification", requiredEvidence: [{ key: "root-test", description: "full application test" }],
      },
      {
        id: "canvas", parentId: "root", title: branchTitle,
        children: ["canvas-skeleton", "canvas-implementation"], executionPhase: "verification",
        requiredEvidence: [{ key: "branch-test", description: "canvas integration test" }],
      },
      {
        id: "canvas-skeleton", parentId: "canvas", title: "Wire canvas contract", children: [],
        objectives: ["Create the shared canvas module and public contract"], expectedOutputs: ["src/canvas.ts"],
        acceptanceCriteria: ["the project builds"], unresolvedQuestions: [], unresolvedDecisions: [], dependencies: [],
        requiredEvidence: [{ key: "contract-check", description: "build verifies the canvas contract" }],
        executionPhase: "skeleton", stopDecompositionReason: "one independently verifiable skeleton boundary",
      },
      {
        id: "canvas-implementation", parentId: "canvas", title: "Implement bead drawing", children: [],
        objectives: ["Implement pointer drawing and undo"], expectedOutputs: ["src/canvas.ts"],
        acceptanceCriteria: ["canvas tests pass"], unresolvedQuestions: [], unresolvedDecisions: [],
        dependencies: ["canvas-skeleton"], requiredEvidence: [{ key: "canvas-test", description: "canvas tests pass" }],
        executionPhase: "implementation", stopDecompositionReason: "one independently testable feature",
      },
    ],
    relations: [{ fromNodeId: "canvas-implementation", toNodeId: "canvas-skeleton", kind: "depends_on" }],
    artifacts: [
      { id: "canvas-file", kind: "file", locator: "src/canvas.ts" },
      { id: "canvas-contract-artifact", kind: "contract", locator: "contract:canvas", granularity: "contract" },
    ],
    artifactLinks: [
      { taskNodeId: "canvas-skeleton", artifactId: "canvas-file", relationType: "creates" },
      { taskNodeId: "canvas-skeleton", artifactId: "canvas-contract-artifact", relationType: "implements" },
      { taskNodeId: "canvas-implementation", artifactId: "canvas-contract-artifact", relationType: "consumes" },
    ],
    artifactContracts: [{
      id: "canvas-contract", artifactId: "canvas-contract-artifact", name: "Canvas Contract", version: "1",
      compatibilityPolicy: "exact", schemaOrSignature: "draw(point, color): void",
      providerNodeIds: ["canvas-skeleton"], consumerNodeIds: ["canvas-implementation"],
      validationRefs: ["contract-check"],
    }],
    skeletonCriteria: [{
      id: "canvas-ready", branchNodeId: "canvas", expectedArtifacts: ["src/canvas.ts"],
      requiredContracts: ["canvas-contract"], verificationCommands: ["npm run build"],
      readinessConditions: ["canvas module imports"],
    }],
  };
}

describe("structured coding runtime vertical slice", () => {
  it("routes, plans, approves, schedules Skeleton first, and supports an explicit direct escape", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-pinbean-e2e-"));
    directories.push(directory);
    const projectDirectory = path.join(directory, "pinbean");
    await mkdir(projectDirectory);
    let route: RequestRouteClassification = "task_tree_workflow";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        request_kind: {
          type: "choice", choice: route,
          probabilities: { direct_response: 0.01, direct_execution: route === "direct_execution" ? 0.97 : 0.02, task_tree_workflow: route === "task_tree_workflow" ? 0.97 : 0.02 },
          confidence: 0.97,
        },
        tree_relation: {
          type: "choice", choice: route === "task_tree_workflow" ? "create_new_tree" : "continue_existing_tree",
          probabilities: { continue_existing_tree: 0.9, change_existing_tree: 0.03, create_new_tree: 0.05, unclear: 0.02 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 20, output_tokens: 5 },
    }), { status: 200 })));
    const runtime = openRuntime({
      ...process.env,
      AGENT_HARNESS_DATA_HOME: path.join(directory, "data"),
      HARNESS_JEV_ROUTING_ENABLED: "true",
      HARNESS_JEV_ENABLED: "false",
      TYPESAFE_API_KEY: "test-only-key",
    });
    const sessionId = "pin-session";

    const routed = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectDirectory,
      prompt: "从零开发一个 React TypeScript 拼豆设计网页，先讨论并确认规划再实现",
    }));
    expect(routed).toMatchObject({
      recorded: true, blocked: false,
      directive: { kind: "context", context: expect.stringContaining("structured_coding") },
    });
    const project = await runtime.projects.resolve(projectDirectory, "inspect");
    if (project.status !== "same_project") throw new Error("routed project was not persisted");
    expect(runtime.runtimeProfiles.current(project.projectId, sessionId)).toMatchObject({ profile: "structured_coding" });

    const proposal = runtime.affiliations.propose({
      projectId: project.projectId, requestTitle: "Build PinBean editor", recommendation: "new_tree",
    });
    const affiliationAnswer = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectDirectory, prompt: "创建新任务树",
    }));
    if (!affiliationAnswer.recorded) throw new Error("affiliation answer was not recorded");
    const affiliation = await runtime.affiliations.resolve({
      projectId: project.projectId, decisionId: proposal.decisionId, choice: "new_tree",
      answerTraceEventId: affiliationAnswer.eventId,
    });
    const draft = runtime.taskTreeDrafts.createDraft({
      projectId: project.projectId, sessionId, affiliationDecisionId: proposal.decisionId,
      document: pinBeanDocument(), idempotencyKey: "pinbean-draft",
    });

    const refinementAnswer = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectDirectory,
      prompt: "画布分支名称改成可缩放画布编辑器，其他内容不变",
    }));
    if (!refinementAnswer.recorded) throw new Error("refinement answer was not recorded");
    const patched = runtime.taskTreeDrafts.patch({
      projectId: project.projectId, sessionId, treeId: draft.treeId,
      expectedTreeRevisionId: draft.revisionId, idempotencyKey: "pinbean-local-patch",
      operations: [{
        op: "replace_document", document: pinBeanDocument("Zoomable canvas editor"),
        sourceUserMessageTraceEventId: refinementAnswer.eventId,
        decision: {
          discussionTopic: "Canvas branch wording", currentUnderstanding: "The canvas must support zooming",
          consideredOptions: ["Keep generic title", "Use zoomable title"],
          agentRecommendation: "Use zoomable title", userDecision: "Use zoomable title",
        },
      }],
    });
    const readiness = runtime.taskTreeValidation.validate({
      projectId: project.projectId, treeId: patched.treeId, treeRevisionId: patched.revisionId,
    });
    expect(readiness).toMatchObject({ ready: true, revisionId: patched.revisionId });
    const approval = runtime.taskTreeApprovals.prepare({
      projectId: project.projectId, sessionId, treeId: patched.treeId,
      treeRevisionId: patched.revisionId, readinessResultId: readiness.resultId,
    });

    await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "ExitPlanMode", tool_use_id: "pinbean-plan", tool_input: { plan: `Implementation plan\n\n${approval.canonicalBlock}` },
    }));
    await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "ExitPlanMode", tool_use_id: "pinbean-plan", tool_input: {}, tool_response: { approved: true },
    }));
    expect(runtime.database.get<{ status: string }>(
      "SELECT status FROM task_tree_approval_references WHERE approval_ref = ?", approval.approvalRef,
    )).toEqual({ status: "consumed" });

    const skeleton = runtime.scheduler.next({ projectId: project.projectId, treeId: patched.treeId });
    expect(skeleton).toMatchObject({ nodeId: "canvas-skeleton", phase: "skeleton", stage: "skeleton_pass" });
    const skeletonAttempt = runtime.executions.startAttempt({
      projectId: project.projectId, nodeId: skeleton!.nodeId, expectedTreeRevisionId: skeleton!.treeRevisionId,
      sourceTraceEventId: refinementAnswer.eventId,
    });
    const write = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "Write", tool_use_id: "write-canvas", tool_input: { file_path: "src/canvas.ts", content: "export const canvas = true" },
      tool_response: { ok: true },
    }));
    const build = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "Bash", tool_use_id: "build-skeleton", tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 },
    }));
    if (!write.recorded || !build.recorded) throw new Error("skeleton facts were not recorded");
    expect(runtime.database.get<{ node_id: string }>("SELECT node_id FROM trace_events WHERE id = ?", write.eventId))
      .toEqual({ node_id: "canvas-skeleton" });
    runtime.executions.attachEvidence({
      projectId: project.projectId, attemptId: skeletonAttempt.attemptId,
      requiredEvidenceKey: "contract-check", traceEventId: build.eventId,
    });
    runtime.executions.beginVerification({ projectId: project.projectId, attemptId: skeletonAttempt.attemptId, expectedStatus: "running" });
    runtime.evaluations.evaluateAttempt({
      projectId: project.projectId, attemptId: skeletonAttempt.attemptId, proposedVerdict: "succeeded", riskSummary: null,
    });
    const skeletonWorkflow = runtime.database.get<{ revision: number }>(
      "SELECT revision FROM workflow_states WHERE tree_id = ?", patched.treeId,
    )!;
    expect(runtime.skeletonGates.evaluate({
      projectId: project.projectId, treeId: patched.treeId, workflowRevision: skeletonWorkflow.revision,
    })).toMatchObject({ status: "passed", workflow: { stage: "branch_implementation", activeBranchNodeId: "canvas" } });

    const implementation = runtime.scheduler.next({ projectId: project.projectId, treeId: patched.treeId });
    expect(implementation).toMatchObject({ nodeId: "canvas-implementation", activeBranchNodeId: "canvas" });
    const implementationAttempt = runtime.executions.startAttempt({
      projectId: project.projectId, nodeId: implementation!.nodeId, expectedTreeRevisionId: implementation!.treeRevisionId,
      sourceTraceEventId: refinementAnswer.eventId,
    });
    const implementationTrace = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "Bash", tool_use_id: "canvas-tests", tool_input: { command: "npm test -- canvas" }, tool_response: { exitCode: 0 },
    }));
    if (!implementationTrace.recorded) throw new Error("implementation fact was not recorded");
    runtime.executions.attachEvidence({
      projectId: project.projectId, attemptId: implementationAttempt.attemptId,
      requiredEvidenceKey: "canvas-test", traceEventId: implementationTrace.eventId,
    });
    runtime.executions.beginVerification({ projectId: project.projectId, attemptId: implementationAttempt.attemptId, expectedStatus: "running" });
    runtime.evaluations.evaluateAttempt({
      projectId: project.projectId, attemptId: implementationAttempt.attemptId, proposedVerdict: "succeeded", riskSummary: null,
    });
    const branchWorkflow = runtime.database.get<{ revision: number }>(
      "SELECT revision FROM workflow_states WHERE tree_id = ?", patched.treeId,
    )!;
    runtime.workflowPhases.evaluate({
      projectId: project.projectId, treeId: patched.treeId, workflowRevision: branchWorkflow.revision,
    });
    expect(runtime.scheduler.next({ projectId: project.projectId, treeId: patched.treeId }))
      .toMatchObject({ nodeId: "canvas", phase: "verification", activeBranchNodeId: "canvas" });

    route = "direct_execution";
    const treeCount = runtime.database.get<{ count: number }>(
      "SELECT count(*) AS count FROM task_trees WHERE project_id = ?", project.projectId,
    )!.count;
    await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectDirectory,
      prompt: "只改一下 README 里的一个错别字",
    }));
    expect(runtime.database.get<{ classification: string }>(`
      SELECT classification FROM request_route_decisions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `, project.projectId)).toEqual({ classification: "direct_execution" });
    const directProposal = runtime.affiliations.propose({
      projectId: project.projectId, requestTitle: "Fix README typo", recommendation: "new_tree",
    });
    const directAnswer = await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectDirectory,
      prompt: "直接执行，不建立或修改任务树",
    }));
    if (!directAnswer.recorded) throw new Error("direct answer was not recorded");
    await runtime.affiliations.resolve({
      projectId: project.projectId, decisionId: directProposal.decisionId,
      choice: "direct_execution", answerTraceEventId: directAnswer.eventId,
    });
    expect(runtime.runtimeProfiles.current(project.projectId, sessionId)).toMatchObject({ profile: "direct_coding" });
    expect(await runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PreToolUse", session_id: sessionId, cwd: projectDirectory,
      tool_name: "Edit", tool_use_id: "readme-typo", tool_input: { file_path: "README.md" },
    }))).toMatchObject({ recorded: true, violation: false, blocked: false });
    expect(runtime.database.get<{ count: number }>(
      "SELECT count(*) AS count FROM task_trees WHERE project_id = ?", project.projectId,
    )).toEqual({ count: treeCount });
    expect(affiliation.resolvedTreeId).toBe(patched.treeId);
    runtime.close();
  });
});
