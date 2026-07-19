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

export interface ERDTableGroup {
  name: string;
  color?: string;
  tables: string[];
}
