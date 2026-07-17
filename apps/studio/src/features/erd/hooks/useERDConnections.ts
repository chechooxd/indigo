import { useMemo } from 'react';
import { routeOrthogonal, pathToSvg } from '../../../lib/routing';
import type { Box } from '../../../lib/routing';
import type { CanvasNode, ERDLink, ConnectionPath } from '../../../types/erd.types';

interface UseERDConnectionsProps {
  nodes: CanvasNode[];
  links: ERDLink[];
  hiddenTables: Set<string>;
  animateRelations: boolean;
  selectedNodeIds: Set<string>;
}

export function useERDConnections({
  nodes,
  links,
  hiddenTables,
  animateRelations,
  selectedNodeIds,
}: UseERDConnectionsProps) {
  const visibleLinks = useMemo(
    () => links.filter(l => !hiddenTables.has(l.from) && !hiddenTables.has(l.to)),
    [links, hiddenTables]
  );

  const visibleNodes = useMemo(
    () => nodes.filter(n => !hiddenTables.has(n.id)),
    [nodes, hiddenTables]
  );

  const connectionPaths = useMemo<ConnectionPath[]>(() => {
    return visibleLinks
      .map((link, idx): ConnectionPath | null => {
        const sourceNode = nodes.find(n => n.id === link.from);
        const targetNode = nodes.find(n => n.id === link.to);
        if (!sourceNode || !targetNode) return null;

        let sourceFieldIndex = sourceNode.fields?.findIndex(f => f.name === link.sourceField) ?? -1;
        if (sourceFieldIndex === -1)
          sourceFieldIndex = sourceNode.fields?.findIndex(f => f.relation?.model === targetNode.name) ?? 0;
        let targetFieldIndex = targetNode.fields?.findIndex(f => f.name === link.targetField) ?? -1;
        if (targetFieldIndex === -1)
          targetFieldIndex = targetNode.fields?.findIndex(f => f.isPk) ?? 0;
        sourceFieldIndex = Math.max(0, sourceFieldIndex);
        targetFieldIndex = Math.max(0, targetFieldIndex);

        const resolvedSourceField = sourceNode.fields?.[sourceFieldIndex]?.name;
        const resolvedTargetField = targetNode.fields?.[targetFieldIndex]?.name;

        const startY = sourceNode.y + 52 + sourceFieldIndex * 28;
        const endY = targetNode.y + 52 + targetFieldIndex * 28;
        const sourceRight = sourceNode.x + 256;
        const sourceLeft = sourceNode.x;
        const targetRight = targetNode.x + 256;
        const targetLeft = targetNode.x;

        const boxes: Box[] = visibleNodes.map(n => ({
          left: n.x - 24,
          right: n.x + 256 + 24,
          top: n.y - 24,
          bottom: n.y + 52 + (n.fields?.length ?? 0) * 28 + 24,
        }));

        let startX: number, endX: number;
        let sourceAttachSide: 'left' | 'right' = 'right';
        let targetAttachSide: 'left' | 'right' = 'left';

        if (sourceRight + 30 < targetLeft) {
          startX = sourceRight;
          endX = targetLeft;
        } else if (sourceLeft > targetRight + 30) {
          startX = sourceLeft;
          endX = targetRight;
          sourceAttachSide = 'left';
          targetAttachSide = 'right';
        } else {
          startX = sourceRight;
          endX = targetRight;
          targetAttachSide = 'right';
        }

        const pathPoints = routeOrthogonal(
          { x: startX, y: startY },
          { x: endX, y: endY },
          sourceAttachSide,
          targetAttachSide,
          boxes
        );
        const d = pathToSvg(pathPoints, 8);

        return {
          id: `link-${idx}`,
          fromId: link.from,
          toId: link.to,
          d,
          startX,
          startY,
          endX,
          endY,
          relationType: link.relationType,
          resolvedSourceField,
          resolvedTargetField,
          sourceAttachSide,
          targetAttachSide,
        } satisfies ConnectionPath;
      })
      .filter((p): p is ConnectionPath => p !== null);
  }, [nodes, visibleLinks, visibleNodes]);

  const activeFields = useMemo(() => {
    const active = new Set<string>();
    connectionPaths.forEach(path => {
      const isActive = animateRelations || selectedNodeIds.has(path.fromId) || selectedNodeIds.has(path.toId);
      if (isActive) {
        if (path.resolvedSourceField) active.add(`${path.fromId}.${path.resolvedSourceField}`);
        if (path.resolvedTargetField) active.add(`${path.toId}.${path.resolvedTargetField}`);
      }
    });
    return active;
  }, [connectionPaths, animateRelations, selectedNodeIds]);

  return { connectionPaths, activeFields, visibleNodes };
}
