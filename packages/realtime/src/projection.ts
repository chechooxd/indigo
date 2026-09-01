/**
 * @indigodb/realtime — column projection (`realtime-column-projection`,
 * design.md decisions 2-3, "Three-state on purpose")
 *
 * Shared by `WalSource` and `PgNotifySource` (design decision 7): resolves a
 * table's `@@realtime(columns: [...])` allowlist once, in each source's
 * constructor, and narrows `new`/`old` row objects to it at the single
 * write-time enforcement point. `event.pk` is never passed through here —
 * identity is built separately from `names.primaryKey` and is never
 * narrowed (design decision 6).
 */

import type { ResolvedTable } from "@indigodb/core";

/**
 * Resolves `table.realtimeColumns` into a projection set.
 *
 * Three states, not two — this distinction IS the feature (design.md,
 * "Three-state on purpose"):
 *   - `null`  — the attribute's `columns` argument is absent (bare
 *     `@@realtime`). Every column streams, byte-identical to behavior
 *     before this capability existed.
 *   - a non-empty `Set<string>` — narrow to exactly those physical column
 *     names.
 *   - an EMPTY `Set<string>` — `columns: []` was declared explicitly.
 *     Identity-only: `new`/`old` project down to `{}`. This must never be
 *     conflated with `null`; collapsing it there would turn the strictest
 *     declaration into a full-row leak, the exact fail-open this capability
 *     exists to prevent.
 */
export function projectionSet(table: ResolvedTable): Set<string> | null {
  if (table.realtimeColumns == null) return null;
  return new Set(table.realtimeColumns);
}

/**
 * Narrows `row`'s own entries to `allow`. `allow === null` returns `row`
 * unchanged (bare `@@realtime` — no narrowing). A non-null `allow` —
 * including an EMPTY `Set` — filters `row` down to exactly the allowlisted
 * keys, returning `{}` for an empty set. There is deliberately no
 * `!allow.size` shortcut anywhere in this function: that would fall back to
 * "stream everything" for the empty-list case, inverting decision 5b's
 * "identity only, no body" guarantee into a full-row leak.
 *
 * Filters entries only — never compacts. A listed key whose value is `null`
 * stays present as `{key: null}`; "narrowed" and "compacted" are different
 * bugs (RWS-7).
 */
export function project(
  row: Record<string, unknown>,
  allow: Set<string> | null,
): Record<string, unknown> {
  if (allow === null) return row;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (allow.has(key)) out[key] = row[key];
  }
  return out;
}
