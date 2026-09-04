/**
 * React Flow custom node: a database table card (dbdiagram-style).
 *
 * Each field row carries four handles (source/target × left/right) so
 * relations can attach at the exact field, on whichever side faces the related
 * table. In view mode (or whenever editing is disabled) the handles stay the
 * original 1×1, `opacity: 0` hit area and non-interactive — edges are built
 * programmatically from the schema, not drawn by the user. In edit mode
 * (`data.handlesConnectable`, design D7) they become connectable with an
 * enlarged hit area so the user can drag between two fields to draw a
 * relation via `ERDCanvas`'s `onConnect`. `buildEdges`' handle IDs
 * (`s-l-{idx}` etc.) are unchanged either way, so rendering is unaffected.
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { TableProperties, Pencil, Trash2, Plus } from 'lucide-react';
import { NODE_WIDTH, type TableRFNode } from '../lib/build-graph';

const hiddenHandleStyle: React.CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  background: 'transparent',
  border: 'none',
  opacity: 0,
};

const connectableHandleStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  minWidth: 8,
  minHeight: 8,
  background: '#6366f1',
  border: '1px solid #eef2ff',
  opacity: 0.85,
};

export default function TableNode({ data, selected }: NodeProps<TableRFNode>) {
  const fields = data.fields ?? [];
  // Absent unless `ERDCanvas` wired an edit context via `toTableNode` — a
  // node built without one (e.g. read-only view) renders no affordance at
  // all, not a disabled one.
  const editable = Boolean(data.onRename || data.onDelete);
  const fieldsEditable = Boolean(data.onEditField || data.onDeleteField);
  const disabled = Boolean(data.editDisabled);
  const disabledReason = data.editDisabledReason;
  const handlesConnectable = Boolean(data.handlesConnectable);
  const handleStyle = handlesConnectable ? connectableHandleStyle : hiddenHandleStyle;

  const handleRename = () => {
    if (disabled) return;
    const next = window.prompt(`Rename table "${data.name}" to:`, data.name);
    if (next && next !== data.name) data.onRename?.(next);
  };

  const handleDelete = () => {
    if (disabled) return;
    data.onDelete?.(data.name);
  };

  const handleAddField = () => {
    if (disabled) return;
    const name = window.prompt('New field name:');
    if (!name) return;
    const fieldType = window.prompt('Field type:', 'String');
    if (!fieldType) return;
    data.onAddField?.(name, fieldType);
  };

  const handleEditField = (field: { name: string; type: string }) => {
    if (disabled) return;
    const nextName = window.prompt(`Rename field "${field.name}" to:`, field.name);
    const nextType = window.prompt(`Type for "${nextName ?? field.name}":`, field.type);
    const changes: { name?: string; fieldType?: string } = {};
    if (nextName && nextName !== field.name) changes.name = nextName;
    if (nextType && nextType !== field.type) changes.fieldType = nextType;
    if (changes.name !== undefined || changes.fieldType !== undefined) {
      data.onEditField?.(field.name, changes);
    }
  };

  const handleDeleteField = (fieldName: string) => {
    if (disabled) return;
    data.onDeleteField?.(fieldName);
  };

  return (
    <div
      className={`bg-zinc-900 rounded-lg shadow-xl border flex flex-col font-mono text-sm overflow-hidden ${
        selected ? 'border-indigo-500 ring-2 ring-indigo-500/50' : 'border-zinc-700/50'
      }`}
      style={{ width: NODE_WIDTH, boxShadow: '0 10px 40px -10px rgba(0,0,0,0.5)' }}
    >
      {/* Header */}
      <div
        className="px-4 py-2 flex items-center justify-between"
        style={{ backgroundColor: data.color }}
      >
        <div className="flex items-center gap-2">
          <TableProperties size={16} className="text-zinc-900" />
          <span className="font-bold text-zinc-900">{data.name}</span>
        </div>
        {editable && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={disabled ? disabledReason : `Rename table "${data.name}"`}
              disabled={disabled}
              onClick={handleRename}
              className="p-0.5 rounded text-zinc-900/70 hover:text-zinc-900 hover:bg-black/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              title={disabled ? disabledReason : `Delete table "${data.name}"`}
              disabled={disabled}
              onClick={handleDelete}
              className="p-0.5 rounded text-zinc-900/70 hover:text-zinc-900 hover:bg-black/10 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>

      {/* Fields */}
      <div className="py-1.5 divide-y divide-zinc-900/40 font-mono text-[11px]">
        {fields.map((field, idx) => (
          <div
            key={idx}
            className="relative flex justify-between px-4 py-1.5 text-zinc-300 hover:bg-zinc-800/50 transition-colors"
          >
            {/* Field-level connection points: 1×1/invisible in view mode,
                enlarged and connectable in edit mode (design D7). */}
            <Handle id={`s-l-${idx}`} type="source" position={Position.Left} isConnectable={handlesConnectable} style={handleStyle} />
            <Handle id={`t-l-${idx}`} type="target" position={Position.Left} isConnectable={handlesConnectable} style={handleStyle} />
            <Handle id={`s-r-${idx}`} type="source" position={Position.Right} isConnectable={handlesConnectable} style={handleStyle} />
            <Handle id={`t-r-${idx}`} type="target" position={Position.Right} isConnectable={handlesConnectable} style={handleStyle} />

            <span className={`flex items-center gap-1 ${field.isPk ? 'font-semibold text-white' : ''}`}>
              {field.isPk && '🔑 '}
              {field.isUnique && '⚡ '}
              {field.relation && '🔗 '}
              {!field.isPk && !field.isUnique && !field.relation && <span className="pl-3.5" />}
              {field.name}
            </span>
            <span className="flex items-center gap-1.5 text-zinc-500">
              {field.type}
              {field.isNullable ? '?' : ''}
              {fieldsEditable && (
                <span className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title={disabled ? disabledReason : `Edit field "${field.name}"`}
                    disabled={disabled}
                    onClick={() => handleEditField(field)}
                    className="p-0.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-black/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    title={disabled ? disabledReason : `Delete field "${field.name}"`}
                    disabled={disabled}
                    onClick={() => handleDeleteField(field.name)}
                    className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-black/20 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              )}
            </span>
          </div>
        ))}
        {fields.length === 0 && (
          <div className="p-3 text-center text-zinc-500 text-[10px] italic">No fields defined</div>
        )}
        {data.onAddField && (
          <button
            type="button"
            title={disabled ? disabledReason : 'Add field'}
            disabled={disabled}
            onClick={handleAddField}
            className="w-full flex items-center justify-center gap-1 px-4 py-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            <Plus size={11} /> Add field
          </button>
        )}
      </div>
    </div>
  );
}
