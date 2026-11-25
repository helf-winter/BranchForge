import path from "node:path";
import { RuntimeDatabase } from "../../agent-storage/database.js";
import { HookIngestionService } from "../../agent-tracking/application/hook-ingestion-service.js";
import { EvaluationService } from "../../agent-verification/application/evaluation-service.js";
import { NodeExecutionService } from "../../agent-execution/application/node-execution-service.js";
import { PlanDriftService } from "../../agent-change/application/plan-drift-service.js";
import { ProjectIdentityService, resolveDataHome } from "../../agent-project/application/project-identity-service.js";
import { RuntimeQueryService } from "./runtime-query-service.js";
import { RuntimeActionService } from "../../agent-change/application/runtime-action-service.js";
import { TaskTreeService } from "../../agent-planning/application/task-tree-service.js";
import { WorkflowService } from "../../agent-workflow/application/workflow-service.js";
import { FailureCaseService } from "../../agent-evolution/application/failure-case-service.js";
import { EvolutionService } from "../../agent-evolution/application/evolution-service.js";
import { ReplacementService } from "../../agent-change/application/replacement-service.js";
import { PluginCompositionService } from "../../agent-plugin/application/plugin-composition-service.js";
import { TaskAffiliationService } from "../../agent-planning/application/task-affiliation-service.js";
import { resolveJevConfiguration } from "../../agent-verification/domain/semantic-evaluation.js";
import { JevEvaluationProvider } from "../../agent-jev/jev-evaluation-provider.js";
import { SemanticEvaluationService } from "../../agent-verification/application/semantic-evaluation-service.js";
import { SkeletonGateService } from "../../agent-verification/application/skeleton-gate-service.js";
import { WorkflowPhaseService } from "../../agent-workflow/application/workflow-phase-service.js";
import { FinalReportService } from "../../agent-workflow/application/final-report-service.js";
import { VerificationFreshnessService } from "../../agent-verification/application/verification-freshness-service.js";
import { resolveJevRequestRoutingConfiguration } from "../../agent-routing/domain/request-routing.js";
import { JevRequestRouter } from "../../agent-jev/jev-request-router.js";
import { RequestRoutingService } from "../../agent-routing/application/request-routing-service.js";
import { RuntimeProfileService } from "../../agent-routing/application/runtime-profile-service.js";
import { TaskTreeDraftService } from "../../agent-planning/application/task-tree-draft-service.js";
import { TaskTreeValidationService } from "../../agent-planning/application/task-tree-validation-service.js";
import { TaskTreeApprovalService } from "../../agent-planning/application/task-tree-approval-service.js";
import { NativePlanBindingService } from "../../agent-planning/application/native-plan-binding-service.js";
import { ExecutionSchedulerService } from "../../agent-execution/application/execution-scheduler-service.js";
import { NodeIdentityRepairService } from "../../agent-planning/application/node-identity-repair-service.js";
import { TaskTreeIterationService } from "../../agent-planning/application/task-tree-iteration-service.js";

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
    taskTreeIterations: new TaskTreeIterationService(database, taskTrees),
    taskTreeValidation: new TaskTreeValidationService(database, taskTrees),
    taskTreeApprovals,
    nativePlans,
    scheduler,
    nodeIdentities: new NodeIdentityRepairService(database),
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
