/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import React, { useState } from 'react';
import { TableColumn } from '../../../../types';

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
  /**
   * No-op guard: table creation has no write backend in this build and the
   * submit control is disabled unconditionally (see CreateTableModal), so
   * this only exists to preventDefault should a form submission ever reach it.
   */
  handleCreateTableSubmit: (e: React.FormEvent) => void;
}

export function useCreateTableForm(): UseCreateTableFormReturn {
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

  const handleCreateTableSubmit = (e: React.FormEvent) => {
    // Table creation has no write backend yet; the submit button is disabled
    // unconditionally so this should never actually run. Guarded no-op only.
    e.preventDefault();
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
