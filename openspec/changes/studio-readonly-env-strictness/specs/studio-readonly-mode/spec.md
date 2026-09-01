# Delta for studio-readonly-mode

## MODIFIED Requirements

### Requirement: Read-only flag resolved once at startup

The system MUST support a `--read-only` CLI flag and an
`INDIGODB_STUDIO_READONLY` env var as its default, following the
`--host`/`INDIGODB_STUDIO_HOST` flag+env-default convention (not the
password's env-only pattern). The env var's accepted set MUST mirror
`resolveStudioAuditLog`: an exact match of `"1"` or `"true"` MUST enable
read-only mode, an exact match of `"0"` or `"false"` MUST disable it, and
ANY other value MUST cause the process to exit non-zero before Studio binds
to a port, with an error message naming `INDIGODB_STUDIO_READONLY` and the
four accepted values. Silent fail-open on a malformed value defeats the
entire purpose of this capability — an operator pointing Studio at a shared,
staging, or production database is relying on read-only mode actually being
on, and a lenient parser only discovers the mismatch after data has already
been mutated. The resolved value MUST be captured once into
`StudioOptions.readOnly` at process startup, mirroring how `auth` is
resolved once, with no route to toggle it while the server is running.
(Previously: any value other than exact-match `"1"`/`"true"` silently left
read-only off with exit 0, instead of rejecting unrecognized values.)

#### Scenario: Default preserves existing write behavior

- GIVEN neither `--read-only` nor `INDIGODB_STUDIO_READONLY` is set
- WHEN a client sends INSERT/UPDATE/DELETE requests to `/api/rows/:table`
- THEN every write behaves exactly as before this change
- AND existing suites (`studio-write.mjs`, `studio-auth.mjs`,
  `studio-auth-preflight.mjs`) continue to pass unmodified

#### Scenario: CLI flag or exact-match "on" env values enable read-only mode

- GIVEN the operator starts `indigodb studio --read-only`, or sets
  `INDIGODB_STUDIO_READONLY=1` without the flag, or sets
  `INDIGODB_STUDIO_READONLY=true` without the flag
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `true` for the lifetime of that process

#### Scenario: Exact-match "off" env values keep read-only disabled

- GIVEN no `--read-only` flag is passed, and `INDIGODB_STUDIO_READONLY` is
  set to `"0"`, or separately set to `"false"`
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `false` and the process starts normally with exit 0
- AND this is unchanged from the resolver's behavior before this change

#### Scenario: Unset env var and no flag leaves read-only off

- GIVEN neither `--read-only` nor `INDIGODB_STUDIO_READONLY` is present in
  the process environment
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it is `false` and the process starts normally with exit 0

#### Scenario: Malformed env values cause a loud startup failure

- GIVEN `INDIGODB_STUDIO_READONLY` is set to `"yes"`, `"on"`, `"TRUE"`,
  `"1.0"`, `" 1 "` (leading/trailing whitespace), or an empty string `""`
- WHEN the server starts
- THEN the process exits with a non-zero status before binding to a port
- AND the error message names `INDIGODB_STUDIO_READONLY` and lists the four
  accepted values (`1`, `true`, `0`, `false`)
- AND `StudioOptions.readOnly` is never bound and no fuzzy truthy parsing is
  applied

#### Scenario: The CLI flag adds read-only but never suppresses env validation

- GIVEN the operator starts `indigodb studio --read-only` while
  `INDIGODB_STUDIO_READONLY` is unset or holds any of the four accepted values
- WHEN the server resolves `StudioOptions.readOnly`
- THEN it resolves to `true` — the flag alone is sufficient, and `"0"`/`"false"`
  in the env var does NOT cancel it

#### Scenario: A malformed env value is rejected even when the flag is passed

- GIVEN `INDIGODB_STUDIO_READONLY` is set to a rejected value such as `"yes"`
- AND the operator also passes `--read-only`
- WHEN `indigodb studio` starts
- THEN the process still exits non-zero before binding, naming the variable and
  the accepted values
- AND the malformed value is NOT silently suppressed by the flag

`--read-only` is enable-only: it can add read-only mode but never turn it off,
so it expresses no intent to override the environment. Suppressing a typo the
operator never asked to suppress would leave that typo in place until the next
launch without the flag, which would then come up writable with no warning —
the exact failure this change exists to close, merely deferred. (This is
deliberately unlike `resolveStudioAuditLog`, whose flag IS authoritative in both
directions and therefore genuinely does override the environment.)
