import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RawJsonEditorDialog } from "./RawJsonEditorDialog";

describe("RawJsonEditorDialog", () => {
  it("does not apply invalid JSON and saves a valid configuration object", () => {
    const onSave = vi.fn();
    render(<RawJsonEditorDialog open value={{ url: "https://example.com" }} onOpenChange={vi.fn()} onSave={onSave} />);

    const editor = screen.getByRole("textbox", { name: "Node configuration JSON" });
    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Save JSON" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '{"retries": 3}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save JSON" }));
    expect(onSave).toHaveBeenCalledWith({ retries: 3 });
  });
});
