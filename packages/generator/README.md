# @indigodb/generator

Generates the strongly-typed TypeScript ORM client bound to `@indigodb/client` from an IndigoDB `ResolvedSchema`.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/generator
```

## Usage

```ts
import { writeFileSync } from "node:fs";
import { parse, resolve } from "@indigodb/core";
import { generateClient } from "@indigodb/generator";

const schema = resolve(
  parse(`
  Table User {
    id    Int    @id @default(autoincrement())
    email String @unique
  }
  `),
);

const code = generateClient(schema);
writeFileSync("src/generated/indigo.ts", code, "utf8");
```

Typically invoked via `npx indigodb generate` (`@indigodb/cli`).

## Exports

- `generateClient(schema: ResolvedSchema): string`

## License

MIT
