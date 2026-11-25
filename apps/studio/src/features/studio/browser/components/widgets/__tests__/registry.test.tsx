/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WIDGET_REGISTRY, resolveWidget } from '../registry';
import type { TableColumn } from '../../../../../../types';

function column(overrides: Partial<TableColumn>): TableColumn {
  return {
    name: 'field',
    type: 'String',
    isPK: false,
    isNN: true,
    isUQ: false,
    ...overrides,
  };
}

describe('resolveWidget', () => {
  it('resolves an enum column to a select of exactly its declared values, regardless of type', () => {
    const col = column({ name: 'status', type: 'Status', isEnum: true, enumValues: ['A', 'B', 'C'] });
    const { unmount } = render(
      WIDGET_REGISTRY.String.render({ column: col, value: '', disabled: false, onChange: () => {} }),
    );
    // Sanity: the plain String widget renders a text input, not a select —
    // asserting resolveWidget takes the enum branch first, not this one.
    expect(screen.getByLabelText('status').tagName).toBe('INPUT');
    unmount();

    render(resolveWidget(col).render({ column: col, value: 'B', disabled: false, onChange: () => {} }));
    const select = screen.getByLabelText('status') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to the text widget for an unrecognized scalar type', () => {
    const col = column({ name: 'weird', type: 'NoSuchScalar' });
    const widget = resolveWidget(col);
    expect(widget).toBe(WIDGET_REGISTRY.String);
  });

  it('resolves each built-in scalar to its registry entry', () => {
    for (const type of ['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Decimal', 'BigInt']) {
      expect(resolveWidget(column({ type }))).toBe(WIDGET_REGISTRY[type]);
    }
  });
});

describe('Boolean widget', () => {
  it('renders a checkbox reflecting the current value', () => {
    const col = column({ name: 'active', type: 'Boolean' });
    render(WIDGET_REGISTRY.Boolean.render({ column: col, value: 'true', disabled: false, onChange: () => {} }));
    const checkbox = screen.getByLabelText('active') as HTMLInputElement;
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(true);
  });

  it('toDraft/parse round-trip true/false', () => {
    expect(WIDGET_REGISTRY.Boolean.toDraft(true)).toBe('true');
    expect(WIDGET_REGISTRY.Boolean.toDraft(false)).toBe('false');
    expect(WIDGET_REGISTRY.Boolean.parse('true', column({ type: 'Boolean' }))).toEqual({ ok: true, value: true });
    expect(WIDGET_REGISTRY.Boolean.parse('false', column({ type: 'Boolean' }))).toEqual({ ok: true, value: false });
  });
});

describe('DateTime widget', () => {
  it('renders a datetime-local input', () => {
    const col = column({ name: 'happenedAt', type: 'DateTime' });
    render(WIDGET_REGISTRY.DateTime.render({ column: col, value: '', disabled: false, onChange: () => {} }));
    expect(screen.getByLabelText('happenedAt')).toHaveAttribute('type', 'datetime-local');
  });

  it('parse rejects an invalid date/time', () => {
    const result = WIDGET_REGISTRY.DateTime.parse('not-a-date', column({ name: 'happenedAt', type: 'DateTime' }));
    expect(result.ok).toBe(false);
  });

  it('parse accepts a valid date/time and returns an ISO string', () => {
    const result = WIDGET_REGISTRY.DateTime.parse('2024-01-15T10:30', column({ name: 'happenedAt', type: 'DateTime' }));
    expect(result.ok).toBe(true);
    expect(typeof (result as { value: unknown }).value).toBe('string');
  });
});

describe('Json widget', () => {
  it('renders a textarea', () => {
    const col = column({ name: 'payload', type: 'Json' });
    render(WIDGET_REGISTRY.Json.render({ column: col, value: '{}', disabled: false, onChange: () => {} }));
    expect(screen.getByLabelText('payload').tagName).toBe('TEXTAREA');
  });

  it('parse rejects invalid JSON without throwing', () => {
    const result = WIDGET_REGISTRY.Json.parse('{not valid', column({ name: 'payload', type: 'Json' }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining('payload') });
  });

  it('parse accepts valid JSON and round-trips the parsed value', () => {
    const result = WIDGET_REGISTRY.Json.parse('{"a":1}', column({ name: 'payload', type: 'Json' }));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('toDraft pretty-prints an object value', () => {
    expect(WIDGET_REGISTRY.Json.toDraft({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(WIDGET_REGISTRY.Json.toDraft(null)).toBe('');
  });
});

describe('Int/Float widgets', () => {
  it('Int rejects a non-integer', () => {
    expect(WIDGET_REGISTRY.Int.parse('3.5', column({ name: 'n', type: 'Int' })).ok).toBe(false);
    expect(WIDGET_REGISTRY.Int.parse('3', column({ name: 'n', type: 'Int' }))).toEqual({ ok: true, value: 3 });
  });

  it('Float accepts a decimal', () => {
    expect(WIDGET_REGISTRY.Float.parse('3.5', column({ name: 'n', type: 'Float' }))).toEqual({ ok: true, value: 3.5 });
  });
});

describe('Decimal/BigInt widgets', () => {
  it('pass values through as strings to preserve precision', () => {
    const col = column({ name: 'amount', type: 'Decimal' });
    expect(WIDGET_REGISTRY.Decimal.parse('12345678901234567890.5', col)).toEqual({
      ok: true,
      value: '12345678901234567890.5',
    });
  });
});

describe('interaction: editing a select fires onChange with the chosen value', () => {
  it('enum widget', async () => {
    const col = column({ name: 'status', type: 'Status', isEnum: true, enumValues: ['A', 'B'] });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(resolveWidget(col).render({ column: col, value: 'A', disabled: false, onChange }));
    await user.selectOptions(screen.getByLabelText('status'), 'B');
    expect(onChange).toHaveBeenCalledWith('B');
  });
});
