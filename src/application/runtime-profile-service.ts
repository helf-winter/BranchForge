import { newId, nowIso } from "../domain/ids.js";
import {
  resolveRuntimeProfile,
  type JevRequestRoutingConfiguration,
  type RouteDisposition,
  type RuntimeProfile,
} from "../domain/request-routing.js";
import type { TaskAffiliationChoice } from "../domain/task-affiliation.js";
import type { RuntimeDatabase } from "../storage/database.js";
import type { ProjectIdentityService } from "./project-identity-service.js";
import type { RequestRouteDecisionView, RequestRoutingService } from "./request-routing-service.js";

interface ProfileStateRow {
  project_id: string;
  session_id: string;
  profile: RuntimeProfile;
  source_route_decision_id: string | null;
  source_affiliation_decision_id: string | null;
  reason_code: string;
  updated_at: string;
}

interface ActiveTreeRow {
  tree_id: string;
  title: string;
  status: string;
  current_node_title: string | null;
  stage: string;
}

export type RuntimeProfileNextAction =
  | "respond_normally"
  | "execute_directly"
  | "establish_task_tree"
  | "continue_task_tree"
  | "await_user_direction";

export interface RuntimeProfileDecisionView {
  projectId: string | null;
  sessionId: string;
  profile: RuntimeProfile;
  disposition: RouteDisposition;
  reasonCode: string;
  routeDecisionId: string | null;
  affiliationDecisionId: string | null;
  nextAction: RuntimeProfileNextAction;
  additionalContext: string | null;
  updatedAt: string;
}

const structuredContext = [
  "Harness runtime profile: structured_coding.",
  "Establish and obtain native approval for a first-class Task Tree revision before project mutation.",
].join("\n");

function nextAction(profile: RuntimeProfile, hasActiveWorkflow: boolean): RuntimeProfileNextAction {
  if (profile === "conversation") return "respond_normally";
  if (profile === "direct_coding") return "execute_directly";
  return hasActiveWorkflow ? "continue_task_tree" : "establish_task_tree";
}

export class RuntimeProfileService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly projects: ProjectIdentityService,
    private readonly routes: RequestRoutingService,
    private readonly config: Pick<JevRequestRoutingConfiguration, "acceptedConfidence" | "advisoryConfidence">,
  ) {}

  async resolveForPrompt(input: {
    cwd: string;
    sessionId: string;
    prompt: string;
    promptTraceEventId?: string;
  }): Promise<RuntimeProfileDecisionView> {
    const inspected = await this.projects.resolve(input.cwd, "inspect");
    const projectId = inspected.status === "same_project" ? inspected.projectId : null;
    const activeTree = projectId ? this.activeTree(projectId) : undefined;
    const route = await this.routes.route({
      projectId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      ...(input.promptTraceEventId ? { promptTraceEventId: input.promptTraceEventId } : {}),
      ...(activeTree ? {
        activeTree: {
          treeId: activeTree.tree_id,
          title: activeTree.title,
          currentNodeTitle: activeTree.current_node_title,
        },
      } : {}),
      hasActiveWorkflow: Boolean(activeTree),
    });
    const prior = projectId ? this.current(projectId, input.sessionId) : null;
    const resolved = resolveRuntimeProfile({
      route: {
        classification: route.classification,
        treeRelation: route.treeRelation,
        confidence: route.confidence,
        probabilities: route.probabilities,
        reasonCodes: route.reasonCodes,
        provider: route.provider,
        model: route.modelResolved ?? route.modelRequested,
        fallbackReason: route.fallbackReason,
      },
      config: this.config,
      ...(prior ? { previousProfile: prior.profile } : {}),
      activeApprovedWorkflow: Boolean(activeTree),
    });

    const shouldPersistProject = resolved.disposition === "accepted" && resolved.profile !== "conversation";
    if (!projectId && !shouldPersistProject) {
      return this.view({
        projectId: null,
        sessionId: input.sessionId,
        profile: resolved.profile,
        disposition: resolved.disposition,
        reasonCode: resolved.reasonCode,
        routeDecisionId: null,
        affiliationDecisionId: null,
        hasActiveWorkflow: false,
        updatedAt: route.createdAt,
      });
    }

    const persistedProjectId = projectId ?? (await this.projects.resolve(input.cwd, "persist")).projectId;
    const persistedRoute = route.persisted
      ? route
      : this.routes.persistTransient({
        projectId: persistedProjectId,
        decision: route,
        ...(input.promptTraceEventId ? { promptTraceEventId: input.promptTraceEventId } : {}),
      });
    return this.persist({
      projectId: persistedProjectId,
      sessionId: input.sessionId,
      profile: resolved.profile,
      disposition: resolved.disposition,
      reasonCode: resolved.reasonCode,
      routeDecisionId: persistedRoute.id,
      affiliationDecisionId: null,
      hasActiveWorkflow: Boolean(activeTree),
    });
  }

  applyAffiliationChoice(input: {
    projectId: string;
    sessionId: string;
    affiliationDecisionId: string;
    choice: TaskAffiliationChoice;
  }): RuntimeProfileDecisionView {
    if (input.choice === "pause") {
      const current = this.current(input.projectId, input.sessionId);
      return {
        ...(current ?? this.view({
          projectId: input.projectId,
          sessionId: input.sessionId,
          profile: "conversation",
          disposition: "explicit_override",
          reasonCode: "affiliation:pause",
          routeDecisionId: null,
          affiliationDecisionId: input.affiliationDecisionId,
          hasActiveWorkflow: false,
          updatedAt: nowIso(),
        })),
        disposition: "explicit_override",
        reasonCode: "affiliation:pause",
        affiliationDecisionId: input.affiliationDecisionId,
        nextAction: "await_user_direction",
        additionalContext: null,
      };
    }
    const profile: RuntimeProfile = input.choice === "direct_execution" ? "direct_coding" : "structured_coding";
    return this.persist({
      projectId: input.projectId,
      sessionId: input.sessionId,
      profile,
      disposition: "explicit_override",
      reasonCode: `affiliation:${input.choice}`,
      routeDecisionId: null,
      affiliationDecisionId: input.affiliationDecisionId,
      hasActiveWorkflow: input.choice !== "direct_execution",
    });
  }

  current(projectId: string, sessionId: string): RuntimeProfileDecisionView | null {
    const row = this.database.get<ProfileStateRow>(`
      SELECT * FROM runtime_profile_states WHERE project_id = ? AND session_id = ?
    `, projectId, sessionId);
    if (!row) return null;
    const activeTree = this.activeTree(projectId);
    return this.view({
      projectId,
      sessionId,
      profile: row.profile,
      disposition: "accepted",
      reasonCode: row.reason_code,
      routeDecisionId: row.source_route_decision_id,
      affiliationDecisionId: row.source_affiliation_decision_id,
      hasActiveWorkflow: Boolean(activeTree),
      updatedAt: row.updated_at,
    });
  }

  private persist(input: {
    projectId: string;
    sessionId: string;
    profile: RuntimeProfile;
    disposition: RouteDisposition;
    reasonCode: string;
    routeDecisionId: string | null;
    affiliationDecisionId: string | null;
    hasActiveWorkflow: boolean;
  }): RuntimeProfileDecisionView {
    const current = this.database.get<ProfileStateRow>(`
      SELECT * FROM runtime_profile_states WHERE project_id = ? AND session_id = ?
    `, input.projectId, input.sessionId);
    if (current?.profile === input.profile
      && current.source_route_decision_id === input.routeDecisionId
      && current.source_affiliation_decision_id === input.affiliationDecisionId
      && current.reason_code === input.reasonCode) {
      return this.view({ ...input, updatedAt: current.updated_at });
    }

    const updatedAt = nowIso();
    this.database.run(`
      INSERT INTO runtime_profile_transitions (
        id, project_id, session_id, prior_profile, next_profile, source_route_decision_id,
        source_affiliation_decision_id, reason_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, newId(), input.projectId, input.sessionId, current?.profile ?? null, input.profile,
    input.routeDecisionId, input.affiliationDecisionId, input.reasonCode, updatedAt);
    this.database.run(`
      INSERT INTO runtime_profile_states (
        project_id, session_id, profile, source_route_decision_id,
        source_affiliation_decision_id, reason_code, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, session_id) DO UPDATE SET
        profile = excluded.profile,
        source_route_decision_id = excluded.source_route_decision_id,
        source_affiliation_decision_id = excluded.source_affiliation_decision_id,
        reason_code = excluded.reason_code,
        updated_at = excluded.updated_at
    `, input.projectId, input.sessionId, input.profile, input.routeDecisionId,
    input.affiliationDecisionId, input.reasonCode, updatedAt);
    return this.view({ ...input, updatedAt });
  }

  private activeTree(projectId: string): ActiveTreeRow | undefined {
    return this.database.get<ActiveTreeRow>(`
      SELECT w.tree_id, t.title, t.status, n.title AS current_node_title, w.stage
      FROM workflow_states w
      JOIN task_trees t ON t.id = w.tree_id
      LEFT JOIN runtime_states r ON r.project_id = w.project_id
      LEFT JOIN task_nodes n ON n.id = r.selected_node_id
      WHERE w.project_id = ? AND w.active = 1 AND t.status <> 'archived'
      ORDER BY w.updated_at DESC, w.id DESC LIMIT 1
    `, projectId);
  }

  private view(input: {
    projectId: string | null;
    sessionId: string;
    profile: RuntimeProfile;
    disposition: RouteDisposition;
    reasonCode: string;
    routeDecisionId: string | null;
    affiliationDecisionId: string | null;
    hasActiveWorkflow: boolean;
    updatedAt: string;
  }): RuntimeProfileDecisionView {
    return {
      projectId: input.projectId,
      sessionId: input.sessionId,
      profile: input.profile,
      disposition: input.disposition,
      reasonCode: input.reasonCode,
      routeDecisionId: input.routeDecisionId,
      affiliationDecisionId: input.affiliationDecisionId,
      nextAction: nextAction(input.profile, input.hasActiveWorkflow),
      additionalContext: input.profile === "structured_coding" ? structuredContext : null,
      updatedAt: input.updatedAt,
    };
  }
}
