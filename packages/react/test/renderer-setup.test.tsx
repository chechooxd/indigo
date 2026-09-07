/**
 * `@indigodb/react`'s renderer scaffold (tasks.md 5a.2).
 *
 * This is deliberately NOT a test of `useLiveTable` — that hook ships in
 * Phase 5b. Its only job is to prove, before Phase 5b depends on it, that
 * this package's Vitest + jsdom + `@testing-library/react` setup actually
 * mounts a real component into a real DOM and cleans it up — the first such
 * renderer setup outside `apps/studio` (design.md D8).
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

function Probe({ label }: { label: string }) {
  return <div data-testid="probe">{label}</div>;
}

describe("renderer scaffold", () => {
  it("mounts a component into jsdom and reads its rendered text", () => {
    render(<Probe label="hello from @indigodb/react" />);

    const node = screen.getByTestId("probe");
    expect(document.body.contains(node)).toBe(true);
    expect(node.textContent).toBe("hello from @indigodb/react");
  });

  it("unmounts cleanly, leaving no probe node behind", () => {
    const { unmount } = render(<Probe label="temporary" />);
    expect(screen.getByTestId("probe")).toBeTruthy();

    unmount();

    expect(screen.queryByTestId("probe")).toBeNull();
  });
});
