import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiWorkflowSession, useAiWorkflowStore } from "../aiWorkflowStore";
import { useAppStore } from "../store";
import { ActiveAiTabs } from "./ActiveAiTabs";

const originalOpenWorkflow = useAppStore.getState().openWorkflow;

describe("ActiveAiTabs", () => {
  beforeEach(() => {
    useAiWorkflowStore.setState({ sessions: {} });
    useAppStore.setState({
      view: "workflows",
      activeWorkflow: undefined,
      openWorkflow: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    useAiWorkflowStore.setState({ sessions: {} });
    useAppStore.setState({ openWorkflow: originalOpenWorkflow });
  });

  it("keeps an active build visible with its current hover status and returns to it", () => {
    const session = {
      ...createAiWorkflowSession({ id: "workflow-1", name: "Daily report" }),
      status: "building" as const,
      statusText: "Testing the complete graph",
      activities: ["Preparing request", "Testing the complete graph"],
    };
    useAiWorkflowStore.setState({ sessions: { [session.workflowId]: session } });

    render(<ActiveAiTabs />);

    const tab = screen.getByRole("button", { name: "Daily report: Testing the complete graph" });
    expect(tab).toHaveTextContent("AI active");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Testing the complete graph");
    fireEvent.click(tab);
    expect(useAiWorkflowStore.getState().sessions["workflow-1"].openRequested).toBe(true);
    expect(useAppStore.getState().openWorkflow).toHaveBeenCalledWith("workflow-1");
  });

  it("does not cover or navigate away from an open editor", () => {
    const session = {
      ...createAiWorkflowSession({ id: "workflow-1", name: "Daily report" }),
      status: "building" as const,
    };
    useAiWorkflowStore.setState({ sessions: { [session.workflowId]: session } });
    useAppStore.setState({ view: "editor", activeWorkflow: { id: "workflow-1" } as never });

    render(<ActiveAiTabs />);
    expect(screen.queryByLabelText("AI builder activity")).not.toBeInTheDocument();
  });
});
