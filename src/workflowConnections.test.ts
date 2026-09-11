import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "./types";
import {
  connectWorkflowNodes,
  connectedNodeRoles,
  disconnectWorkflowEdge,
  isValidWorkflowConnection,
} from "./workflowConnections";

describe("connected node roles", () => {
  it("classifies direct inputs and outputs around the selected node", () => {
    const roles = connectedNodeRoles(
      [
        { id: "in", sourceNodeId: "source", sourceHandle: "output", targetNodeId: "selected", targetHandle: "input" },
        { id: "out", sourceNodeId: "selected", sourceHandle: "output", targetNodeId: "target", targetHandle: "input" },
        { id: "unrelated", sourceNodeId: "other-a", sourceHandle: "output", targetNodeId: "other-b", targetHandle: "input" },
      ],
      "selected",
    );

    expect(Object.fromEntries(roles)).toEqual({ source: "input", target: "output" });
  });

  it("marks a neighbour used in both directions without including unrelated nodes", () => {
    const roles = connectedNodeRoles(
      [
        { id: "there", sourceNodeId: "selected", sourceHandle: "output", targetNodeId: "shared", targetHandle: "input" },
        { id: "back", sourceNodeId: "shared", sourceHandle: "output", targetNodeId: "selected", targetHandle: "input" },
      ],
      "selected",
    );

    expect(roles.get("shared")).toBe("both");
    expect(connectedNodeRoles([], undefined)).toEqual(new Map());
  });
});

const workflow = (): Workflow => ({
  id: "site-workflow",
  schemaVersion: 7,
  name: "Local site",
  description: "",
  enabled: true,
  triggerNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "manual_trigger", version: 1, name: "Start", position: { x: 0, y: 0 }, configuration: {}, disabled: false },
    { id: "html", type: "code", version: 1, name: "HTML", position: { x: 200, y: 0 }, configuration: { language: "html", sourceCode: "<main />", executionMode: "source" }, disabled: false },
    { id: "js", type: "code", version: 1, name: "JavaScript", position: { x: 200, y: 160 }, configuration: { language: "javascript", sourceCode: "console.log('ready')", executionMode: "source" }, disabled: false },
    { id: "css", type: "code", version: 1, name: "CSS", position: { x: 200, y: 320 }, configuration: { language: "css", sourceCode: "main {}", executionMode: "source" }, disabled: false },
    { id: "site", type: "web_builder", version: 1, name: "Web Builder", position: { x: 500, y: 160 }, configuration: { html: "", javascript: "", css: "", port: 0, openBrowser: true }, disabled: false, inputBindings: {} },
  ],
  edges: [],
  settings: {
    defaultNodeTimeoutMs: 30000,
    maxConcurrentNodes: 3,
    permissions: { approvedFolders: [], approvedNetworkDomains: [], commandExecutionPermitted: false, backgroundExecutionPermitted: false, approvedBrowserProfileIds: [], browserAutomationPermitted: false, externalCommunicationPermitted: false },
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("Web Builder graph inputs", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "12345678-0000-0000-0000-000000000000" });
  });

  it("connects Merge by stable named target port and rejects a second producer", () => {
    const current=workflow();
    current.nodes.push({id:"merge",type:"merge",version:1,name:"Merge",position:{x:700,y:0},configuration:{inputPorts:[{id:"input_a",name:"A"},{id:"input_b",name:"B"}]},disabled:false});
    const first=connectWorkflowNodes(current,{source:"html",target:"merge",sourceHandle:"output",targetHandle:"input_a"})!;
    expect(first.edges[0]).toMatchObject({sourcePort:"output",targetPort:"input_a",targetHandle:"input_a"});
    expect(isValidWorkflowConnection(first,{source:"js",target:"merge",sourceHandle:"output",targetHandle:"input_a"})).toBe(false);
    expect(isValidWorkflowConnection(first,{source:"js",target:"merge",sourceHandle:"output",targetHandle:"unknown"})).toBe(false);
    expect(isValidWorkflowConnection(first,{source:"js",target:"merge",sourceHandle:"output",targetHandle:"input_b"})).toBe(true);
  });

  it("accepts only the matching Code language for each named input", () => {
    const current = workflow();
    expect(isValidWorkflowConnection(current, { source: "html", target: "site", sourceHandle: "output", targetHandle: "html" })).toBe(true);
    expect(isValidWorkflowConnection(current, { source: "js", target: "site", sourceHandle: "output", targetHandle: "html" })).toBe(false);
    expect(isValidWorkflowConnection(current, { source: "trigger", target: "site", sourceHandle: "output", targetHandle: "html" })).toBe(false);
  });

  it("keeps canvas notes outside the executable graph", () => {
    const current = workflow();
    current.nodes.push({
      id: "instructions",
      type: "note",
      version: 1,
      name: "Setup",
      position: { x: 20, y: 320 },
      configuration: { content: "Choose a URL before running." },
      disabled: false,
    });

    expect(isValidWorkflowConnection(current, { source: "trigger", target: "instructions" })).toBe(false);
    expect(isValidWorkflowConnection(current, { source: "instructions", target: "html" })).toBe(false);
  });

  it("creates the visual dependency edge and code output binding together", () => {
    const next = connectWorkflowNodes(workflow(), { source: "js", target: "site", sourceHandle: "output", targetHandle: "javascript" })!;
    expect(next.edges[0]).toMatchObject({
      sourceNodeId: "js",
      targetNodeId: "site",
      targetHandle: "javascript",
      sourcePort: "code",
      targetPort: "javascript",
    });
    expect(next.nodes.find((node) => node.id === "site")?.inputBindings?.javascript).toEqual({
      kind: "node_output",
      nodeId: "js",
      path: ["code"],
    });
  });

  it("assembles all three source blocks directly without a Merge node", () => {
    let next = workflow();
    for (const [source, targetHandle] of [["html", "html"], ["js", "javascript"], ["css", "css"]] as const) {
      next = connectWorkflowNodes(next, { source, target: "site", sourceHandle: "code", targetHandle })!;
    }
    expect(next.edges).toHaveLength(3);
    expect(next.nodes.some((node) => node.type === "merge")).toBe(false);
    expect(Object.keys(next.nodes.find((node) => node.id === "site")!.inputBindings!)).toEqual([
      "html", "javascript", "css",
    ]);
  });

  it("accepts dedicated JavaScript nodes only when they provide source", () => {
    const current = workflow();
    current.nodes.push({ id: "dedicated-js", type: "javascript_code", version: 1, name: "JS", position: { x: 0, y: 0 }, configuration: { language: "javascript", sourceCode: "alert(1)", executionMode: "source" }, disabled: false });
    expect(isValidWorkflowConnection(current, { source: "dedicated-js", target: "site", sourceHandle: "code", targetHandle: "javascript" })).toBe(true);
    current.nodes.at(-1)!.configuration.executionMode = "run";
    expect(isValidWorkflowConnection(current, { source: "dedicated-js", target: "site", sourceHandle: "result", targetHandle: "javascript" })).toBe(false);
  });

  it("clears the generated binding when its visual connection is removed", () => {
    const connected = connectWorkflowNodes(workflow(), { source: "css", target: "site", sourceHandle: "output", targetHandle: "css" })!;
    const disconnected = disconnectWorkflowEdge(connected, connected.edges[0].id);
    expect(disconnected.edges).toHaveLength(0);
    expect(disconnected.nodes.find((node) => node.id === "site")?.inputBindings?.css).toBeUndefined();
  });
});
