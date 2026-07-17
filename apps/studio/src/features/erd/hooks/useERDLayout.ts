import { useCallback } from 'react';
import { applyLayout, type LayoutType } from '../../../shared/lib/layout-engine';
import type { CanvasNode, ERDLink } from '../../../types/erd.types';

export function useERDLayout(
  links: ERDLink[],
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>
) {
  const handleApplyLayout = useCallback(
    (type: LayoutType) => {
      setNodes(prev => applyLayout(type, prev, links));
    },
    [links, setNodes]
  );

  return { applyLayout: handleApplyLayout };
}
