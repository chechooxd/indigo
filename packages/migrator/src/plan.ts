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

/** One SQL statement, tagged with the phase it must execute in. */
export interface MigrationStatement {
  sql: string;
  phase: MigrationPhase;
}

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
