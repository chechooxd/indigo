/**
 * Smoke test: does @base-ui's Menu primitive (DropdownMenuCheckboxItem's
 * base) open under jsdom at all?
 *
 * This is a HARD GATE for the later Filter Columns slice — it decides
 * whether that work builds on DropdownMenuCheckboxItem or falls back to a
 * plain checkbox panel. See apply-progress for which path was chosen.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";

describe("DropdownMenuCheckboxItem under jsdom", () => {
  it("opens and renders its checkbox item when the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false} onCheckedChange={() => {}}>
            Column A
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByText("Open"));

    expect(await screen.findByText("Column A")).toBeInTheDocument();
  });
});
