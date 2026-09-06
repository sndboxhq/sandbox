import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Trigger({ onAction }: { onAction: () => void }) {
  const toast = useToast();
  return <button onClick={() => toast.push("Workflow archived.", "success", { label: "Undo", onAction })}>Archive</button>;
}
describe("Toast actions", () => {
  it("is focusable, dismisses, and runs at most once", () => {
    const onAction = vi.fn(); render(<ToastProvider><Trigger onAction={onAction} /></ToastProvider>);
    fireEvent.click(screen.getByText("Archive")); const undo = screen.getByRole("button", { name: "Undo" }); undo.focus(); expect(undo).toHaveFocus();
    fireEvent.click(undo); fireEvent.click(undo); expect(onAction).toHaveBeenCalledTimes(1); expect(screen.queryByText("Workflow archived.")).not.toBeInTheDocument();
  });
});
