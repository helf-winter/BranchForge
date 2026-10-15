# Task Node Identity Isolation Implementation Plan

> User-approved Harness repair. Use test-first implementation and independent review. Do not change JEV configuration, counter code, or live Runtime state automatically.

**Goal:** Prevent cross-tree node ID collisions and offer a safe, explicit recovery path for the existing counter root without changing approved planning facts or rerunning verified branches.

**Architecture:** Canonicalize conflicting new node IDs per tree before persistence and remap structural references. For legacy unexecuted collisions, add audited read-model overlays for document/node identity; original revision JSON and immutable execution/approval/Gate records remain unchanged. Recovery is explicit, revision-bound, transactional, and refused when existing node execution/effect history makes reassociation unsafe.

**Stack:** TypeScript, Node SQLite, Vitest, Claude binding.

## Constraints and review focus

- Preserve the previous uncommitted 0.1.6 changes and unrelated untracked files.
- Cross-project and same-project trees may reuse logical IDs; canonical IDs remain stable across revisions.
- Never overwrite another tree's node or forge succeeded execution.
- Overlay recovery must preserve original document/body JSON, revision IDs, approval hashes, branch statuses, historical Traces/Evaluations/Gates.
- Refuse stale revision, active Attempt, ambiguous/executed conflicting nodes, or cross-project requests. Backups and explicit approval are required before any live recovery.
- No Git commit/push without a user request.

## Tasks

- [x] Reproduce foreign node ownership in a shared database, fix normalization/reference mapping and guard persistence.
- [x] Reproduce legacy root not schedulable; add schema-only read-model overlays and explicit preview/apply service with immutable audit and rollback tests.
- [x] Route application reads through named identity-aware views, retaining original write tables and raw facts.
- [x] Verify an approved tree at root_verification starts only its root Attempt and reaches final report after recovery, without revision/approval/branch reset.
- [x] Add CLI preview/apply path, document limitations, run full check and independent review, update installed plugin.
- [x] Leave actual data unchanged and hand off the recovery preview for explicit authorization.

## Verification record (2026-10-12)

- Final `npm run check`: exit 0; typecheck, build, 504 tests across 71 files, official plugin/marketplace validation, and the separate 12-test plugin suite passed.
- Added 6 future-isolation and 9 legacy-recovery tests. CLI subprocess tests exercise the release entry built by pretest; earlier source-compiler startup timeouts were resolved without extending timeouts or weakening assertions.
- Independent review found a historical non-root alias safety gap and a preview migration issue; both were corrected and independently rechecked. No remaining review findings in scope.
- A consistent snapshot of the real counter database was replayed in isolation: recovery restored root scheduling and the Gate/Final Report protocol. Replay proof was explicitly synthetic; this does not attest to the live counter's root verification.
- Hardware-read-only preview of live tree `fba07d5e-75aa-4110-a83f-d2c7324acf94`, revision `ab024ebd-85bf-4152-a0df-f46802569e06`, returned one foreign-owned `root`, no blockers, and `canApply: true`. Live schema remained 25 and the workflow remained root_verification revision 39. No real-data apply occurred.
- Installed user plugin updated from 0.1.6 to 0.1.7; restart Claude Code to load the new process. JEV configuration, counter source, and live execution facts were not changed. No commit/push performed.
