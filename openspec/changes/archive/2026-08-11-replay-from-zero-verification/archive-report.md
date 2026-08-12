# Archive Report: Replay-from-Zero Verification

**Archived**: 2026-08-11  
**Change**: `replay-from-zero-verification`  
**Status**: Completed and closed  
**Closes**: Roadmap Phase 1 epic "Replay-from-zero verification" — **and this is the final Phase 1 epic, so roadmap Phase 1 ("The proving ground") is now fully closed**

---

## Final State Summary

This archive captures the terminal state of the `replay-from-zero-verification` change as delivered. The change is complete, all verification gates passed, and Phase 1 roadmap closure is recorded herein.

### Change Outcome

Proves that an accumulated migration history (the way `migrations/` actually grows after several real `migrate dev` runs) replayed in order from an empty database reconstructs a database structurally consistent with a fresh `db push` of the final schema — closing the exact defect class `fix-migrator-correctness` was designed to prevent.

**Result**: The real 4-hop chain matched the push path cleanly with zero divergence, independently reproduced by orchestration with intentional type-drift injections confirming the comparator is working, not vacuous.

---

## Verification Report Status

Per the Final-State Authority hierarchy, verification facts rank highest:

**Verify-report outcome (final)**: `PASS`
- **Critical issues**: 0
- **Warnings**: 1 (task 6.1 spec-promotion deferral) — **resolved at archive time** (this step)
- **Suggestions**: 1 (loadChainFixture error-branch coverage) — **resolved** at commit `ed85101`, `test(migrator): cover loadChainFixture's error branches`

**Test suite status** (after remediation):
- `pnpm --filter @indigodb/migrator test`: 7/7 replay checks (previously 5)
- `pnpm build`: 10/10
- `pnpm lint`: 18/18
- `pnpm test` (root): 16/16
- `cd crates && cargo test`: 23/23

---

## Task Completion

All 20 implementation tasks are complete:

| Phase | Tasks | Status |
|-------|-------|--------|
| 1: Comparator Self-Tests | 1.1–1.4 (4 tasks) | ✓ Complete |
| 2: Comparator Implementation | 2.1–2.3 (3 tasks) | ✓ Complete |
| 3: Chain Fixture | 3.1–3.5 (5 tasks) | ✓ Complete |
| 4: Chain Replay Suite | 4.1–4.4 (4 tasks) | ✓ Complete |
| 5: Wiring | 5.1–5.3 (3 tasks) | ✓ Complete |
| 6: Spec Promotion | 6.1 (1 task) | ✓ Complete (archive-time) |

**Spec Promotion (Task 6.1)**: Delta requirements from `openspec/changes/replay-from-zero-verification/specs/migration-appliability-tests/spec.md` have been merged into the main spec at `openspec/specs/migration-appliability-tests/spec.md`. Seven ADDED requirements appended:
1. Chain fixtures represent an accumulated migration history
2. Chain hops are additive-only by design
3. The full chain replays against one fresh instance without reset
4. A separate instance is seeded via a single push of the final schema
5. Structural comparison covers semantic shape, excluding naming and guard artifacts
6. Any non-excluded divergence is a hard failure
7. Chain replay is wired into the existing appliability test run

---

## Artifacts Archived

The complete change folder has been moved to `openspec/changes/archive/2026-08-11-replay-from-zero-verification/`:

- `proposal.md` — change intent and scope
- `design.md` — detailed design
- `tasks.md` — 20 implementation tasks (all complete)
- `specs/migration-appliability-tests/spec.md` — delta spec (ADDED 7 requirements)
- `verify-report.md` — final verification report (PASS)

**Archived to**: `openspec/changes/archive/2026-08-11-replay-from-zero-verification/`

---

## Spec Merge Details

**Main spec updated**: `openspec/specs/migration-appliability-tests/spec.md`

**Action**: Appended 7 ADDED requirements to the existing 13 requirements, bringing the total to 20 requirements.

**Merge verification**: `diff -r` between pre-move snapshot and archived folder returned empty (no truncation or alteration).

**Spec line count**: Grew from 141 lines (existing) to 244 lines (merged) — 103 lines of delta requirements appended.

---

## Source of Truth Update

The following main spec has been updated and is now authoritative:

- `openspec/specs/migration-appliability-tests/spec.md` — now includes chain-replay verification capability

Consumers of this spec (implementation, testing, documentation) should reference the updated main spec, not the archived delta.

---

## Git State at Archive

- **Branch**: `migrator/replay-from-zero-verification`
- **Tip commit**: `ed85101` (`test(migrator): cover loadChainFixture's error branches`)
- **Stacked on**: `main` at `14cabe5`
- **Status**: Not pushed, no PR open (intentional, pending user authorization)

**Note**: The archive report records the filesystem state and SDD artifact closure only. Repository delivery (push, PR, merge) remains user-owned.

---

## Roadmap Closure: Phase 1 Complete

**Milestone**: This archive closes the "Replay-from-zero verification" epic from roadmap Phase 1.

**Phase 1 Status**: `CLOSED` — This is the final Phase 1 epic. All roadmap Phase 1 work ("The proving ground") is now complete and closed:
1. `fix-compiler-correctness` — ✓ closed
2. `add-postgres-integration-tests` — ✓ closed
3. `fix-migrator-correctness` — ✓ closed
4. `add-ci-floor` — ✓ closed
5. `grow-compiler-corpus` — ✓ closed
6. `harden-studio-server` — ✓ closed
7. `delete-studio-simulations` — ✓ closed
8. `client-executor-seam` — ✓ closed
9. `replay-from-zero-verification` — ✓ closed (this archive)

All of Phase 1 ("The proving ground") is now archived and closed.

---

## SDD Cycle Completion

The change has been fully planned, implemented, verified (PASS), and archived:

- ✓ Proposal defined scope and approach
- ✓ Spec defined requirements and scenarios
- ✓ Design provided technical approach
- ✓ Tasks broke work into 20 actionable units
- ✓ Apply completed all 20 tasks
- ✓ Verify validated PASS with 0 CRITICAL issues
- ✓ Archive merged delta specs to main, moved folder, and closed Phase 1

**SDD cycle**: Complete and closed.

---

## Key Facts for Traceability

- **Artifact store mode**: Hybrid (filesystem + Engram)
- **Spec merge**: 7 ADDED requirements appended to existing 13-requirement spec
- **Archive folder**: `openspec/changes/archive/2026-08-11-replay-from-zero-verification/`
- **Verification gate**: PASS (0 CRITICAL, 1 WARNING resolved, 1 SUGGESTION resolved)
- **Task completion gate**: 20/20 complete
- **Phase 1 closure**: Explicit — roadmap Phase 1 ("The proving ground") is now closed in full
