import type { Connection } from "@xyflow/react";
import { definitionFor, isAnnotation, isTrigger } from "./catalogue";
import type { Workflow, WorkflowEdge, WorkflowNode } from "./types";

export const WEB_BUILDER_INPUT_PORTS = [
  { id: "html", label: "HTML", language: "html" },
  { id: "javascript", label: "JS", language: "javascript" },
  { id: "css", label: "CSS", language: "css" },
] as const;

export type WebBuilderInputPort = (typeof WEB_BUILDER_INPUT_PORTS)[number]["id"];
export type ConnectedNodeRole = "input" | "output" | "both";

export function connectedNodeRoles(
  edges: WorkflowEdge[],
  selectedNodeId?: string,
): Map<string, ConnectedNodeRole> {
  const roles = new Map<string, ConnectedNodeRole>();
  if (!selectedNodeId) return roles;
  const addRole = (nodeId: string, role: "input" | "output") => {
    const current = roles.get(nodeId);
    roles.set(nodeId, current && current !== role ? "both" : role);
  };
  for (const edge of edges) {
    if (edge.targetNodeId === selectedNodeId) addRole(edge.sourceNodeId, "input");
    if (edge.sourceNodeId === selectedNodeId) addRole(edge.targetNodeId, "output");
  }
  return roles;
}

type CandidateConnection = {
  source: Connection["source"];
  target: Connection["target"];
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function isWebBuilderInput(value: string | null | undefined): value is WebBuilderInputPort {
  return WEB_BUILDER_INPUT_PORTS.some((port) => port.id === value);
}

export function isValidWorkflowConnection(
  workflow: Workflow,
  connection: CandidateConnection,
): boolean {
  if (
    !connection.source ||
    !connection.target ||
    connection.source === connection.target
  ) {
    return false;
  }

  const source = workflow.nodes.find((node) => node.id === connection.source);
  const target = workflow.nodes.find((node) => node.id === connection.target);
  if (!source || !target || isTrigger(target.type) || isAnnotation(source.type) || isAnnotation(target.type)) return false;

  const sourceHandle = connection.sourceHandle ?? "output";
  const targetHandle = connection.targetHandle ?? "input";
  const duplicate = workflow.edges.some(
    (edge) =>
      edge.sourceNodeId === source.id &&
      edge.targetNodeId === target.id &&
      edge.sourceHandle === sourceHandle &&
      edge.targetHandle === targetHandle,
  );
  if (duplicate) return false;

  if(sourceHandle==="error"&&source.errorPolicy?.strategy!=="route")return false;
  const sourcePorts=source.type==="custom_function"?[...(source.customization?.outputs??[]),...(source.customization?.branches??[])]:definitionFor(source.type).outputs;
  const targetPorts=target.type==="custom_function"?(target.customization?.inputs??[]):definitionFor(target.type).inputs;
  const sourcePort=sourcePorts.find(port=>port.key===sourceHandle);
  const targetPort=targetPorts.find(port=>port.key===targetHandle);
  if(source.type==="custom_function"&&sourceHandle!=="error"&&!sourcePort)return false;
  if(target.type==="custom_function"&&!targetPort)return false;
  if(sourcePort&&targetPort&&sourcePort.type!=="any"&&targetPort.type!=="any"&&sourcePort.type!==targetPort.type)return false;

  if(target.type === "merge"){
    const ports=((target.configuration.inputPorts as Array<{id:string}>|undefined)??[]).map(port=>port.id);
    return ports.includes(targetHandle)&&!workflow.edges.some(edge=>edge.targetNodeId===target.id&&(edge.targetPort??edge.targetHandle)===targetHandle);
  }
  if (target.type === "custom_function") return !workflow.edges.some(edge=>edge.targetNodeId===target.id&&(edge.targetPort??edge.targetHandle)===targetHandle);
  if (target.type !== "web_builder") return targetHandle === "input";
  const sourceMode = String(source.configuration.executionMode ?? "source");
  const sourceNode = source.type === "code" || source.type === "javascript_code";
  if (!isWebBuilderInput(targetHandle) || !sourceNode || sourceMode !== "source") return false;

  const input = WEB_BUILDER_INPUT_PORTS.find((port) => port.id === targetHandle)!;
  if (source.configuration.language !== input.language) return false;

  return !workflow.edges.some(
    (edge) =>
      edge.targetNodeId === target.id && edge.targetHandle === targetHandle,
  );
}

export function connectWorkflowNodes(
  workflow: Workflow,
  connection: CandidateConnection,
): Workflow | undefined {
  if (!isValidWorkflowConnection(workflow, connection)) return undefined;

  const sourceId = connection.source!;
  const targetId = connection.target!;
  const sourceHandle = connection.sourceHandle ?? "output";
  const targetHandle = connection.targetHandle ?? "input";
  const target=workflow.nodes.find(node=>node.id===targetId);
  const webBuilderInput = isWebBuilderInput(targetHandle)&&target?.type==="web_builder";
  const mergeInput=target?.type==="merge"||target?.type==="custom_function";
  const edge: WorkflowEdge = {
    id: `edge_${crypto.randomUUID().slice(0, 8)}`,
    sourceNodeId: sourceId,
    sourceHandle,
    targetNodeId: targetId,
    targetHandle,
    ...(webBuilderInput
      ? {
          kind: "control" as const,
          sourcePort: "code",
          targetPort: targetHandle,
        }
      : mergeInput ? {kind:"control" as const,sourcePort:sourceHandle,targetPort:targetHandle} : {}),
  };

  return {
    ...workflow,
    nodes: webBuilderInput
      ? workflow.nodes.map((node) =>
          node.id === targetId
            ? {
                ...node,
                inputBindings: {
                  ...node.inputBindings,
                  [targetHandle]: {
                    kind: "node_output" as const,
                    nodeId: sourceId,
                    path: ["code"],
                  },
                },
              }
            : node,
        )
      : workflow.nodes,
    edges: [...workflow.edges, edge],
  };
}

export function disconnectWorkflowEdge(workflow: Workflow, edgeId: string): Workflow {
  const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return workflow;

  const target = workflow.nodes.find((node) => node.id === edge.targetNodeId);
  const binding = target?.inputBindings?.[edge.targetHandle];
  const shouldClearBinding =
    binding?.kind === "node_output" &&
    binding.nodeId === edge.sourceNodeId;

  return {
    ...workflow,
    nodes: shouldClearBinding
      ? workflow.nodes.map((node) => {
          if (node.id !== edge.targetNodeId) return node;
          const inputBindings = { ...node.inputBindings };
          delete inputBindings[edge.targetHandle];
          return { ...node, inputBindings };
        })
      : workflow.nodes,
    edges: workflow.edges.filter((candidate) => candidate.id !== edgeId),
  };
}

export function webBuilderPortForTarget(node: WorkflowNode | undefined): WebBuilderInputPort | "input" {
  return node?.type === "web_builder" ? "html" : "input";
}
