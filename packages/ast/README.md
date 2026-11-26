# @indigodb/ast

Shared TypeScript AST, attribute, and scalar definitions for the `.indigo` schema language.

Part of [IndigoDB](https://github.com/chechooxd/indigo) (`Node >= 22`).

## Installation

```bash
npm install @indigodb/ast
```

## Overview

`@indigodb/ast` defines the structural TypeScript interfaces shared across the compiler wrapper (`@indigodb/compiler`), parser (`@indigodb/parser`), resolver/IR (`@indigodb/core`), generator (`@indigodb/generator`), and migrator (`@indigodb/migrator`).

Main exports:

- `ScalarType` (`String`, `Int`, `Float`, `Boolean`, `DateTime`, `Json`, `BigInt`, `Bytes`, `Decimal`)
- `RelationType` (`OneToOne`, `OneToMany`, `ManyToMany`)
- `SCALAR_TYPES` (`ReadonlySet<string>`)
- AST types: `Schema`, `Datasource`, `Generator`, `Model`, `Field`, `FieldType`, `Attribute`, `AttributeArg`, `AttributeValue`, `Enum`, `EnumValue`, `Relation`, `TableGroup`

## Usage

```ts
import { ScalarType, SCALAR_TYPES, type Schema } from "@indigodb/ast";

console.log(SCALAR_TYPES.has(ScalarType.Json)); // true

function listModels(schema: Schema): string[] {
  return schema.models.map((m) => m.name);
}
```

## License

MIT
