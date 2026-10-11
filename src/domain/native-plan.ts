import { createHash } from "node:crypto";
import { HarnessError } from "./errors.js";
import type { TaskTreeDocument } from "./task-tree.js";

interface CanonicalTreeView {
  treeId: string;
  revisionId: string;
  revision: number;
  title: string;
  document: TaskTreeDocument;
}

interface CanonicalReadinessView {
  resultId: string;
  ready: boolean;
  scopeKind: "tree" | "branch";
  coveredNodeIds: string[];
}

const START_PREFIX = "agent-harness-task-tree:start";
const END_MARKER = "<!-- agent-harness-task-tree:end -->";
const APPROVAL_REF = /^[A-Za-z0-9_-]+$/;

function oneLine(value: string): string {
  return value.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;").replace(/\s+/g, " ").trim();
}

function summary(label: string, values: string[] | undefined): string | null {
  return values?.length ? `  - ${label}: ${values.map(oneLine).join("; ")}` : null;
}

export function normalizeNativePlanText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function renderCanonicalTaskTreeBlock(input: {
  approvalRef: string;
  tree: CanonicalTreeView;
  readiness: CanonicalReadinessView;
}): string {
  if (!APPROVAL_REF.test(input.approvalRef)) {
    throw new HarnessError("invalid_input", "approval reference contains unsupported characters");
  }
  if (!input.readiness.ready || input.readiness.scopeKind !== "tree") {
    throw new HarnessError("workflow_transition_rejected", "canonical Task Tree approval requires ready whole-tree validation");
  }
  const { document } = input.tree;
  const lines = [
    `<!-- ${START_PREFIX} approval_ref="${input.approvalRef}" -->`,
    "## Task Tree",
    "",
    `- Tree: ${oneLine(input.tree.title)}`,
    `- Revision: ${input.tree.revision} (${input.tree.revisionId})`,
    `- Readiness: ready (${input.readiness.resultId})`,
  ];
  if (document.planningContext) {
    lines.push(`- Goal: ${oneLine(document.planningContext.goal)}`);
    lines.push(`- Scope: ${document.planningContext.scopeBoundaries.map(oneLine).join("; ")}`);
    lines.push(`- Exclusions: ${document.planningContext.exclusions.map(oneLine).join("; ")}`);
    if (document.planningContext.unresolvedQuestions.length) {
      lines.push(`- Unresolved questions: ${document.planningContext.unresolvedQuestions.map(oneLine).join("; ")}`);
    }
    if (document.planningContext.unresolvedDecisions.length) {
      lines.push(`- Unresolved decisions: ${document.planningContext.unresolvedDecisions.map(oneLine).join("; ")}`);
    }
  }
  lines.push("", "### Nodes");
  for (const node of document.nodes) {
    lines.push(`- [${node.executionPhase ?? "container"}] ${oneLine(node.id)}: ${oneLine(node.title)}`);
    for (const item of [
      summary("Objective", node.objectives),
      summary("Outputs", node.expectedOutputs),
      summary("Acceptance", node.acceptanceCriteria),
      summary("Unresolved questions", node.unresolvedQuestions),
      summary("Unresolved decisions", node.unresolvedDecisions),
      summary("Dependencies", node.dependencies),
    ]) if (item) lines.push(item);
    if (node.stopDecompositionReason) lines.push(`  - Stop reason: ${oneLine(node.stopDecompositionReason)}`);
  }
  lines.push("", "### Artifacts");
  if (!document.artifacts.length) lines.push("- None");
  for (const artifact of document.artifacts) {
    lines.push(`- ${oneLine(artifact.id)} [${artifact.kind}/${artifact.status ?? "draft"}]: ${oneLine(artifact.locator)}`);
  }
  lines.push("", "### Relations");
  if (!document.relations.length) lines.push("- None");
  for (const relation of document.relations) {
    const qualifiers = [relation.artifactId, relation.dependencyKind, relation.coordinationKind, relation.description]
      .filter((value): value is string => Boolean(value)).map(oneLine);
    lines.push(`- ${oneLine(relation.fromNodeId)} -${relation.kind}-> ${oneLine(relation.toNodeId)}${qualifiers.length ? ` (${qualifiers.join("; ")})` : ""}`);
  }
  lines.push("", "### Skeleton acceptance");
  if (!document.skeletonCriteria?.length) lines.push("- None");
  for (const criterion of document.skeletonCriteria ?? []) {
    lines.push(`- Skeleton acceptance ${oneLine(criterion.id)} for ${oneLine(criterion.branchNodeId)}`);
    lines.push(`  - Expected artifacts: ${criterion.expectedArtifacts.map(oneLine).join("; ")}`);
    lines.push(`  - Required contracts: ${criterion.requiredContracts.map(oneLine).join("; ")}`);
    lines.push(`  - Verification: ${criterion.verificationCommands.map(oneLine).join("; ")}`);
    lines.push(`  - Ready when: ${criterion.readinessConditions.map(oneLine).join("; ")}`);
  }
  lines.push(END_MARKER);
  return lines.join("\n");
}

export function extractCanonicalTaskTreeBlock(markdown: string): { approvalRef: string; block: string } {
  const normalized = normalizeNativePlanText(markdown);
  const lines = normalized.split("\n");
  const markerIndexes = lines.flatMap((line, index) =>
    line.includes("agent-harness-task-tree:") ? [index] : []);
  if (markerIndexes.length !== 2) {
    throw new HarnessError("invalid_input", "native Plan must contain exactly one canonical Task Tree block");
  }
  const startIndex = markerIndexes[0]!;
  const endIndex = markerIndexes[1]!;
  const startMatch = lines[startIndex]!.match(/^<!-- agent-harness-task-tree:start approval_ref="([A-Za-z0-9_-]+)" -->$/);
  if (!startMatch || lines[endIndex] !== END_MARKER || startIndex >= endIndex) {
    throw new HarnessError("invalid_input", "native Plan contains malformed canonical Task Tree markers");
  }
  return { approvalRef: startMatch[1]!, block: lines.slice(startIndex, endIndex + 1).join("\n") };
}

export function hashNativePlanBlock(block: string): string {
  return createHash("sha256").update(normalizeNativePlanText(block)).digest("hex");
}
