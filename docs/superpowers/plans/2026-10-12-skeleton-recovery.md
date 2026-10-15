# Skeleton Gate Recovery Implementation Plan

> **For agentic workers:** Use test-first implementation and independent review for the scoped fixes below. The user has approved execution of this repair.

**Goal:** Allow an approved Task Tree to recover from missing Skeleton evidence without rewriting successful Attempts, rebuilding the tree, or bypassing native approval.

**Architecture:** Preserve exact command identity and immutable Trace/Evaluation/Gate history. Readiness rejects impossible contract references; gates explain missing validation separately from missing definitions and read attached command facts rather than mutable latest projections. The deterministic scheduler may offer a fresh, narrowly scoped repair Attempt after a failed current Skeleton Gate.

**Tech Stack:** TypeScript, Node 22 SQLite, Vitest, Claude plugin/MCP.

**Spec:** The counter acceptance failure and read-only diagnosis recorded in this conversation; `docs/harness-deadlock-regressions.md` defines history preservation.

## Global Constraints

- Do not modify the real counter app, project identity, installed runtime database, Task Tree revisions, or historical failed records.
- Do not automatically equate shell pipelines with the planned bare verification command: a pipeline can hide the test's failure.
- Preserve native approval, confirmation, dependency, scope, revision, and blocking Drift checks.
- No commit or push unless the user requests it.

## Review Focus

- A repeated command in another branch must not overwrite an earlier branch's attached verification fact.
- A repair must not reuse failed, invalidated, cross-project, or mismatched-context evidence.
- A successful node cannot be rerun arbitrarily, without a failed current Skeleton Gate and scheduler selection.
- Read-only pipelines must remain blocked if any segment writes files, executes a script, or uses command substitution.
- A changed revision, active Attempt, missing confirmation, or blocking Drift must block repair scheduling.

### Task 1: Readiness contracts

Files: `src/domain/task-refinement.ts`, `tests/unit/task-refinement.test.ts`.

- [x] Add failing cases for absent required contract definitions and unreachable validation references.
- [x] Require every Skeleton contract reference to resolve and its validation references to bind to branch Skeleton evidence or explicitly owned artifacts; warn about artifact Trace attachment obligations.
- [x] Run targeted tests and update incomplete test fixtures without weakening the new validation.

### Task 2: Safe diagnostics

Files: `src/domain/read-only-shell.ts`, `src/application/hook-ingestion-service.ts`, shell unit and Hook integration tests.

- [x] Reproduce the real read-only `ls | head; find | head` and `cd && grep | head` refusals.
- [x] Implement conservative token/segment validation, rejecting file output, substitutions, mutating options and unknown commands.
- [x] Verify both useful diagnostics and adversarial suffix/option cases.

### Task 3: Gate evidence and local repair

Files: Skeleton Gate policy/service, execution scheduler/service, integration tests.

- [x] Reproduce command projection overwrite, missing contract validation mislabeling, and no schedulable node after all Skeleton Attempts succeeded.
- [x] Inspect actual attached successful command Traces; preserve raw command identity and per-branch binding.
- [x] Return actionable contract diagnostics and deterministic repair metadata from `harness_get_next_executable_node`.
- [x] Permit only the scheduler-selected confirmed Skeleton node to start a new repair Attempt after a current failed Gate. Preserve old succeeded Attempts and Evaluations; accumulate still-valid evidence in the same unchanged execution context.
- [x] Verify a new repair Attempt, fresh evidence, gate re-evaluation and normal branch execution without a new tree/revision or approval.

### Task 4: Integration and release

- [x] Run focused tests, full `npm run check`, and independent review.
- [x] Document recovery commands/steps, bump plugin version and update the local installed plugin after verification.
- [x] Leave the real failed acceptance tree untouched for the user's resumed test.


## Verification Record

- Fresh `npm run check` exited 0: 489 tests across 69 files, typecheck, build, both official manifest validations, and 12 plugin tests passed.
- Independent read-only review found five recovery/parser edge cases; each received RED/GREEN regression coverage and was resolved before release.
- Installed WSL user plugin updated from 0.1.5 to 0.1.6; restart is required.
- Real counter project/RuntimeDB and historical failed Task Tree were not changed. Live acceptance remains the user's next step; it is not claimed complete.
- No Git commit or push was performed. Only the agent-created temporary test log `limit` was removed; existing untracked directories were preserved.
