import type { CanvasNode } from '../../types/erd.types';

export const NODE_WIDTH = 256;
export const NODE_HEADER_HEIGHT = 40;
export const NODE_FIELD_HEIGHT = 28;

export function getNodeHeight(node: CanvasNode): number {
  return NODE_HEADER_HEIGHT + (node.fields?.length ?? 0) * NODE_FIELD_HEIGHT;
}
