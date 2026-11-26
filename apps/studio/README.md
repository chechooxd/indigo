# @indigodb/studio

Visual workspace bundle for IndigoDB — interactive ER diagram + live `.indigo` editor, table/data browser, read-only SQL query console, and schema documentation.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Usage

`@indigodb/studio` ships the compiled frontend SPA served by `@indigodb/cli`'s `indigodb studio` command:

```bash
npm install -D @indigodb/cli
npx indigodb studio
```

By default, `indigodb studio` binds to `127.0.0.1:5555` and opens your browser to explore your schema, live PostgreSQL rows, SQL console, and generated docs.

For remote/shared hosts, guardrails (`--host`, `--read-only`, `--query-timeout`, `--query-row-cap`, `INDIGODB_STUDIO_PASSWORD`, `--audit-log`) are documented in `npx indigodb studio --help`.

## License

MIT
