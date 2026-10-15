import { HarnessError } from "../domain/errors.js";
import { openRuntime } from "../application/runtime.js";
import { mapClaudeHook } from "../bindings/claude/hook-mapper.js";
import { present } from "./presenter.js";
import { resolveJevRequestRoutingConfiguration } from "../domain/request-routing.js";
import { backupRuntimeDatabase } from "../storage/backup.js";
import path from "node:path";
import { RuntimeDatabase } from "../storage/database.js";
import { ProjectIdentityService, resolveDataHome } from "../application/project-identity-service.js";
import { NodeIdentityRepairService } from "../application/node-identity-repair-service.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["--json", "--include-archived", "--apply"].includes(args[index]!)) continue;
    if ([
      "--cwd", "--limit", "--cursor", "--status",
      "--map-limit", "--map-cursor", "--evidence-limit", "--evidence-cursor",
      "--expected-revision", "--backup",
    ].includes(args[index]!)) { index += 1; continue; }
    result.push(args[index]!);
  }
  return result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const json = args.includes("--json");
  const cwd = option(args, "--cwd") ?? process.cwd();
  const words = positional(args);

  if (words[0] === "doctor") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
    const routing = resolveJevRequestRoutingConfiguration(process.env);
    const result = {
      node: { ok: supported, version: process.versions.node, minimum: "22.13.0" },
      sqlite: { ok: true, implementation: "node:sqlite" },
      requestRouting: {
        enabled: routing.enabled,
        readiness: routing.readiness,
        apiKeyConfigured: Boolean(routing.apiKey),
        model: routing.model,
      },
    };
    process.stdout.write(`${present(result, json)}\n`);
    return 0;
  }

  if (words[0] === "tree" && words[1] === "repair-identities" && !args.includes("--apply")) {
    let database: RuntimeDatabase | undefined;
    try {
      if (!words[2]) throw new HarnessError("invalid_input", "tree ID is required for identity recovery");
      database = new RuntimeDatabase(path.join(resolveDataHome(process.env), "runtime.db"), { readOnly: true });
      const project = await new ProjectIdentityService(database).resolve(cwd, "inspect");
      if (project.status !== "same_project") throw new HarnessError("project_identity_conflict", "read-only identity preview requires the registered project path");
      const result = new NodeIdentityRepairService(database).preview({ projectId: project.projectId, treeId: words[2] });
      process.stdout.write(`${present(result, json)}\n`);
      return 0;
    } catch (error) { return presentCliError(error); }
    finally { database?.close(); }
  }

  const runtime = openRuntime();
  try {
    let result: unknown;
    if (words[0] === "project" && words[1] === "inspect") {
      result = await runtime.projects.resolve(cwd, "inspect");
    } else if (words[0] === "project" && words[1] === "clones") {
      const project = await requireProject(runtime, cwd);
      const direction = words[2];
      if (direction && !["incoming", "outgoing", "all"].includes(direction)) {
        throw new HarnessError("invalid_input", "clone direction must be incoming, outgoing, or all");
      }
      const status = option(args, "--status");
      if (status && !["pending", "cloning", "completed", "incomplete", "failed", "recovered"].includes(status)) {
        throw new HarnessError("invalid_input", "invalid clone status");
      }
      const cursor = option(args, "--cursor");
      result = runtime.queries.getProjectClones(project.projectId, {
        ...(direction ? { direction: direction as "incoming" | "outgoing" | "all" } : {}),
        ...(status ? { status: status as "pending" | "cloning" | "completed" | "incomplete" | "failed" | "recovered" } : {}),
        limit: Number(option(args, "--limit") ?? 50), ...(cursor ? { cursor } : {}),
      });
    } else if (words[0] === "project" && words[1] === "clone-detail") {
      const project = await requireProject(runtime, cwd);
      const cloneId = words[2];
      if (!cloneId) throw new HarnessError("invalid_input", "clone ID is required");
      const mapCursor = option(args, "--map-cursor");
      const evidenceCursor = option(args, "--evidence-cursor");
      result = runtime.queries.getProjectCloneDetail(project.projectId, cloneId, {
        mapLimit: Number(option(args, "--map-limit") ?? 100), ...(mapCursor ? { mapCursor } : {}),
        evidenceLimit: Number(option(args, "--evidence-limit") ?? 50), ...(evidenceCursor ? { evidenceCursor } : {}),
      });
    } else if (words[0] === "taskroot") {
      const title = words.slice(1).join(" ").trim();
      const project = await runtime.projects.resolve(cwd, "persist");
      if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this path");
      result = await runtime.taskTrees.createTaskRoot({ projectId: project.projectId, title });
    } else if (words[0] === "tree" && words[1] === "candidates") {
      const project = await requireProject(runtime, cwd);
      const query = words.slice(2).join(" ");
      result = runtime.taskTrees.listTaskTreeCandidates({
        projectId: project.projectId, ...(query ? { query } : {}),
        ...(args.includes("--include-archived") ? { includeArchived: true } : {}),
      });
    } else if (words[0] === "tree" && words[1] === "repair-identities") {
      const project = await requireProject(runtime, cwd);
      const treeId = words[2];
      if (!treeId) throw new HarnessError("invalid_input", "tree ID is required for identity recovery");
      if (!args.includes("--apply")) result = runtime.nodeIdentities.preview({ projectId: project.projectId, treeId });
      else {
        const expectedTreeRevisionId = option(args, "--expected-revision");
        const target = option(args, "--backup");
        if (!expectedTreeRevisionId || !target) throw new HarnessError("invalid_input", "explicit identity recovery requires --expected-revision and --backup");
        const preview = runtime.nodeIdentities.preview({ projectId: project.projectId, treeId });
        if (preview.treeRevisionId !== expectedTreeRevisionId) throw new HarnessError("revision_conflict", "identity recovery preview is stale");
        if (!preview.canApply) throw new HarnessError("runtime_action_rejected", "identity recovery is not safe", preview);
        const backupPath = backupRuntimeDatabase(runtime.database.filename, target);
        result = { ...runtime.nodeIdentities.apply({ projectId: project.projectId, treeId, expectedTreeRevisionId }), backupPath };
      }
    } else if (words[0] === "tree" && words[1] === "select") {
      const project = await requireProject(runtime, cwd);
      result = runtime.taskTrees.selectTaskTree({ projectId: project.projectId, treeId: words[2] ?? "" });
    } else if (words[0] === "tree" && words[1] === "archive") {
      const project = await requireProject(runtime, cwd);
      result = runtime.taskTrees.archiveTaskTree({ projectId: project.projectId, treeId: words[2] ?? "" });
    } else if (words[0] === "tree" && words[1] === "restore") {
      const project = await requireProject(runtime, cwd);
      result = runtime.taskTrees.restoreTaskTree({ projectId: project.projectId, treeId: words[2] ?? "" });
    } else if (words[0] === "tree" && words[1] === "snapshot") {
      const project = await requireProject(runtime, cwd);
      result = runtime.queries.getRuntimeSnapshot(project.projectId);
    } else if (words[0] === "tree" && words[1] === "summary") {
      const project = await requireProject(runtime, cwd);
      result = runtime.queries.getTaskTreeSummary(project.projectId, words[2] ?? "");
    } else if (words[0] === "tree" && words[1] === "readiness") {
      const project = await requireProject(runtime, cwd);
      result = runtime.taskTrees.scanPlanReadiness({ projectId: project.projectId, treeId: words[2] ?? "" });
    } else if (words[0] === "trace" && words[1] === "list") {
      const project = await requireProject(runtime, cwd);
      const cursor = option(args, "--cursor");
      result = runtime.queries.getTraceEvents(project.projectId, { limit: Number(option(args, "--limit") ?? 50), ...(cursor ? { cursor } : {}) });
    } else if (words[0] === "node" && words[1] === "attempt-start") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.startAttempt({ projectId: project.projectId, nodeId: words[2] ?? "", expectedTreeRevisionId: words[3] ?? "" });
    } else if (words[0] === "node" && words[1] === "verify") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.beginVerification({ projectId: project.projectId, attemptId: words[2] ?? "", expectedStatus: "running" });
    } else if (words[0] === "node" && words[1] === "evidence") {
      const project = await requireProject(runtime, cwd);
      result = runtime.executions.attachEvidence({ projectId: project.projectId, attemptId: words[2] ?? "", requiredEvidenceKey: words[3] ?? "", traceEventId: words[4] ?? "" });
    } else if (words[0] === "node" && words[1] === "evaluate") {
      const project = await requireProject(runtime, cwd);
      const proposedVerdict = words[3];
      if (!proposedVerdict || !["succeeded", "failed", "blocked", "uncertain"].includes(proposedVerdict)) throw new HarnessError("invalid_input", "evaluation verdict is required");
      result = runtime.evaluations.evaluateAttempt({
        projectId: project.projectId,
        attemptId: words[2] ?? "",
        proposedVerdict: proposedVerdict as "succeeded" | "failed" | "blocked" | "uncertain",
        riskSummary: words.slice(4).join(" ") || null,
      });
    } else if (words[0] === "hook") {
      result = await runtime.hooks.ingest(mapClaudeHook(JSON.parse(await readStdin()) as unknown));
    } else if (words[0] === "mcp") {
      runtime.close();
      const { startMcpServer } = await import("../bindings/claude/mcp-server.js");
      await startMcpServer();
      return 0;
    } else {
      throw new HarnessError("invalid_input", "unknown command");
    }
    process.stdout.write(`${present(result, json)}\n`);
    return 0;
  } catch (error) {
    return presentCliError(error);
  } finally {
    try { runtime.close(); } catch { /* MCP owns its runtime after dispatch. */ }
  }
}

function presentCliError(error: unknown): number {
  const harnessError = error instanceof HarnessError ? error : new HarnessError("storage_failure", error instanceof Error ? error.message : String(error));
  process.stderr.write(`${present({ error: { code: harnessError.code, message: harnessError.message, details: harnessError.details ?? null } }, true)}\n`);
  return 1;
}

async function requireProject(runtime: ReturnType<typeof openRuntime>, cwd: string) {
  let project = await runtime.projects.resolve(cwd, "inspect");
  if (project.status === "new_project") throw new HarnessError("project_not_registered", "current directory has no Harness project");
  if (project.status === "identity_conflict") throw new HarnessError("project_identity_conflict", "project marker conflicts with this path");
  if (project.status === "copy_detected" || project.status === "moved_or_renamed") {
    project = await runtime.projects.resolve(cwd, "persist");
  }
  return project;
}
