/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { TableColumn, Table } from '../../../../types';
import { useDataStore } from '../../../../store/useDataStore';

const DEFAULT_COLUMNS: TableColumn[] = [
  { name: 'id', type: 'UUID', defaultValue: 'gen_random_uuid()', isPK: true, isNN: true, isUQ: true, description: 'Unique identifier.' },
];

export interface UseCreateTableFormReturn {
  isCreateModalOpen: boolean;
  newTableName: string;
  newTableSchema: string;
  newTableColumns: TableColumn[];

  handleOpenCreateModal: () => void;
  handleCloseCreateModal: () => void;
  setNewTableName: (name: string) => void;
  setNewTableSchema: (schema: string) => void;
  handleAddColumn: () => void;
  handleRemoveColumn: (index: number) => void;
  handleUpdateColumn: (index: number, fields: Partial<TableColumn>) => void;
  /** Returns the new table index to switch to, or null if validation failed */
  handleCreateTableSubmit: (e: React.FormEvent, tables: Table[], onSuccess: (newIndex: number) => void) => void;
}

export function useCreateTableForm(): UseCreateTableFormReturn {
  const { setTables } = useDataStore();

  const [isCreateModalOpen, setIsCreateModalOpen] = useState<boolean>(false);
  const [newTableName, setNewTableName] = useState<string>('');
  const [newTableSchema, setNewTableSchema] = useState<string>('public');
  const [newTableColumns, setNewTableColumns] = useState<TableColumn[]>(DEFAULT_COLUMNS);

  const handleOpenCreateModal = () => {
    setNewTableName('');
    setNewTableSchema('public');
    setNewTableColumns([...DEFAULT_COLUMNS]);
    setIsCreateModalOpen(true);
  };

  const handleCloseCreateModal = () => setIsCreateModalOpen(false);

  const handleAddColumn = () => {
    setNewTableColumns(prev => [
      ...prev,
      { name: `col_${prev.length + 1}`, type: 'VARCHAR(255)', isPK: false, isNN: false, isUQ: false, defaultValue: '', description: '' },
    ]);
  };

  const handleUpdateColumn = (index: number, fields: Partial<TableColumn>) => {
    setNewTableColumns(prev => prev.map((col, idx) => (idx === index ? { ...col, ...fields } : col)));
  };

  const handleRemoveColumn = (index: number) => {
    setNewTableColumns(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleCreateTableSubmit = (
    e: React.FormEvent,
    tables: Table[],
    onSuccess: (newIndex: number) => void,
  ) => {
    e.preventDefault();

    const cleanedName = newTableName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanedName) {
      alert('Please enter a valid table name (a-z, 0-9, and underscores only).');
      return;
    }

    if (tables.some(t => t.name.toLowerCase() === cleanedName)) {
      alert(`A table named "${cleanedName}" already exists in the workspace schema.`);
      return;
    }

    if (newTableColumns.length === 0) {
      alert('At least one column is required to create a table.');
      return;
    }

    const colNames = newTableColumns.map(c => c.name.trim().toLowerCase());
    const hasDuplicates = colNames.some((val, i) => colNames.indexOf(val) !== i);
    if (hasDuplicates) {
      alert('Column names must be unique.');
      return;
    }

    for (const col of newTableColumns) {
      const cleanedColName = col.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!cleanedColName) {
        alert('All columns must have valid names (a-z, 0-9, and underscores only).');
        return;
      }
    }

    const newTable: Table = {
      name: cleanedName,
      schema: newTableSchema,
      columns: newTableColumns.map(col => ({
        ...col,
        name: col.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''),
      })),
      records: [],
      recordCount: 0,
    };

    setTables(prev => [...prev, newTable]);
    setIsCreateModalOpen(false);
    onSuccess(tables.length); // tables.length before mutation === the index of the newly added table
  };

  return {
    isCreateModalOpen,
    newTableName,
    newTableSchema,
    newTableColumns,
    handleOpenCreateModal,
    handleCloseCreateModal,
    setNewTableName,
    setNewTableSchema,
    handleAddColumn,
    handleRemoveColumn,
    handleUpdateColumn,
    handleCreateTableSubmit,
  };
}
