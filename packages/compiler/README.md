# @indigodb/compiler

WebAssembly compiler (compiled from Rust) for the `.indigo` schema language, with dedicated Node and browser entry points.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/compiler
```

## Usage

On **Node.js**, the WASM module is initialized synchronously at module load (`initCompiler()` is a resolved no-op). In **browsers**, call `await initCompiler()` once before invoking compiler functions:

```ts
import { initCompiler, compileSchema, parseSchemaWithSpans } from "@indigodb/compiler";

await initCompiler(); // required in browsers; no-op in Node.js

const result = compileSchema(`
Table User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`);

if ("errors" in result) {
  console.error(result.errors);
} else {
  console.log(result.schema, result.resolved, result.validationErrors);
}
```

## Exports

- `initCompiler()` — initializes the WASM module (async in browsers, synchronous no-op in Node)
- `parseSchema(source)` — parses `.indigo` source into `{ schema }` or `{ errors }`
- `parseSchemaWithSpans(source)` — parses with UTF-16 side-channel `SpanIndex`
- `validateSchema(schema)` — validates a parsed `Schema` AST
- `resolveSchema(schema)` — lowers a `Schema` AST into resolved IR data
- `compileSchema(source)` — single-call parse + validate + resolve
- Types: `CompilerError`, `ParseResult`, `CompileResult`, `ParseWithSpansResult`, `SourceSpan`, `ModelSpan`, `FieldSpan`, `AttributeSpan`, `SpanIndex`

## License

MIT
