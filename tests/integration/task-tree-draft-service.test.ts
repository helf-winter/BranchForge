import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskAffiliationService } from "../../src/application/task-affiliation-service.js";
import { TaskTreeDraftService } from "../../src/application/task-tree-draft-service.js";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import { TaskTreeValidationService } from "../../src/application/task-tree-validation-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const decision = {
  discussionTopic: "Canvas architecture",
  currentUnderstanding: "The branch owns canvas rendering",
  consideredOptions: ["Canvas", "DOM grid"],
  agentRecommendation: "Canvas",
  userDecision: "Use Canvas",
};

function completeDocument(suffix = ""): TaskTreeDocument {
  return {
    planningVersion: 1,
    planningContext: {
      goal: `Build editor${suffix}`,
      scopeBoundaries: ["browser"],
      exclusions: ["server"],
      unresolvedQuestions: [],
      unresolvedDecisions: [],
      plannedEffects: [],
    },
    nodes: [
      { id: "root", parentId: null, title: `Editor${suffix}`, children: ["canvas", "storage"] },
      {
        id: "canvas", parentId: "root", title: `Canvas${suffix}`, children: [], objectives: ["Draw beads"],
        expectedOutputs: ["canvas.ts"], acceptanceCriteria: ["draw test passes"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "canvas-test", description: "Canvas test" }],
        executionPhase: "implementation", stopDecompositionReason: "One independently verifiable feature",
      },
      {
        id: "storage", parentId: "root", title: "Storage", children: [], objectives: ["Persist work"],
        expectedOutputs: ["storage.ts"], acceptanceCriteria: ["storage test passes"], unresolvedQuestions: [],
        unresolvedDecisions: [], dependencies: [], requiredEvidence: [{ key: "storage-test", description: "Storage test" }],
        executionPhase: "implementation", stopDecompositionReason: "One independently verifiable feature",
      },
    ],
    relations: [],
    artifacts: [],
    skeletonCriteria: [
      {
        id: "canvas-skeleton", branchNodeId: "canvas", expectedArtifacts: ["canvas.ts"],
        requiredContracts: ["canvas-api"], verificationCommands: ["npm test"], readinessConditions: ["module imports"],
      },
      {
        id: "storage-skeleton", branchNodeId: "storage", expectedArtifacts: ["storage.ts"],
        requiredContracts: ["storage-api"], verificationCommands: ["npm test"], readinessConditions: ["module imports"],
      },
    ],
  };
}

function incompleteDocument(): TaskTreeDocument {
  return {
    planningVersion: 1,
    nodes: [{ id: "root", parentId: null, title: "Unresolved editor", children: [] }],
    relations: [],
    artifacts: [],
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-task-tree-authoring-"));
  dirs.push(directory);
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p1', '/a', 'now', 'now')");
  database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES ('p2', '/b', 'now', 'now')");
  const affiliations = new TaskAffiliationService(database);
  const trees = new TaskTreeService(database);
  return {
    database,
    affiliations,
    trees,
    drafts: new TaskTreeDraftService(database, trees),
    validation: new TaskTreeValidationService(database, trees),
  };
}

function answer(database: RuntimeDatabase, projectId: string, id: string, sessionId = "session-1", treeId: string | null = null) {
  database.run(`
    INSERT INTO trace_events (
      id, project_id, tree_id, session_id, event_name, payload_json, execution_context_json, occurred_at, idempotency_key
    ) VALUES (?, ?, ?, ?, 'UserPromptSubmit', '{}', '{}', '9999-01-01', ?)
  `, id, projectId, treeId, sessionId, id);
}

async function resolvedNewTree(f: Awaited<ReturnType<typeof fixture>>) {
  const proposal = f.affiliations.propose({ projectId: "p1", requestTitle: "Build editor", recommendation: "new_tree" });
  answer(f.database, "p1", "new-tree-answer");
  const resolved = await f.affiliations.resolve({
    projectId: "p1", decisionId: proposal.decisionId, choice: "new_tree", answerTraceEventId: "new-tree-answer",
  });
  return { proposal, resolved };
}

describe("TaskTreeDraftService", () => {
  it("requires a resolved same-Project affiliation and exact merge revision", async () => {
    const f = await fixture();
    const pending = f.affiliations.propose({ projectId: "p1", requestTitle: "Pending", recommendation: "new_tree" });
    expect(() => f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: pending.decisionId,
      document: completeDocument(), idempotencyKey: "pending",
    })).toThrow(expect.objectContaining({ code: "confirmation_required" }));

    const existing = await f.trees.createTaskRoot({ projectId: "p2", title: "Existing" });
    const merge = f.affiliations.propose({
      projectId: "p2", requestTitle: "Extend Existing", candidateQuery: "Existing",
      recommendation: "merge", recommendedTreeId: existing.treeId,
    });
    answer(f.database, "p2", "merge-answer", "session-2");
    await f.affiliations.resolve({
      projectId: "p2", decisionId: merge.decisionId, choice: "merge", chosenTreeId: existing.treeId,
      answerTraceEventId: "merge-answer",
    });
    expect(() => f.drafts.createDraft({
      projectId: "p2", sessionId: "session-2", affiliationDecisionId: merge.decisionId,
      document: completeDocument(), idempotencyKey: "merge-missing-base",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    f.database.close();
  });

  it("creates one immutable revision from a blank new-tree root and enforces idempotency", async () => {
    const f = await fixture();
    const { proposal } = await resolvedNewTree(f);
    const first = f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      document: completeDocument(), idempotencyKey: "create-1",
    });
    const repeated = f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      document: completeDocument(), idempotencyKey: "create-1",
    });
    expect(first).toMatchObject({ revision: 2, document: { planningVersion: 1 } });
    expect(repeated).toEqual(first);
    expect(f.database.all("SELECT id FROM task_tree_revisions WHERE tree_id = ?", first.treeId)).toHaveLength(2);
    expect(f.database.all("SELECT id FROM task_tree_authoring_commands")).toHaveLength(1);
    expect(() => f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      expectedTreeRevisionId: first.revisionId, document: completeDocument(" changed"), idempotencyKey: "create-1",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(() => f.database.run("UPDATE task_tree_authoring_commands SET input_hash = 'changed' WHERE idempotency_key = 'create-1'"))
      .toThrow();
    f.database.close();
  });

  it("accepts a structurally valid incomplete draft while exact validation reports blockers", async () => {
    const f = await fixture();
    const { proposal } = await resolvedNewTree(f);
    const draft = f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      document: incompleteDocument(), idempotencyKey: "incomplete",
    });
    const readiness = f.validation.validate({ projectId: "p1", treeId: draft.treeId, treeRevisionId: draft.revisionId });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockingIssues.length).toBeGreaterThan(0);
    expect(() => f.validation.validate({ projectId: "p1", treeId: draft.treeId, treeRevisionId: "stale" }))
      .toThrow(expect.objectContaining({ code: "revision_conflict" }));
    f.database.close();
  });

  it("applies one evidence-linked local patch and rejects a stale concurrent base atomically", async () => {
    const f = await fixture();
    const { proposal } = await resolvedNewTree(f);
    const base = f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      document: completeDocument(), idempotencyKey: "base",
    });
    answer(f.database, "p1", "patch-answer", "session-1", base.treeId);
    const local = completeDocument();
    local.nodes = local.nodes.map((node) => node.id === "canvas" ? { ...node, title: "Canvas renderer" } : node);
    const patched = f.drafts.patch({
      projectId: "p1", sessionId: "session-1", treeId: base.treeId,
      expectedTreeRevisionId: base.revisionId, idempotencyKey: "patch-1",
      operations: [{
        op: "replace_document", document: local, sourceUserMessageTraceEventId: "patch-answer", decision,
      }],
    });
    expect(patched.revision).toBe(3);
    answer(f.database, "p1", "patch-answer-2", "session-2", base.treeId);
    expect(() => f.drafts.patch({
      projectId: "p1", sessionId: "session-2", treeId: base.treeId,
      expectedTreeRevisionId: base.revisionId, idempotencyKey: "stale-patch",
      operations: [{
        op: "replace_document", document: completeDocument(" other"),
        sourceUserMessageTraceEventId: "patch-answer-2", decision,
      }],
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(f.database.all("SELECT id FROM task_tree_authoring_commands WHERE idempotency_key = 'stale-patch'")).toEqual([]);
    f.database.close();
  });

  it("requires the existing impact preview contract for cross-branch patches", async () => {
    const f = await fixture();
    const { proposal } = await resolvedNewTree(f);
    const base = f.drafts.createDraft({
      projectId: "p1", sessionId: "session-1", affiliationDecisionId: proposal.decisionId,
      document: completeDocument(), idempotencyKey: "cross-base",
    });
    answer(f.database, "p1", "cross-answer", "session-1", base.treeId);
    const cross = completeDocument();
    cross.nodes = cross.nodes.map((node) => node.id === "canvas" || node.id === "storage"
      ? { ...node, title: `${node.title} revised` }
      : node);
    expect(() => f.drafts.patch({
      projectId: "p1", sessionId: "session-1", treeId: base.treeId,
      expectedTreeRevisionId: base.revisionId, idempotencyKey: "cross-no-preview",
      operations: [{ op: "replace_document", document: cross, sourceUserMessageTraceEventId: "cross-answer", decision }],
    })).toThrow(expect.objectContaining({ code: "confirmation_required" }));
    const preview = f.trees.previewDraftChangeSet({
      projectId: "p1", treeId: base.treeId, baseRevisionId: base.revisionId, proposedDocument: cross,
    });
    const result = f.drafts.patch({
      projectId: "p1", sessionId: "session-1", treeId: base.treeId,
      expectedTreeRevisionId: base.revisionId, idempotencyKey: "cross-preview",
      operations: [{
        op: "replace_document", document: cross, sourceUserMessageTraceEventId: "cross-answer",
        decision, previewId: preview.previewId,
      }],
    });
    expect(result.revision).toBe(3);
    f.database.close();
  });
});
