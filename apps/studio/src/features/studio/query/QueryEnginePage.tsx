/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useDataStore } from '../../../store/useDataStore';
import { isBackendAvailable } from '../../../lib/api';
import { loadSchemaIntoStore } from '../../../lib/schema-loader';
import { useQueryRunner } from './hooks/useQueryRunner';
import { SchemaBrowserPanel } from './components/SchemaBrowserPanel';
import { SqlEditor } from './components/SqlEditor';
import { ResultsTable } from './components/ResultsTable';

export default function QueryEnginePage() {
  const { tables, setTables, setResolvedSchema } = useDataStore();
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
        <ResultsTable results={queryResults} errorMsg={errorMsg} />
      </section>
    </div>
  );
}
