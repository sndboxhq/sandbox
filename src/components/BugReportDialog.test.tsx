import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { BugReportDialog } from "./BugReportDialog";
import { ToastProvider } from "./ui/Toast";

describe("BugReportDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("submits only the issue and what happened", async () => {
    const submit = vi.spyOn(api, "submitBugReport").mockResolvedValue({
      delivered: true,
      provider: "discord",
      status: 204,
      reportId: "BUG-1234ABCD",
    });
    const onOpenChange = vi.fn();
    render(
      <ToastProvider>
        <BugReportDialog open onOpenChange={onOpenChange} currentView="editor" />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText("What is your issue?"), {
      target: { value: "Web Builder preview stays blank" },
    });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "The localhost page opens without any generated content." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith({
      summary: "Web Builder preview stays blank",
      description: "The localhost page opens without any generated content.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps send disabled until both fields contain enough detail", () => {
    render(
      <ToastProvider>
        <BugReportDialog open onOpenChange={vi.fn()} currentView="workflows" />
      </ToastProvider>,
    );
    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Add diagnostic data/ })).not.toBeChecked();
    expect(screen.queryByLabelText(/preview/i)).not.toBeInTheDocument();
  });

  it("adds basic diagnostics only when toggled", async () => {
    const submit = vi.spyOn(api, "submitBugReport").mockResolvedValue({
      delivered: true,
      provider: "discord",
      status: 204,
      reportId: "BUG-1234ABCD",
    });
    render(
      <ToastProvider>
        <BugReportDialog open onOpenChange={vi.fn()} currentView="editor" />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText("What is your issue?"), {
      target: { value: "Code editor diagnostics disappear" },
    });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "The errors vanish after changing the selected language." },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Add diagnostic data/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toMatchObject({
      diagnostics: { View: "editor", "App version": "v0.7.10-beta.2" },
    });
  });
});
