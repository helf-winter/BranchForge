import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskTreeService } from "../../src/application/task-tree-service.js";
import type { TaskTreeDocument } from "../../src/domain/task-tree.js";
import { remapTaskTreeNodeIds } from "../../src/domain/task-node-identity.js";
import { RuntimeDatabase } from "../../src/storage/database.js";

const fixtures: Array<{ directory: string; database: RuntimeDatabase }> = [];
const document: TaskTreeDocument = {
  nodes: [
    { id: "root", parentId: null, title: "First root", children: ["leaf"] },
    {
      id: "leaf", parentId: "root", title: "First leaf", children: [], objectives: ["Persist a result"],
      expectedOutputs: ["result.txt"], acceptanceCriteria: ["Result exists"], dependencies: [],
      requiredEvidence: [{ key: "result-test", description: "Result test" }], executionPhase: "implementation",
      stopDecompositionReason: "One observable result",
    },
  ],
  relations: [], artifacts: [],
};

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-node-identity-"));
  const database = new RuntimeDatabase(path.join(directory, "runtime.db"));
  fixtures.push({ directory, database });
  for (const id of ["p1", "p2"]) {
    database.run("INSERT INTO projects (id, canonical_path, created_at, updated_at) VALUES (?, ?, 'now', 'now')", id, `/${id}`);
  }
  return { database, service: new TaskTreeService(database) };
}

afterEach(async () => {
  for (const { database, directory } of fixtures.splice(0)) {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Task Tree node identity", () => {
  it("maps references once and restricts planned effect remapping to actual node identities", () => {
    const original: TaskTreeDocument = {
      ...document,
      planningContext: {
        goal: "Map once", scopeBoundaries: [], exclusions: [], unresolvedQuestions: [], unresolvedDecisions: [],
        plannedEffects: [
          { id: "node", riskLevel: "low", targetRef: "leaf", summary: "leaf", mitigation: null },
          { id: "external", riskLevel: "low", targetRef: "external", summary: "external", mitigation: null },
        ],
      },
    };
    const before = structuredClone(original);
    const mapped = remapTaskTreeNodeIds(original, new Map([["root", "leaf"], ["leaf", "new-leaf"], ["external", "should-not-change"]]));
    expect(mapped.nodes.map((node) => ({ id: node.id, parentId: node.parentId, children: node.children }))).toEqual([
      { id: "leaf", parentId: null, children: ["new-leaf"] },
      { id: "new-leaf", parentId: "leaf", children: [] },
    ]);
    expect(mapped.planningContext!.plannedEffects.map((effect) => effect.targetRef)).toEqual(["new-leaf", "external"]);
    expect(original).toEqual(before);
  });

  it("remaps all node references while preserving artifact IDs and literal effect targets", async () => {
    const { database, service } = await fixture();
    const first = await service.createTaskRoot({ projectId: "p1", title: "First" });
    service.saveDraftRevision({ projectId: "p1", treeId: first.treeId, baseRevisionId: first.revisionId, document });
    const second = await service.createTaskRoot({ projectId: "p2", title: "Second" });
    const rich: TaskTreeDocument = {
      ...document, planningVersion: 1,
      nodes: document.nodes.map((node) => node.id === "leaf" ? { ...node, dependencies: ["root"] } : node),
      relations: [{ fromNodeId: "leaf", toNodeId: "root", kind: "depends_on" }],
      artifacts: [{ id: "root", kind: "contract", locator: "contract:identity" }],
      artifactLinks: [{ taskNodeId: "leaf", artifactId: "root", relationType: "implements" }],
      artifactContracts: [{ id: "contract", artifactId: "root", name: "Identity", version: "1", compatibilityPolicy: "exact", schemaOrSignature: "run(): void", providerNodeIds: ["leaf"], consumerNodeIds: ["root"], validationRefs: ["leaf"] }],
      skeletonCriteria: [{ id: "criterion", branchNodeId: "root", expectedArtifacts: ["root"], requiredContracts: ["contract"], verificationCommands: ["test"], readinessConditions: ["ready"] }],
      planningContext: {
        goal: "Identity", scopeBoundaries: [], exclusions: [], unresolvedQuestions: [], unresolvedDecisions: [],
        plannedEffects: [
          { id: "exact", riskLevel: "low", targetRef: "leaf", summary: "leaf", mitigation: null },
          { id: "literal", riskLevel: "low", targetRef: "path/leaf", summary: "leaf", mitigation: null },
        ],
      },
    };
    const original = structuredClone(rich);
    const saved = service.saveDraftRevision({ projectId: "p2", treeId: second.treeId, baseRevisionId: second.revisionId, document: rich });
    const rootId = `node:${second.treeId}:root`;
    const leafId = `node:${second.treeId}:leaf`;
    expect(saved.document.nodes).toEqual([{ ...rich.nodes[0], id: rootId, children: [leafId] }, { ...rich.nodes[1], id: leafId, parentId: rootId, dependencies: [rootId] }]);
    expect(saved.document.relations).toEqual([{ fromNodeId: leafId, toNodeId: rootId, kind: "depends_on" }]);
    expect(saved.document.artifactLinks).toEqual([{ taskNodeId: leafId, artifactId: "root", relationType: "implements" }]);
    expect(saved.document.artifactContracts).toEqual([{ ...rich.artifactContracts![0], providerNodeIds: [leafId], consumerNodeIds: [rootId] }]);
    expect(saved.document.skeletonCriteria).toEqual([{ ...rich.skeletonCriteria![0], branchNodeId: rootId }]);
    expect(saved.document.planningContext!.plannedEffects.map((effect) => effect.targetRef)).toEqual([leafId, "path/leaf"]);
    expect(saved.document.artifacts).toEqual(rich.artifacts);
    expect(rich).toEqual(original);
    expect(database.get("SELECT from_node_id, to_node_id FROM task_relation_edges WHERE tree_revision_id = ?", saved.revisionId)).toEqual({ from_node_id: leafId, to_node_id: rootId });
    expect(database.get("SELECT task_node_id FROM task_node_artifact_links WHERE tree_revision_id = ?", saved.revisionId)).toEqual({ task_node_id: leafId });
    expect(database.get("SELECT branch_task_node_id FROM skeleton_acceptance_criteria WHERE tree_revision_id = ?", saved.revisionId)).toEqual({ branch_task_node_id: rootId });
  });

  it("compares logical aliases before preview and applies canonical node references", async () => {
    const { database, service } = await fixture();
    const first = await service.createTaskRoot({ projectId: "p1", title: "First" });
    service.saveDraftRevision({ projectId: "p1", treeId: first.treeId, baseRevisionId: first.revisionId, document });
    const second = await service.createTaskRoot({ projectId: "p2", title: "Second" });
    const saved = service.saveDraftRevision({ projectId: "p2", treeId: second.treeId, baseRevisionId: second.revisionId, document });
    const proposed = { ...document, nodes: document.nodes.map((node) => node.id === "leaf" ? { ...node, title: "Refined leaf" } : node) };
    const preview = service.previewDraftChangeSet({ projectId: "p2", treeId: second.treeId, baseRevisionId: saved.revisionId, proposedDocument: proposed });
    expect(preview.affectedNodeIds).toEqual([`node:${second.treeId}:leaf`]);
    expect(preview.applyMode).toBe("direct_draft_apply");
    database.run("INSERT INTO trace_events (id, project_id, tree_id, session_id, event_name, payload_json, occurred_at, idempotency_key) VALUES ('identity-prompt', 'p2', ?, 'session', 'UserPromptSubmit', '{}', '2099-01-01T00:00:00.000Z', 'identity-prompt')", second.treeId);
    const applied = service.applyRefinementChangeSet({
      projectId: "p2", treeId: second.treeId, baseRevisionId: saved.revisionId,
      operations: [{ op: "replace_document", document: proposed }], previewId: preview.previewId, sourceUserMessageTraceEventId: "identity-prompt",
      decision: { discussionTopic: "Leaf", currentUnderstanding: "Leaf scope", consideredOptions: ["Refine"], agentRecommendation: "Refine", userDecision: "Refine" },
    });
    expect(applied.document.nodes.map((node) => node.id)).toEqual(saved.document.nodes.map((node) => node.id));
    expect(database.get<{ operations_json: string; affected_node_ids_json: string }>("SELECT operations_json, affected_node_ids_json FROM draft_change_sets WHERE result_revision_id = ?", applied.revisionId)).toMatchObject({
      operations_json: expect.stringContaining(`node:${second.treeId}:leaf`), affected_node_ids_json: JSON.stringify([`node:${second.treeId}:leaf`]),
    });
  });

  it("rejects an occupied deterministic target without writing a revision or changing either tree", async () => {
    const { database, service } = await fixture();
    const first = await service.createTaskRoot({ projectId: "p1", title: "First" });
    service.saveDraftRevision({ projectId: "p1", treeId: first.treeId, baseRevisionId: first.revisionId, document });
    const second = await service.createTaskRoot({ projectId: "p2", title: "Second" });
    database.run("INSERT INTO task_nodes (id, tree_id, parent_id, title, status) VALUES (?, ?, NULL, 'Occupied', 'succeeded')", `node:${second.treeId}:root`, first.treeId);
    const before = database.all("SELECT * FROM task_nodes ORDER BY id");
    expect(() => service.saveDraftRevision({ projectId: "p2", treeId: second.treeId, baseRevisionId: second.revisionId, document })).toThrow(expect.objectContaining({ code: "storage_failure" }));
    expect(database.all("SELECT * FROM task_nodes ORDER BY id")).toEqual(before);
    expect(service.getRevision("p2", second.treeId).revisionId).toBe(second.revisionId);
    expect(database.all("SELECT id FROM task_tree_revisions WHERE tree_id = ?", second.treeId)).toHaveLength(1);
  });

  it.each(["p1", "p2"])("preserves the first owner when a second tree in %s reuses node IDs", async (secondProjectId) => {
    const { database, service } = await fixture();
    const first = await service.createTaskRoot({ projectId: "p1", title: "First" });
    const savedFirst = service.saveDraftRevision({ projectId: "p1", treeId: first.treeId, baseRevisionId: first.revisionId, document });
    database.run("UPDATE task_nodes SET status = 'succeeded' WHERE tree_id = ?", first.treeId);
    service.archiveTaskTree({ projectId: "p1", treeId: first.treeId });
    const firstNodes = database.all("SELECT * FROM task_nodes WHERE tree_id = ? ORDER BY id", first.treeId);
    const firstTree = database.get("SELECT * FROM task_trees WHERE id = ?", first.treeId);
    const firstRevisions = database.all("SELECT * FROM task_tree_revisions WHERE tree_id = ? ORDER BY revision", first.treeId);

    const second = await service.createTaskRoot({ projectId: secondProjectId, title: "Second" });
    const proposed = { ...document, nodes: document.nodes.map((node) => ({ ...node, title: `Second ${node.id}` })) };
    const savedSecond = service.saveDraftRevision({ projectId: secondProjectId, treeId: second.treeId, baseRevisionId: second.revisionId, document: proposed });
    expect(database.all("SELECT * FROM task_nodes WHERE tree_id = ? ORDER BY id", first.treeId)).toEqual(firstNodes);
    expect(database.get("SELECT * FROM task_trees WHERE id = ?", first.treeId)).toEqual(firstTree);
    expect(database.all("SELECT * FROM task_tree_revisions WHERE tree_id = ? ORDER BY revision", first.treeId)).toEqual(firstRevisions);
    expect(service.getRevision("p1", first.treeId).document).toEqual(savedFirst.document);
    expect(savedSecond.document.nodes.map((node) => node.id)).toEqual([`node:${second.treeId}:root`, `node:${second.treeId}:leaf`]);
    for (const node of savedSecond.document.nodes) {
      expect(database.get("SELECT tree_id, parent_id, title FROM task_nodes WHERE id = ?", node.id)).toEqual({ tree_id: second.treeId, parent_id: node.parentId, title: node.title });
    }

    database.run("UPDATE task_nodes SET status = 'succeeded' WHERE tree_id = ?", second.treeId);
    database.run("UPDATE task_node_confirmation_states SET state = 'confirmed' WHERE tree_revision_id = ?", savedSecond.revisionId);
    const repeated = service.saveDraftRevision({ projectId: secondProjectId, treeId: second.treeId, baseRevisionId: savedSecond.revisionId, document: proposed });
    expect(repeated.document).toEqual(savedSecond.document);
    expect(database.all("SELECT task_node_id, state FROM task_node_confirmation_states WHERE tree_revision_id = ? ORDER BY task_node_id", repeated.revisionId)).toEqual([
      { task_node_id: `node:${second.treeId}:leaf`, state: "confirmed" },
      { task_node_id: `node:${second.treeId}:root`, state: "confirmed" },
    ]);
    expect(database.all("SELECT status FROM task_nodes WHERE id IN (?, ?)", `node:${second.treeId}:root`, `node:${second.treeId}:leaf`)).toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
  });
});
