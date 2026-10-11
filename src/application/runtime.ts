import path from "node:path";
import { RuntimeDatabase } from "../storage/database.js";
import { HookIngestionService } from "./hook-ingestion-service.js";
import { EvaluationService } from "./evaluation-service.js";
import { NodeExecutionService } from "./node-execution-service.js";
import { PlanDriftService } from "./plan-drift-service.js";
import { ProjectIdentityService, resolveDataHome } from "./project-identity-service.js";
import { RuntimeQueryService } from "./runtime-query-service.js";
import { RuntimeActionService } from "./runtime-action-service.js";
import { TaskTreeService } from "./task-tree-service.js";
import { WorkflowService } from "./workflow-service.js";
import { FailureCaseService } from "./failure-case-service.js";
import { EvolutionService } from "./evolution-service.js";
import { ReplacementService } from "./replacement-service.js";
import { PluginCompositionService } from "./plugin-composition-service.js";
import { TaskAffiliationService } from "./task-affiliation-service.js";
import { resolveJevConfiguration } from "../domain/semantic-evaluation.js";
import { JevEvaluationProvider } from "../bindings/typesafe/jev-evaluation-provider.js";
import { SemanticEvaluationService } from "./semantic-evaluation-service.js";
import { SkeletonGateService } from "./skeleton-gate-service.js";
import { WorkflowPhaseService } from "./workflow-phase-service.js";
import { FinalReportService } from "./final-report-service.js";
import { VerificationFreshnessService } from "./verification-freshness-service.js";
import { resolveJevRequestRoutingConfiguration } from "../domain/request-routing.js";
import { JevRequestRouter } from "../bindings/typesafe/jev-request-router.js";
import { RequestRoutingService } from "./request-routing-service.js";
import { RuntimeProfileService } from "./runtime-profile-service.js";
import { TaskTreeDraftService } from "./task-tree-draft-service.js";
import { TaskTreeValidationService } from "./task-tree-validation-service.js";
import { TaskTreeApprovalService } from "./task-tree-approval-service.js";
import { NativePlanBindingService } from "./native-plan-binding-service.js";
import { ExecutionSchedulerService } from "./execution-scheduler-service.js";

export function openRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const database = new RuntimeDatabase(path.join(resolveDataHome(environment), "runtime.db"));
  const projects = new ProjectIdentityService(database);
  const drifts = new PlanDriftService(database);
  const failures = new FailureCaseService(database);
  const evolution = new EvolutionService(database);
  const replacements = new ReplacementService(database);
  const plugins = new PluginCompositionService(database);
  const jevConfiguration = resolveJevConfiguration(environment);
  const requestRoutingConfiguration = resolveJevRequestRoutingConfiguration(environment);
  const requestRouting = new RequestRoutingService(
    database,
    requestRoutingConfiguration,
    new JevRequestRouter(requestRoutingConfiguration),
  );
  const runtimeProfiles = new RuntimeProfileService(
    database,
    projects,
    requestRouting,
    requestRoutingConfiguration,
  );
  const affiliations = new TaskAffiliationService(database, runtimeProfiles);
  const taskTrees = new TaskTreeService(database);
  const workflows = new WorkflowService(database);
  const taskTreeApprovals = new TaskTreeApprovalService(database, taskTrees);
  const nativePlans = new NativePlanBindingService(database, workflows);
  const semanticEvaluations = new SemanticEvaluationService(
    database,
    jevConfiguration,
    new JevEvaluationProvider(jevConfiguration),
  );
  const freshness = new VerificationFreshnessService(database);
  const scheduler = new ExecutionSchedulerService(database);
  return {
    database,
    projects,
    taskTrees,
    taskTreeDrafts: new TaskTreeDraftService(database, taskTrees),
    taskTreeValidation: new TaskTreeValidationService(database, taskTrees),
    taskTreeApprovals,
    nativePlans,
    scheduler,
    affiliations,
    workflows,
    executions: new NodeExecutionService(database),
    evaluations: new EvaluationService(database, failures, evolution, { semanticEvaluationRequired: jevConfiguration.enabled }),
    semanticEvaluations,
    requestRouting,
    runtimeProfiles,
    skeletonGates: new SkeletonGateService(database),
    workflowPhases: new WorkflowPhaseService(database),
    finalReports: new FinalReportService(database),
    freshness,
    failures,
    evolution,
    replacements,
    plugins,
    drifts,
    actions: new RuntimeActionService(database, drifts),
    queries: new RuntimeQueryService(database, { semanticEvaluation: semanticEvaluations.configuration() }),
    hooks: new HookIngestionService(database, projects, drifts, freshness, runtimeProfiles, nativePlans),
    close: () => database.close(),
  };
}
