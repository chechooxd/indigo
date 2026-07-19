/**
 * @indigodb/core — Attribute helpers
 *
 * Small utilities for reading values out of the AST's generic `Attribute`/
 * `AttributeValue` nodes. The `.indigo` parser stores every `@`/`@@` decorator
 * generically, so doc metadata (`@note`) and ORM semantics (`@id`, `@relation`,
 * `@default`) are all read from here. Table grouping/color now come from
 * `TableGroup` blocks, resolved separately in `resolve.ts`.
 */

import type { Attribute, AttributeValue, AttributeArg } from "@indigodb/ast";

/** Finds the first attribute with the given name. */
export function getAttr(
  attributes: Attribute[],
  name: string,
): Attribute | undefined {
  return attributes.find((a) => a.name === name);
}

/** Whether an attribute with the given name is present. */
export function hasAttr(attributes: Attribute[], name: string): boolean {
  return attributes.some((a) => a.name === name);
}

/** Returns a positional argument (empty `name`) at the given index. */
export function positionalArg(
  attr: Attribute | undefined,
  index = 0,
): AttributeArg | undefined {
  if (!attr) return undefined;
  const positionals = attr.args.filter((a) => a.name === "");
  return positionals[index];
}

/** Returns a named argument value (e.g. `fields:` in `@relation`). */
export function namedArg(
  attr: Attribute | undefined,
  name: string,
): AttributeValue | undefined {
  return attr?.args.find((a) => a.name === name)?.value;
}

/** Reads a string from an attribute value, else undefined. */
export function asString(value: AttributeValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}

/**
 * Reads a list of identifier references from an array value, e.g. the
 * `[authorId]` in `@relation(fields: [authorId])` or `@@index([a, b])`.
 */
export function asReferenceList(value: AttributeValue | undefined): string[] {
  if (!value || value.kind !== "array") return [];
  const out: string[] = [];
  for (const item of value.values) {
    if (item.kind === "reference") out.push(item.value);
    else if (item.kind === "string") out.push(item.value);
  }
  return out;
}

/** The first positional string of an attribute (e.g. `@note("hi")` → "hi"). */
export function firstString(attr: Attribute | undefined): string | undefined {
  return asString(positionalArg(attr)?.value);
}
