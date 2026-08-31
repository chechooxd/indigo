# Studio Environment Badge Specification

## Purpose

`indigodb studio` MUST let an operator label a running instance with an environment name
(`development | staging | production`, or any other non-empty custom label), resolved once at
startup and surfaced through the existing status probe and a persistent UI badge, so an operator
with multiple tabs open has a glanceable, evidence-based answer to "which database am I about to
edit?". The label is purely informational: it gates nothing.

## Requirements

### Requirement: Environment resolved once at startup from an explicit flag or env var, unset by default

The system MUST support a `--env <name>` CLI flag and an `INDIGODB_ENV` environment variable,
resolved via a new pure `resolveStudioEnvironment(option, env)` function in `packages/cli/src/util.ts`,
alongside `resolveStudioReadOnly`/`resolveQueryTimeoutMs`/`resolveQueryRowCap`. `--env` MUST take
precedence over `INDIGODB_ENV` when both are present. Resolution MUST happen once, after
`loadEnv()`, inside the `studio` CLI action, with no route to change the label on a running
server. When neither is set, the resolved value MUST be `null` — never a default label. The
system MUST NOT derive the label from the hostname, connection string, or any other heuristic.

#### Scenario: Neither flag nor env var set resolves to null

- GIVEN neither `--env` nor `INDIGODB_ENV` is set
- WHEN `indigodb studio` starts
- THEN `resolveStudioEnvironment` returns `null`
- AND `GET /api/auth/status` reports `environment: null`

#### Scenario: --env flag takes precedence over INDIGODB_ENV

- GIVEN `INDIGODB_ENV=staging` is set
- WHEN `indigodb studio` starts with `--env production`
- THEN `GET /api/auth/status` reports `environment: "production"`

#### Scenario: INDIGODB_ENV is used when no flag is passed

- GIVEN `INDIGODB_ENV=staging` is set and no `--env` flag is passed
- WHEN `indigodb studio` starts
- THEN `GET /api/auth/status` reports `environment: "staging"`

### Requirement: Open label set — three recognised names plus any custom label

The system MUST accept `development`, `staging`, and `production` as recognised labels, each
rendered with its own distinct visual treatment in the badge, with `production` the most
prominent. The system MUST also accept any other non-empty, non-whitespace-only string within a
bounded length as a valid, unrecognised label: it MUST resolve successfully, reach the status
probe verbatim, and render in the badge with a shared neutral treatment. `resolveStudioEnvironment`
MUST NOT throw for an unrecognised name.

#### Scenario: Each recognised label resolves and reaches the probe

- GIVEN `--env development`, `--env staging`, and `--env production` in turn
- WHEN `indigodb studio` starts for each
- THEN `GET /api/auth/status` reports `environment` equal to that exact value each time
- AND the Studio badge renders with that label's distinct treatment (production most prominent)

#### Scenario: An unrecognised but structurally valid label resolves successfully

- GIVEN `--env qa` is passed
- WHEN `indigodb studio` starts
- THEN the process starts normally with no error
- AND `GET /api/auth/status` reports `environment: "qa"`
- AND the Studio badge renders the literal text `qa` with the shared neutral treatment (not the
  `development`/`staging`/`production` treatment)

#### Scenario: A recognised label is matched case-insensitively and rendered verbatim

- GIVEN `--env Production` is passed
- WHEN `indigodb studio` starts
- THEN `GET /api/auth/status` reports `environment: "Production"` — the operator's own casing,
  unchanged
- AND the Studio badge renders the literal text `Production`
- AND it uses the `production` distinct treatment, NOT the neutral one
- AND the same holds for any casing of `development` and `staging`

#### Scenario: Surrounding whitespace is trimmed before recognition

- GIVEN `INDIGODB_ENV=" production "` is set (for example from a `.env` line with a trailing
  space, invisible in an editor)
- WHEN `indigodb studio` starts
- THEN the process starts normally with no error
- AND `GET /api/auth/status` reports `environment: "production"` — trimmed
- AND the Studio badge uses the `production` distinct treatment, NOT the neutral one

#### Scenario: A long but valid label is truncated in the badge, never overflowing the header

- GIVEN `GET /api/auth/status` reports an `environment` label at the maximum accepted length
- WHEN the Studio shell renders
- THEN the badge displays the label truncated with an ellipsis rather than wrapping or widening
  the header
- AND the complete untruncated label remains available to the operator on hover

### Requirement: Structurally invalid values are rejected at startup

The system MUST reject a structurally invalid `--env`/`INDIGODB_ENV` value — after trimming: an
empty string, a value longer than 32 UTF-16 code units, or a value containing any character below
U+0020 or U+007F DEL — by exiting non-zero before the server binds. Interior control characters are
rejected because they corrupt the startup log line; an unfamiliar *name* is never a reason to
reject. The error message MUST name `--env` and `INDIGODB_ENV` as the source of
the offending value. The system MUST NOT reject a value for being unrecognised.

#### Scenario: An empty or whitespace-only value is rejected at startup

- GIVEN `--env ""` or `--env "   "` is passed
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `--env` / `INDIGODB_ENV` as the source of the invalid value

#### Scenario: An over-length value is rejected at startup

- GIVEN `--env` is passed a value longer than 32 UTF-16 code units after trimming
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `--env` / `INDIGODB_ENV` as the source of the invalid value
- AND a value of exactly 32 code units is ACCEPTED (boundary is inclusive)

#### Scenario: An interior control character is rejected at startup

- GIVEN `--env` is passed a value containing an interior newline or tab (for example a pasted
  `.env` line)
- WHEN the operator starts `indigodb studio`
- THEN the process exits non-zero before binding
- AND the error message names `--env` / `INDIGODB_ENV` as the source of the invalid value

### Requirement: Absent label renders no badge

When `environment` resolves to `null`, the system MUST NOT render any badge, and MUST NOT
substitute a default label such as `development`.

#### Scenario: Unset environment renders no badge

- GIVEN `GET /api/auth/status` reports `environment: null`
- WHEN the Studio SPA loads or the store refreshes status
- THEN no environment badge is rendered anywhere in the shell

#### Scenario: Standalone dev with no backend renders no badge

- GIVEN the Studio SPA is running standalone (`pnpm dev`, no backend) and the status probe fails
- WHEN the app shell loads
- THEN no environment badge is rendered and no error is thrown

### Requirement: The badge is never an enforcement input

The environment label MUST NOT be read by, or influence the outcome of, any access-control or
guardrail decision, including read-only mode (`resolveStudioReadOnly`), session auth, or query
guardrails. `environment` MUST NOT be passed as an argument to, or checked inside, any function
that decides whether a request is authorized, read-only, or capped.

#### Scenario: Production environment does not enable read-only mode

- GIVEN `--env production` is passed and `--read-only`/`INDIGODB_STUDIO_READONLY` is not set
- WHEN a client sends a write to `/api/rows/:table`
- THEN the write succeeds exactly as it would with no `--env` set

#### Scenario: Production environment does not alter auth or query guardrail behavior

- GIVEN `--env production` is passed
- WHEN a client exercises `/api/auth/login`, an authenticated `/api/*` route, or `POST /api/query`
- THEN each response is identical to the equivalent request with no `--env` set, aside from
  `environment` in the `GET /api/auth/status` body

### Requirement: Persistent environment badge in the Studio shell

The Studio frontend MUST render a persistent badge showing the resolved `environment` value
whenever the status probe reports a non-null `environment`, reusing the existing status wiring in
`useAuthStore` (the same mechanism as `readOnly`'s banner), and MUST NOT render it when
`environment` is `null`.

#### Scenario: Badge renders with the recognised label's distinct treatment

- GIVEN the status probe response includes `environment: "production"`
- WHEN the Studio SPA loads or the store refreshes status
- THEN a persistent badge is displayed showing the `production` label with its distinct,
  most-prominent visual treatment

#### Scenario: Badge renders custom labels verbatim with the neutral treatment

- GIVEN the status probe response includes `environment: "qa"`
- WHEN the Studio SPA loads
- THEN a persistent badge is displayed showing the literal text `qa` with the shared neutral
  treatment
