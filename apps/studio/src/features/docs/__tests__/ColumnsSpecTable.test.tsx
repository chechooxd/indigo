/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ColumnsSpecTable } from '../components/ColumnsSpecTable';
import type { TableColumn } from '../../../types';
import { MIXED_NOTES_COLUMNS } from './fixtures/mixed-notes';

const columns: TableColumn[] = MIXED_NOTES_COLUMNS.map(({ name, description }) => ({
  name,
  type: 'TEXT',
  isPK: false,
  isNN: false,
  isUQ: false,
  description,
}));

describe('ColumnsSpecTable description column (studio-ui-honesty)', () => {
  it('renders real notes verbatim and an honest "No description" marker for un-noted columns', () => {
    render(<ColumnsSpecTable columns={columns} />);

    expect(screen.queryByText('Database engine system column value.')).toBeNull();
    expect(screen.getByRole('cell', { name: 'Unique identifier' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Soft-delete timestamp' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: 'No description' })).toHaveLength(1);
  });
});
