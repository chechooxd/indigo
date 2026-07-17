/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Minus, Plus, Maximize, Hand, Workflow, Network, LayoutGrid, Grid3X3, Zap } from 'lucide-react';

interface ERDToolbarProps {
  zoomLevel: number;
  isPanModeActive: boolean;
  showGrid: boolean;
  animateRelations: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  onTogglePanMode: () => void;
  onApplyLayout: (type: 'lr' | 'snowflake' | 'compact') => void;
  onToggleGrid: () => void;
  onToggleAnimateRelations: () => void;
}

export default function ERDToolbar({
  zoomLevel,
  isPanModeActive,
  showGrid,
  animateRelations,
  onZoomIn,
  onZoomOut,
  onFitToScreen,
  onTogglePanMode,
  onApplyLayout,
  onToggleGrid,
  onToggleAnimateRelations,
}: ERDToolbarProps) {
  return (
    <>
      {/* Bottom-left: Zoom & Pan controls */}
      <div className="absolute bottom-6 left-6 z-10 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl flex items-center p-1.5 gap-1 text-xs font-semibold">
        <button
          onClick={onZoomOut}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
        >
          <Minus size={18} />
        </button>
        <div className="flex items-center px-2 font-mono text-zinc-300 min-w-[3rem] justify-center">{zoomLevel}%</div>
        <button
          onClick={onZoomIn}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
        >
          <Plus size={18} />
        </button>
        <div className="w-px h-6 bg-zinc-800 mx-1" />
        <button
          onClick={onFitToScreen}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
          title="Ajustar todos los elementos en la vista — 1"
        >
          <Maximize size={18} />
        </button>
        <button
          onClick={onTogglePanMode}
          className={`p-2 rounded cursor-pointer ml-1 transition-colors ${isPanModeActive ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700'}`}
          title="Haz clic para activar el modo panorámico&#10;O mantén Espacio/clic medio del ratón + arrastra para desplazarte"
        >
          <Hand size={18} />
        </button>
      </div>

      {/* Bottom-center: Layout & Grid controls */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl flex items-center p-1.5 gap-2 z-20">
        <button
          onClick={() => onApplyLayout('lr')}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
          title="Organización: Izquierda-derecha (Rank)"
        >
          <Workflow size={18} />
        </button>
        <button
          onClick={() => onApplyLayout('snowflake')}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
          title="Organización: Snowflake (Grado)"
        >
          <Network size={18} />
        </button>
        <button
          onClick={() => onApplyLayout('compact')}
          className="p-2 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded cursor-pointer"
          title="Organización: Compacto (Masonry)"
        >
          <LayoutGrid size={18} />
        </button>

        <div className="w-px h-6 bg-zinc-800 mx-2" />

        <button
          onClick={onToggleGrid}
          className={`p-2 rounded cursor-pointer transition-colors ${showGrid ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800 text-zinc-500'}`}
          title="Activar/Desactivar Cuadrícula"
        >
          <Grid3X3 size={18} />
        </button>
        <button
          onClick={onToggleAnimateRelations}
          className={`p-2 rounded cursor-pointer transition-colors ${animateRelations ? 'bg-emerald-500/20 text-emerald-400' : 'hover:bg-zinc-800 text-zinc-500'}`}
          title="Animar Relaciones"
        >
          <Zap size={18} />
        </button>
      </div>
    </>
  );
}
