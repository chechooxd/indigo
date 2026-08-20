# Delta for Shadow Database Replay

## MODIFIED Requirements

### Requirement: Recorded order diverging from on-disk order produces a loud diagnostic

If the order recorded in `_indigo_migrations` disagrees with the
lexicographic order of migration directories on disk, the system MUST raise
an explicit diagnostic instead of silently picking either ordering. Order
divergence and checksum drift (see the checksum-mismatch requirement below)
are two independent desync signals; detecting one does not substitute for
the other.

(Previously: this requirement's text asserted "no checksum column exists
yet on `_indigo_migrations`, so order divergence is the only available
desync signal" — false once checksums land; that claim is removed here.)

#### Scenario: Reordered migrations produce a diagnostic, not a silent wrong diff

- GIVEN `_indigo_migrations`' recorded order disagrees with the lexicographic order of directories under `migrations/`
- WHEN `migrateDev` attempts to build the shadow database
- THEN an explicit diagnostic reports the order mismatch, and `migrateDev` does not silently produce a wrong diff by guessing an ordering

## ADDED Requirements

### Requirement: A checksum mismatch on a recorded migration produces a hard refusal

For each recorded migration replayed onto the shadow database, the system
MUST recompute the sha256 checksum of its on-disk `migration.sql` and
compare it against the checksum stored on that migration's
`_indigo_migrations` row. If they differ, the system MUST refuse to build
the shadow database and MUST raise an explicit, actionable diagnostic
naming the drifted migration id, in the same refusal shape as the existing
missing/pending diagnostics. There is no flag or configuration to bypass
this refusal — this supersedes the module's prior documented position that
no stronger signal than recorded-vs-on-disk existed.

#### Scenario: Editing an applied migration's SQL blocks the next `migrate dev`

- GIVEN a recorded migration's `migration.sql` has been edited since it was applied, changing its on-disk content
- WHEN `migrateDev` attempts to build the shadow database
- THEN replay halts before producing a `prev`, an explicit diagnostic names the drifted migration id, and `migrateDev` does not proceed to diff against a shadow built from the edited content

#### Scenario: Unmodified recorded migrations replay without a checksum diagnostic

- GIVEN every recorded migration's on-disk content matches its stored checksum
- WHEN the shadow database is built
- THEN no checksum diagnostic is raised, and replay proceeds as it does today
