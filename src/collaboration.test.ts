import { describe, expect, it, vi } from "vitest";
import { applyCollaborationOperation, diffCollaborativeWorkflow } from "./collaboration";
import type { Workflow } from "./types";

const workflow = (): Workflow => ({
  id: "10000000-0000-4000-8000-000000000001", schemaVersion: 7, name: "Shared", description: "",
  enabled: false, triggerNodeId: "trigger", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  nodes: [{ id: "trigger", type: "manual_trigger", version: 1, name: "Manual", position: { x: 0, y: 0 }, configuration: {}, disabled: false }],
  edges: [], settings: { defaultNodeTimeoutMs: 30_000, maxConcurrentNodes: 4, permissions: { approvedFolders: ["C:/private"], approvedNetworkDomains: [], commandExecutionPermitted: true, backgroundExecutionPermitted: false, approvalRevision: "local", approvedBrowserProfileIds: [], browserAutomationPermitted: false, externalCommunicationPermitted: false } },
});

describe("collaborative workflow operations", () => {
  it("separates semantic updates from high-frequency node movement", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "20000000-0000-4000-8000-000000000002" });
    const before = workflow();
    const after = structuredClone(before);
    after.nodes[0].name = "Start here";
    after.nodes[0].position = { x: 40, y: 80 };
    const operation = diffCollaborativeWorkflow(before, after, "actor", 4)!;
    expect(operation.changes.map((change) => change.kind)).toEqual(["node_update", "node_move"]);
    expect(applyCollaborationOperation(before, operation).nodes[0]).toMatchObject({ name: "Start here", position: { x: 40, y: 80 } });
    vi.unstubAllGlobals();
  });

  it("never shares enablement or permission grants", () => {
    const before = workflow();
    const after = structuredClone(before);
    after.enabled = true;
    after.settings.permissions.approvedFolders = ["D:/shared"];
    after.settings.permissions.commandExecutionPermitted = false;
    expect(diffCollaborativeWorkflow(before, after, "actor", 0)).toBeUndefined();
  });

  it("removes incident edges atomically with a deleted node", () => {
    const before = workflow();
    before.nodes.push({ id: "data", type: "set_data", version: 1, name: "Data", position: { x: 200, y: 0 }, configuration: { values: {} }, disabled: false });
    before.edges.push({ id: "edge", sourceNodeId: "trigger", sourceHandle: "output", targetNodeId: "data", targetHandle: "input" });
    const after = structuredClone(before);
    after.nodes = after.nodes.filter((node) => node.id !== "data");
    after.edges = [];
    const operation = diffCollaborativeWorkflow(before, after, "actor", 1)!;
    const applied = applyCollaborationOperation(before, operation);
    expect(applied.nodes.map((node) => node.id)).toEqual(["trigger"]);
    expect(applied.edges).toEqual([]);
  });
});
