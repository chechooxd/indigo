/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ERD patch engine (`studio-erd-editing`, design D2–D4).
 *
 * `applyErdEdit` is the SOLE edit-applying export of this module, and this
 * module must NEVER export or return a `SpanIndex`, a `SourceSpan`, or any
 * other value a caller could cache and later replay against a different
 * buffer. `applyErdEdit` calls `parseWithSpans` on `currentText` and
 * applies the resulting patch in the same synchronous call — there is no
 * window in which a stale span can exist, because no span is ever handed
 * back to a caller (design D3). This is a review-time constraint, not a
 * type-level guarantee: no typecheck catches a future re-export of
 * `parseWithSpans` from this file. Task 3.8's export-surface test is the
 * only automated enforcement.
 *
 * `applyEdits` is the low-level, anchor-agnostic splice primitive: it
 * accepts already-resolved `{start, end, text}` ranges (UTF-16 code-unit
 * offsets, end-exclusive) and is safe to export because it never touches a
 * span or a parse result — it has no way to go stale on its own.
 */

import { parseWithSpans, IndigoParseError } from '@indigodb/core';
import type { ModelSpan } from '@indigodb/core';

/** A resolved, already-anchored text replacement. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies `edits` to `source`. Sorts descending by `start` and splices
 * right-to-left so earlier offsets stay valid, and throws on any pair of
 * overlapping ranges rather than silently applying an ambiguous result
 * (design D4). "Untouched by construction": every byte of `source` outside
 * the union of the edit ranges is copied into the result verbatim.
 */
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);

  for (let i = 1; i < sorted.length; i++) {
    const later = sorted[i - 1];
    const earlier = sorted[i];
    if (earlier.end > later.start) {
      throw new Error(
        `Overlapping edit ranges: [${earlier.start}, ${earlier.end}) and [${later.start}, ${later.end})`,
      );
    }
  }

  let result = source;
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * The edit vocabulary an ERD action can express. This PR (`studio-erd-designer`
 * PR3a, the patch engine slice) implements only `renameTable`, enough to
 * prove the engine's anchor resolution and refusal paths end-to-end.
 * `addTable` (PR3b), `deleteTable`'s referenced-table refusal and
 * `renameTable`'s relation-preservation guarantee (Phase 4), field CRUD
 * (Phase 5), and `addRelation` (Phase 6) widen this union as those slices
 * land — see `openspec/changes/studio-erd-designer/tasks.md`.
 */
export type ErdEdit = { kind: 'renameTable'; from: string; to: string };

export type ErdEditResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'parse-failed' | 'anchor-missing'; message: string };

function findModel(models: ModelSpan[], name: string): ModelSpan | undefined {
  return models.find((model) => model.name === name);
}

/**
 * Applies one `ErdEdit` against `currentText`. Parses `currentText` fresh
 * on every call (via `parseWithSpans`) and locates the edit's anchor in
 * that fresh result — never from a previously held span. A parse failure
 * or a missing anchor refuses the edit and leaves `currentText` untouched:
 * there is no fallback to a cached position (design D3).
 */
export function applyErdEdit(currentText: string, edit: ErdEdit): ErdEditResult {
  let spans;
  try {
    ({ spans } = parseWithSpans(currentText));
  } catch (error) {
    if (error instanceof IndigoParseError) {
      return { ok: false, reason: 'parse-failed', message: error.message };
    }
    throw error;
  }

  switch (edit.kind) {
    case 'renameTable': {
      const model = findModel(spans.models, edit.from);
      if (!model) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Table "${edit.from}" was not found in the current buffer.`,
        };
      }
      const text = applyEdits(currentText, [
        { start: model.nameToken.start, end: model.nameToken.end, text: edit.to },
      ]);
      return { ok: true, text };
    }
  }
}
