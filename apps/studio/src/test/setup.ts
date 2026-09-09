/**
 * Vitest global setup for `apps/studio`'s jsdom environment.
 *
 * jsdom doesn't implement these browser APIs at all, and `@base-ui`'s popup
 * primitives (dropdown menus, tooltips) call them during their open/position
 * logic — without these stubs, rendering one throws instead of rendering.
 *
 * The DOM stubs are unconditional overwrites *within* the DOM branch, not
 * `typeof`/`in` guards on `window`/`Element` themselves: the DOM lib types
 * already declare all three as always present on `Window`/`Element`, so a
 * direct runtime existence check on them narrows to `never` under `tsc` and
 * fails the production build. This file is test-only — overwriting is safe
 * here.
 *
 * The `hasDom` guard sidesteps that: it tests a separately-typed expression
 * (`globalThis` widened to an optional `window`), so `tsc` never narrows the
 * DOM globals away, while at runtime a node-environment test file — one that
 * needs the real WASM compiler, which jsdom cannot host — no longer crashes
 * in setup before its first assertion. `ResizeObserver` is assigned on
 * `globalThis` and stays unconditional; it is harmless in either
 * environment.
 */

import "@testing-library/jest-dom/vitest";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const hasDom = typeof (globalThis as { window?: unknown }).window !== "undefined";

if (hasDom) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

  Element.prototype.scrollIntoView = () => {};
}
