/**
 * @indigodb/ast
 *
 * Abstract Syntax Tree definitions for .indigo schema files.
 * These types represent the parsed structure of an IndigoDB schema
 * and serve as the contract between the parser, generator, and migrator.
 */

// ─── Scalar Types ────────────────────────────────────────────────────────────

/** Built-in scalar types supported by the .indigo schema language. */
export enum ScalarType {
  String = "String",
  Int = "Int",
  Float = "Float",
  Boolean = "Boolean",
  DateTime = "DateTime",
  Json = "Json",
  BigInt = "BigInt",
  Bytes = "Bytes",
  Decimal = "Decimal",
}

// ─── Relation Types ──────────────────────────────────────────────────────────

/** Describes the cardinality of a relationship between two models. */
export enum RelationType {
  OneToOne = "OneToOne",
  OneToMany = "OneToMany",
  ManyToMany = "ManyToMany",
}

// ─── Attribute Values ────────────────────────────────────────────────────────

/** Represents the possible value types within an attribute argument. */
export type AttributeValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "reference"; value: string }
  | { kind: "function"; name: string; args: AttributeValue[] }
  | { kind: "array"; values: AttributeValue[] };

// ─── Attributes ──────────────────────────────────────────────────────────────

/** A single argument passed to an attribute (positional or named). */
export interface AttributeArg {
  /** Argument name. Empty string for positional arguments. */
  name: string;
  /** Argument value. */
  value: AttributeValue;
}

/**
 * Represents an attribute decorator on a field or model block.
 * Examples: @id, @unique, @default(autoincrement()), @@index([email])
 */
export interface Attribute {
  /**
   * Namespace prefix for `@ns.Name` syntax (e.g. `"db"` in `@db.VarChar`).
   * Absent for ordinary attributes (`@unique`, `@map`).
   */
  namespace?: string;
  /** Attribute name without the @ prefix (e.g., "id", "unique", "default"). */
  name: string;
  /** Arguments passed to the attribute. Empty array if none. */
  args: AttributeArg[];
}

// ─── Field Type ──────────────────────────────────────────────────────────────

/**
 * Describes the type of a field, including modifiers.
 * Examples: String, String?, Int[], User
 */
export interface FieldType {
  /** Type name — either a ScalarType value or a reference to a Model/Enum. */
  name: string;
  /** Whether this is a built-in scalar type. */
  scalar: boolean;
  /** Whether the field is a list type (e.g., Post[]). */
  list: boolean;
  /** Whether the field is optional (e.g., String?). */
  optional: boolean;
}

// ─── Field ───────────────────────────────────────────────────────────────────

/** A single field within a model definition. */
export interface Field {
  /** Field name (e.g., "id", "email", "posts"). */
  name: string;
  /** Type information for this field. */
  type: FieldType;
  /** Attributes applied to this field (e.g., @id, @unique). */
  attributes: Attribute[];
}

// ─── Model ───────────────────────────────────────────────────────────────────

/**
 * Represents a model block in the schema.
 * Maps to a database table.
 */
export interface Model {
  /** Model name (e.g., "User", "Post"). */
  name: string;
  /** Fields declared in the model body. */
  fields: Field[];
  /** Block-level attributes (e.g., @@index, @@unique, @@map). */
  attributes: Attribute[];
}

// ─── Table Group ─────────────────────────────────────────────────────────────

/**
 * A `TableGroup` block: a named, colored cluster of tables for the ERD.
 * `color` is set once on the group and inherited by every table it contains.
 */
export interface TableGroup {
  /** Group display name (e.g. "Order Management"). */
  name: string;
  /** Accent color inherited by every table in `tables` (e.g. "#818cf8"). */
  color?: string;
  /** Names of the models (tables) that belong to this group. */
  tables: string[];
}

// ─── Enum ────────────────────────────────────────────────────────────────────

/** A single value within an enum declaration. */
export interface EnumValue {
  /** Value name (e.g., "ADMIN", "USER"). */
  name: string;
  /** Attributes on this enum value (e.g., @map("admin")). */
  attributes: Attribute[];
}

/** Represents an enum block in the schema. */
export interface Enum {
  /** Enum name (e.g., "Role", "Status"). */
  name: string;
  /** Declared values. */
  values: EnumValue[];
}

// ─── Relation (Resolved) ─────────────────────────────────────────────────────

/**
 * A fully-resolved relation between two models.
 * Computed after parsing from @relation attributes.
 */
export interface Relation {
  /** Relation name (from the @relation attribute or auto-generated). */
  name: string;
  /** Cardinality of the relation. */
  type: RelationType;
  /** Source model name. */
  from: string;
  /** Source field name(s) (foreign key columns). */
  fromFields: string[];
  /** Target model name. */
  to: string;
  /** Target field name(s) (referenced columns). */
  toFields: string[];
}

// ─── Datasource ──────────────────────────────────────────────────────────────

/** Represents a datasource block defining the database connection. */
export interface Datasource {
  /** Block name (e.g., "db"). */
  name: string;
  /** Database provider identifier (e.g., "postgresql", "mysql", "sqlite"). */
  provider: string;
  /** Connection URL — may be a literal string or an env() function call. */
  url: AttributeValue;
}

// ─── Generator ───────────────────────────────────────────────────────────────

/** Represents a generator block configuring code generation. */
export interface Generator {
  /** Block name (e.g., "client"). */
  name: string;
  /** Generator provider (e.g., "indigodb-client-ts"). */
  provider: string;
  /** Optional output directory for generated code. */
  output?: string;
}

// ─── Schema (Root Node) ──────────────────────────────────────────────────────

/**
 * The root AST node representing an entire .indigo schema file.
 * This is the output of the parser and the input to both the
 * generator and migrator.
 */
export interface Schema {
  /** Datasource configurations. */
  datasources: Datasource[];
  /** Generator configurations. */
  generators: Generator[];
  /** Model definitions (map to database tables). */
  models: Model[];
  /** Enum definitions. */
  enums: Enum[];
  /** Table group declarations (`TableGroup Name { ... }`). */
  tableGroups: TableGroup[];
}

/**
 * Helper: set of all scalar type names for quick lookup.
 */
export const SCALAR_TYPES: ReadonlySet<string> = new Set(
  Object.values(ScalarType),
);
