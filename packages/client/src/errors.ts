/**
 * @indigodb/client — Typed database-error taxonomy (`client-database-errors`
 * spec).
 *
 * Real Postgres failures (unique violation, FK violation, connection loss,
 * etc.) escape `@indigodb/client` unwrapped otherwise, forcing callers to
 * string-match SQLSTATE on an untyped `Error`. `withDatabaseErrors` decorates
 * an `Executor` so every failure it raises comes out as a typed
 * `IndigoDatabaseError` — never double-wrapped, and never touching an error
 * that isn't structurally a pg `DatabaseError` in the first place.
 */

import type { Executor } from "./types.js";

/**
 * Minimal, additive taxonomy (design.md Decision "SQLSTATE detection is
 * structural, taxonomy is minimal"): `"23505"` (unique_violation) gets its
 * own code; every other SQLSTATE — including FK violations, connection
 * loss, or a missing/short code — falls into `"UNKNOWN"`. New codes can join
 * this union later without touching call sites.
 */
export type DatabaseErrorCode = "UNIQUE_VIOLATION" | "UNKNOWN";

const SQLSTATE_UNIQUE_VIOLATION = "23505";

export class IndigoDatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  /** Raw SQLSTATE string, `""` when the original error carried none. */
  readonly sqlstate: string;

  constructor(code: DatabaseErrorCode, sqlstate: string, message: string, cause: unknown) {
    super(message, { cause });
    this.name = "IndigoDatabaseError";
    this.code = code;
    this.sqlstate = sqlstate;
  }
}

/** Structural check for "looks like a pg `DatabaseError`" — never
 * `instanceof pg.DatabaseError` (design.md Decision "SQLSTATE detection is
 * structural"): `instanceof` breaks across duplicate `pg` copies in a pnpm
 * tree. A string `.code` is the only signal read. */
function sqlstateOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function classify(sqlstate: string): DatabaseErrorCode {
  return sqlstate === SQLSTATE_UNIQUE_VIOLATION ? "UNIQUE_VIOLATION" : "UNKNOWN";
}

/**
 * Innermost `Executor` decorator (design.md "Wrapping sits INSIDE the
 * extension chain"): wraps the raw driver executor BEFORE `wrapLog`/
 * `applyExtensions` compose over it, at every exec-construction site in
 * `client.ts` except the injected `db.exec` path (documented boundary in
 * `client.ts`). Never double-wraps an already-`IndigoDatabaseError`; leaves
 * every non-pg error (e.g. a `TypeError`) completely untouched.
 */
export function withDatabaseErrors(run: Executor): Executor {
  return async (sql, params) => {
    try {
      return await run(sql, params);
    } catch (err) {
      if (err instanceof IndigoDatabaseError) throw err;
      const sqlstate = sqlstateOf(err);
      if (sqlstate === undefined) throw err;
      const code = classify(sqlstate);
      throw new IndigoDatabaseError(
        code,
        sqlstate,
        `IndigoDatabaseError: ${code} (SQLSTATE ${sqlstate})`,
        err,
      );
    }
  };
}
