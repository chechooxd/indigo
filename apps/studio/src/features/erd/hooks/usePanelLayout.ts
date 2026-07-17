import { useState, useEffect } from 'react';

export type PanelLayout = 'both' | 'editor' | 'canvas';

export function usePanelLayout() {
  const [editorWidth, setEditorWidth] = useState(40);
  const [layout, setLayout] = useState<PanelLayout>('both');
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMoveResize = (e: MouseEvent) => {
      const newWidth = (e.clientX / window.innerWidth) * 100;
      if (newWidth > 15 && newWidth < 85) {
        setEditorWidth(newWidth);
      } else if (newWidth <= 15) {
        setLayout('canvas');
        setEditorWidth(40);
        setIsResizing(false);
      } else if (newWidth >= 85) {
        setLayout('editor');
        setEditorWidth(40);
        setIsResizing(false);
      }
    };
    const handleMouseUpResize = () => setIsResizing(false);
    window.addEventListener('mousemove', handleMouseMoveResize);
    window.addEventListener('mouseup', handleMouseUpResize);
    return () => {
      window.removeEventListener('mousemove', handleMouseMoveResize);
      window.removeEventListener('mouseup', handleMouseUpResize);
    };
  }, [isResizing]);

  return { layout, setLayout, editorWidth, isResizing, startResize: () => setIsResizing(true) };
}
