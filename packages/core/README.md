# @indigodb/core

Relational intermediate representation (IR), schema validator, resolver, and `.indigo` printer for IndigoDB.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/core
```

## Usage

```ts
import { initCompiler, parse, validate, resolve, printSchema } from "@indigodb/core";

await initCompiler(); // no-op in Node.js; required in browsers

const ast = parse(`
Table User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
`);

const errors = validate(ast);
if (errors.length === 0) {
  const ir = resolve(ast);
  console.log(printSchema(ir));
}
```

## Key Exports

- Parsing & init: `initCompiler`, `parse`, `parseWithSpans`, `IndigoParseError`
- Validation & lowering: `validate`, `resolve`
- Printing: `printSchema`, `PrintOptions`, `IndigoPrintError`
- Attribute helpers: `getAttr`, `hasAttr`, `positionalArg`, `namedArg`, `asString`, `asReferenceList`, `firstString`
- IR types: `ResolvedSchema`, `ResolvedTable`, `ResolvedColumn`, `ResolvedIndex`, `ResolvedRelation`, `ResolvedEnum`, `ResolvedTableGroup`, `AllowRule`, `AllowAction`, `ValidationError`

## License

MIT
