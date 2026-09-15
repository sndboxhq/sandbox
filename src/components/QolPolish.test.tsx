import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { useAppStore } from "../store";
import type { ExecutionRecord, Workflow, WorkflowSummary } from "../types";
import { HistoryView } from "./HistoryView";
import { InstalledPluginsView } from "./InstalledPluginsView";
import { PendingApprovalsView } from "./PendingApprovalsView";
import { ToastProvider } from "./ui/Toast";

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAppStore.setState({
    workflows: [],
    selectedExecution: undefined,
  });
});

describe("small workflow quality safeguards", () => {
  it("does not show an empty approvals state before loading and offers a retry", async () => {
    vi.spyOn(api, "listPendingApprovals")
      .mockRejectedValueOnce(new Error("runner unavailable"))
      .mockResolvedValueOnce([]);

    render(<PendingApprovalsView />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No pending approvals")).not.toBeInTheDocument();
    expect(await screen.findByText("Pending approvals could not load")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No pending approvals")).toBeInTheDocument();
  });

  it("does not show an empty plugin state before loading and offers a retry", async () => {
    vi.spyOn(api, "listInstalledPlugins")
      .mockRejectedValueOnce(new Error("plugin store unavailable"))
      .mockResolvedValueOnce([]);

    render(<InstalledPluginsView />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("No plugins installed")).not.toBeInTheDocument();
    expect(await screen.findByText("Installed plugins could not load")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No plugins installed")).toBeInTheDocument();
  });

  it("requires explicit confirmation before deleting all run history", async () => {
    const workflow: Workflow = {
      id: "workflow-one",
      schemaVersion: 7,
      name: "Daily report",
      description: "",
      enabled: false,
      triggerNodeId: "trigger",
      nodes: [],
      edges: [],
      settings: {
        defaultNodeTimeoutMs: 30_000,
        maxConcurrentNodes: 1,
        permissions: {
          approvedFolders: [],
          approvedNetworkDomains: [],
          commandExecutionPermitted: false,
          backgroundExecutionPermitted: false,
          approvedBrowserProfileIds: [],
          browserAutomationPermitted: false,
          externalCommunicationPermitted: false,
        },
      },
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    const summary: WorkflowSummary = {
      workflow,
      metadata: { favorite: false, tags: [] },
    };
    const run: ExecutionRecord = {
      id: "run-one",
      workflowId: workflow.id,
      workflowVersion: 1,
      trigger: { type: "manual" },
      status: "successful",
      startedAt: "2026-09-15T00:00:00.000Z",
      nodeExecutions: [],
      recoveredAfterCrash: false,
    };
    useAppStore.setState({ workflows: [summary] });
    vi.spyOn(api, "queryExecutions").mockResolvedValue({ items: [run] });
    const clear = vi.spyOn(api, "clearExecutionHistory").mockResolvedValue(1);

    render(<ToastProvider><HistoryView /></ToastProvider>);
    await screen.findByText("Daily report");
    fireEvent.click(screen.getByRole("button", { name: "Manage history" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all history" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete all run history?" });
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete all history" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(0));
  });
});
