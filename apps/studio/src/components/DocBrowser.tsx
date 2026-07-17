/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { Search, Share, Terminal, Copy, ArrowRight, Table, Database, Sparkles } from 'lucide-react';
import { useDataStore } from '../store/useDataStore';
import { useNavigationStore } from '../store/useNavigationStore';

export default function DocBrowser() {
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
    return tables.map((t, idx) => ({ ...t, originalIdx: idx }))
      .filter(t => t.name.toLowerCase().includes(docFilterQuery.toLowerCase()));
  }, [tables, docFilterQuery]);

  // Generate dynamic DDL code based on the selected table's schema
  const ddlDefinitionCode = useMemo(() => {
    if (!activeTable) return '';
    let code = `CREATE TABLE ${activeTable.schema}.${activeTable.name} (\n`;
    activeTable.columns.forEach((col, idx) => {
      let line = `  ${col.name} ${col.type.toLowerCase()}`;
      if (col.isPK) line += ' PRIMARY KEY';
      if (col.isNN) line += ' NOT NULL';
      if (col.isUQ) line += ' UNIQUE';
      if (col.defaultValue) line += ` DEFAULT ${col.defaultValue}`;
      
      const isLast = idx === activeTable.columns.length - 1;
      line += isLast ? '' : ',';
      code += line + '\n';
    });
    code += `);\n\n-- Create optimized index\nCREATE INDEX idx_${activeTable.name}_lookup ON ${activeTable.name}(id);`;
    return code;
  }, [activeTable]);

  const handleCopyDDL = () => {
    navigator.clipboard.writeText(ddlDefinitionCode);
    alert(`Success: DDL schema script for "${activeTable.name}" copied to clipboard.`);
  };

  const handleShareReference = () => {
    const url = window.location.href + `#docs/${activeTable.schema}/${activeTable.name}`;
    navigator.clipboard.writeText(url);
    alert(`Reference link generated and copied to clipboard:\n\n${url}`);
  };

  const triggerQueryTable = () => {
    // We would normally pass code via store, for now just navigate
    navigate('studio', 'query');
  };

  return (
    <div id="docs-workbench" className="flex-1 flex overflow-hidden bg-[#09090b]">
      {/* Docs Schema Navigation Sidebar */}
      <section className="w-[280px] h-full border-r border-zinc-800 flex flex-col bg-[#09090b] shrink-0">
        <div className="p-4">
          <div className="flex items-center gap-2 text-zinc-400 relative bg-zinc-950/20 rounded-xl border border-zinc-800 px-3 py-2 focus-within:border-zinc-700">
            <Search className="w-4 h-4 text-zinc-600" />
            <input 
              value={docFilterQuery}
              onChange={(e) => setDocFilterQuery(e.target.value)}
              className="bg-transparent border-0 focus:ring-0 text-xs w-full outline-none p-0 text-zinc-200 placeholder-zinc-600" 
              placeholder="Search specs & index..." 
              type="text"
            />
          </div>
        </div>

        {/* Dynamic Category List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar text-xs">
          <div>
            <div className="px-3 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-sans">
              CORE SCHEMAS
            </div>
            <div className="space-y-1 mt-2">
              {filteredTables.filter(t => t.schema === 'public' || t.schema === 'billing').map((t) => {
                const isSelected = activeTable.name === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() => setSelectedTableIdx(t.originalIdx)}
                    className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer ${
                      isSelected 
                        ? 'bg-zinc-900 text-white font-semibold border border-zinc-800' 
                        : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                    }`}
                  >
                    <Table className="w-3.5 h-3.5 text-zinc-500" />
                    <span className="font-mono">{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="px-3 py-1 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-sans">
              ANALYTICS & AUXILIARY
            </div>
            <div className="space-y-1 mt-2">
              {filteredTables.filter(t => t.schema === 'analytics').map((t) => {
                const isSelected = activeTable.name === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() => setSelectedTableIdx(t.originalIdx)}
                    className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-all cursor-pointer ${
                      isSelected 
                        ? 'bg-zinc-900 text-white font-semibold border border-zinc-800' 
                        : 'text-zinc-500 hover:text-white hover:bg-zinc-900/60'
                    }`}
                  >
                    <Table className="w-3.5 h-3.5 text-zinc-500" />
                    <span className="font-mono">{t.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Docs Center Main Content Area */}
      <article className="flex-1 overflow-y-auto bg-[#09090b] custom-scrollbar pb-12">
        {/* Header Hero Banner */}
        <div className="relative h-48 w-full border-b border-zinc-800 bg-zinc-950/20 flex flex-col justify-end p-8 overflow-hidden shrink-0">
          <div className="absolute top-0 right-0 p-8 opacity-5">
            <Database className="w-32 h-32 text-zinc-500" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-zinc-900 border border-zinc-800 text-zinc-300 px-2 py-0.5 rounded-lg text-[10px] font-bold tracking-wider font-mono">
                TABLE
              </span>
              <span className="text-zinc-500 text-xs font-mono">{activeTable.schema}.{activeTable.name}</span>
            </div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight font-sans">
              {activeTable.name}
            </h1>
            <p className="text-zinc-400 mt-2 text-xs font-sans max-w-3xl leading-relaxed">
              Provides unified metadata specifications for the <span className="font-mono font-semibold text-zinc-200">{activeTable.name}</span> entity. Automatically managed within the transactional limits of active cluster branches.
            </p>
          </div>

          <div className="absolute bottom-6 right-8 flex gap-2">
            <button 
              onClick={handleShareReference}
              className="bg-zinc-900 border border-zinc-800 text-zinc-300 px-3.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Share className="w-3.5 h-3.5" />
              <span>Share Reference</span>
            </button>
            <button 
              onClick={triggerQueryTable}
              className="bg-white text-black px-4 py-1.5 rounded-xl text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 hover:bg-zinc-200 transition-all cursor-pointer shadow-lg"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Query Table</span>
            </button>
          </div>
        </div>

        {/* Content specification blocks */}
        <div className="p-8 max-w-4xl mx-auto space-y-10">
          {/* Section: Columns Spec */}
          <section>
            <h2 className="text-xs font-bold text-zinc-400 mb-4 uppercase tracking-widest font-sans flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
              <span>Columns Specification</span>
            </h2>
            <div className="border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
              <table className="w-full text-left text-xs font-sans">
                <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800 font-semibold">
                  <tr>
                    <th className="p-3">Column Name</th>
                    <th className="p-3">Type</th>
                    <th className="p-3">Constraints</th>
                    <th className="p-3">Default Value</th>
                    <th className="p-3">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900 text-zinc-300">
                  {activeTable.columns.map((col) => (
                    <tr key={col.name} className="hover:bg-zinc-950/40 transition-colors">
                      <td className="p-3 font-mono font-bold text-zinc-100">{col.name}</td>
                      <td className="p-3">
                        <span className="bg-zinc-900 text-zinc-400 border border-zinc-800/80 px-1.5 py-0.5 rounded-md font-mono text-[10px]">
                          {col.type}
                        </span>
                      </td>
                      <td className="p-3 font-semibold text-xs">
                        <div className="flex gap-1">
                          {col.isPK && <span className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-[9px]">PK</span>}
                          {col.isNN && <span className="bg-zinc-900/40 border border-zinc-900 text-zinc-500 px-1.5 py-0.5 rounded text-[9px]">NN</span>}
                          {col.isUQ && <span className="bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-[9px]">UQ</span>}
                        </div>
                      </td>
                      <td className="p-3 text-zinc-500 font-mono text-[11px] italic">
                        {col.defaultValue || '-'}
                      </td>
                      <td className="p-3 text-zinc-400 max-w-xs text-[11px] leading-relaxed">
                        {col.description || 'Database engine system column value.'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Section DDL and Relationships */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* DDL Segment */}
            <section className="flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-sans">
                  DDL Definition
                </h3>
                <button 
                  onClick={handleCopyDDL}
                  className="text-zinc-400 text-[10px] font-bold flex items-center gap-1.5 hover:text-white hover:underline cursor-pointer"
                >
                  <Copy className="w-3 h-3" /> Copy Schema
                </button>
              </div>
              <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-2xl p-4 font-mono text-[11px] text-zinc-300 leading-relaxed whitespace-pre overflow-x-auto shadow-inner">
                {ddlDefinitionCode}
              </div>
            </section>

            {/* Relationships Specs */}
            <section className="flex flex-col justify-between">
              <div>
                <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-sans mb-3">
                  Relational Dependencies
                </h3>
                <div className="space-y-3">
                  {activeRelations.length > 0 ? (
                    activeRelations.map((rel, i) => {
                      const label =
                        rel.type === 'OneToOne' ? '1-to-1' : rel.list ? '1-to-N' : 'N-to-1';
                      const detail =
                        rel.fkColumns.length > 0
                          ? `Foreign Key: ${rel.fkColumns.join(', ')} → ${rel.targetModel}.${rel.refColumns.join(', ')}`
                          : `References ${rel.targetModel}`;
                      return (
                        <div key={i} className="p-3.5 bg-zinc-950 border border-zinc-800 rounded-2xl flex items-center justify-between hover:border-zinc-700 transition-colors cursor-pointer">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] bg-zinc-900 border border-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-bold font-mono">{label}</span>
                            <div>
                              <div className="text-[11px] font-bold text-white font-mono">{rel.name}</div>
                              <div className="text-[9px] text-zinc-500">{detail}</div>
                            </div>
                          </div>
                          <ArrowRight className="w-3.5 h-3.5 text-zinc-600" />
                        </div>
                      );
                    })
                  ) : (
                    <div className="p-6 text-center border border-zinc-900 rounded-2xl text-zinc-600 text-[11px] italic">
                      No relationships defined for this table.
                    </div>
                  )}
                </div>
              </div>

              {/* Table Metrics summary */}
              <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-2xl space-y-2 mt-4 font-sans text-xs">
                <div className="text-white font-bold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Metadata Summary</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Record Count:</span>
                  <span className="font-mono text-zinc-200 font-semibold">{activeTable.records ? activeTable.records.length : 0} live rows</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </article>
    </div>
  );
}
