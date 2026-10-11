import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const document = {
  planningVersion: 1 as const,
  planningContext: {
    goal: "Build API", scopeBoundaries: ["API only"], exclusions: ["No UI"],
    unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [],
  },
  nodes: [
    { id: "root", parentId: null, title: "Build API", children: ["api"], executionPhase: "verification" as const, requiredEvidence: [{ key: "root-test", description: "root integration passes" }] },
    { id: "api", parentId: "root", title: "API", children: ["api-skeleton", "api-implementation"], executionPhase: "verification" as const, requiredEvidence: [{ key: "branch-test", description: "branch integration passes" }] },
    {
      id: "api-skeleton", parentId: "api", title: "Wire API", children: [], objectives: ["Wire API skeleton"],
      expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["API compiles"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: [], requiredEvidence: [{ key: "contract-check", description: "contract compiles" }],
      executionPhase: "skeleton" as const, stopDecompositionReason: "one verifiable skeleton",
    },
    {
      id: "api-implementation", parentId: "api", title: "Implement API", children: [], objectives: ["Implement API behavior"],
      expectedOutputs: ["src/api.ts"], acceptanceCriteria: ["API tests pass"], unresolvedQuestions: [], unresolvedDecisions: [],
      dependencies: ["api-skeleton"], requiredEvidence: [{ key: "api-test", description: "API tests pass" }],
      executionPhase: "implementation" as const, stopDecompositionReason: "one independently testable branch",
    },
  ],
  relations: [{ fromNodeId: "api-implementation", toNodeId: "api-skeleton", kind: "depends_on" as const }],
  artifacts: [
    { id: "api-file", kind: "file" as const, locator: "src/api.ts" },
    { id: "api-contract-artifact", kind: "contract" as const, locator: "contract:api", granularity: "contract" as const },
  ],
  artifactLinks: [
    { taskNodeId: "api-skeleton", artifactId: "api-file", relationType: "creates" as const },
    { taskNodeId: "api-skeleton", artifactId: "api-contract-artifact", relationType: "implements" as const },
    { taskNodeId: "api-implementation", artifactId: "api-contract-artifact", relationType: "consumes" as const },
  ],
  artifactContracts: [{
    id: "api-contract", artifactId: "api-contract-artifact", name: "API Contract", version: "1",
    compatibilityPolicy: "exact" as const, schemaOrSignature: "GET /api -> 200",
    providerNodeIds: ["api-skeleton"], consumerNodeIds: ["api-implementation"], validationRefs: ["contract-check"],
  }],
  skeletonCriteria: [{
    id: "api-skeleton-ready", branchNodeId: "api", expectedArtifacts: ["src/api.ts"],
    requiredContracts: ["api-contract"], verificationCommands: ["npm run build"], readinessConditions: ["API is wired"],
  }],
};

async function confirmedFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-skeleton-gate-")); dirs.push(directory);
  const projectDir = path.join(directory, "project"); await mkdir(projectDir);
  const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data") };
  const runtime = openRuntime(environment);
  const project = await runtime.projects.resolve(projectDir, "persist");
  const root = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title: "Build API" });
  const revision = runtime.taskTrees.saveDraftRevision({
    projectId: project.projectId, treeId: root.treeId, baseRevisionId: root.revisionId, document,
  });
  const readiness = runtime.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: root.treeId });
  expect(readiness.ready).toBe(true);
  const prompt = runtime.workflows.createConfirmationPrompt({
    projectId: project.projectId, treeId: root.treeId, scopeId: root.treeId,
    readinessResultId: readiness.resultId, prompt: "Execute?", workflowRevision: 3,
  });
  const answer = await runtime.hooks.ingest(mapClaudeHook({
    hook_event_name: "UserPromptSubmit", session_id: "gate-run", cwd: projectDir, prompt: "yes",
  }));
  if (!answer.recorded) throw new Error("answer was not recorded");
  runtime.workflows.confirmScope({
    projectId: project.projectId, confirmationId: prompt.confirmationId, answer: "yes",
    answerTraceEventId: answer.eventId, workflowRevision: 3,
  });
  return { directory, projectDir, environment, runtime, project, root, revision, answerTraceEventId: answer.eventId };
}

describe("SkeletonGateService", () => {
  it.each(["root", "contract", "criterion", "rerun"])("reuses Skeleton facts only when their execution context is unchanged (%s)", async (change) => {
    const f = await confirmedFixture();
    const attempt = f.runtime.executions.startAttempt({ projectId: f.project.projectId, nodeId: "api-skeleton", expectedTreeRevisionId: f.revision.revisionId, sourceTraceEventId: f.answerTraceEventId });
    await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "gate-run", cwd: f.projectDir, tool_name: "Write", tool_use_id: "carry-write", tool_input: { file_path: "src/api.ts" }, tool_response: { ok: true } }));
    const build = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "gate-run", cwd: f.projectDir, tool_name: "Bash", tool_use_id: "carry-build", tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 } }));
    if (!build.recorded) throw new Error("missing build evidence");
    f.runtime.executions.attachEvidence({ projectId: f.project.projectId, attemptId: attempt.attemptId, requiredEvidenceKey: "contract-check", traceEventId: build.eventId });
    f.runtime.executions.beginVerification({ projectId: f.project.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
    f.runtime.evaluations.evaluateAttempt({ projectId: f.project.projectId, attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    const revised = structuredClone(document);
    if (change === "root" || change === "rerun") revised.nodes.find((node) => node.id === "root")!.title = "Locally refined root";
    if (change === "contract") revised.artifactContracts[0]!.schemaOrSignature = "GET /api -> { items: string[] }";
    if (change === "criterion") revised.skeletonCriteria[0]!.verificationCommands = ["npm run build -- --strict"];
    const revision = f.runtime.taskTrees.saveDraftRevision({ projectId: f.project.projectId, treeId: f.root.treeId, baseRevisionId: f.revision.revisionId, document: revised });
    f.runtime.database.run("UPDATE task_node_confirmation_states SET state = 'confirmed' WHERE tree_revision_id = ?", revision.revisionId);
    f.runtime.database.run("UPDATE workflow_states SET stage = 'skeleton_pass' WHERE tree_id = ?", f.root.treeId);
    let expectedAttemptId = attempt.attemptId;
    if (change === "rerun") {
      f.runtime.database.run("UPDATE execution_attempts SET attempt_number = 2 WHERE id = ?", attempt.attemptId);
      f.runtime.database.run("UPDATE task_nodes SET status = 'needs_revalidation' WHERE id = 'api-skeleton'");
      const next = f.runtime.executions.startAttempt({ projectId: f.project.projectId, nodeId: "api-skeleton", expectedTreeRevisionId: revision.revisionId, sourceTraceEventId: f.answerTraceEventId });
      const rerunBuild = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: "gate-run", cwd: f.projectDir, tool_name: "Bash", tool_use_id: "rerun-build", tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 } }));
      if (!rerunBuild.recorded) throw new Error("missing rerun build evidence");
      f.runtime.executions.attachEvidence({ projectId: f.project.projectId, attemptId: next.attemptId, requiredEvidenceKey: "contract-check", traceEventId: rerunBuild.eventId });
      f.runtime.executions.beginVerification({ projectId: f.project.projectId, attemptId: next.attemptId, expectedStatus: "running" });
      f.runtime.evaluations.evaluateAttempt({ projectId: f.project.projectId, attemptId: next.attemptId, proposedVerdict: "succeeded", riskSummary: null });
      expectedAttemptId = next.attemptId;
    }
    const workflow = f.runtime.database.get<{ revision: number }>("SELECT revision FROM workflow_states WHERE tree_id = ?", f.root.treeId)!;
    const gate = f.runtime.skeletonGates.evaluate({ projectId: f.project.projectId, treeId: f.root.treeId, workflowRevision: workflow.revision });
    if (change === "root" || change === "rerun") expect(gate).toMatchObject({ status: "passed", blockers: [], attemptIds: [expectedAttemptId] });
    else {
      expect(gate.status).not.toBe("passed");
      expect(gate.attemptIds).toEqual([]);
      expect(f.runtime.database.get("SELECT status FROM task_nodes WHERE id = 'api-skeleton'")).toEqual({ status: "needs_revalidation" });
      expect(f.runtime.scheduler.next({ projectId: f.project.projectId, treeId: f.root.treeId })).toMatchObject({ nodeId: "api-skeleton" });
    }
    expect(f.runtime.database.get("SELECT tree_revision_id FROM execution_attempts WHERE id = ?", attempt.attemptId)).toEqual({ tree_revision_id: f.revision.revisionId });
    f.runtime.close();
  });
  it("persists blockers, remains executable, then advances only after every planned fact exists", async () => {
    const fixture = await confirmedFixture();
    const first = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(first).toMatchObject({
      status: "failed", workflow: { stage: "skeleton_pass", revision: 4 },
      blockers: expect.arrayContaining([
        { code: "skeleton_attempt_incomplete", ref: "api" },
        { code: "expected_artifact_missing", ref: "src/api.ts" },
      ]),
    });

    const attempt = fixture.runtime.executions.startAttempt({
      projectId: fixture.project.projectId, nodeId: "api-skeleton", expectedTreeRevisionId: fixture.revision.revisionId,
      sourceTraceEventId: fixture.answerTraceEventId,
    });
    const write = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Write", tool_use_id: "write-api",
      tool_input: { file_path: "src/api.ts", content: "export const api = true" }, tool_response: { ok: true },
    }));
    const build = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Bash", tool_use_id: "build-api",
      tool_input: { command: "npm run build" }, tool_response: { exitCode: 0 },
    }));
    if (!write.recorded || !build.recorded) throw new Error("Skeleton traces were not recorded");
    fixture.runtime.executions.attachEvidence({
      projectId: fixture.project.projectId, attemptId: attempt.attemptId,
      requiredEvidenceKey: "contract-check", traceEventId: build.eventId,
    });
    fixture.runtime.executions.beginVerification({ projectId: fixture.project.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
    fixture.runtime.evaluations.evaluateAttempt({
      projectId: fixture.project.projectId, attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null,
    });
    const passed = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(passed).toMatchObject({
      status: "passed", blockers: [], workflow: { stage: "branch_implementation", revision: 5 },
      attemptIds: [attempt.attemptId], evidenceTraceIds: expect.arrayContaining([write.eventId, build.eventId]),
    });
    expect(fixture.runtime.queries.getRuntimeSnapshot(fixture.project.projectId)).toMatchObject({
      workflow: { stage: "branch_implementation", revision: 5, activeBranchNodeId: "api" },
      latestSkeletonGate: { resultId: passed.resultId, status: "passed", blockerCount: 0 },
      workflowBranches: [{ branchNodeId: "api", order: 0, status: "active" }],
    });
    expect(() => fixture.runtime.workflows.transition({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 5, to: "branch_verification",
    })).toThrow(expect.objectContaining({ code: "workflow_transition_rejected" }));

    const incompleteImplementation = fixture.runtime.workflowPhases.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 5,
    });
    expect(incompleteImplementation).toMatchObject({ status: "failed", incompleteNodeIds: ["api-implementation"], nextStage: "branch_implementation" });
    const implementation = fixture.runtime.executions.startAttempt({
      projectId: fixture.project.projectId, nodeId: "api-implementation", expectedTreeRevisionId: fixture.revision.revisionId,
      sourceTraceEventId: fixture.answerTraceEventId,
    });
    const implementationTrace = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Bash", tool_use_id: "api-test",
      tool_input: { command: "npm test -- api" }, tool_response: { exitCode: 0 },
    }));
    if (!implementationTrace.recorded) throw new Error("implementation trace was not recorded");
    fixture.runtime.executions.attachEvidence({ projectId: fixture.project.projectId, attemptId: implementation.attemptId, requiredEvidenceKey: "api-test", traceEventId: implementationTrace.eventId });
    fixture.runtime.executions.beginVerification({ projectId: fixture.project.projectId, attemptId: implementation.attemptId, expectedStatus: "running" });
    fixture.runtime.evaluations.evaluateAttempt({ projectId: fixture.project.projectId, attemptId: implementation.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(fixture.runtime.workflowPhases.evaluate({ projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 5 }))
      .toMatchObject({ status: "passed", nextStage: "branch_verification", nextBranchNodeId: "api", workflow: { revision: 6 } });

    const branchAttempt = fixture.runtime.executions.startAttempt({ projectId: fixture.project.projectId, nodeId: "api", expectedTreeRevisionId: fixture.revision.revisionId, sourceTraceEventId: fixture.answerTraceEventId });
    const branchTrace = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Bash", tool_use_id: "branch-test",
      tool_input: { command: "npm test -- branch" }, tool_response: { exitCode: 0 },
    }));
    if (!branchTrace.recorded) throw new Error("branch trace was not recorded");
    fixture.runtime.executions.attachEvidence({ projectId: fixture.project.projectId, attemptId: branchAttempt.attemptId, requiredEvidenceKey: "branch-test", traceEventId: branchTrace.eventId });
    fixture.runtime.executions.beginVerification({ projectId: fixture.project.projectId, attemptId: branchAttempt.attemptId, expectedStatus: "running" });
    fixture.runtime.evaluations.evaluateAttempt({ projectId: fixture.project.projectId, attemptId: branchAttempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(fixture.runtime.workflowPhases.evaluate({ projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 6 }))
      .toMatchObject({ status: "passed", nextStage: "root_verification", nextBranchNodeId: null, workflow: { revision: 7 } });

    const rootAttempt = fixture.runtime.executions.startAttempt({ projectId: fixture.project.projectId, nodeId: "root", expectedTreeRevisionId: fixture.revision.revisionId, sourceTraceEventId: fixture.answerTraceEventId });
    const rootTrace = await fixture.runtime.hooks.ingest(mapClaudeHook({
      hook_event_name: "PostToolUse", session_id: "gate-run", cwd: fixture.projectDir, tool_name: "Bash", tool_use_id: "root-test",
      tool_input: { command: "npm test -- integration" }, tool_response: { exitCode: 0 },
    }));
    if (!rootTrace.recorded) throw new Error("root trace was not recorded");
    fixture.runtime.executions.attachEvidence({ projectId: fixture.project.projectId, attemptId: rootAttempt.attemptId, requiredEvidenceKey: "root-test", traceEventId: rootTrace.eventId });
    fixture.runtime.executions.beginVerification({ projectId: fixture.project.projectId, attemptId: rootAttempt.attemptId, expectedStatus: "running" });
    fixture.runtime.evaluations.evaluateAttempt({ projectId: fixture.project.projectId, attemptId: rootAttempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
    expect(fixture.runtime.workflowPhases.evaluate({ projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 7 }))
      .toMatchObject({ status: "passed", nextStage: "final_report", workflow: { revision: 8 } });
    fixture.runtime.close();

    const reopened = openRuntime(fixture.environment);
    expect(reopened.skeletonGates.list(fixture.project.projectId, { treeId: fixture.root.treeId }))
      .toEqual([expect.objectContaining({ resultId: passed.resultId, status: "passed" }), expect.objectContaining({ resultId: first.resultId, status: "failed" })]);
    expect(reopened.workflowPhases.list(fixture.project.projectId, { treeId: fixture.root.treeId }))
      .toHaveLength(4);
    reopened.close();
  });

  it("blocks unresolved drift and isolates result history by Project", async () => {
    const fixture = await confirmedFixture();
    fixture.runtime.drifts.recordDrift({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, nodeId: "api-skeleton",
      driftType: "relation_changed", severity: "blocking", description: "Contract wiring drifted",
      explanation: "Observed wiring differs from the confirmed plan", recommendation: "Resolve the contract before implementation",
    });
    const result = fixture.runtime.skeletonGates.evaluate({
      projectId: fixture.project.projectId, treeId: fixture.root.treeId, workflowRevision: 4,
    });
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "blocking_drift" })]));
    const otherDir = path.join(fixture.directory, "other"); await mkdir(otherDir);
    const other = await fixture.runtime.projects.resolve(otherDir, "persist");
    expect(fixture.runtime.skeletonGates.list(other.projectId)).toEqual([]);
    fixture.runtime.close();
  });
});

