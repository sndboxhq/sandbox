import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Workflow, WorkflowNode } from "../types";
import { CustomNodeEditor } from "./CustomNodeEditor";

const node: WorkflowNode = {
  id: "custom-node",
  type: "custom_function",
  version: 1,
  name: "Custom function",
  position: { x: 0, y: 0 },
  configuration: {},
  disabled: false,
  customization: {
    sourceType: "javascript_code",
    sourceVersion: 1,
    sourceName: "JavaScript",
    sourceContractHash: "contract",
    language: "javascript",
    sourceCode: "return { answer: 42 };",
    description: "A custom function",
    inputs: [],
    outputs: [],
    branches: [],
    tests: [],
    runtimeRequirement: ">=20",
  },
};

const workflow: Workflow = {
  id: "workflow",
  schemaVersion: 7,
  name: "Workflow",
  description: "",
  enabled: false,
  triggerNodeId: "custom-node",
  nodes: [node],
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("CustomNodeEditor", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("zooms only the code text with Ctrl or Command plus the mouse wheel", () => {
    vi.spyOn(api, "getCustomNodeVerification").mockResolvedValue(undefined);
    const { container } = render(
      <CustomNodeEditor
        workflow={workflow}
        node={node}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onAi={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Custom function source" });
    const codeGrid = container.querySelector<HTMLElement>(".fx-code-grid");

    expect(screen.getByRole("status", { name: "Code zoom 100%" })).toBeVisible();
    expect(codeGrid?.style.getPropertyValue("--fx-code-font-size")).toBe("12px");

    fireEvent.wheel(editor, { ctrlKey: true, deltaY: -100 });
    expect(screen.getByRole("status", { name: "Code zoom 108%" })).toBeVisible();
    expect(codeGrid?.style.getPropertyValue("--fx-code-font-size")).toBe("13px");

    fireEvent.wheel(editor, { deltaY: -100 });
    expect(screen.getByRole("status", { name: "Code zoom 108%" })).toBeVisible();

    fireEvent.wheel(editor, { metaKey: true, deltaY: 100 });
    expect(screen.getByRole("status", { name: "Code zoom 100%" })).toBeVisible();
    expect(codeGrid?.style.getPropertyValue("--fx-code-font-size")).toBe("12px");
  });

  it("allows code zoom up to 400%", () => {
    vi.spyOn(api, "getCustomNodeVerification").mockResolvedValue(undefined);
    render(
      <CustomNodeEditor
        workflow={workflow}
        node={node}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onBack={vi.fn()}
        onAi={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Custom function source" });

    for (let step = 0; step < 50; step += 1) {
      fireEvent.wheel(editor, { ctrlKey: true, deltaY: -100 });
    }

    expect(screen.getByRole("status", { name: "Code zoom 400%" })).toBeVisible();
  });
});
