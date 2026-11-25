/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import type { ReactNode } from 'react';
import type { TableColumn } from '../../../../../types';

const CONTROL_CLASS =
  'w-full bg-zinc-950 border border-zinc-805 rounded-xl p-2.5 text-xs text-white outline-none focus:border-zinc-700 font-mono disabled:cursor-not-allowed disabled:opacity-70';

export interface FieldWidgetRenderProps {
  column: TableColumn;
  /** Current draft (buffer) text, never the raw DB value. */
  value: string;
  disabled: boolean;
  onChange(next: string): void;
}

export interface FieldWidgetParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * The extension point for one scalar/enum "kind" of column. `render` is the
 * editable control; `toDraft` converts a raw DB value into the buffer's text
 * representation; `parse` converts the buffer's text back into the value the
 * write path sends. `parse` is never called for a column the user has
 * explicitly marked null — that's the caller's (`useRecordEditor`'s)
 * responsibility, orthogonal to any individual widget.
 */
export interface FieldWidget {
  render(props: FieldWidgetRenderProps): ReactNode;
  toDraft(dbValue: unknown): string;
  parse(draft: string, column: TableColumn): { ok: true; value: unknown } | { ok: false; error: string };
}

function textToDraft(dbValue: unknown): string {
  return dbValue === null || dbValue === undefined ? '' : String(dbValue);
}

const stringWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        type="text"
        className={CONTROL_CLASS}
        aria-label={column.name}
      />
    );
  },
  toDraft: textToDraft,
  parse(draft) {
    return { ok: true, value: draft };
  },
};

const intWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        type="number"
        step={1}
        className={CONTROL_CLASS}
        aria-label={column.name}
      />
    );
  },
  toDraft: textToDraft,
  parse(draft, column) {
    if (draft.trim() === '' || !/^-?\d+$/.test(draft.trim())) {
      return { ok: false, error: `${column.name} must be a whole number` };
    }
    return { ok: true, value: Number.parseInt(draft, 10) };
  },
};

const floatWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        type="number"
        step="any"
        className={CONTROL_CLASS}
        aria-label={column.name}
      />
    );
  },
  toDraft: textToDraft,
  parse(draft, column) {
    const n = Number(draft);
    if (draft.trim() === '' || Number.isNaN(n)) {
      return { ok: false, error: `${column.name} must be a number` };
    }
    return { ok: true, value: n };
  },
};

// Decimal/BigInt pass through as strings, deliberately: converting to a JS
// number would silently lose precision the database itself preserves.
const preciseNumericWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        type="text"
        inputMode="decimal"
        className={CONTROL_CLASS}
        aria-label={column.name}
      />
    );
  },
  toDraft: textToDraft,
  parse(draft, column) {
    if (draft.trim() === '' || !/^-?\d+(\.\d+)?$/.test(draft.trim())) {
      return { ok: false, error: `${column.name} must be a numeric string` };
    }
    return { ok: true, value: draft.trim() };
  },
};

const booleanWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        type="checkbox"
        checked={value === 'true'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        className="rounded bg-zinc-950 border-zinc-800 focus:ring-0"
        aria-label={column.name}
      />
    );
  },
  toDraft(dbValue) {
    return dbValue ? 'true' : 'false';
  },
  parse(draft) {
    return { ok: true, value: draft === 'true' };
  },
};

/** Converts any Date-like/ISO-string DB value into the value a
 * `<input type="datetime-local">` control accepts (`YYYY-MM-DDTHH:mm`). */
function toDatetimeLocal(dbValue: unknown): string {
  if (dbValue === null || dbValue === undefined || dbValue === '') return '';
  const d = dbValue instanceof Date ? dbValue : new Date(String(dbValue));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const dateTimeWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        type="datetime-local"
        className={CONTROL_CLASS}
        aria-label={column.name}
      />
    );
  },
  toDraft: toDatetimeLocal,
  parse(draft, column) {
    if (draft.trim() === '') {
      return { ok: false, error: `${column.name} must be a valid date/time` };
    }
    const d = new Date(draft);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: `${column.name} must be a valid date/time` };
    }
    return { ok: true, value: d.toISOString() };
  },
};

const jsonWidget: FieldWidget = {
  render({ column, value, disabled, onChange }) {
    return (
      <textarea
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${CONTROL_CLASS} h-44 leading-relaxed resize-none`}
        spellCheck={false}
        aria-label={column.name}
      />
    );
  },
  toDraft(dbValue) {
    if (dbValue === null || dbValue === undefined) return '';
    if (typeof dbValue === 'string') return dbValue;
    return JSON.stringify(dbValue, null, 2);
  },
  parse(draft, column) {
    try {
      return { ok: true, value: JSON.parse(draft) };
    } catch {
      return { ok: false, error: `${column.name} must be valid JSON` };
    }
  },
};

/** Registry keyed by `ResolvedColumn.type` for built-in scalars. */
export const WIDGET_REGISTRY: Record<string, FieldWidget> = {
  String: stringWidget,
  Int: intWidget,
  Float: floatWidget,
  Boolean: booleanWidget,
  DateTime: dateTimeWidget,
  Json: jsonWidget,
  Decimal: preciseNumericWidget,
  BigInt: preciseNumericWidget,
};

/** Builds a `<select>` widget for an enum column's declared values. */
function enumWidget(values: string[]): FieldWidget {
  return {
    render({ column, value, disabled, onChange }) {
      return (
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={CONTROL_CLASS}
          aria-label={column.name}
        >
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    },
    toDraft(dbValue) {
      return dbValue === null || dbValue === undefined ? (values[0] ?? '') : String(dbValue);
    },
    parse(draft) {
      return { ok: true, value: draft };
    },
  };
}

/**
 * Resolves the widget for `column`: enum columns first (their declared
 * `enumValues`), then a registry hit by `type`, then a plain text fallback
 * for any unrecognized scalar.
 */
export function resolveWidget(column: TableColumn): FieldWidget {
  if (column.isEnum && column.enumValues) return enumWidget(column.enumValues);
  return WIDGET_REGISTRY[column.type] ?? stringWidget;
}
