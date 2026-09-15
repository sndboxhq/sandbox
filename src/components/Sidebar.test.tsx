import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { Sidebar } from "./Sidebar";
import { ToastProvider } from "./ui/Toast";
import { TooltipProvider } from "./ui/Tooltip";

const mocks = vi.hoisted(() => ({
  listPendingApprovals: vi.fn(),
  runnerStatus: vi.fn(),
  setRunnerPaused: vi.fn(),
}));

vi.mock("../api", () => ({ api: { isDesktop: false, ...mocks } }));
vi.mock("./DesktopUpdateNotice", () => ({ DesktopUpdateNotice: () => null }));
vi.mock("./LatestNewsButton", () => ({ LatestNewsButton: () => null }));

describe("Sidebar runner status", () => {
  beforeEach(() => {
    useAppStore.setState({ view: "workflows", workflows: [], activeWorkflow: undefined });
    mocks.listPendingApprovals.mockResolvedValue([]);
    mocks.runnerStatus.mockResolvedValue({
      paused: false,
      activeWorkflowIds: [],
      localSchedulesStopOnQuit: true,
      scheduledWorkflowCount: 1,
      scheduledWorkflows: [{ workflowId: "morning", name: "Morning sync", ready: false }],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows configured schedules and why they are not runnable", async () => {
    render(<TooltipProvider><ToastProvider><Sidebar onCommand={() => undefined}/></ToastProvider></TooltipProvider>);

    expect(await screen.findByText("1 scheduled")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Runner active" }));

    expect(await screen.findByText("Scheduled workflows")).toBeVisible();
    expect(screen.getByText("Morning sync")).toBeVisible();
    expect(screen.getByText("Needs background permission")).toBeVisible();
  });

  it("refreshes when the workflow collection changes", async () => {
    render(<TooltipProvider><ToastProvider><Sidebar onCommand={() => undefined}/></ToastProvider></TooltipProvider>);
    await waitFor(() => expect(mocks.runnerStatus).toHaveBeenCalledTimes(1));

    useAppStore.setState({ workflows: [{} as never] });
    await waitFor(() => expect(mocks.runnerStatus).toHaveBeenCalledTimes(2));
  });

  it("keeps the sidebar usable when runner status cannot be loaded", async () => {
    mocks.runnerStatus.mockRejectedValue(new Error("database unavailable"));

    render(<TooltipProvider><ToastProvider><Sidebar onCommand={() => undefined}/></ToastProvider></TooltipProvider>);

    expect(await screen.findByText("Runner unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Runner status unavailable" }));
    expect(await screen.findByText(/Existing workflow data is preserved/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(mocks.runnerStatus).toHaveBeenCalledTimes(2));
  });
});
