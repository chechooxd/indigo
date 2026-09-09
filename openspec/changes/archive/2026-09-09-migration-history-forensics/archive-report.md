
---

## Post-archive correction: a second contradictory requirement survived the merge

The archive merge was checked by reading the canonical spec rather than trusting the tool, and
one contradiction had survived.

`openspec/specs/migration-history-integrity/spec.md` still carried
`### Requirement: A legacy history table silently backfills checksums on first touch`, which
states the system **MUST** compute and store checksums for legacy rows automatically. Work Unit
A deleted exactly that behaviour — the `ALTER TABLE ... ADD COLUMN` statements, the backfill
loop, and the four tests covering them. The canonical spec therefore required behaviour the
shipped code no longer has.

**The mechanical cause is worth recording, because it will recur.** The delta expressed this as
a MODIFIED requirement under a new title —
`_indigo_migrations records checksum, success, installed_by, and execution_time_ms, created
once with no backfill` — and the merge matches requirements by title. A renamed requirement
therefore reads as an addition, and its predecessor survives beside it. The `success` deferral
was caught only because it was named explicitly in the archive brief; this one was not named,
and it slipped through the same gap.

Replaced with `A pre-existing history table is left exactly as it is`, stating the real
behaviour and carrying a note explaining what it supersedes and why — the same shape as the
`success` note, so a reader meeting either one sees the history rather than an unexplained
absence.

**Process lesson for the next archive of a MODIFIED capability:** matching by requirement title
is not sufficient. Diff the canonical spec's requirement list before and after the merge, and
account for every requirement that is not carried forward AND every one that is. A requirement
the delta renamed looks identical to a requirement the delta added.
