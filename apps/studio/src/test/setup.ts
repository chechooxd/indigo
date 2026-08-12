/**
 * Vitest global setup for `apps/studio`'s jsdom environment.
 *
 * jsdom doesn't implement these browser APIs at all, and `@base-ui`'s popup
 * primitives (dropdown menus, tooltips) call them during their open/position
 * logic — without these stubs, rendering one throws instead of rendering.
 *
 * These are unconditional overwrites, not `typeof`/`in` guards: the DOM lib
 * types already declare all three as always present on `Window`/`Element`,
 * so a runtime existence check narrows to `never` under `tsc` and fails the
 * production build. This file is test-only — overwriting is safe here.
 */

import "@testing-library/jest-dom/vitest";

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

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
