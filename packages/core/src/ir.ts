/**
 * @indigodb/core — Relational IR
 *
 * The `ResolvedSchema` is the normalized, relational intermediate representation
 * produced from a parsed `.indigo` `Schema` AST. It is the single contract that
 * every downstream consumer (migrator, generator, docs, client, studio) reads,
 * so nobody re-derives table/column/relation structure from the raw AST.
 */

import type { RelationType, Datasource } from "@indigodb/ast";

// ─── Defaults ──────────────────────────────────────────────────────────────

/**
 * A resolved column default. Literal values (`@default("USER")`, `@default(0)`)
 * become `value`; generator functions (`@default(now())`, `@default(uuid())`,
 * `@default(autoincrement())`) become `function`.
 */
export type ResolvedDefault =
  | { kind: "value"; value: string | number | boolean }
  | { kind: "function"; name: string };

// ─── Columns ─────────────────────────────────────────────────────────────────

/** A physical column derived from a scalar or enum field. */
export interface ResolvedColumn {
  /** Field name as written in the schema (e.g. "authorId"). */
  name: string;
  /** Physical column name (`@map` override, else `name`). */
  dbName: string;
  /** Scalar type name or enum name. */
  type: string;
  /** Whether `type` refers to an enum rather than a built-in scalar. */
  isEnum: boolean;
  /** Whether the column allows NULL (optional field, `Type?`). */
  nullable: boolean;
  /** Whether the column is (part of) the primary key (`@id`). */
  isPk: boolean;
  /** Whether the column has a UNIQUE constraint (`@unique`). */
  unique: boolean;
  /** Whether the column auto-increments (`@default(autoincrement())`). */
  autoincrement: boolean;
  /** Resolved default value, if any. */
  default?: ResolvedDefault;
  /** Documentation note (`@note("...")`). */
  note?: string;
  /**
   * Physical type override from a `@db.X(...)` attribute (e.g.
   * `{ name: "VarChar", args: ["255"] }`), populated only when the field
   * carries a native-type attribute that passed validation. Absent (not
   * `null`) when no override applies — the migrator falls back to
   * `mapScalarToPg`. SQL-dialect rendering lives in `@indigodb/migrator`,
   * not here.
   */
  nativeType?: { name: string; args: string[] };
}

// ─── Constraints ─────────────────────────────────────────────────────────────

/** A foreign key produced by a `@relation(fields: [...], references: [...])`. */
export interface ForeignKey {
  /** Local physical columns holding the FK. */
  columns: string[];
  /** Referenced table physical name. */
  refTable: string;
  /** Referenced physical columns. */
  refColumns: string[];
  /** Optional constraint name. */
  name?: string;
  /**
   * ON DELETE behaviour (`@relation(onDelete: ...)`). Interpolated verbatim
   * into executed DDL by `@indigodb/migrator` — the compiler guarantees this
   * is already SQL-ready text (e.g. `"CASCADE"`, `"SET NULL"`) from a closed,
   * validated domain, never the raw schema spelling.
   */
  onDelete?: string;
  /**
   * ON UPDATE behaviour (`@relation(onUpdate: ...)`), same SQL-ready text
   * contract as `onDelete`. Optional because older `.snapshot.json` files
   * written before this key existed have no `onUpdate` at all.
   *
   * Tracked incompleteness: resolved into the IR, but `@indigodb/migrator`
   * does not yet render `ON UPDATE` DDL from it — follow-up change:
   * `fix-migrator-correctness`.
   */
  onUpdate?: string;
}

/** A secondary index (`@@index`) or composite unique (`@@unique`). */
export interface ResolvedIndex {
  /** Physical columns covered by the index. */
  columns: string[];
  /** Whether it is a UNIQUE index. */
  unique: boolean;
  /** Optional index name (`name:` argument); absent when auto-derived. */
  name?: string;
  /**
   * Postgres index access method (`type:` argument). Absent means the
   * default btree — an explicit `type: btree` in the schema also
   * canonicalizes to absent, so it never diffs against an implicit btree
   * index.
   */
  type?: "btree" | "gin" | "gist" | "hash";
}

// ─── Relations (for the client / ERD) ────────────────────────────────────────

/** A relation field on a model (not a physical column). */
export interface ResolvedRelation {
  /**
   * Relation field name as written in the schema (e.g. "author", "posts") —
   * distinct from `relationName`, the optional `@relation("Name", ...)`
   * label used to pair this field with its inverse side.
   */
  name: string;
  /** Target model name. */
  targetModel: string;
  /** Cardinality. */
  type: RelationType;
  /** Whether the relation field is a list (`Post[]`). */
  list: boolean;
  /** Whether the relation field is optional (`User?`). */
  optional: boolean;
  /**
   * Local FK columns, when this side holds the foreign key. On an inverse
   * side (`inverse: true`) these are populated from the paired counterpart's
   * FK columns, which live on the OTHER model's table — not on this
   * relation's own owning table.
   */
  fkColumns: string[];
  /**
   * Referenced columns on the target model. Same inverse-side caveat as
   * `fkColumns`: on an inverse side these mirror the counterpart's
   * `refColumns`, not a reference declared by this field itself.
   */
  refColumns: string[];
  /** The positional `@relation("Name", ...)` literal, when declared. */
  relationName?: string;
  /**
   * `true` when this relation is the paired inverse side of another
   * relation field (its FK/reference columns were populated by the
   * cross-model pairing pass, not declared directly on this field).
   * Absent (never `false`) on FK-holding / unpaired sides.
   */
  inverse?: true;
}

// ─── Row-level security (`@@allow`) ─────────────────────────────────────────

/**
 * Canonical `@@allow` action — never the `write`/`all` alias, which the
 * compiler's `resolve.rs` expands into these four at resolve time (design
 * decision #6).
 */
export type AllowAction = "create" | "read" | "update" | "delete";

/**
 * One side of a resolved `@@allow` equality condition. `field` always
 * carries the physical `dbName` (design decision #7), never the logical
 * field name, so a `@map` rename remaps allow rules for free via
 * `remapPhysicalNames`. No cast text is carried here — `@indigodb/migrator`
 * derives the Postgres cast from the referenced column's SQL type
 * (decision #8), not the compiler.
 */
export type AllowOperand =
  | { kind: "field"; name: string }
  /** Always `"userId"` in slice 1 — the closed claim vocabulary. */
  | { kind: "claim"; name: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };

/**
 * One resolved `@@allow` rule, already expanded from any `write`/`all`
 * alias into a single canonical action. Operand order follows declaration
 * order in the schema — the compiler never normalizes sides.
 */
export interface AllowRule {
  action: AllowAction;
  left: AllowOperand;
  right: AllowOperand;
}

// ─── Tables ──────────────────────────────────────────────────────────────────

export interface ResolvedTable {
  /** Model name as written (PascalCase, e.g. "User"). */
  name: string;
  /** Physical table name (`@@map` override, else `name`). */
  dbName: string;
  /** Physical columns. */
  columns: ResolvedColumn[];
  /** Primary key physical column names. */
  primaryKey: string[];
  /** Foreign keys held by this table. */
  foreignKeys: ForeignKey[];
  /** Secondary indexes / composite uniques. */
  indexes: ResolvedIndex[];
  /** Relation fields (both FK-holding and inverse sides). */
  relations: ResolvedRelation[];
  /** Documentation note (`@@note("...")`). */
  note?: string;
  /** Whether the table emits realtime change events (`@@realtime`). */
  realtime?: boolean;
  /** ERD colour, inherited from the containing `TableGroup`'s `color`, if any. */
  color?: string;
  /** Name of the `TableGroup` this table belongs to, if any. */
  group?: string;
  /**
   * Resolved `@@allow` rules, one entry per canonical action after alias
   * expansion. Declared LAST and absent (not `null`) when the model has no
   * `@@allow`, so every pre-existing `.snapshot.json` stays byte-identical.
   */
  allow?: AllowRule[];
}

/** A single enum member: its schema name plus its physical (`@map`) label. */
export interface ResolvedEnumMember {
  name: string;
  dbName: string;
}

export interface ResolvedEnum {
  name: string;
  values: string[];
  /**
   * Additive alongside `values` — `values` keeps its existing consumers
   * (`postgres.ts`, `migrate.ts`, `client.ts`, `schema-adapter.ts`)
   * unchanged. Optional because older `.snapshot.json` files written before
   * this key existed have no `members` at all.
   *
   * Tracked incompleteness: reaches the IR, but `@indigodb/migrator` still
   * renders `values` only — follow-up change: `fix-migrator-correctness`.
   */
  members?: ResolvedEnumMember[];
}

/** A resolved `TableGroup Name { ... }` block: a named, colored cluster of tables. */
export interface ResolvedTableGroup {
  /** Group display name. */
  name: string;
  /** Accent color inherited by every table in `tables`. */
  color?: string;
  /** Names of the tables (models) belonging to this group. */
  tables: string[];
}

/** The fully-resolved relational model of an `.indigo` schema. */
export interface ResolvedSchema {
  tables: ResolvedTable[];
  enums: ResolvedEnum[];
  /** Table group declarations, in source order. */
  tableGroups: ResolvedTableGroup[];
  /** First datasource block, if declared. */
  datasource?: Datasource;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationError {
  message: string;
  model?: string;
  field?: string;
}
