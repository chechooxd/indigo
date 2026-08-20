# Delta for Migration History Integrity

## MODIFIED Requirements

### Requirement: Checksum drift is a hard refusal with no override

Checksum drift detected by `migrate dev` (via shadow replay) or
`migrate deploy` (via preflight) MUST always block the run. The system MUST
NOT provide any flag, environment variable, or configuration option to
suppress or override this refusal. The sanctioned remedy path is
`migrate resolve` acting on the ledger only — reverting the on-disk file to
match the recorded checksum, or explicitly reconciling the ledger via
`migrate resolve --applied`/`--rolled-back` per `migration-history-resolve`.
`migrate resolve --applied <id>` itself MUST refuse (not silently
re-baseline) when the target id's on-disk content has already drifted from
its recorded checksum, so `resolve` provides no side door around this
refusal.
(Previously: the only remedy described was reverting the migration or
re-baselining by editing the recorded history directly via raw SQL.)

#### Scenario: No override surface exists for drift

- GIVEN a checksum mismatch is detected during `migrate dev` or `migrate deploy`
- WHEN the user attempts to proceed anyway
- THEN no documented flag, environment variable, or configuration bypasses the refusal, and the run remains blocked until the drifted migration is reverted or the ledger is explicitly reconciled via `migrate resolve`

#### Scenario: `migrate resolve` cannot be used to silently re-baseline a drifted checksum

- GIVEN a recorded migration's on-disk content no longer matches its stored checksum
- WHEN an operator runs `migrate resolve --applied <id>` on that same id, hoping to clear the drift
- THEN `resolve` refuses and leaves the stored checksum unchanged, exactly as `migration-history-resolve` specifies
