/**
 * The ERD canvas, built on React Flow (@xyflow/react).
 *
 * React Flow owns pan/zoom/drag/selection/fit-view natively; we only build the
 * table + group nodes and the field-level relation edges from the parsed schema.
 * Edges are derived from live node positions each render, so they re-route as
 * tables are dragged (dbdiagram-style) with no custom routing code.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  applyNodeChanges,
  useNodesState,
  useReactFlow,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Grid3x3, Network, Snowflake, LayoutGrid, Search, Plus } from 'lucide-react';

import type { CanvasNode, ERDLink, ERDTableGroup } from '../../types/erd.types';
import { applyLayout, type LayoutType } from '../../shared/lib/layout-engine';
import { useAuthStore } from '../../store/useAuthStore';
import TableNode from './components/TableNode';
import GroupNode from './components/GroupNode';
import {
  buildEdges,
  buildGroupNodes,
  toTableNode,
  type TableEditAffordances,
  type TableRFNode,
} from './lib/build-graph';
import { useLayoutStore, resolvePositions } from './lib/layout-store';
import { applyErdEdit } from './lib/patch';

const nodeTypes: NodeTypes = { table: TableNode, group: GroupNode };

interface ERDCanvasProps {
  parsedNodes: CanvasNode[];
  links: ERDLink[];
  tableGroups: ERDTableGroup[];
  hiddenTables: Set<string>;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Current `.indigo` source buffer — `applyErdEdit`'s `addTable` affordance
   * parses this fresh on every click (design D3) and, on success, hands the
   * patched text to `onDslChange`. Persistence to disk is unaffected here —
   * this only updates the same in-memory buffer Monaco edits also apply to. */
  dslCode: string;
  onDslChange: (next: string) => void;
}

export default function ERDCanvas({
  parsedNodes,
  links,
  tableGroups,
  hiddenTables,
  isSidebarOpen,
  onToggleSidebar,
  dslCode,
  onDslChange,
}: ERDCanvasProps) {
  const [tableNodes, setTableNodes] = useNodesState<TableRFNode>([]);
  const [showGrid, setShowGrid] = useState(true);
  const { fitView } = useReactFlow();
  const { layout, loaded: layoutLoaded, updatePosition } = useLayoutStore();

  // Node CRUD affordances (Phase 4) are disabled — with a stated reason —
  // whenever the schema cannot ultimately be saved, so the user is never
  // led into edits that could not be persisted: no `schemaPath` configured
  // (`schemaWritable:false`) or the server is globally read-only.
  const schemaWritable = useAuthStore(s => s.schemaWritable);
  const readOnly = useAuthStore(s => s.readOnly);
  const editDisabled = !schemaWritable || readOnly;
  const editDisabledReason = readOnly
    ? 'Studio is in read-only mode.'
    : !schemaWritable
      ? 'This schema is not writable in the current Studio session.'
      : undefined;

  // Refusal banner for a rename/delete `applyErdEdit` call (e.g. `deleteTable`
  // refused as `referenced`) — surfaced here rather than silently dropped,
  // per `studio-erd-editing`'s delete-refusal requirement.
  const [editError, setEditError] = useState<string | null>(null);

  const handleRenameTable = useCallback(
    (from: string, to: string) => {
      const result = applyErdEdit(dslCode, { kind: 'renameTable', from, to });
      if (result.ok) {
        setEditError(null);
        onDslChange(result.text);
      } else {
        setEditError(result.message);
      }
    },
    [dslCode, onDslChange],
  );

  const handleDeleteTable = useCallback(
    (name: string) => {
      const result = applyErdEdit(dslCode, { kind: 'deleteTable', name });
      if (result.ok) {
        setEditError(null);
        onDslChange(result.text);
      } else {
        setEditError(result.message);
      }
    },
    [dslCode, onDslChange],
  );

  const handleAddField = useCallback(
    (table: string, name: string, fieldType: string) => {
      const result = applyErdEdit(dslCode, { kind: 'addField', table, name, fieldType });
      if (result.ok) {
        setEditError(null);
        onDslChange(result.text);
      } else {
        setEditError(result.message);
      }
    },
    [dslCode, onDslChange],
  );

  const handleEditField = useCallback(
    (table: string, field: string, changes: { name?: string; fieldType?: string }) => {
      const result = applyErdEdit(dslCode, { kind: 'editField', table, field, ...changes });
      if (result.ok) {
        setEditError(null);
        onDslChange(result.text);
      } else {
        setEditError(result.message);
      }
    },
    [dslCode, onDslChange],
  );

  const handleDeleteField = useCallback(
    (table: string, field: string) => {
      const result = applyErdEdit(dslCode, { kind: 'deleteField', table, field });
      if (result.ok) {
        setEditError(null);
        onDslChange(result.text);
      } else {
        setEditError(result.message);
      }
    },
    [dslCode, onDslChange],
  );

  const buildEditAffordances = useCallback(
    (name: string): TableEditAffordances => ({
      onRename: next => handleRenameTable(name, next),
      onDelete: () => handleDeleteTable(name),
      onAddField: (fieldName, fieldType) => handleAddField(name, fieldName, fieldType),
      onEditField: (field, changes) => handleEditField(name, field, changes),
      onDeleteField: field => handleDeleteField(name, field),
      disabled: editDisabled,
      disabledReason: editDisabledReason,
    }),
    [
      handleRenameTable,
      handleDeleteTable,
      handleAddField,
      handleEditField,
      handleDeleteField,
      editDisabled,
      editDisabledReason,
    ],
  );

  // Reconcile parsed schema → table nodes, preserving dragged positions.
  // Waits for the persisted layout to load first (`layoutLoaded`) so a
  // node's FIRST position always comes from the sidecar file when one
  // exists — starting from the parser's own seed formula and only
  // overwriting it once the layout arrives would flash the seed position
  // and then never re-apply the persisted one, since an already-reconciled
  // node's position is deliberately preserved below on every later run.
  useEffect(() => {
    if (!layoutLoaded) return;
    setTableNodes(prev => {
      const prevById = new Map(prev.map(n => [n.id, n]));
      const resolved = resolvePositions(parsedNodes.map(pn => pn.name), layout);
      return parsedNodes.map(pn => {
        const base = toTableNode(pn, hiddenTables.has(pn.name), buildEditAffordances(pn.name));
        const existing = prevById.get(pn.id);
        if (existing) {
          return { ...base, position: existing.position, selected: existing.selected };
        }
        const persisted = resolved[pn.name];
        return persisted ? { ...base, position: persisted } : base;
      });
    });
  }, [parsedNodes, hiddenTables, setTableNodes, layout, layoutLoaded, buildEditAffordances]);

  const groupNodes = useMemo(
    () => buildGroupNodes(tableNodes, tableGroups),
    [tableNodes, tableGroups],
  );

  const nodes = useMemo(() => [...groupNodes, ...tableNodes], [groupNodes, tableNodes]);
  const edges = useMemo(
    () => buildEdges(tableNodes, links, hiddenTables),
    [tableNodes, links, hiddenTables],
  );

  // Only table nodes are interactive; ignore changes to derived group nodes.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const tableChanges = changes.filter(
        c => !('id' in c) || !String((c as { id: string }).id).startsWith('group-'),
      );
      setTableNodes(nds => applyNodeChanges(tableChanges, nds) as TableRFNode[]);

      // Persist a table's position via the debounced layout autosave once a
      // drag ENDS (`dragging: false`) — a drag fires many intermediate
      // position changes with `dragging: true`, and each one would otherwise
      // restart its own debounce cycle.
      for (const change of tableChanges) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          updatePosition(change.id, change.position);
        }
      }
    },
    [setTableNodes, updatePosition],
  );

  // Picks a name that does not collide with any currently-parsed table, so
  // the affordance never needs a dialog just to add a starter table.
  const handleAddTable = useCallback(() => {
    const existingNames = new Set(parsedNodes.map(n => n.name));
    let name = 'NewTable';
    for (let suffix = 1; existingNames.has(name); suffix++) {
      name = `NewTable${suffix}`;
    }
    const result = applyErdEdit(dslCode, { kind: 'addTable', name });
    if (result.ok) {
      onDslChange(result.text);
    }
  }, [dslCode, onDslChange, parsedNodes]);

  const runLayout = useCallback(
    (type: LayoutType) => {
      setTableNodes(nds => {
        const canvasNodes: CanvasNode[] = nds.map(n => ({
          id: n.id,
          name: n.data.name,
          x: n.position.x,
          y: n.position.y,
          color: n.data.color ?? '',
          fields: n.data.fields,
        }));
        const laid = applyLayout(type, canvasNodes, links);
        const posById = new Map(laid.map(c => [c.id, { x: c.x, y: c.y }]));
        return nds.map(n => ({ ...n, position: posById.get(n.id) ?? n.position }));
      });
      window.setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
    },
    [links, setTableNodes, fitView],
  );

  return (
    <ReactFlow
      colorMode="dark"
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{
        type: 'smoothstep',
        style: { stroke: '#6b7280', strokeWidth: 2 },
      }}
    >
      {showGrid && <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#27272a" />}
      {editError && (
        <Panel position="top-center" className="max-w-lg">
          <div
            role="alert"
            className="px-3 py-2 rounded-lg bg-red-950/80 border border-red-800 text-red-300 text-xs font-mono shadow-xl"
          >
            {editError}
          </div>
        </Panel>
      )}
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={n => (n.type === 'group' ? 'transparent' : ((n.data as { color?: string }).color ?? '#3f3f46'))}
        maskColor="rgba(9,9,11,0.6)"
      />
      <Panel position="top-right" className="flex gap-1 bg-zinc-900/90 border border-zinc-800 p-1 rounded-lg shadow-xl backdrop-blur">
        <ToolbarButton title="Agregar tabla" onClick={handleAddTable}>
          <Plus size={15} />
        </ToolbarButton>
        <div className="w-px bg-zinc-800 mx-0.5" />
        <ToolbarButton title="Organización: Izquierda-derecha" onClick={() => runLayout('lr')}>
          <Network size={15} />
        </ToolbarButton>
        <ToolbarButton title="Organización: Snowflake" onClick={() => runLayout('snowflake')}>
          <Snowflake size={15} />
        </ToolbarButton>
        <ToolbarButton title="Organización: Compacto" onClick={() => runLayout('compact')}>
          <LayoutGrid size={15} />
        </ToolbarButton>
        <div className="w-px bg-zinc-800 mx-0.5" />
        <ToolbarButton title="Activar/Desactivar Cuadrícula" active={showGrid} onClick={() => setShowGrid(g => !g)}>
          <Grid3x3 size={15} />
        </ToolbarButton>
        <div className="w-px bg-zinc-800 mx-0.5" />
        <ToolbarButton title="Vistas del diagrama" active={isSidebarOpen} onClick={onToggleSidebar}>
          <Search size={15} />
        </ToolbarButton>
      </Panel>
    </ReactFlow>
  );
}

function ToolbarButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded cursor-pointer transition-colors ${
        active ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}
