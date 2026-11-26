# @indigodb/migrator

PostgreSQL schema diffing, DDL generation (`db push` & versioned migrations), shadow-database replay, destructive-change safety guards, and live catalog introspection (`db pull`) for IndigoDB.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/migrator
```

## Usage

```ts
import { parse, resolve } from "@indigodb/core";
import { planMigration, renderMigrationSql, renderPushSql } from "@indigodb/migrator";

const prev = resolve(parse(`Table User { id Int @id @default(autoincrement()) }`));
const next = resolve(
  parse(`
  Table User {
    id    Int    @id @default(autoincrement())
    email String @unique
  }
  `),
);

// Idempotent db push script
const pushSql = renderPushSql(next);

// Versioned migration plan + SQL
const plan = planMigration(prev, next);
if (plan.diagnostics.length > 0) {
  console.warn("Blocking/force-required diagnostics:", plan.diagnostics);
}
const migrationSql = renderMigrationSql(plan);
```

## Key Exports

- **Versioned migrations**: `planMigration`, `renderMigrationSql`, `splitMigrationSql`, `scanRequiresForce`
- **Direct sync & PostgreSQL DDL**: `renderPushSql`, `renderIndexDdl`, `renderPolicy`, `renderRlsBlock`, `renderDisableRls`, `renderRealtimeLogSql`, `renderPublicationSql`, `renderReplicationPreSql`, `computeBuckets`
- **Introspection & shadow replay**: `introspectResolvedSchema`, `buildShadowSchema`, `ShadowReplayError`
- **Phase markers & types**: `NO_TRANSACTION_BEGIN`, `NO_TRANSACTION_END`, `REQUIRES_FORCE_MARKER`, `MigrationPlan`, `MigrationDiagnostic`

## License

MIT
