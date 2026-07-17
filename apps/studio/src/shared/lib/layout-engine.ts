import type { CanvasNode } from '../../types/erd.types';
import type { ERDLink } from '../../types/erd.types';
import { getNodeHeight } from './node-geometry';

export type LayoutType = 'lr' | 'snowflake' | 'compact';

export function applyLRLayout(nodes: CanvasNode[], links: ERDLink[]): CanvasNode[] {
  const nodeRank: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};

  nodes.forEach(n => {
    nodeRank[n.id] = 0;
    adjacency[n.id] = [];
    inDegree[n.id] = 0;
  });

  links.forEach(l => {
    if (adjacency[l.from] && inDegree[l.to] !== undefined) {
      adjacency[l.from].push(l.to);
      inDegree[l.to]++;
    }
  });

  const queue: string[] = [];
  Object.keys(inDegree).forEach(id => {
    if (inDegree[id] === 0) queue.push(id);
  });

  if (queue.length === 0 && nodes.length > 0) {
    queue.push(nodes[0].id);
  }

  const maxIterations = nodes.length * 2;
  let iter = 0;
  while (queue.length > 0 && iter++ < maxIterations) {
    const current = queue.shift()!;
    const currentRank = nodeRank[current];
    adjacency[current]?.forEach(child => {
      if (nodeRank[child] <= currentRank) nodeRank[child] = currentRank + 1;
      inDegree[child]--;
      if (inDegree[child] === 0) queue.push(child);
    });
  }

  const rankGroups: Record<number, string[]> = {};
  Object.entries(nodeRank).forEach(([id, rank]) => {
    if (!rankGroups[rank]) rankGroups[rank] = [];
    rankGroups[rank].push(id);
  });

  const X_SPACING = 450;
  const Y_SPACING = 60;
  const newPositions: Record<string, { x: number; y: number }> = {};

  nodes.forEach(n => {
    const rank = nodeRank[n.id] || 0;
    const indexInRank = rankGroups[rank].indexOf(n.id);
    let yOffset = 80;
    for (let i = 0; i < indexInRank; i++) {
      const prevNodeId = rankGroups[rank][i];
      const prevNode = nodes.find(nn => nn.id === prevNodeId);
      if (prevNode) yOffset += getNodeHeight(prevNode) + Y_SPACING;
    }
    newPositions[n.id] = { x: 80 + rank * X_SPACING, y: yOffset };
  });

  return nodes.map(node => {
    const pos = newPositions[node.id];
    return pos ? { ...node, ...pos } : node;
  });
}

export function applySnowflakeLayout(nodes: CanvasNode[], links: ERDLink[]): CanvasNode[] {
  const degree: Record<string, number> = {};
  nodes.forEach(n => (degree[n.id] = 0));
  links.forEach(l => {
    if (degree[l.from] !== undefined) degree[l.from]++;
    if (degree[l.to] !== undefined) degree[l.to]++;
  });
  const sortedNodes = [...nodes].sort((a, b) => degree[b.id] - degree[a.id]);
  const CENTER_X = 800;
  const CENTER_Y = 600;
  const newPositions: Record<string, { x: number; y: number }> = {};
  if (sortedNodes.length > 0) newPositions[sortedNodes[0].id] = { x: CENTER_X, y: CENTER_Y };
  let currentRadius = 450;
  let nodesInCurrentCircle = 6;
  let nodeIndex = 1;
  while (nodeIndex < sortedNodes.length) {
    const endCircle = Math.min(nodeIndex + nodesInCurrentCircle, sortedNodes.length);
    const count = endCircle - nodeIndex;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI;
      newPositions[sortedNodes[nodeIndex + i].id] = {
        x: CENTER_X + currentRadius * Math.cos(angle),
        y: CENTER_Y + currentRadius * Math.sin(angle),
      };
    }
    nodeIndex += count;
    currentRadius += 450;
    nodesInCurrentCircle = Math.floor(nodesInCurrentCircle * 1.5);
  }
  return nodes.map(node => {
    const pos = newPositions[node.id];
    return pos ? { ...node, ...pos } : node;
  });
}

export function applyCompactLayout(nodes: CanvasNode[]): CanvasNode[] {
  const COLUMN_WIDTH = 320;
  const COLUMN_SPACING = 40;
  const ROW_SPACING = 40;
  const NUM_COLUMNS = Math.max(3, Math.ceil(Math.sqrt(nodes.length)));
  const columnHeights = new Array(NUM_COLUMNS).fill(80);
  const sortedNodes = [...nodes].sort((a, b) => (b.fields?.length ?? 0) - (a.fields?.length ?? 0));
  const newPositions: Record<string, { x: number; y: number }> = {};
  sortedNodes.forEach(n => {
    let minCol = 0;
    let minHeight = columnHeights[0];
    for (let i = 1; i < NUM_COLUMNS; i++) {
      if (columnHeights[i] < minHeight) {
        minHeight = columnHeights[i];
        minCol = i;
      }
    }
    newPositions[n.id] = { x: 80 + minCol * (COLUMN_WIDTH + COLUMN_SPACING), y: columnHeights[minCol] };
    columnHeights[minCol] += getNodeHeight(n) + ROW_SPACING;
  });
  return nodes.map(node => {
    const pos = newPositions[node.id];
    return pos ? { ...node, ...pos } : node;
  });
}

export function applyLayout(type: LayoutType, nodes: CanvasNode[], links: ERDLink[]): CanvasNode[] {
  switch (type) {
    case 'lr':
      return applyLRLayout(nodes, links);
    case 'snowflake':
      return applySnowflakeLayout(nodes, links);
    case 'compact':
      return applyCompactLayout(nodes);
  }
}
