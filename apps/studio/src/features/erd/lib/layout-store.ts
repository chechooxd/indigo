/**
 * ERD node-position layout: fetch-on-load, 500ms-debounced autosave against
 * `PUT /api/schema/layout` (`studio-layout-persistence`).
 *
 * Split into pure, vitest-testable pieces (`seedPosition`,
 * `resolvePositions`, `createLayoutAutosave`) plus the `useLayoutStore` hook
 * that wires them into React state and `ERDCanvas`'s node-drag lifecycle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLayout, saveLayout, type LayoutPosition } from '../../../lib/api';

export type Layout = Record<string, LayoutPosition>;

/**
 * The existing formula-based seed (moved here from `useERDParser`, which
 * this module now supersedes as the single owner of "where does a table go
 * when there's no persisted position"): three columns, wrapping every three
 * tables into a new row.
 */
export function seedPosition(idx: number): LayoutPosition {
  return { x: 40 + (idx % 3) * 320, y: 80 + Math.floor(idx / 3) * 220 };
}

/**
 * Resolves every current table's position: the persisted layout entry when
 * present (keyed by table NAME), else the seed formula keyed by the table's
 * position in `tableNames`.
 *
 * A stale layout key for a table that no longer exists is naturally ignored
 * here — only `tableNames` are ever consulted, so an extra key in `layout`
 * simply never gets read (studio-layout-persistence: "A stale key for a
 * deleted table is ignored, not an error").
 */
export function resolvePositions(tableNames: string[], layout: Layout): Layout {
  const out: Layout = {};
  tableNames.forEach((name, idx) => {
    out[name] = layout[name] ?? seedPosition(idx);
  });
  return out;
}

export interface LayoutAutosave {
  /** Schedules `positions` to be saved after the debounce window, replacing
   * any not-yet-fired pending save. */
  schedule(positions: Layout): void;
  /** Cancels any pending debounce timer and, if a save was pending, sends it
   * immediately instead of dropping it — the unmount-flush guarantee. */
  flush(): void;
  /** Cancels any pending debounce timer AND drops the pending save without
   * sending it (used when a fetch failed and there is nothing to persist). */
  cancel(): void;
}

/**
 * Builds a debounced autosave controller. `save` is called with the LATEST
 * scheduled positions and the current version (read fresh via `getVersion`
 * at send time, so a version bumped by an earlier flush is honored by a
 * later one); `onSaved` receives the server's new version.
 *
 * Framework-agnostic on purpose (no React inside) so `flush`'s "no dropped
 * final write" property is directly testable with fake timers, without
 * mounting a component (design.md: "not enforceable by any tool" note 3 —
 * this is the automated guard for it).
 */
export function createLayoutAutosave(
  save: (positions: Layout, version: string | null) => Promise<{ ok: boolean; version?: string }>,
  getVersion: () => string | null,
  onSaved: (version: string) => void,
  delayMs = 500,
): LayoutAutosave {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Layout | null = null;

  function send(): void {
    if (pending === null) return;
    const positions = pending;
    pending = null;
    void save(positions, getVersion()).then((result) => {
      if (result.ok && result.version) onSaved(result.version);
    });
  }

  return {
    schedule(positions) {
      pending = positions;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        send();
      }, delayMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      send();
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

/**
 * Fetches the persisted layout on mount, exposes the resolved positions for
 * a given set of table names, and schedules a debounced autosave whenever a
 * node is dragged. The autosave FLUSHES on unmount — see `createLayoutAutosave`'s
 * `flush`, called from this hook's cleanup — so navigating away right after
 * a drag never drops the final write.
 */
export function useLayoutStore() {
  const [layout, setLayout] = useState<Layout>({});
  const [loaded, setLoaded] = useState(false);
  const versionRef = useRef<string | null>(null);
  const autosaveRef = useRef<LayoutAutosave | null>(null);

  if (autosaveRef.current === null) {
    autosaveRef.current = createLayoutAutosave(
      (positions, version) => saveLayout(positions, version),
      () => versionRef.current,
      (newVersion) => {
        versionRef.current = newVersion;
      },
    );
  }

  useEffect(() => {
    let cancelled = false;
    void fetchLayout().then((result) => {
      if (cancelled) return;
      if (result) {
        setLayout(result.positions);
        versionRef.current = result.version;
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush-on-unmount: a pending debounced save must not be silently dropped
  // when the ERD designer unmounts (route change, tab close) before the
  // 500ms window elapses.
  useEffect(() => {
    return () => {
      autosaveRef.current?.flush();
    };
  }, []);

  const updatePosition = useCallback((name: string, position: LayoutPosition) => {
    setLayout((prev) => {
      const next = { ...prev, [name]: position };
      autosaveRef.current?.schedule(next);
      return next;
    });
  }, []);

  return { layout, loaded, updatePosition };
}
