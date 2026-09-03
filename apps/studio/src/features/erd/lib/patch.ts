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

import { parseWithSpans, resolve, IndigoParseError } from '@indigodb/core';
import type { ModelSpan, FieldSpan } from '@indigodb/core';

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
 * The edit vocabulary an ERD action can express. PR3a (the patch engine
 * slice) implemented only `renameTable`. PR3b added `addTable`, an
 * insertion rather than a replace — it has no existing anchor to locate, so
 * it never refuses with `anchor-missing`; only a fresh-parse failure can
 * refuse it. Phase 4 added `deleteTable`. Phase 5 (this slice) adds field
 * CRUD (`addField`/`editField`/`deleteField`), anchored on `FieldSpan`s
 * nested inside each `ModelSpan.fields` — the same fresh-parse-per-call
 * discipline applies: a field is looked up in THIS call's `spans`, never
 * from a caller-held reference. `addRelation` (Phase 6) widens this union
 * further — see `openspec/changes/studio-erd-designer/tasks.md`.
 */
export type ErdEdit =
  | { kind: 'renameTable'; from: string; to: string }
  | { kind: 'addTable'; name: string }
  | { kind: 'deleteTable'; name: string }
  | { kind: 'addField'; table: string; name: string; fieldType: string }
  | {
      kind: 'editField';
      table: string;
      field: string;
      name?: string;
      fieldType?: string;
      optional?: boolean;
    }
  | { kind: 'deleteField'; table: string; field: string };

export type ErdEditResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'parse-failed' | 'anchor-missing' | 'referenced'; message: string };

function findModel(models: ModelSpan[], name: string): ModelSpan | undefined {
  return models.find((model) => model.name === name);
}

function findField(model: ModelSpan, name: string): FieldSpan | undefined {
  return model.fields.find((field) => field.name === name);
}

/**
 * Applies one `ErdEdit` against `currentText`. Parses `currentText` fresh
 * on every call (via `parseWithSpans`) and locates the edit's anchor in
 * that fresh result — never from a previously held span. A parse failure
 * or a missing anchor refuses the edit and leaves `currentText` untouched:
 * there is no fallback to a cached position (design D3).
 */
export function applyErdEdit(currentText: string, edit: ErdEdit): ErdEditResult {
  let schema;
  let spans;
  try {
    ({ schema, spans } = parseWithSpans(currentText));
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
    case 'addTable': {
      // Pure insertion, no existing node to locate — the anchor is the end
      // of the last model's body (right after its closing `}`) so the new
      // table lands next to existing tables rather than after everything
      // else in the file (e.g. a trailing `TableGroup` block). When the
      // buffer has no models yet, the anchor falls back to the end of the
      // buffer. Because `start === end` at the anchor, this is a zero-width
      // insertion: nothing is deleted, so every byte on either side of the
      // anchor — including any construct that follows, like `TableGroup` —
      // is copied through untouched by `applyEdits` (design D4).
      const anchor =
        spans.models.length > 0
          ? spans.models[spans.models.length - 1].bodyClose.end
          : currentText.length;
      const insertion = `\n\nTable ${edit.name} {\n  id Int @id\n}`;
      const text = applyEdits(currentText, [{ start: anchor, end: anchor, text: insertion }]);
      return { ok: true, text };
    }
    case 'deleteTable': {
      const model = findModel(spans.models, edit.name);
      if (!model) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Table "${edit.name}" was not found in the current buffer.`,
        };
      }
      // Refusal is IR-sourced, not span-sourced (design D5): every
      // referencing table/field pair is computed from a fresh
      // `resolve(schema)` over THIS call's fresh parse, never from a
      // caller-held scan or span. The target table's physical name may
      // differ from its declared name only via `@@map`, which the ERD does
      // not yet author — resolving through `resolved.tables` keeps the
      // lookup correct either way instead of assuming `dbName === name`.
      const resolved = resolve(schema);
      const targetDbName = resolved.tables.find((table) => table.name === edit.name)?.dbName ?? edit.name;
      const referencing = resolved.tables
        .filter((table) => table.name !== edit.name)
        .map((table) => ({
          table: table.name,
          fields: table.foreignKeys
            .filter((fk) => fk.refTable === targetDbName)
            .flatMap((fk) => fk.columns),
        }))
        .filter((entry) => entry.fields.length > 0);

      if (referencing.length > 0) {
        const message = `Cannot delete "${edit.name}": referenced by ${referencing
          .map((entry) => `${entry.table}.${entry.fields.join(', ')}`)
          .join('; ')}.`;
        return { ok: false, reason: 'referenced', message };
      }

      const text = applyEdits(currentText, [
        { start: model.decl.start, end: model.decl.end, text: '' },
      ]);
      return { ok: true, text };
    }
    case 'addField': {
      // Pure insertion (same shape as `addTable`'s anchor logic): anchors
      // right after the last field's full declaration (name, type and any
      // attributes — `decl` covers the whole line's content) so the new
      // field lands next to existing fields. An empty table anchors right
      // after the opening `{`, matching `addTable`'s own seed body.
      const model = findModel(spans.models, edit.table);
      if (!model) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Table "${edit.table}" was not found in the current buffer.`,
        };
      }
      const anchor =
        model.fields.length > 0
          ? model.fields[model.fields.length - 1].decl.end
          : model.bodyOpen.end;
      const insertion = `\n  ${edit.name} ${edit.fieldType}`;
      const text = applyEdits(currentText, [{ start: anchor, end: anchor, text: insertion }]);
      return { ok: true, text };
    }
    case 'editField': {
      // Targeted token replacement, never a full-`decl` rewrite: replacing
      // only `nameToken`/`typeToken` (and the single `?` immediately after
      // the type token, when present) leaves the field's attributes and
      // surrounding whitespace byte-unchanged. Widening any of these
      // replacement spans by even one token would start eating adjacent
      // text (task 5.4's mutation target).
      const model = findModel(spans.models, edit.table);
      if (!model) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Table "${edit.table}" was not found in the current buffer.`,
        };
      }
      const field = findField(model, edit.field);
      if (!field) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Field "${edit.field}" was not found on table "${edit.table}".`,
        };
      }
      const fieldEdits: TextEdit[] = [];
      if (edit.name !== undefined && edit.name !== field.name) {
        fieldEdits.push({ start: field.nameToken.start, end: field.nameToken.end, text: edit.name });
      }
      if (edit.fieldType !== undefined) {
        fieldEdits.push({ start: field.typeToken.start, end: field.typeToken.end, text: edit.fieldType });
      }
      if (edit.optional !== undefined) {
        const hasQuestionMark = currentText[field.typeToken.end] === '?';
        if (edit.optional && !hasQuestionMark) {
          fieldEdits.push({ start: field.typeToken.end, end: field.typeToken.end, text: '?' });
        } else if (!edit.optional && hasQuestionMark) {
          fieldEdits.push({ start: field.typeToken.end, end: field.typeToken.end + 1, text: '' });
        }
      }
      const text = applyEdits(currentText, fieldEdits);
      return { ok: true, text };
    }
    case 'deleteField': {
      // Removes the field's ENTIRE line — its leading indentation (found by
      // scanning back to the previous newline) through its trailing newline
      // (if any) — not just `decl`'s trimmed content, so no blank,
      // indentation-only line survives the deletion (the same boundary
      // hazard `deleteTable` guards against with an exact-string test).
      const model = findModel(spans.models, edit.table);
      if (!model) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Table "${edit.table}" was not found in the current buffer.`,
        };
      }
      const field = findField(model, edit.field);
      if (!field) {
        return {
          ok: false,
          reason: 'anchor-missing',
          message: `Field "${edit.field}" was not found on table "${edit.table}".`,
        };
      }
      const lineStart = currentText.lastIndexOf('\n', field.decl.start - 1) + 1;
      let lineEnd = field.decl.end;
      if (currentText[lineEnd] === '\n') lineEnd += 1;
      const text = applyEdits(currentText, [{ start: lineStart, end: lineEnd, text: '' }]);
      return { ok: true, text };
    }
  }
}
