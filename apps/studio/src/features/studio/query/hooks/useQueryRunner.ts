/**
 * @license
 * SPDX-License-Identifier: MIT
 */

import { useState } from 'react';
import type { Table } from '../../../../types';
import type { QueryResult } from '../../../../lib/api';
import { isBackendAvailable, runQuery } from '../../../../lib/api';
import { formatSql } from '../lib/format-sql';
import { executeMockQuery } from '../lib/mock-query-engine';

export interface UseQueryRunnerReturn {
  selectedTableInBrowser: string;
  queryCode: string;
  queryResults: QueryResult | null;
  errorMsg: string | null;

  setQueryCode: (code: string) => void;
  handleRunQuery: () => void;
  handleFormatCode: () => void;
  loadPresetQuery: (tableName: string) => void;
}

export function useQueryRunner(tables: Table[]): UseQueryRunnerReturn {
  const [selectedTableInBrowser, setSelectedTableInBrowser] = useState<string>('users');
  const [queryCode, setQueryCode] = useState<string>('SELECT * FROM users LIMIT 10;');
  // Initial snapshot mirrors the very first table's mock records under a fixed
  // column set; intentional — not derived reactively from `tables`.
  const [queryResults, setQueryResults] = useState<QueryResult | null>({
    columns: ['id', 'email', 'full_name', 'created_at', 'role'],
    rows: tables[0].records,
    // Initial mock snapshot is never truncated — it's the full mock record set.
    truncated: false,
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleRunQuery = () => {
    setErrorMsg(null);
    setQueryResults(null);

    // Real backend (indigodb studio): run the query against PostgreSQL.
    if (isBackendAvailable()) {
      runQuery(queryCode)
        .then((result) => setQueryResults(result))
        .catch((err: Error) => setErrorMsg(err.message));
      return;
    }

    // Standalone fallback: simulate against mock data.
    setTimeout(() => {
      const outcome = executeMockQuery(queryCode, tables);
      if (outcome.ok) setQueryResults(outcome.result);
      else setErrorMsg(outcome.error);
    }, 400);
  };

  const handleFormatCode = () => {
    setQueryCode(formatSql(queryCode));
  };

  const loadPresetQuery = (tableName: string) => {
    setSelectedTableInBrowser(tableName);
    setQueryCode(`SELECT * FROM ${tableName} LIMIT 10;`);
  };

  return {
    selectedTableInBrowser,
    queryCode,
    queryResults,
    errorMsg,
    setQueryCode,
    handleRunQuery,
    handleFormatCode,
    loadPresetQuery,
  };
}
