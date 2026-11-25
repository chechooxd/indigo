/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { isPositional, type Diagnostic } from '../lib/diagnostics';

interface DiagnosticsPanelProps {
  diagnostics: Diagnostic[];
}

/**
 * Labelled diagnostics entries for the ERD editor: parse errors show their
 * exact reported position, and validation errors are explicitly labelled as
 * having no source location — never a fabricated line/column. This is what
 * makes a validation failure visible on screen, not only via the (absent)
 * Monaco marker.
 */
export function DiagnosticsPanel({ diagnostics }: DiagnosticsPanelProps) {
  if (diagnostics.length === 0) return null;

  return (
    <div
      role="alert"
      className="border-t border-zinc-800 bg-zinc-950/60 text-[11px] font-mono max-h-40 overflow-y-auto"
    >
      {diagnostics.map((diagnostic, index) => (
        <div
          key={index}
          className="flex items-start gap-2 px-4 py-1.5 border-b border-zinc-900 last:border-b-0"
        >
          <span className="uppercase font-semibold text-red-400 shrink-0">
            {diagnostic.source === 'parse' ? 'Syntax error' : 'Validation error'}
          </span>
          <span className="text-zinc-300 flex-1">{diagnostic.message}</span>
          {isPositional(diagnostic) ? (
            <span className="text-zinc-500 shrink-0">
              Line {diagnostic.line}, column {diagnostic.column}
            </span>
          ) : (
            <span className="text-zinc-500 shrink-0" data-testid="no-source-location">
              No source location available
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
