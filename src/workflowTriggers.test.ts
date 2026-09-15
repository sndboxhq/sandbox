import { describe, expect, it } from "vitest";
import type { Workflow } from "./types";
import { repairWorkflowTriggerReference } from "./workflowTriggers";

const workflow = (triggerNodeId: string, nodes: Workflow["nodes"]): Workflow => ({
  id: "workflow", schemaVersion: 7, name: "Schedule", description: "", enabled: true,
  triggerNodeId, nodes, edges: [],
  settings: { defaultNodeTimeoutMs: 30_000, maxConcurrentNodes: 4, permissions: { approvedFolders: [], approvedNetworkDomains: [], approvedBrowserProfileIds: [], browserAutomationPermitted: false, externalCommunicationPermitted: false, commandExecutionPermitted: false, backgroundExecutionPermitted: false } },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
});
const node = (id: string, type: Workflow["nodes"][number]["type"]): Workflow["nodes"][number] => ({ id, type, version: 1, name: id, position: { x: 0, y: 0 }, configuration: {}, disabled: false });

describe("workflow trigger references", () => {
  it("repairs a stale reference when exactly one trigger exists", () => {
    const repaired = repairWorkflowTriggerReference(workflow("deleted-manual", [node("schedule", "schedule_trigger"), node("step", "set_data")]));
    expect(repaired.triggerNodeId).toBe("schedule");
  });

  it("does not guess when the graph has zero or multiple triggers", () => {
    const none = workflow("old", [node("step", "set_data")]);
    const many = workflow("old", [node("manual", "manual_trigger"), node("schedule", "schedule_trigger")]);
    expect(repairWorkflowTriggerReference(none)).toBe(none);
    expect(repairWorkflowTriggerReference(many)).toBe(many);
  });
});
