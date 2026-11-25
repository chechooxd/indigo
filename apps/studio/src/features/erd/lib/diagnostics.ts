/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * One parse- or validation-class problem found while processing the editor's
 * `.indigo` buffer. `source: 'parse'` entries come from `IndigoParseError`
 * and always carry a position (1-based); `source: 'validate'` entries come
 * from `@indigodb/core`'s `validate()` (a `ValidationError`-shaped failure of
 * `{message, model?, field?}`) and never carry a position — the compiler has
 * no notion of a source span for a validation failure. A position is never
 * fabricated for a `validate` entry: no text search, no line-1 fallback.
 */
export interface Diagnostic {
  source: 'parse' | 'validate';
  message: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** Only ever present on `source: 'validate'` entries. */
  model?: string;
  /** Only ever present on `source: 'validate'` entries. */
  field?: string;
}

/**
 * A `Diagnostic` narrowed to one that carries a real, non-fabricated
 * position. Only `source: 'parse'` entries can satisfy this — `toMarkers`
 * accepts only this type so "a validation error produces zero markers" is a
 * `tsc` guarantee, not a filter someone can delete later.
 */
export interface PositionalDiagnostic extends Diagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export function isPositional(diagnostic: Diagnostic): diagnostic is PositionalDiagnostic {
  return (
    diagnostic.line !== undefined &&
    diagnostic.column !== undefined &&
    diagnostic.endLine !== undefined &&
    diagnostic.endColumn !== undefined
  );
}

/**
 * Structurally compatible with `monaco.editor.IMarkerData` without importing
 * `monaco-editor` into this pure, dependency-free module. Callers with a real
 * Monaco instance (`ERDDesignerPage`) pass this straight to
 * `monaco.editor.setModelMarkers`.
 */
export interface DiagnosticMarker {
  /** Matches `monaco.MarkerSeverity.Error` (8). */
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const MARKER_SEVERITY_ERROR = 8;

/**
 * Maps positional diagnostics to Monaco markers. Callers are expected to
 * rebuild the full marker list from scratch on every parse (decision 17) —
 * this function is pure and stateless, so "clear and replace" is the
 * caller's responsibility via `monaco.editor.setModelMarkers(model, "indigo",
 * toMarkers(...))`, never an incremental accumulation.
 */
export function toMarkers(diagnostics: PositionalDiagnostic[]): DiagnosticMarker[] {
  return diagnostics.map((diagnostic) => ({
    severity: MARKER_SEVERITY_ERROR,
    message: diagnostic.message,
    startLineNumber: diagnostic.line,
    startColumn: diagnostic.column,
    endLineNumber: diagnostic.endLine,
    endColumn: diagnostic.endColumn,
  }));
}
