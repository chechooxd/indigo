# Delta for Client Executor Injection

## ADDED Requirements

### Requirement: Extension composition wraps both pool and injected executors

`IndigoClientBase` MUST apply the composed `QueryExtension` chain (defined by
`client-query-extensions`) around `this.exec` regardless of whether the underlying
executor was built from a `pg.Pool` or supplied via executor injection, and around every
session executor produced by `$withSession`. All requirements in this spec MUST remain
unchanged in behavior when `extensions` is absent from `IndigoClientOptions`.

#### Scenario: Extensions wrap the default pg.Pool executor

- GIVEN a client constructed with only `connectionString` and an `extensions` array
- WHEN `this.exec` is invoked
- THEN the extension chain MUST wrap the `pg.Pool`-backed executor
- AND queries MUST reach the pool only after passing through the composed chain

#### Scenario: Extensions wrap an injected executor

- GIVEN a client constructed with an injected executor (via the executor injection path)
  and an `extensions` array
- WHEN `this.exec` is invoked
- THEN the extension chain MUST wrap the injected executor identically to the `pg.Pool`
  path
- AND no extension behavior MUST depend on which construction path produced the base
  executor

#### Scenario: Existing injection requirements hold when extensions is absent

- GIVEN a client constructed with no `extensions` option
- WHEN any scenario from the existing `client-executor-injection` requirements is
  exercised (pool construction, injection bypass, `$queryRaw` path-independence,
  `$disconnect` teardown, realtime teardown, the transaction hook)
- THEN behavior MUST be identical to before this capability existed
