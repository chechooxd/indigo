# Delta for Client Executor Injection

## ADDED Requirements

### Requirement: Optional transaction hook on injected executors

`IndigoClientOptions.db` MUST gain an optional `transaction?: <T>(fn: (exec: Executor)
=> Promise<T>) => Promise<T>` field so non-`pg` executors (the PGlite test harness,
custom engines) can support `$transaction` through the same injection seam used for
ordinary queries. All existing `client-executor-injection` requirements MUST remain
unchanged when this field is absent.

#### Scenario: Hook present is used by $transaction

- GIVEN a client constructed with an injected `db` that implements `transaction`
- WHEN `$transaction(fn)` is called
- THEN the injected `transaction` hook MUST be invoked with a callback that receives a
  transaction-scoped `Executor`
- AND that `Executor` MUST be used to build the `tx` delegates passed to `fn`

#### Scenario: Hook absent leaves non-transaction behavior unchanged

- GIVEN a client constructed with an injected `db` that does not implement `transaction`
- WHEN the client is constructed and used for ordinary (non-`$transaction`) queries
- THEN construction and query behavior MUST be identical to before this field existed
- AND no error MUST be thrown merely because the hook is absent

#### Scenario: Hook absence only surfaces when $transaction is called

- GIVEN a client constructed with an injected `db` that does not implement `transaction`
- WHEN `$transaction(fn)` is called on that client
- THEN the unsupported-transaction error defined by `client-transactions` MUST be raised
- AND this MUST be the only place the missing hook is observable
