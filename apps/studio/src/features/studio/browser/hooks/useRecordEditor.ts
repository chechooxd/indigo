/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';

// This build has no write backend: record editing, adding, and saving are
// disabled unconditionally (see TableBrowserPage/RecordInspector). This hook
// therefore only owns the read-only edit-buffer display state — the sync
// effect that populates it from the active row lives in TableBrowserPage.
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
}

export function useRecordEditor(): UseRecordEditorReturn {
  const [selectedRowIndex, setSelectedRowIndex] = useState<number>(0);
  const [detailsPanelOpen, setDetailsPanelOpen] = useState<boolean>(true);

  const [editEmail, setEditEmail] = useState<string>('');
  const [editRole, setEditRole] = useState<string>('');
  const [editMetadata, setEditMetadata] = useState<string>('');

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
  };
}
