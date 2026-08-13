/**
 * Isolated `erasableSyntaxOnly` proof for the generator's const-object enum
 * emission (client-query-type-safety spec "Enum-bearing model compiles
 * under erasableSyntaxOnly"). Deliberately standalone — NOT importing
 * `ModelDelegate`/`delegate.ts`, which uses TS constructor parameter
 * properties (non-erasable syntax) unrelated to this proof; pulling it in
 * would fail `erasableSyntaxOnly` for a reason that has nothing to do with
 * enum emission. Mirrors exactly what `@indigodb/generator`'s `client.ts`
 * now emits for an enum column.
 */

export const Status = {
  Active: "active",
  Inactive: "inactive",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

interface Widget {
  id: number;
  status: Status;
}

function setStatus(s: Status): void {
  void s;
}

const widget: Widget = { id: 1, status: Status.Active };
setStatus(widget.status);
setStatus(Status.Inactive);
