---
name: task-tree-planning
description: Use when a coding request is complex, multi-stage, cross-module, has unresolved design decisions, or the user explicitly requests structured planning; skip it for small self-contained changes and whenever the user explicitly asks to execute directly without a Task Tree.
---

# Task Tree Planning

Use Claude's native discussion, reasoning, Plan Mode, and `AskUserQuestion`. The Runtime preserves durable planning facts; it does not replace native planning.

## Choose the path

- Explanation-only or small self-contained change: answer or execute directly. Do not create a Task Tree.
- Explicit “execute directly/no Task Tree”: resolve any pending affiliation as `direct_execution`, then obey it.
- Complex, multi-stage, cross-module, or explicitly planned work: follow the workflow below.

## Structured planning workflow

1. Inspect Project identity and propose `new_tree` or `merge` with `harness_propose_task_affiliation`.
2. Show the candidates and recommendation. Use `AskUserQuestion` so the user explicitly chooses `direct_execution`, `new_tree`, `merge`, or `pause`.
3. Find the later answer through `harness_get_trace_events`, then call `harness_resolve_task_affiliation`. Do not draft before affiliation is resolved.
4. Discuss requirements natively. Build one full goal-level `planningVersion: 1` document with planning context, nodes, Leaf Task Contracts, relations, planned Artifacts/Effects, and per-branch Skeleton Acceptance Criteria.
5. Call `harness_create_task_tree_draft` once for that complete goal-level document. Unresolved details belong in the document, not hidden conversation state.
6. Continue question-driven local refinement. After a user-visible decision changes structure, call `harness_patch_task_tree` with exactly one operation, the answer Trace ID, the exact base revision, and a concise Decision Record. Do not create a revision when nothing structural changed.
7. Call `harness_validate_task_tree`. Discuss its highest-impact blocker with the user and repeat patch/validate until `ready: true`.
8. Call `harness_prepare_task_tree_approval` using a later `UserPromptSubmit`. Insert its canonical block unchanged into the native Plan.
9. Use native Plan approval exactly once. After approval, continue with the executable node supplied by the Runtime.

## Planning contract

- A leaf has one objective, explicit outputs and acceptance criteria, no unresolved question or decision, valid dependencies, completion evidence, an execution phase, and a stop-decomposition reason.
- Calls, data exchange, and shared contracts are relations backed by planned Artifacts. High-risk Effects include mitigation.
- Never write a JSON manifest into the native Plan.
- Never ask for a second Harness confirmation; native Plan approval is the confirmation surface.
- On revision conflict, read current state and reconcile. Never overwrite a newer revision.
