/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import type { ResolvedRelation } from '@indigodb/core';
import type { Table } from '../../../types';
import { useDataStore } from '../../../store/useDataStore';
import { useNavigationStore } from '../../../store/useNavigationStore';
import { generateTableDDL } from '../lib/ddl-generator';

export interface FilteredTable extends Table {
  originalIdx: number;
}

export interface UseDocBrowserReturn {
  activeTable: Table;
  filteredTables: FilteredTable[];
  activeRelations: ResolvedRelation[];
  ddlDefinitionCode: string;
  docFilterQuery: string;

  setSelectedTableIdx: (idx: number) => void;
  setDocFilterQuery: (query: string) => void;
  shareReference: () => void;
  queryTable: () => void;
}

export function useDocBrowser(): UseDocBrowserReturn {
  const { tables, resolvedSchema } = useDataStore();
  const { navigate } = useNavigationStore();
  const [selectedTableIdx, setSelectedTableIdx] = useState<number>(0);
  const [docFilterQuery, setDocFilterQuery] = useState<string>('');

  const activeTable = tables[selectedTableIdx] || tables[0];

  // Real relations for the active table (from the resolved schema, when a
  // backend is present). Falls back to empty under standalone/mock mode.
  const activeRelations = useMemo(() => {
    if (!resolvedSchema || !activeTable) return [];
    return resolvedSchema.tables.find((t) => t.name === activeTable.name)?.relations ?? [];
  }, [resolvedSchema, activeTable]);

  const filteredTables = useMemo(() => {
    return tables
      .map((t, idx) => ({ ...t, originalIdx: idx }))
      .filter((t) => t.name.toLowerCase().includes(docFilterQuery.toLowerCase()));
  }, [tables, docFilterQuery]);

  const ddlDefinitionCode = useMemo(() => {
    if (!activeTable) return '';
    return generateTableDDL(activeTable);
  }, [activeTable]);

  const shareReference = () => {
    const url = window.location.href + `#docs/${activeTable.schema}/${activeTable.name}`;
    navigator.clipboard.writeText(url);
    alert(`Reference link generated and copied to clipboard:\n\n${url}`);
  };

  const queryTable = () => {
    // We would normally pass code via store, for now just navigate
    navigate('studio', 'query');
  };

  return {
    activeTable,
    filteredTables,
    activeRelations,
    ddlDefinitionCode,
    docFilterQuery,
    setSelectedTableIdx,
    setDocFilterQuery,
    shareReference,
    queryTable,
  };
}
