/**
 * Converts the parsed ERD view-model (CanvasNode[] + ERDLink[]) into React Flow
 * nodes and edges.
 *
 * Field-level, dbdiagram-style relations: each edge attaches to the specific FK
 * field on the source and the referenced field on the target, and picks the
 * left/right side of each table based on their relative position — recomputed
 * every render, so edges re-route automatically as tables are dragged. The
 * orthogonal, rounded geometry itself is React Flow's native `smoothstep` edge.
 */

import type { Node, Edge } from '@xyflow/react';
import type { CanvasNode, ERDLink } from '../../../types/erd.types';
import type { Field } from '../../../lib/parser';
import { NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_FIELD_HEIGHT } from '../../../shared/lib/node-geometry';

export { NODE_WIDTH };

export interface TableNodeData extends Record<string, unknown> {
  name: string;
  color?: string;
  fields: Field[];
}

export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  width: number;
  height: number;
  color?: string;
}

export type TableRFNode = Node<TableNodeData, 'table'>;
export type GroupRFNode = Node<GroupNodeData, 'group'>;

/** Which field row an edge endpoint connects to (source FK / target PK). */
function sourceFieldIndex(node: CanvasNode, link: ERDLink, targetName: string): number {
  const fields = node.fields ?? [];
  let idx = fields.findIndex(f => f.name === link.sourceField);
  if (idx === -1) idx = fields.findIndex(f => f.relation?.model === targetName);
  return Math.max(0, idx);
}

function targetFieldIndex(node: CanvasNode, link: ERDLink): number {
  const fields = node.fields ?? [];
  let idx = fields.findIndex(f => f.name === link.targetField);
  if (idx === -1) idx = fields.findIndex(f => f.isPk);
  return Math.max(0, idx);
}

/** Builds a table node keeping React Flow as the owner of live position. */
export function toTableNode(node: CanvasNode, hidden: boolean): TableRFNode {
  return {
    id: node.id,
    type: 'table',
    position: { x: node.x, y: node.y },
    hidden,
    data: { name: node.name, color: node.color, fields: node.fields ?? [] },
  };
}

/**
 * Builds edges from the current node positions. `nodes` must carry live
 * positions (React Flow node state) so the side selection tracks dragging.
 */
export function buildEdges(
  nodes: TableRFNode[],
  links: ERDLink[],
  hidden: Set<string>,
): Edge[] {
  const byId = new Map(nodes.map(n => [n.id, n]));

  return links
    .filter(l => !hidden.has(l.from) && !hidden.has(l.to))
    .map((link, idx): Edge | null => {
      const source = byId.get(link.from);
      const target = byId.get(link.to);
      if (!source || !target) return null;

      const sFields = source.data.fields;
      const tFields = target.data.fields;
      const sIdx = sourceFieldIndex(
        { id: source.id, name: source.data.name, x: 0, y: 0, color: '', fields: sFields },
        link,
        target.data.name,
      );
      const tIdx = targetFieldIndex(
        { id: target.id, name: target.data.name, x: 0, y: 0, color: '', fields: tFields },
        link,
      );

      // Attach on the side of each table that faces the other one.
      const sourceCenter = source.position.x + NODE_WIDTH / 2;
      const targetCenter = target.position.x + NODE_WIDTH / 2;
      const targetIsRight = targetCenter >= sourceCenter;
      const sourceSide = targetIsRight ? 'r' : 'l';
      const targetSide = targetIsRight ? 'l' : 'r';

      return {
        id: `edge-${idx}-${link.from}-${link.to}`,
        source: link.from,
        target: link.to,
        sourceHandle: `s-${sourceSide}-${sIdx}`,
        targetHandle: `t-${targetSide}-${tIdx}`,
        type: 'smoothstep',
        data: { relationType: link.relationType },
      } satisfies Edge;
    })
    .filter((e): e is Edge => e !== null);
}

/** Derives background group boxes from the live positions of member tables. */
export function buildGroupNodes(
  nodes: TableRFNode[],
  tableGroups: { name: string; tables: string[] }[],
): GroupRFNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const PAD = 28;

  return tableGroups
    .map((group): GroupRFNode | null => {
      const members = group.tables
        .map(t => byId.get(t))
        .filter((n): n is TableRFNode => !!n && !n.hidden);
      if (members.length === 0) return null;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const m of members) {
        const h = NODE_HEADER_HEIGHT + m.data.fields.length * NODE_FIELD_HEIGHT;
        minX = Math.min(minX, m.position.x);
        minY = Math.min(minY, m.position.y);
        maxX = Math.max(maxX, m.position.x + NODE_WIDTH);
        maxY = Math.max(maxY, m.position.y + h);
      }

      const width = maxX - minX + PAD * 2;
      const height = maxY - minY + PAD * 2 + 18;

      return {
        id: `group-${group.name}`,
        type: 'group',
        position: { x: minX - PAD, y: minY - PAD - 18 },
        // Explicit width/height on the node itself (not just the inner div's
        // CSS) so React Flow can place it immediately instead of waiting for
        // a ResizeObserver measurement pass — group nodes are rebuilt fresh
        // every render (derived from live table positions), so they never
        // stay mounted long enough for that measurement to land, and were
        // rendered permanently `visibility: hidden` without this.
        width,
        height,
        style: { width, height },
        draggable: false,
        selectable: false,
        connectable: false,
        zIndex: -1,
        data: {
          label: group.name,
          width,
          height,
          color: members[0]?.data.color,
        },
      };
    })
    .filter((n): n is GroupRFNode => n !== null);
}
