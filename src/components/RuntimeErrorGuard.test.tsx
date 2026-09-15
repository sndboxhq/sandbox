import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeErrorGuard } from "./RuntimeErrorGuard";
import { ToastProvider } from "./ui/Toast";

describe("RuntimeErrorGuard", () => {
  afterEach(cleanup);

  it("turns an unhandled rejection into a recoverable notification", async () => {
    render(<ToastProvider><RuntimeErrorGuard/></ToastProvider>);
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: new Error("runner disconnected") });
    window.dispatchEvent(event);
    expect(await screen.findByRole("alert")).toHaveTextContent("runner disconnected");
  });

  it("ignores expected cancellation failures", () => {
    render(<ToastProvider><RuntimeErrorGuard/></ToastProvider>);
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: new Error("Operation cancelled") });
    window.dispatchEvent(event);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
