# Delta for Client Query Extensions

## MODIFIED Requirements

### Requirement: Extension composition order and wrapLog placement

Extensions MUST compose right-to-left around the base executor, so `extensions[0]` is
outermost (first to observe the call, last to observe the result) and the last extension
is innermost, closest to the base executor. `wrapLog`'s `log: boolean` behavior MUST
remain innermost — between the last extension and the base executor — logging the exact
SQL produced after all extensions have run, together with one redacted positional
placeholder per bound parameter (e.g. `$1=<redacted>, $2=<redacted>`), in call order.
`wrapLog` MUST NOT emit any bound parameter's runtime value under any circumstance, and
no configuration option MAY restore raw value logging.
(Previously: required logging "the exact SQL/params actually sent, with zero behavior
change from today," which included raw parameter values; the "Absent extensions"
scenario separately locked `log`'s payload — including params — as byte-identical to
pre-capability behavior.)

#### Scenario: Extensions run in declared order

- GIVEN a client constructed with `extensions: [a, b]`
- WHEN a query executes
- THEN `a` MUST observe the call before `b`
- AND `a` MUST observe the result after `b`

#### Scenario: wrapLog logs the SQL each extension actually forwards

- GIVEN a client constructed with `log: true` and an extension that rewrites `sql`
- WHEN a query executes
- THEN the logged SQL MUST be the SQL produced after all extensions have run, not the
  original caller-supplied SQL

#### Scenario: Absent extensions leaves composition overhead unchanged

- GIVEN a client constructed with no `extensions` option (or an empty array)
- WHEN any query executes
- THEN no composition overhead (extra wrapping beyond the innermost `wrapLog` step)
  MUST be introduced
- AND `wrapLog`'s redaction behavior (this requirement) applies identically whether or
  not extensions are present — it is NOT the pre-capability raw-value behavior

#### Scenario: Bound parameter values never appear in captured stdout

- GIVEN a client constructed with `log: true` and a non-empty params array containing a
  recognisable sentinel secret value
- WHEN a query executes with that params array
- THEN no line captured from stdout MUST contain the sentinel value

#### Scenario: Redacted placeholders preserve arity and position

- GIVEN a client constructed with `log: true` and a non-empty params array of N values
- WHEN a query executes
- THEN the emitted log line MUST contain exactly N redacted placeholders, one per
  parameter position, in the params' order

#### Scenario: Redaction holds when an extension rewrites params

- GIVEN a client constructed with `log: true` and an extension that rewrites both `sql`
  and `params` (non-empty, containing a sentinel secret) before calling `next`
- WHEN a query executes
- THEN the emitted log line MUST show the post-extension SQL and redacted placeholders
  matching the post-extension params' arity
- AND the sentinel value MUST NOT appear in captured stdout
