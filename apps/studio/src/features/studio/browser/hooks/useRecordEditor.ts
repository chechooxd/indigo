/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { Table } from '../../../../types';
import { useStudioStore } from '../../../../store/useStudioStore';

export interface UseRecordEditorReturn {
  selectedRowIndex: number;
  detailsPanelOpen: boolean;
  editEmail: string;
  editRole: string;
  editMetadata: string;

  setSelectedRowIndex: (index: number) => void;
  setDetailsPanelOpen: (open: boolean) => void;
  setEditEmail: (email: string) => void;
  setEditRole: (role: string) => void;
  setEditMetadata: (metadata: string) => void;

  handleSaveChanges: (activeTable: Table) => void;
  handleDiscardChanges: (activeTable: Table) => void;
  /** Adds a mock record to the active table and switches to it */
  handleAddRecord: (activeTable: Table) => void;
}

export function useRecordEditor(activeTableIndex: number): UseRecordEditorReturn {
  const { updateTableRecords } = useStudioStore();

  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(0);
  const [detailsPanelOpen, setDetailsPanelOpen] = useState<boolean>(true);

  const [editEmail, setEditEmail] = useState<string>('');
  const [editRole, setEditRole] = useState<string>('');
  const [editMetadata, setEditMetadata] = useState<string>('');

  // useTableData exposes the active table; we receive it to sync the edit buffers
  // by listening to selectedRowIndex + activeTableIndex changes externally.
  // The actual sync is triggered by callers passing the activeTable into the handlers.
  // We keep the effect here since useRecordEditor owns the sync logic.
  // NOTE: activeTable is passed at call-time; we expose a helper for callers to call on mount/change.

  const syncFromRecord = (activeTable: Table) => {
    if (activeTable && activeTable.records && activeTable.records[selectedRowIndex]) {
      const row = activeTable.records[selectedRowIndex];
      setEditEmail(row.email || '');
      setEditRole(row.role || 'USER');
      setEditMetadata(row.metadata || '{}');
    } else {
      setEditEmail('');
      setEditRole('USER');
      setEditMetadata('{}');
    }
  };

  const handleSaveChanges = (activeTable: Table) => {
    if (!activeTable || !activeTable.records || !activeTable.records[selectedRowIndex]) return;

    try {
      if (editMetadata) {
        JSON.parse(editMetadata);
      }
    } catch {
      alert('Malformed Metadata JSON. Please correct syntax before saving.');
      return;
    }

    const updatedRecords = [...activeTable.records];
    updatedRecords[selectedRowIndex] = {
      ...updatedRecords[selectedRowIndex],
      email: editEmail,
      role: editRole,
      metadata: editMetadata,
    };

    updateTableRecords(activeTable.name, updatedRecords);
    alert(`Success: Record "${updatedRecords[selectedRowIndex].id}" has been modified inside live state.`);
  };

  const handleDiscardChanges = (activeTable: Table) => {
    syncFromRecord(activeTable);
  };

  const handleAddRecord = (activeTable: Table) => {
    if (!activeTable) return;

    const mockId = 'clp2' + Math.random().toString(36).substr(2, 9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newRow: Record<string, any> = {
      id: mockId,
      email: `new.entity_${Math.floor(Math.random() * 1000)}@indigodb.io`,
      full_name: 'Simulated Workspace Row',
      role: 'USER',
      created_at:
        new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ', 12:00 PM',
      verified: Math.random() > 0.5,
      metadata: JSON.stringify({ source: 'Data Studio creator', ip: '127.0.0.1' }, null, 2),
    };

    activeTable.columns.forEach(col => {
      if (newRow[col.name] === undefined) {
        newRow[col.name] = col.defaultValue ? col.defaultValue.replace(/'/g, '') : 'Simulated Value';
      }
    });

    const updated = [...activeTable.records, newRow];
    updateTableRecords(activeTable.name, updated);
    setSelectedRowIndex(updated.length - 1);
    setDetailsPanelOpen(true);
  };

  return {
    selectedRowIndex,
    detailsPanelOpen,
    editEmail,
    editRole,
    editMetadata,
    setSelectedRowIndex,
    setDetailsPanelOpen,
    setEditEmail,
    setEditRole,
    setEditMetadata,
    handleSaveChanges,
    handleDiscardChanges,
    handleAddRecord,
  };
}
