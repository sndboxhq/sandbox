import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ProductDialog } from "@sandbox/product-ui";

function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Remove runner</button><ProductDialog open={open} title="Remove runner?" description="This disconnects one runner." onClose={() => setOpen(false)} dangerous><button onClick={() => setOpen(false)}>Cancel</button><button>Remove</button></ProductDialog></>;
}

describe("ProductDialog", () => {
  it("closes with Escape and restores focus to the trigger", async () => {
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Remove runner" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await new Promise((resolve) => window.setTimeout(resolve, 1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
