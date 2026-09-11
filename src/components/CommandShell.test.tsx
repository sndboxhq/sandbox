import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandShell } from "./CommandShell";

describe("CommandShell", () => {
  beforeEach(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the console mounted after running help", async () => {
    render(
      <CommandShell
        open
        onOpenChange={vi.fn()}
        onShortcuts={vi.fn()}
        onLauncher={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "sndbox command" }), {
      target: { value: "help" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText(/^Commands:/)).toBeVisible();
    expect(screen.getByRole("region", { name: "sndbox command console" })).toBeVisible();
  });
});
