/**
 * @indigodb/migrator — Migration plan contract
 *
 * `planMigration` (see `migrate.ts`) returns one ordered, phase-tagged
 * statement list plus any diagnostics that must block generation, instead
 * of a bare `string[]`. A flat array cannot say "this statement must run
 * outside the migration transaction", cannot say "generation is refused,
 * here is why" without a second parallel traversal of the same diff, and
 * gives the migration runner no structure to act on. `MigrationPlan`
 * carries all three in one pass, one canonical statement order.
 */

/**
 * Execution phase for a single migration statement.
 * - `"transaction"`: runs inside the migration's `BEGIN`/`COMMIT` block.
 * - `"pre-transaction"`: must run BEFORE the transaction starts (e.g.
 *   `ALTER TYPE ... ADD VALUE`, which PostgreSQL refuses to let a later
 *   statement in the SAME transaction use).
 */
export type MigrationPhase = "pre-transaction" | "transaction";

/**
 * Whether applying a statement can lose or corrupt existing data (or fail
 * outright against a populated table): `"safe"` statements never do;
 * `"requires-force"` statements do (or PostgreSQL may refuse them, e.g.
 * `SET NOT NULL` against a row already holding `NULL`) and must be
 * explicitly confirmed before `migrate dev`/`migrate deploy` applies them.
 */
export type MigrationRisk = "safe" | "requires-force";

/**
 * One SQL statement, tagged with the phase it must execute in and its
 * destructiveness. A discriminated union on `risk` — rather than an
 * optional `impact?: string` alongside a flat `risk` — makes "tagged
 * requires-force with no human-readable impact" unrepresentable: every
 * requires-force statement is constructed with its impact, by construction,
 * never left to a default.
 */
export type MigrationStatement =
  | { sql: string; phase: MigrationPhase; risk: "safe" }
  | { sql: string; phase: MigrationPhase; risk: "requires-force"; impact: string };

/** Stable, machine-readable reason a migration's generation was refused. */
export type MigrationDiagnosticCode =
  | "ambiguous-column-remap"
  | "enum-value-removed"
  | "required-column-without-default";

/**
 * A refusal reported ALONGSIDE the plan's statements, not instead of them —
 * a plan with diagnostics still lists every statement it would otherwise
 * have emitted; callers that must refuse generation check
 * `diagnostics.length`, they never receive a silently-filtered plan.
 */
export interface MigrationDiagnostic {
  code: MigrationDiagnosticCode;
  message: string;
  table?: string;
  column?: string;
  enumName?: string;
  values?: string[];
}

/**
 * The full result of diffing two schema states: every statement needed to
 * migrate from `prev` to `next`, in execution order, plus any diagnostics
 * that must block generation.
 */
export interface MigrationPlan {
  statements: MigrationStatement[];
  diagnostics: MigrationDiagnostic[];
}

/** Opens a block of statement text that must run outside the transaction. */
export const NO_TRANSACTION_BEGIN = "-- indigo:begin no-transaction";
/** Closes a block opened by `NO_TRANSACTION_BEGIN`. */
export const NO_TRANSACTION_END = "-- indigo:end no-transaction";

/**
 * Splits a rendered migration file back into its pre-transaction statements
 * — each meant to be sent as its OWN `client.query()` call, one at a time
 * (`pg`'s simple query protocol wraps a multi-statement string in an
 * implicit transaction, so a single call for this whole section would put
 * `ADD VALUE` back inside a transaction and defeat the entire point) — and
 * the remaining transactional body.
 *
 * Not a SQL parser: it splits on blank lines, the exact separator
 * `renderMigrationSql` joins statements with, and recognizes a block as
 * pre-transaction only when its first and last lines are the marker pair
 * above. A file with no marker block returns it unchanged as `transactional`
 * — this is LOAD-BEARING for backward compatibility: pre-existing
 * `migrations/*.sql` files on disk carry no marker, so they stay fully
 * transactional exactly as before.
 */
export function splitMigrationSql(
  sql: string,
): { preTransaction: string[]; transactional: string } {
  if (sql.length === 0) return { preTransaction: [], transactional: "" };

  const blocks = sql.split("\n\n");
  const transactionalBlocks: string[] = [];
  const preTransaction: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    // When the marker block is the LAST block in the file, `renderMigrationSql`'s
    // single trailing "\n" lands inside THIS block (only one "\n", not "\n\n",
    // so it survives the split), leaving an empty final line after the END
    // marker. Strip exactly that one trailing blank line before checking the
    // marker shape — detection only; the ORIGINAL `block` (with its trailing
    // newline intact) is still what gets pushed to `transactionalBlocks` below
    // when a block turns out not to be marked, so unmarked byte-for-byte output
    // is unaffected.
    const markerLines = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    const isMarked =
      markerLines[0] === NO_TRANSACTION_BEGIN &&
      markerLines[markerLines.length - 1] === NO_TRANSACTION_END;
    if (!isMarked) {
      transactionalBlocks.push(block);
      continue;
    }
    const statement = markerLines
      .slice(1, -1)
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .trim();
    if (statement) preTransaction.push(statement);
  }

  return { preTransaction, transactional: transactionalBlocks.join("\n\n") };
}

/**
 * Prefix of the comment line `renderMigrationSql` (see `migrate.ts`) writes
 * directly above every `requires-force` statement in a rendered migration
 * file: `-- indigo:requires-force <impact>`. This is the ONLY carrier that
 * reaches `migrate deploy` — deploy reads `migration.sql` off disk and never
 * re-runs `planMigration`, so an in-memory `risk` tag alone cannot gate it,
 * and the spec forbids re-parsing SQL to rediscover destructiveness. One
 * marker line serves three jobs: file annotation, deploy's gate input, and
 * (verbatim) the refusal message's bulleted impact.
 */
export const REQUIRES_FORCE_MARKER = "-- indigo:requires-force ";

/**
 * Extracts every `requires-force` impact string from a rendered migration
 * file, in file order — `migrate deploy`'s gate input. Not a SQL parser:
 * it scans line-by-line for `REQUIRES_FORCE_MARKER`, mirroring
 * `splitMigrationSql`'s "not a parser" contract above. A file with no
 * marker line returns `[]` — LOAD-BEARING for backward compatibility:
 * migration files written before this classifier existed carry no marker,
 * so they stay ungated exactly as they were.
 */
export function scanRequiresForce(sql: string): string[] {
  const impacts: string[] = [];
  for (const line of sql.split("\n")) {
    if (line.startsWith(REQUIRES_FORCE_MARKER)) {
      impacts.push(line.slice(REQUIRES_FORCE_MARKER.length));
    }
  }
  return impacts;
}
