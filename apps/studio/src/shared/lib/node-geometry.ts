import type { CanvasNode } from '../../types/erd.types';

export const NODE_WIDTH = 256;
export const NODE_HEADER_HEIGHT = 40;
export const NODE_FIELD_HEIGHT = 28;
export const NODE_PADDING_TOP = 52; // header + top spacing

export function getNodeHeight(node: CanvasNode): number {
  return NODE_HEADER_HEIGHT + (node.fields?.length ?? 0) * NODE_FIELD_HEIGHT;
}

export function getNodeFieldY(nodeY: number, fieldIndex: number): number {
  return nodeY + NODE_PADDING_TOP + fieldIndex * NODE_FIELD_HEIGHT;
}

export function getNodeBounds(node: CanvasNode) {
  return {
    left: node.x,
    right: node.x + NODE_WIDTH,
    top: node.y,
    bottom: node.y + getNodeHeight(node),
  };
}

export function getNodePaddedBounds(node: CanvasNode, padding = 24) {
  const bounds = getNodeBounds(node);
  return {
    left: bounds.left - padding,
    right: bounds.right + padding,
    top: bounds.top - padding,
    bottom: bounds.bottom + padding,
  };
}
