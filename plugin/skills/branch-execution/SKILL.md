---
name: branch-execution
description: Use when a confirmed Task Tree is ready to execute through skeleton and branch implementation stages.
---

# Branch Execution

Use Claude Code's native reasoning and tools inside the confirmed scope. The Runtime is the source of truth for which Task Node may execute next.

1. Call `harness_get_next_executable_node` with the active Tree ID. If it returns `null`, inspect Runtime Snapshot, blocking Drift, confirmation, dependency, or phase-gate facts instead of choosing a node yourself.
2. Query the current Session's latest same-Project Trace with `harness_get_trace_events`, then call `harness_start_node_attempt` with that `sourceTraceEventId` and exactly the scheduler-returned `nodeId` and `treeRevisionId`. This binds the Attempt to the current Session/runtime without accepting a raw Session ID. Do not mutate project files before the Attempt starts.
3. Use native Claude tools to implement only that node's objective, outputs, dependencies, Artifact relationships, and active-branch scope. Hooks bind resulting Trace and Artifact facts to the active Attempt.
4. Run the node's required verification, call `harness_begin_node_verification`, attach each required evidence key with `harness_attach_attempt_evidence`, then call `harness_evaluate_node_attempt`.
5. Query `harness_get_next_executable_node` again. During `skeleton_pass` it yields breadth-oriented Skeleton work. During branch implementation or verification it stays inside `activeBranchNodeId` and follows deterministic eligible depth order. Never invent a cross-branch order.
6. After every current Skeleton Task Node succeeds, call `harness_evaluate_skeleton_gate` with the current Workflow revision. Inspect its per-branch blockers when it fails or is uncertain; never infer Gate success from prose or manually advance the stage.
7. After an active branch's implementation nodes succeed, call `harness_evaluate_workflow_phase`; execute the scheduled verification nodes and call the phase gate again. The Runtime activates the next branch or enters root verification.
8. After root verification enters `final_report`, query Runtime Snapshot and call `harness_finalize_task_tree` with the current Workflow revision and a stable idempotency key. Completion exists only when this returns the immutable Final Report.
9. If a later mutation rewinds verified work, inspect `harness_get_verification_invalidations`, then resume from the node returned by the scheduler. Never reuse an invalidated Evaluation or Gate.
10. If implementation requires changing confirmed scope, return that branch to local refinement and obtain confirmation again. If only the implementation revision is being swapped while identity and topology stay stable, use the evidence-backed Task Node Replacement workflow.

Do not start leaf implementation while shared Skeleton work is incomplete, and do not fabricate Trace evidence or lifecycle state.
