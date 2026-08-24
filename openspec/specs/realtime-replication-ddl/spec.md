# Realtime Replication DDL Specification

## Purpose

Defines how `@@realtime` models are translated into Postgres logical-replication DDL — publication
and slot lifecycle, idempotency, versioned-migration diffing, retirement of the legacy NOTIFY
trigger, and preflight diagnostics — for both `db push` and versioned migrations.

## Requirements

### Requirement: Publication is created idempotently for `@@realtime` tables

For a schema with at least one `@@realtime` model, the migrator MUST emit an idempotent
`CREATE PUBLICATION` covering exactly the `@@realtime` tables, following the existing
`DO $$`-guarded idempotency pattern.

#### Scenario: First push creates the publication

- GIVEN a schema with one `@@realtime` model and no existing publication
- WHEN `db push` DDL is rendered and applied
- THEN a publication is created covering that table

#### Scenario: Re-running push is a no-op

- GIVEN a schema whose publication was already applied
- WHEN `db push` runs again unchanged
- THEN the rendered DDL converges without error and the publication membership is unchanged

### Requirement: Slot is created idempotently and tied to schema state

The migrator MUST idempotently ensure the logical replication slot (name resolved per the
slot-naming convention shared with `WalSource`) exists whenever the schema has at least one
`@@realtime` model, and MUST drop the slot and publication when the last `@@realtime` model is
removed.

#### Scenario: Slot created alongside publication

- GIVEN a schema with one `@@realtime` model and no existing slot
- WHEN `db push` applies the DDL
- THEN the replication slot is created

#### Scenario: Slot dropped when last `@@realtime` model is removed

- GIVEN a previously migrated schema with one `@@realtime` model
- WHEN the `@@realtime` attribute is removed from that model and the migration is applied
- THEN the migration drops both the publication and the replication slot

### Requirement: Versioned migrations diff publication and slot changes in order

`diffResolved`/`renderMigrationSql` MUST emit publication membership changes (`ALTER
PUBLICATION ... ADD/DROP TABLE`) and slot create/drop statements matched against the previous
snapshot, ordered so the publication/slot exist before any dependent DDL.

#### Scenario: Adding `@@realtime` to an existing model

- GIVEN a previously migrated model with no `@@realtime`
- WHEN `@@realtime` is added and diffed against an existing publication
- THEN the migration includes `ALTER PUBLICATION ... ADD TABLE` for that table

#### Scenario: Removing `@@realtime` from one of several tables

- GIVEN a previously migrated schema with two `@@realtime` models
- WHEN `@@realtime` is removed from one of them
- THEN the migration includes `ALTER PUBLICATION ... DROP TABLE` for that table only, and the
  slot is retained because another `@@realtime` table still exists

### Requirement: Legacy NOTIFY trigger objects are retired

`renderNotifyFunction`/`renderCreateTrigger` MUST NOT be emitted in generated DDL. Versioned
migrations MUST include `DROP` statements for any existing `indigo_notify_*` function and
trigger objects so a previously migrated database converges.

#### Scenario: Fresh push emits no NOTIFY objects

- GIVEN a schema with one `@@realtime` model, pushed for the first time
- WHEN `db push` DDL is rendered
- THEN it contains no `indigo_notify_trigger` or `indigo_notify_function` statements

#### Scenario: Migrating a notify-era schema drops legacy objects

- GIVEN a database previously migrated with the NOTIFY trigger present
- WHEN a new migration is generated against the current schema
- THEN it includes `DROP FUNCTION`/`DROP TRIGGER` statements for the legacy notify objects

### Requirement: `wal_level` is verified before applying replication DDL

`db push` and `migrate deploy` MUST check `SHOW wal_level` before applying publication/slot DDL
and MUST fail with an actionable error (naming the required `wal_level=logical` and that it
needs superuser + restart) when the value is not `logical`, applying nothing.

#### Scenario: Preflight passes with `wal_level=logical`

- GIVEN a target database with `wal_level=logical`
- WHEN `db push` runs against a schema with `@@realtime` models
- THEN the preflight check passes and DDL is applied

#### Scenario: Preflight blocks on `wal_level=replica`

- GIVEN a target database with `wal_level=replica`
- WHEN `db push` runs against a schema with `@@realtime` models
- THEN it fails before applying any DDL, with an error naming the required `wal_level=logical`

### Requirement: Missing `REPLICATION` privilege fails preflight with a remediation

The preflight MUST also verify the connecting role has the `REPLICATION` privilege (or is a
superuser) and MUST fail with an error naming the required `GRANT` when it is absent.

#### Scenario: Preflight blocks on missing privilege

- GIVEN a target database with `wal_level=logical` but a connecting role lacking `REPLICATION`
- WHEN `db push` runs against a schema with `@@realtime` models
- THEN it fails before applying any DDL, with an error naming the required `GRANT ... REPLICATION`

### Requirement: Slot name resolution is shared with the consumer path

The DDL path (`packages/migrator` driven by `packages/cli`) MUST resolve the slot name using
the same default (`indigo_realtime`) and override (`INDIGODB_REALTIME_SLOT`) rules as
`WalSource`, so the created slot and the slot `WalSource` connects to are always the same name.

#### Scenario: Override is honored consistently

- GIVEN `INDIGODB_REALTIME_SLOT=tenant_a_realtime` set for both `db push` and the running
  `WalSource` process
- WHEN `db push` creates the slot and `WalSource` connects
- THEN both resolve to slot `tenant_a_realtime`
