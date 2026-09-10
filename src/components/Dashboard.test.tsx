import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { defaultPreferences, usePreferences } from "../preferences";
import { useAppStore } from "../store";
import type { ExecutionRecord, Workflow, WorkflowSummary } from "../types";
import { ToastProvider } from "./ui/Toast";
import { Dashboard } from "./Dashboard";
import { DASHBOARD_SAVED_VIEWS_KEY } from "../dashboardSavedViews";

const workflow: Workflow = {
  id: "workflow-one",
  schemaVersion: 1,
  name: "Daily report",
  description: "Downloads the daily report",
  enabled: false,
  triggerNodeId: "trigger",
  nodes: [
    {
      id: "trigger",
      type: "manual_trigger",
      version: 1,
      name: "Manual Trigger",
      position: { x: 0, y: 0 },
      configuration: {},
      disabled: false,
    },
  ],
  edges: [],
  settings: {
    defaultNodeTimeoutMs: 30000,
    maxConcurrentNodes: 1,
    permissions: {
      approvedFolders: [],
      approvedNetworkDomains: [],
      approvedBrowserProfileIds: [],
      commandExecutionPermitted: false,
      backgroundExecutionPermitted: false,
      browserAutomationPermitted: false,
      externalCommunicationPermitted: false,
    },
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
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
  startedAt: workflow.updatedAt,
  nodeExecutions: [],
  recoveredAfterCrash: false,
};

describe("Dashboard interactions", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    usePreferences.setState({ ...defaultPreferences });
    useAppStore.setState({
      view: "workflows",
      workflows: [],
      executions: [],
      activeWorkflow: undefined,
      selectedExecution: undefined,
      loading: false,
      error: undefined,
    });
    vi.spyOn(api, "listWorkflows").mockResolvedValue([summary]);
    vi.spyOn(api, "getWorkflow").mockResolvedValue(workflow);
    vi.spyOn(api, "runWorkflow").mockResolvedValue(run);
  });

  it("opens a row on one click while nested Run stays isolated", async () => {
    render(
      <ToastProvider>
        <Dashboard />
      </ToastProvider>,
    );
    await screen.findByText("Daily report");
    fireEvent.click(screen.getByLabelText("Run Daily report"));
    expect(useAppStore.getState().view).toBe("workflows");
    fireEvent.click(document.querySelector(".workflow-row")!);
    await waitFor(() => expect(useAppStore.getState().view).toBe("editor"));
  });

  it("focuses search with slash and submits creation explicitly", async () => {
    const created = { ...workflow, id: "created", name: "Named workflow" };
    vi.spyOn(api, "createWorkflow").mockResolvedValue(created);
    render(
      <ToastProvider>
        <Dashboard />
      </ToastProvider>,
    );
    const search = await screen.findByLabelText("Search workflows");
    fireEvent.keyDown(window, { key: "/" });
    expect(search).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    const name = screen.getByLabelText("Workflow name");
    fireEvent.change(name, { target: { value: "Named workflow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));
    await waitFor(() =>
      expect(api.createWorkflow).toHaveBeenCalledWith(
        undefined,
        "Named workflow",
      ),
    );
  });

  it("shows fifteen premade templates and creates the selected graph", async () => {
    vi.spyOn(api, "createWorkflow").mockResolvedValue({
      ...workflow,
      id: "status-site",
      name: "Localhost Status Site",
    });
    render(
      <ToastProvider>
        <Dashboard />
      </ToastProvider>,
    );
    await screen.findByText("Daily report");

    fireEvent.click(screen.getByRole("tab", { name: /Templates/ }));
    expect(screen.getAllByText("Use template")).toHaveLength(15);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Use Localhost Status Site template",
      }),
    );
    expect(screen.getByLabelText("Workflow name")).toHaveValue(
      "Localhost Status Site",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));

    await waitFor(() =>
      expect(api.createWorkflow).toHaveBeenCalledWith(
        "localhost-status-site",
        "Localhost Status Site",
      ),
    );
  });

  it("saves and applies a named workflow view", async () => {
    render(<ToastProvider><Dashboard /></ToastProvider>);
    await screen.findByText("Daily report");
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "daily" } });
    fireEvent.keyDown(screen.getByLabelText("Saved workflow views"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByText(/Save current view/));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Daily work" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(localStorage.getItem(DASHBOARD_SAVED_VIEWS_KEY)).toContain("Daily work"));
    fireEvent.change(screen.getByLabelText("Search workflows"), { target: { value: "other" } });
    fireEvent.keyDown(screen.getByLabelText("Saved workflow views"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByText("Daily work"));
    expect(screen.getByLabelText("Search workflows")).toHaveValue("daily");
  });

  it("deletes a saved view with a single-use Undo action", async () => {
    localStorage.setItem(DASHBOARD_SAVED_VIEWS_KEY, JSON.stringify({ version: 1, views: [{ id: "view-one", name: "Daily work", state: { search: "", workflowFilter: "all", folder: "", sortOrder: "modified" }, createdAt: 1, updatedAt: 1 }] }));
    render(<ToastProvider><Dashboard /></ToastProvider>);
    await screen.findByText("Daily report");
    fireEvent.keyDown(screen.getByLabelText("Saved workflow views"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByText(/Manage saved views/));
    fireEvent.click(screen.getByLabelText("Delete Daily work"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(localStorage.getItem(DASHBOARD_SAVED_VIEWS_KEY)).toContain("Daily work"));
  });

  it("keeps bulk selection contextual and confirms the exact archive count", async () => {
    const archive = vi.spyOn(api, "archiveWorkflows").mockResolvedValue();
    render(<ToastProvider><Dashboard /></ToastProvider>);
    await screen.findByText("Daily report");
    fireEvent.click(screen.getByLabelText("Select Daily report"));
    expect(screen.getByRole("toolbar", { name: "Selected workflow actions" })).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Archive 1 workflow?");
    fireEvent.click(screen.getByRole("button", { name: "Archive workflows" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(["workflow-one"]));
  });
});
