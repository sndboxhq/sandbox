import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowNode } from "../types";
import { CollectionNodeInspector } from "./CollectionNodeInspector";

afterEach(cleanup);

const permissions = {
  approvedFolders: [],
  approvedNetworkDomains: [],
  commandExecutionPermitted: false,
  backgroundExecutionPermitted: false,
  approvedBrowserProfileIds: [],
  browserAutomationPermitted: false,
  externalCommunicationPermitted: false,
};

describe("CollectionNodeInspector", () => {
  it("confirms before removing a switch case with a connected branch", () => {
    const node: WorkflowNode = {
      id: "switch",
      type: "switch",
      version: 1,
      name: "Route item",
      position: { x: 200, y: 100 },
      configuration: {
        routingMode: "rules",
        cases: [
          { id: "case-one", name: "First", rules: [] },
          { id: "case-two", name: "Second", rules: [] },
        ],
      },
      disabled: false,
    };
    const workflow: Workflow = {
      id: "workflow",
      schemaVersion: 7,
      name: "Routing",
      description: "",
      enabled: false,
      triggerNodeId: "trigger",
      nodes: [node],
      edges: [{
        id: "edge-one",
        sourceNodeId: node.id,
        sourceHandle: "case-one",
        targetNodeId: "notify",
        targetHandle: "input",
      }],
      settings: { defaultNodeTimeoutMs: 30_000, maxConcurrentNodes: 1, permissions },
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    const onChange = vi.fn();
    render(<CollectionNodeInspector workflow={workflow} node={node} onChange={onChange} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Remove case" })[0]);

    const dialog = screen.getByRole("alertdialog", { name: "Remove connected case?" });
    expect(dialog).toHaveTextContent("This also removes 1 connected branch");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove case" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].configuration.cases).toHaveLength(1);
    expect(onChange.mock.calls[0][1]).toEqual({ edges: [] });
  });
});
