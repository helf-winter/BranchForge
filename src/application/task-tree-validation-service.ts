import { HarnessError } from "../domain/errors.js";
import type { RuntimeDatabase } from "../storage/database.js";
import { TaskTreeService } from "./task-tree-service.js";

export type PlanReadinessView = ReturnType<TaskTreeService["scanPlanReadiness"]>;

export class TaskTreeValidationService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly trees = new TaskTreeService(database),
  ) {}

  validate(input: {
    projectId: string;
    treeId: string;
    treeRevisionId: string;
  }): PlanReadinessView {
    const current = this.database.get<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM task_trees WHERE id = ? AND project_id = ?",
      input.treeId, input.projectId,
    );
    if (!current || current.current_revision_id !== input.treeRevisionId) {
      throw new HarnessError("revision_conflict", "Task Tree validation requires the exact current revision");
    }
    return this.trees.scanPlanReadiness({ projectId: input.projectId, treeId: input.treeId });
  }
}
