/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Play, Sparkles, RefreshCw, Folder, ChevronRight, FileText, AlertCircle, Database } from 'lucide-react';
import { useDataStore } from '../store/useDataStore';
import { isBackendAvailable, runQuery } from '../lib/api';

export default function QueryEngine() {
  const { tables } = useDataStore();
  const [selectedTableInBrowser, setSelectedTableInBrowser] = useState<string>('users');
  const [queryCode, setQueryCode] = useState<string>('SELECT * FROM users LIMIT 10;');
  const [queryResults, setQueryResults] = useState<{ columns: string[]; rows: any[] } | null>({
    columns: ['id', 'email', 'full_name', 'created_at', 'role'],
    rows: tables[0].records
  });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedFolder, setExpandedFolder] = useState<boolean>(true);

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
    const normalizedQuery = queryCode.trim().toLowerCase();
    
    // Find table name
    const match = normalizedQuery.match(/from\s+([a-zA-Z0-9_]+)/);
    if (!match) {
      setErrorMsg("SQL Syntax Error: Could not determine target table name. Make sure you have a 'FROM <table_name>' clause.");
      return;
    }

    const tableName = match[1];
    const targetTable = tables.find(t => t.name.toLowerCase() === tableName.toLowerCase());

    if (!targetTable) {
      setErrorMsg(`Database Error: Relation "${tableName}" does not exist in schema "public" or "billing".`);
      return;
    }

    // Prepare simulated columns and records
    setTimeout(() => {
      const columns = targetTable.columns.map(c => c.name);
      
      // Filter out meta tags or format nicely for output
      const formattedRows = targetTable.records.map(rec => {
        const rowObj: any = {};
        columns.forEach(colName => {
          rowObj[colName] = rec[colName] !== undefined ? rec[colName] : 'NULL';
        });
        return rowObj;
      });

      setQueryResults({
        columns,
        rows: formattedRows
      });
    }, 400);
  };

  const handleFormatCode = () => {
    let clean = queryCode.replace(/\s+/g, ' ').trim();
    // Capitalize key terms
    const keywords = ['select', 'from', 'where', 'limit', 'order by', 'group by', 'left join', 'inner join', 'on'];
    keywords.forEach(keyword => {
      const reg = new RegExp(`\\b${keyword}\\b`, 'gi');
      clean = clean.replace(reg, keyword.toUpperCase());
    });
    setQueryCode(clean);
  };

  const loadPresetQuery = (tableName: string) => {
    setSelectedTableInBrowser(tableName);
    setQueryCode(`SELECT * FROM ${tableName} LIMIT 10;`);
  };

  return (
    <div id="query-engine-container" className="flex-1 flex overflow-hidden bg-[#09090b]">
      {/* Left Sidebar: Schema Browser */}
      <aside className="w-64 border-r border-zinc-800 bg-[#09090b] flex flex-col shrink-0">
        <div className="p-4 border-b border-zinc-800 flex justify-between items-center bg-zinc-950/20">
          <span className="text-[10px] font-extrabold text-zinc-500 uppercase tracking-wider font-sans">
            SCHEMA BROWSER
          </span>
          <button 
            onClick={() => alert("Schema metadata refreshed.")}
            className="p-1.5 hover:text-white text-zinc-500 hover:bg-zinc-900 rounded-xl transition-all cursor-pointer"
            title="Refresh database schema"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
          <div className="space-y-1">
            {/* Schema folder node */}
            <div 
              onClick={() => setExpandedFolder(!expandedFolder)}
              className="flex items-center gap-1.5 px-2.5 py-2 text-zinc-400 hover:bg-zinc-900 rounded-xl cursor-pointer transition-colors"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expandedFolder ? 'rotate-90' : ''}`} />
              <Folder className="w-4 h-4 text-zinc-500" />
              <span className="text-xs font-semibold">schemas</span>
            </div>

            {expandedFolder && (
              <div className="pl-3.5 space-y-1 border-l border-zinc-900 ml-4 py-1">
                {tables.map((t) => {
                  const isSelected = selectedTableInBrowser === t.name;
                  return (
                    <div key={t.name} className="space-y-1">
                      <div 
                        onClick={() => loadPresetQuery(t.name)}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all ${
                          isSelected ? 'bg-zinc-900 text-white font-semibold' : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                        }`}
                      >
                        <Database className="w-3.5 h-3.5 shrink-0" />
                        <span className="text-xs font-mono truncate">{t.schema}.{t.name}</span>
                      </div>

                      {/* Render columns on selective expansion */}
                      {isSelected && (
                        <div className="pl-4 space-y-1 border-l border-zinc-800 ml-3.5 py-1.5">
                          {t.columns.map(col => (
                            <div key={col.name} className="flex items-center justify-between text-[10px] font-mono pr-2 py-0.5">
                              <span className="text-zinc-400">{col.name}</span>
                              <span className="text-zinc-600 truncate max-w-[70px]" title={col.type}>
                                {col.type.toLowerCase()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Editor & Results Container */}
      <section className="flex-1 flex flex-col overflow-hidden bg-[#09090b]">
        {/* Top bar */}
        <div className="h-1/2 flex flex-col border-b border-zinc-800">
          <div className="flex items-center justify-between px-4 h-10 bg-zinc-950/20 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
              <span className="text-xs font-mono font-medium text-zinc-300">
                query_{selectedTableInBrowser}.sql
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={handleFormatCode}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-900 rounded-xl transition-all cursor-pointer"
                title="Format SQL keywords"
              >
                <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
                <span>Format</span>
              </button>
              <button 
                onClick={handleRunQuery}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-white text-black font-extrabold rounded-xl hover:bg-zinc-200 active:scale-95 transition-all text-xs cursor-pointer shadow-lg"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>RUN QUERY</span>
              </button>
            </div>
          </div>

          {/* Interactive SQL Area */}
          <div className="flex-1 p-4 font-mono text-sm leading-6 flex flex-col bg-[#09090b]">
            <textarea
              value={queryCode}
              onChange={(e) => setQueryCode(e.target.value)}
              className="w-full flex-1 bg-transparent border-0 focus:ring-0 p-0 text-zinc-200 font-mono text-sm resize-none outline-none leading-relaxed"
              spellCheck="false"
              placeholder="SELECT * FROM users LIMIT 10;"
            />
            <div className="text-[10px] text-zinc-600 flex justify-between font-sans select-none border-t border-zinc-900 pt-2">
              <span>Press RUN QUERY button to trigger active executor.</span>
              <span>PostgreSQL 15 syntax supported</span>
            </div>
          </div>
        </div>

        {/* Results Panel */}
        <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
          <div className="flex h-10 bg-zinc-950/20 border-b border-zinc-800 px-4 items-center">
            <button className="px-3 py-1 bg-zinc-900/50 text-white text-xs font-bold font-sans border-b-2 border-white rounded-t-xl">
              Query Output Results
            </button>
          </div>

          <div className="flex-1 overflow-auto custom-scrollbar bg-[#09090b]">
            {errorMsg ? (
              <div className="p-6 flex gap-3 text-red-400 bg-red-950/10 border border-red-900/30 rounded-2xl m-4 h-[calc(100%-32px)]">
                <AlertCircle className="w-5 h-5 shrink-0" />
                <div>
                  <h4 className="font-bold text-sm mb-1">Execution Failure</h4>
                  <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">{errorMsg}</pre>
                </div>
              </div>
            ) : queryResults ? (
              <table className="w-full text-left font-mono text-xs border-collapse">
                <thead className="bg-zinc-950 sticky top-0 border-b border-zinc-800 z-10">
                  <tr>
                    {queryResults.columns.map((col) => (
                      <th key={col} className="p-3 font-semibold uppercase tracking-wider text-zinc-400 border-r border-zinc-900">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {queryResults.rows.length === 0 ? (
                    <tr>
                      <td colSpan={queryResults.columns.length} className="p-6 text-center text-zinc-600 italic">
                        No rows returned.
                      </td>
                    </tr>
                  ) : (
                    queryResults.rows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-zinc-900/30 transition-colors">
                        {queryResults.columns.map((col) => (
                          <td key={col} className="p-3 border-r border-zinc-900/60 text-zinc-300">
                            {typeof row[col] === 'boolean' 
                              ? (row[col] ? 'TRUE' : 'FALSE') 
                              : row[col] !== null 
                              ? String(row[col]) 
                              : 'NULL'}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2">
                <RefreshCw className="w-6 h-6 animate-spin text-zinc-700" />
                <span className="text-xs italic text-zinc-500">Executing transaction rollback checks...</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
