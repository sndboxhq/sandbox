import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { useAiWorkflowStore } from "../aiWorkflowStore";
import type { AiWorkflowProposal, Workflow } from "../types";
import { AiWorkflowChat } from "./AiWorkflowChat";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

const workflow: Workflow = {
  id: "workflow-1",
  schemaVersion: 1,
  name: "Daily report",
  description: "",
  enabled: false,
  triggerNodeId: "trigger",
  nodes: [{ id: "trigger", type: "manual_trigger", version: 1, name: "Start", position: { x: 0, y: 0 }, configuration: {}, disabled: false }],
  edges: [],
  settings: {
    defaultNodeTimeoutMs: 30_000,
    maxConcurrentNodes: 1,
    permissions: {
      approvedFolders: [], approvedNetworkDomains: [], approvedBrowserProfileIds: [],
      commandExecutionPermitted: false, backgroundExecutionPermitted: false,
      browserAutomationPermitted: false, externalCommunicationPermitted: false,
    },
  },
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
};

describe("AiWorkflowChat prompt submission", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    useAiWorkflowStore.setState({ sessions: {} });
    vi.spyOn(api, "listConnections").mockResolvedValue([{
      id: "ai-1", provider: "openai", displayName: "OpenAI", scopes: [],
      createdAt: workflow.createdAt, status: "connected", metadata: { model: "test-model" },
    }]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAiWorkflowStore.setState({ sessions: {} });
  });

  it("keeps the workflow chat open while a build starts and completes", async () => {
    vi.mocked(listen).mockImplementationOnce(() => new Promise(() => undefined));
    let finish: ((proposal: AiWorkflowProposal) => void) | undefined;
    vi.spyOn(api, "buildWorkflowWithAi").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(api, "validateWorkflow").mockResolvedValue([]);
    const onOpenChange = vi.fn();

    render(<AiWorkflowChat open workflow={workflow} onOpenChange={onOpenChange} onApply={vi.fn()} />);
    const composer = await screen.findByRole("textbox", { name: "Message AI builder" });
    fireEvent.change(composer, { target: { value: "Build a daily report" } });
    expect(fireEvent.keyDown(composer, { key: "Enter" })).toBe(false);

    expect(screen.getByRole("complementary", { name: "AI workflow builder" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(useAiWorkflowStore.getState().sessions[workflow.id].status).toBe("building");
    await waitFor(() => expect(api.buildWorkflowWithAi).toHaveBeenCalledWith("ai-1", "Build a daily report", workflow, expect.any(String)));

    finish?.({ workflow, message: "Built it.", addedNodeCount: 0, removedNodeCount: 0, issues: [], tested: true, validationAttempts: 1 });
    await waitFor(() => expect(screen.getByText("Built it.")).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
