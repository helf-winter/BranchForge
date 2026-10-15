import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRuntime } from "../../src/application/runtime.js";
import { mapClaudeHook } from "../../src/bindings/claude/hook-mapper.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";

export function iterationDocument(branches = ["base"], containers = false): TaskTreeDocument {
  const document: TaskTreeDocument = {
    planningVersion: 1,
    planningContext: { goal: "Counter", scopeBoundaries: ["browser"], exclusions: ["cloud"], unresolvedQuestions: [], unresolvedDecisions: [], plannedEffects: [] },
    nodes: [{ id: "root", parentId: null, title: "Counter", children: branches, executionPhase: "verification", requiredEvidence: [{ key: "root", description: "Verify current branches" }] }],
    relations: [], artifacts: [], artifactLinks: [], skeletonCriteria: [], artifactContracts: [],
  };
  for (const branch of branches) {
    document.nodes.push({ id: branch, parentId: "root", title: branch, children: [`${branch}-skeleton`, `${branch}-impl`], executionPhase: "verification", requiredEvidence: [{ key: `${branch}-verify`, description: "branch test" }] });
    for (const phase of ["skeleton", "implementation"] as const) {
      const id = `${branch}-${phase === "skeleton" ? "skeleton" : "impl"}`;
      document.nodes.push({ id, parentId: branch, title: id, children: [], executionPhase: phase, objectives: ["Verify module"], expectedOutputs: [`${branch}.js`], acceptanceCriteria: ["npm test passes"], dependencies: phase === "implementation" ? [`${branch}-skeleton`] : [], unresolvedQuestions: [], unresolvedDecisions: [], requiredEvidence: [{ key: `${id}-test`, description: "module test" }], stopDecompositionReason: "one module" });
      document.artifactLinks!.push({ taskNodeId: id, artifactId: `${branch}-file`, relationType: phase === "skeleton" ? "creates" : "reads" });
    }
    document.artifacts.push({ id: `${branch}-file`, kind: "file", locator: `${branch}.js` });
    document.artifacts.push({ id: `${branch}-api`, kind: "contract", locator: `contract:${branch}` });
    document.artifactContracts!.push({ id: `${branch}-contract`, artifactId: `${branch}-api`, name: `${branch} API`, version: "1", schemaOrSignature: "value:number", compatibilityPolicy: "exact", providerNodeIds: [`${branch}-skeleton`], consumerNodeIds: [`${branch}-impl`], validationRefs: [`${branch}-skeleton-test`] });
    document.skeletonCriteria!.push({ id: `${branch}-ready`, branchNodeId: branch, expectedArtifacts: [`${branch}.js`], requiredContracts: [`${branch}-contract`], verificationCommands: ["npm test"], readinessConditions: ["module is available"] });
    if (containers) {
      const container = document.nodes.find(node => node.id === branch)!;
      delete container.executionPhase; delete container.requiredEvidence;
      container.children.push(`${branch}-verify`);
      document.nodes.push({ ...structuredClone(document.nodes.find(node => node.id === `${branch}-impl`)!), id: `${branch}-verify`, title: "Branch verification", executionPhase: "verification", dependencies: [`${branch}-impl`], requiredEvidence: [{ key: `${branch}-verify`, description: "branch integration" }] });
    }
  }
  return document;
}

export async function completedTreeFixture(options: { repairRoot?: boolean; containers?: boolean; document?: TaskTreeDocument; beforeRoot?: (fixture: IterationFixture) => Promise<void> } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-iteration-"));
  const projectDir = path.join(directory, "project"); await mkdir(projectDir);
  const environment = { ...process.env, AGENT_HARNESS_DATA_HOME: path.join(directory, "data"), HARNESS_JEV_ENABLED: "false", HARNESS_JEV_ROUTING_ENABLED: "false" };
  const runtime = openRuntime(environment);
  const project = await runtime.projects.resolve(projectDir, "persist");
  const fixture = { directory, projectDir, environment, runtime, projectId: project.projectId, treeId: "", revisionId: "", sessionId: "iteration-session", sequence: 0,
    async close() { fixture.runtime.close(); await rm(directory, { recursive: true, force: true }); } };
  const decision = await affiliation(fixture, "new_tree");
  const draft = runtime.taskTreeDrafts.createDraft({ projectId: project.projectId, sessionId: fixture.sessionId, affiliationDecisionId: decision.decisionId, document: options.document ?? iterationDocument(["base"], options.containers), idempotencyKey: "initial-draft" });
  fixture.treeId = draft.treeId; fixture.revisionId = draft.revisionId;
  await approveIteration(fixture);
  const report = await executeToReport(fixture, "first-report", options.repairRoot || options.beforeRoot ? { beforeRoot: async () => {
    if (options.beforeRoot) await options.beforeRoot(fixture);
    if (!options.repairRoot) return;
    // Controlled legacy defect in a temp fixture, before this root has any
    // Attempt: its raw identifier is owned by a separate archived tree.
    runtime.database.run("INSERT INTO task_trees (id, project_id, title, status, current_revision_id, created_at, updated_at) VALUES ('archived-owner', ?, 'Old project', 'archived', 'owner-revision', '2026', '2026')", project.projectId);
    runtime.database.run("INSERT INTO task_tree_revisions (id, tree_id, revision, document_json, created_at) VALUES ('owner-revision', 'archived-owner', 1, '{}', '2026')");
    runtime.database.run("UPDATE task_nodes SET tree_id = 'archived-owner' WHERE id = 'root'");
    runtime.nodeIdentities.apply({ projectId: project.projectId, treeId: fixture.treeId, expectedTreeRevisionId: fixture.revisionId });
  } } : {});
  return Object.assign(fixture, { report });
}
export type IterationFixture = { runtime: ReturnType<typeof openRuntime>; projectId: string; projectDir: string; treeId: string; revisionId: string; sessionId: string; sequence: number };
export async function affiliation(f: IterationFixture, choice: "new_tree" | "merge") {
  const proposal = f.runtime.affiliations.propose({ projectId: f.projectId, requestTitle: choice === "merge" ? "Add snapshots" : "Counter", recommendation: choice, ...(choice === "merge" ? { recommendedTreeId: f.treeId, candidateQuery: f.treeId } : {}) });
  const answer = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "AskUserQuestion", tool_use_id: `affiliation-${++f.sequence}`, tool_input: {}, tool_response: { answers: { scope: choice === "merge" ? "归并到当前任务树" : "新建任务树" } } }));
  if (!answer.recorded) throw new Error("Affiliation proof missing");
  await f.runtime.affiliations.resolve({ projectId: f.projectId, decisionId: proposal.decisionId, choice, ...(choice === "merge" ? { chosenTreeId: f.treeId } : {}), answerTraceEventId: answer.eventId });
  return proposal;
}
export async function approveIteration(f: IterationFixture) {
  const readiness = f.runtime.taskTreeValidation.validate({ projectId: f.projectId, treeId: f.treeId, treeRevisionId: f.revisionId });
  if (!readiness.ready) throw new Error(`Not ready: ${JSON.stringify(readiness)}`);
  // Native confirmation after planning is proof, not a second affiliation request.
  await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: f.sessionId, cwd: f.projectDir, prompt: "确认，按规划执行" }));
  const approval = f.runtime.taskTreeApprovals.prepare({ projectId: f.projectId, sessionId: f.sessionId, treeId: f.treeId, treeRevisionId: f.revisionId, readinessResultId: readiness.resultId });
  const toolId = `approve-${++f.sequence}`;
  await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PreToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "ExitPlanMode", tool_use_id: toolId, tool_input: { plan: approval.canonicalBlock } }));
  await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "ExitPlanMode", tool_use_id: toolId, tool_input: {}, tool_response: { approved: true } }));
  return approval;
}
export async function executeToReport(f: IterationFixture, key: string, options: { beforeRoot?: () => Promise<void>; beforeFinalize?: () => Promise<void>; onNode?: (nodeId: string) => Promise<void> } = {}) {
  let beforeRoot = options.beforeRoot; let beforeFinalize = options.beforeFinalize;
  for (let step = 0; step < 50; step++) {
    const workflow = f.runtime.database.get<{ stage: string; revision: number }>("SELECT stage, revision FROM workflow_states WHERE tree_id = ? AND active = 1", f.treeId);
    if (!workflow) throw new Error("No active workflow");
    if (workflow.stage === "root_verification" && beforeRoot) { await beforeRoot(); beforeRoot = undefined; }
    if (workflow.stage === "final_report") {
      if (beforeFinalize) { await beforeFinalize(); beforeFinalize = undefined; }
      try { return f.runtime.finalReports.finalize({ projectId: f.projectId, treeId: f.treeId, workflowRevision: workflow.revision, idempotencyKey: key }); }
      catch (error) { if (f.runtime.database.get<{ stage: string }>("SELECT stage FROM workflow_states WHERE tree_id = ? AND active = 1", f.treeId)?.stage === "final_report") throw error; continue; }
    }
    const next = f.runtime.scheduler.next({ projectId: f.projectId, treeId: f.treeId });
    if (next) {
      const source = f.runtime.database.get<{ id: string }>("SELECT id FROM trace_events WHERE project_id = ? AND session_id = ? AND event_name = 'UserPromptSubmit' ORDER BY rowid DESC LIMIT 1", f.projectId, f.sessionId)!;
      const attempt = f.runtime.executions.startAttempt({ projectId: f.projectId, nodeId: next.nodeId, expectedTreeRevisionId: f.revisionId, sourceTraceEventId: source.id });
      if (next.phase === "skeleton" && next.executionPurpose !== "revalidation") {
        const filename = `${next.nodeId.replace(/-skeleton$/, "")}.js`;
        await writeFile(path.join(f.projectDir, filename), "export const value = 1;\n");
        await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Write", tool_use_id: `write-${++f.sequence}`, tool_input: { file_path: filename }, tool_response: { ok: true } }));
      }
      if (options.onNode) await options.onNode(next.nodeId);
      if (f.runtime.database.get<{ status: string }>("SELECT status FROM execution_attempts WHERE id = ?", attempt.attemptId)?.status === "aborted") continue;
      f.runtime.executions.beginVerification({ projectId: f.projectId, attemptId: attempt.attemptId, expectedStatus: "running" });
      const evidence = await f.runtime.hooks.ingest(mapClaudeHook({ hook_event_name: "PostToolUse", session_id: f.sessionId, cwd: f.projectDir, tool_name: "Bash", tool_use_id: `test-${++f.sequence}`, tool_input: { command: "npm test" }, tool_response: { exitCode: 0 } }));
      if (!evidence.recorded) throw new Error("Verification proof missing");
      for (const required of next.requiredEvidence) f.runtime.executions.attachEvidence({ projectId: f.projectId, attemptId: attempt.attemptId, requiredEvidenceKey: required.key, traceEventId: evidence.eventId });
      const evaluated = f.runtime.evaluations.evaluateAttempt({ projectId: f.projectId, attemptId: attempt.attemptId, proposedVerdict: "succeeded", riskSummary: null });
      if (!evaluated.transition.applied) throw new Error(`Proof rejected: ${JSON.stringify(evaluated)}`);
    } else {
      const result = workflow.stage === "skeleton_pass" ? f.runtime.skeletonGates.evaluate({ projectId: f.projectId, treeId: f.treeId, workflowRevision: workflow.revision }) : f.runtime.workflowPhases.evaluate({ projectId: f.projectId, treeId: f.treeId, workflowRevision: workflow.revision });
      if (result.status !== "passed" && result.workflow.stage === workflow.stage) throw new Error(`Gate rejected: ${JSON.stringify(result)}`);
    }
  }
  throw new Error("Fixture exceeded deterministic execution bound");
}
