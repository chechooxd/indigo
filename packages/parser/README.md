# @indigodb/parser

Thin TypeScript parser API for `.indigo` schemas backed by `@indigodb/compiler` (Rust → WASM).

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/parser
```

## Usage

```ts
import { parse, IndigoParseError } from "@indigodb/parser";

try {
  const schema = parse(`
  Table Post {
    id    Int    @id @default(autoincrement())
    title String
  }
  `);
  console.log(schema.models);
} catch (err) {
  if (err instanceof IndigoParseError) {
    console.error(err.errors); // 1-based line/column diagnostics
  }
}
```

In browser environments, initialize `@indigodb/compiler` (`await initCompiler()`) before calling `parse()`.

## Exports

- `parse(input: string): Schema`
- `IndigoParseError` (`.errors: ParseErrorDetail[]`)
- `ParseErrorDetail`, `Schema`

## License

MIT
