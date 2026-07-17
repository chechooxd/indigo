import { useState, useRef, useEffect, useCallback } from 'react';
import type { CanvasNode, SelectionBox, ERDTableGroup } from '../../../types/erd.types';

interface UseERDInteractionProps {
  nodes: CanvasNode[];
  setNodes: React.Dispatch<React.SetStateAction<CanvasNode[]>>;
  tableGroups: ERDTableGroup[];
  hiddenTables: Set<string>;
}

export function useERDInteraction({ nodes, setNodes, tableGroups, hiddenTables }: UseERDInteractionProps) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoomLevel, setZoomLevel] = useState(100);
  const [isPanning, setIsPanning] = useState(false);
  const [isPanModeActive, setIsPanModeActive] = useState(false);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [coords, setCoords] = useState({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);
  const panStartRef = useRef({ x: 0, y: 0 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const baseSelectionRef = useRef<Set<string>>(new Set());

  const handleMouseUp = useCallback(() => {
    setDraggingNodeId(null);
    setIsPanning(false);
    setSelectionBox(null);
  }, []);

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseUp]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setPan({ x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y });
        return;
      }
      let currentCoords = coords;
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = Math.round((e.clientX - rect.left - pan.x * (zoomLevel / 100)) / (zoomLevel / 100));
        const y = Math.round((e.clientY - rect.top - pan.y * (zoomLevel / 100)) / (zoomLevel / 100));
        currentCoords = { x, y };
        setCoords(currentCoords);
      }
      if (draggingNodeId) {
        setNodes(prev => {
          const node = prev.find(n => n.id === draggingNodeId);
          if (!node) return prev;
          let finalX = currentCoords.x - dragOffsetRef.current.x;
          let finalY = currentCoords.y - dragOffsetRef.current.y;
          const nodeWidth = 256;
          const nodeHeight = 40 + (node.fields?.length ?? 0) * 28;
          const nodeRect = { left: finalX, top: finalY, right: finalX + nodeWidth, bottom: finalY + nodeHeight };
          for (const group of tableGroups) {
            if (group.tables.includes(draggingNodeId)) continue;
            const groupNodes = prev.filter(n => group.tables.includes(n.id) && !hiddenTables.has(n.id));
            if (groupNodes.length === 0) continue;
            const padding = 24;
            const minX = Math.min(...groupNodes.map(n => n.x)) - padding;
            const minY = Math.min(...groupNodes.map(n => n.y)) - padding;
            const maxX = Math.max(...groupNodes.map(n => n.x + 256)) + padding;
            const maxY = Math.max(...groupNodes.map(n => n.y + 40 + (n.fields?.length ?? 0) * 28)) + padding;
            const groupRect = { left: minX, top: minY, right: maxX, bottom: maxY };
            if (!(groupRect.left > nodeRect.right || groupRect.right < nodeRect.left || groupRect.top > nodeRect.bottom || groupRect.bottom < nodeRect.top)) {
              const pushLeft = groupRect.left - nodeRect.right;
              const pushRight = groupRect.right - nodeRect.left;
              const pushTop = groupRect.top - nodeRect.bottom;
              const pushBottom = groupRect.bottom - nodeRect.top;
              const minPush = Math.min(Math.abs(pushLeft), Math.abs(pushRight), Math.abs(pushTop), Math.abs(pushBottom));
              if (minPush === Math.abs(pushLeft)) finalX += pushLeft;
              else if (minPush === Math.abs(pushRight)) finalX += pushRight;
              else if (minPush === Math.abs(pushTop)) finalY += pushTop;
              else finalY += pushBottom;
              nodeRect.left = finalX;
              nodeRect.right = finalX + nodeWidth;
              nodeRect.top = finalY;
              nodeRect.bottom = finalY + nodeHeight;
            }
          }
          const deltaX = finalX - node.x;
          const deltaY = finalY - node.y;
          return prev.map(n => {
            if (n.id === draggingNodeId) return { ...n, x: finalX, y: finalY };
            if (selectedNodeIds.has(n.id) && n.id !== draggingNodeId) return { ...n, x: n.x + deltaX, y: n.y + deltaY };
            return n;
          });
        });
      }
      if (selectionBox && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const cx = Math.round((e.clientX - rect.left - pan.x * (zoomLevel / 100)) / (zoomLevel / 100));
        const cy = Math.round((e.clientY - rect.top - pan.y * (zoomLevel / 100)) / (zoomLevel / 100));
        setSelectionBox(prev => (prev ? { ...prev, endX: cx, endY: cy } : null));
        const minX = Math.min(selectionBox.startX, cx);
        const maxX = Math.max(selectionBox.startX, cx);
        const minY = Math.min(selectionBox.startY, cy);
        const maxY = Math.max(selectionBox.startY, cy);
        const newSelected = new Set(baseSelectionRef.current);
        nodes.forEach(n => {
          if (hiddenTables.has(n.id)) return;
          const nW = 256;
          const nH = 40 + (n.fields?.length ?? 0) * 28;
          if (n.x + nW > minX && n.x < maxX && n.y + nH > minY && n.y < maxY) newSelected.add(n.id);
        });
        setSelectedNodeIds(newSelected);
      }
    },
    [isPanning, pan, zoomLevel, draggingNodeId, selectionBox, nodes, tableGroups, hiddenTables, selectedNodeIds, coords]
  );

  const handleNodeMouseDown = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (isPanModeActive) return;
      e.preventDefault();
      e.stopPropagation();
      let newSelection = new Set(selectedNodeIds);
      if (!newSelection.has(id)) {
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) newSelection = new Set([id]);
        else newSelection.add(id);
        setSelectedNodeIds(newSelection);
      }
      setDraggingNodeId(id);
      const targetNode = nodes.find(n => n.id === id);
      if (targetNode) {
        dragOffsetRef.current = { x: coords.x - targetNode.x, y: coords.y - targetNode.y };
      }
    },
    [isPanModeActive, selectedNodeIds, nodes, coords]
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.button === 0 && isPanModeActive) || e.button === 1) {
        setIsPanning(true);
        panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      } else if (e.button === 0 && !isPanModeActive && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const startX = Math.round((e.clientX - rect.left - pan.x * (zoomLevel / 100)) / (zoomLevel / 100));
        const startY = Math.round((e.clientY - rect.top - pan.y * (zoomLevel / 100)) / (zoomLevel / 100));
        setSelectionBox({ startX, startY, endX: startX, endY: startY });
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          setSelectedNodeIds(new Set());
          baseSelectionRef.current = new Set();
        } else {
          baseSelectionRef.current = new Set(selectedNodeIds);
        }
      }
    },
    [isPanModeActive, pan, zoomLevel, selectedNodeIds]
  );

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoomLevel(prev => Math.min(Math.max(20, prev - e.deltaY * 0.5), 200));
    } else {
      setPan(prev => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  }, []);

  const handleZoom = useCallback((direction: 'in' | 'out') => {
    setZoomLevel(prev => (direction === 'in' ? Math.min(150, prev + 10) : Math.max(50, prev - 10)));
  }, []);

  const handleFitToScreen = useCallback(
    (visibleNodes: CanvasNode[]) => {
      if (!canvasRef.current || visibleNodes.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      visibleNodes.forEach(n => {
        const h = 40 + (n.fields?.length ?? 0) * 28;
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + 256 > maxX) maxX = n.x + 256;
        if (n.y + h > maxY) maxY = n.y + h;
      });
      const padding = 100;
      const contentWidth = maxX - minX + padding * 2;
      const contentHeight = maxY - minY + padding * 2;
      const viewport = canvasRef.current.parentElement;
      if (!viewport) return;
      const { clientWidth, clientHeight } = viewport;
      const newZoom = Math.min(clientWidth / contentWidth, clientHeight / contentHeight, 1.5) * 100;
      const clampedZoom = Math.max(20, Math.min(newZoom, 150));
      const scaledW = (maxX - minX) * (clampedZoom / 100);
      const scaledH = (maxY - minY) * (clampedZoom / 100);
      setZoomLevel(Math.round(clampedZoom));
      setPan({
        x: (clientWidth - scaledW) / 2 - minX * (clampedZoom / 100),
        y: (clientHeight - scaledH) / 2 - minY * (clampedZoom / 100),
      });
    },
    []
  );

  return {
    pan,
    zoomLevel,
    isPanModeActive,
    selectedNodeIds,
    selectionBox,
    coords,
    canvasRef,
    handleMouseMove,
    handleNodeMouseDown,
    handleCanvasMouseDown,
    handleWheel,
    handleZoom,
    handleFitToScreen,
    togglePanMode: () => setIsPanModeActive(p => !p),
  };
}
