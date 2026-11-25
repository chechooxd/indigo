/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect } from 'vitest';
import { isPositional, toMarkers, type Diagnostic, type PositionalDiagnostic } from '../lib/diagnostics';

describe('toMarkers', () => {
  it('maps a positional diagnostic to a Monaco-shaped marker at the exact reported position', () => {
    const positional: PositionalDiagnostic = {
      source: 'parse',
      message: 'Unexpected token',
      line: 4,
      column: 3,
      endLine: 4,
      endColumn: 9,
    };

    expect(toMarkers([positional])).toEqual([
      {
        severity: 8,
        message: 'Unexpected token',
        startLineNumber: 4,
        startColumn: 3,
        endLineNumber: 4,
        endColumn: 9,
      },
    ]);
  });

  it('rejects a position-less diagnostic at compile time (SD-3) — @ts-expect-error is the guard', () => {
    const validationDiagnostic: Diagnostic = {
      source: 'validate',
      message: 'Duplicate model name',
      model: 'User',
    };

    // @ts-expect-error — toMarkers requires PositionalDiagnostic[]; a
    // position-less Diagnostic must not typecheck. This is the compile-time
    // guarantee that "validation errors produce zero markers" cannot be
    // silently deleted by a future refactor.
    toMarkers([validationDiagnostic]);
  });
});

describe('isPositional', () => {
  it('narrows a diagnostic with a full position to PositionalDiagnostic', () => {
    const diagnostic: Diagnostic = {
      source: 'parse',
      message: 'x',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 2,
    };
    expect(isPositional(diagnostic)).toBe(true);
  });

  it('rejects a diagnostic with no position', () => {
    const diagnostic: Diagnostic = { source: 'validate', message: 'x' };
    expect(isPositional(diagnostic)).toBe(false);
  });
});
