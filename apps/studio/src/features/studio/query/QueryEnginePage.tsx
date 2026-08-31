/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { useDataStore } from '../../../store/useDataStore';
import { useAuthStore } from '../../../store/useAuthStore';
import { isBackendAvailable } from '../../../lib/api';
import { loadSchemaIntoStore } from '../../../lib/schema-loader';
import { useQueryRunner } from './hooks/useQueryRunner';
import { SchemaBrowserPanel } from './components/SchemaBrowserPanel';
import { SqlEditor } from './components/SqlEditor';
import { ResultsTable } from './components/ResultsTable';

export default function QueryEnginePage() {
  const { t } = useTranslation();
  const { tables, setTables, setResolvedSchema } = useDataStore();
  const queryTimeoutMs = useAuthStore((s) => s.queryTimeoutMs);
  const queryRowCap = useAuthStore((s) => s.queryRowCap);
  const {
    selectedTableInBrowser,
    queryCode,
    queryResults,
    errorMsg,
    setQueryCode,
    handleRunQuery,
    handleFormatCode,
    loadPresetQuery,
  } = useQueryRunner(tables);

  return (
    <div id="query-engine-container" className="flex-1 flex overflow-hidden bg-[#09090b]">
      <SchemaBrowserPanel
        tables={tables}
        selectedTable={selectedTableInBrowser}
        onSelectTable={loadPresetQuery}
        canRefresh={isBackendAvailable()}
        onRefresh={() => loadSchemaIntoStore({ setTables, setResolvedSchema })}
      />

      <section className="flex-1 flex flex-col overflow-hidden bg-[#09090b]">
        <SqlEditor
          queryCode={queryCode}
          fileLabel={`query_${selectedTableInBrowser}.sql`}
          onChange={setQueryCode}
          onFormat={handleFormatCode}
          onRun={handleRunQuery}
        />
        <div className="px-4 py-1 text-[11px] text-zinc-500 font-sans border-b border-zinc-900 shrink-0">
          {t('queryEngine.limitsHint', { cap: queryRowCap, timeoutSeconds: Math.round(queryTimeoutMs / 1000) })}
        </div>
        {queryResults?.truncated && (
          <div
            role="status"
            className="px-4 py-2 bg-amber-950/40 border-b border-amber-900/60 text-[11px] text-amber-300 font-sans font-medium shrink-0"
          >
            {t('queryEngine.truncatedBanner', { cap: queryRowCap })}
          </div>
        )}
        <ResultsTable results={queryResults} errorMsg={errorMsg} />
      </section>
    </div>
  );
}
