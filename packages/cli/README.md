# @indigodb/cli

Command-line interface for IndigoDB: scaffold `.indigo` schemas, push/pull PostgreSQL databases, run versioned DDL + data migrations, generate typed TypeScript clients, run the realtime SSE/channels daemon, and launch Studio.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install -D @indigodb/cli
npm install @indigodb/client
```

Or run commands directly with `npx indigodb <command>`.

## Commands

| Command | Description |
| --- | --- |
| `indigodb init` | Scaffold `schema.indigo` and `.env` |
| `indigodb db push` | Sync `schema.indigo` directly to PostgreSQL (supports `--print`) |
| `indigodb db pull` | Introspect an existing PostgreSQL database into `schema.indigo` |
| `indigodb migrate dev --name <name>` | Diff against shadow DB, write SQL migration (with `--create-only`, `--empty`, `--force`) |
| `indigodb migrate deploy` | Apply pending `migration.sql` (+ optional transactional `data.sql`) |
| `indigodb migrate status` | Inspect applied vs. pending migrations and checksum drift |
| `indigodb migrate resolve` | Mark a migration `--applied <id>` or `--rolled-back <id>` |
| `indigodb generate` | Emit typed TypeScript client from `schema.indigo` |
| `indigodb realtime` | Start the standalone HTTP SSE + channels + metrics daemon (`--port`, `--allow-origin`) |
| `indigodb studio` | Launch the visual Studio workspace (`--port`, `--host`, `--read-only`, `--no-open`) |

## Quickstart

```bash
npx indigodb init
npx indigodb db push
npx indigodb generate
npx indigodb studio
```

Run `npx indigodb --help` or `npx indigodb <command> --help` for full flags and environment variables (`DATABASE_URL`, `INDIGODB_STUDIO_PASSWORD`, `INDIGODB_REALTIME_SECRET`, `INDIGODB_REALTIME_ALLOWED_ORIGINS`).

## License

MIT
