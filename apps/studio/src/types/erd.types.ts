import type { Field } from '../lib/parser';

export interface CanvasNode {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  fields?: Field[];
}

export interface ERDLink {
  from: string;
  to: string;
  relationType: '1-1' | '1-n' | 'n-1';
  sourceField?: string;
  targetField?: string;
}

export interface ConnectionPath {
  id: string;
  fromId: string;
  toId: string;
  d: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  relationType: '1-1' | '1-n' | 'n-1';
  resolvedSourceField?: string;
  resolvedTargetField?: string;
  sourceAttachSide: 'left' | 'right';
  targetAttachSide: 'left' | 'right';
}

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface ERDTableGroup {
  name: string;
  tables: string[];
}
