import type {
  Workflow,
  WorkflowCollaborationChange,
  WorkflowCollaborationOperation,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

function semanticNode(node: WorkflowNode) {
  const { position: _position, ...semantic } = node;
  return semantic;
}

function sharedSettings(workflow: Workflow): Omit<Workflow["settings"], "permissions"> {
  const { permissions: _permissions, ...settings } = workflow.settings;
  return settings;
}

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Produces deterministic, entity-scoped edits. Runtime enablement and device
 * permission grants are intentionally never shared through live canvas edits.
 */
export function diffCollaborativeWorkflow(
  previous: Workflow,
  next: Workflow,
  actorId: string,
  baseSequence: number,
): WorkflowCollaborationOperation | undefined {
  if (previous.id !== next.id) throw new Error("Collaboration cannot change workflow identity.");
  const changes: WorkflowCollaborationChange[] = [];
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  for (const node of previous.nodes) if (!nextNodes.has(node.id)) changes.push({ kind: "node_remove", nodeId: node.id });
  for (const node of next.nodes) {
    const before = previousNodes.get(node.id);
    if (!before) { changes.push({ kind: "node_add", node: structuredClone(node) }); continue; }
    if (!equal(semanticNode(before), semanticNode(node))) changes.push({ kind: "node_update", node: structuredClone(node) });
    if (!equal(before.position, node.position)) changes.push({ kind: "node_move", nodeId: node.id, position: { ...node.position } });
  }

  const previousEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  const nextEdges = new Map(next.edges.map((edge) => [edge.id, edge]));
  for (const edge of previous.edges) if (!nextEdges.has(edge.id)) changes.push({ kind: "edge_remove", edgeId: edge.id });
  for (const edge of next.edges) {
    const before = previousEdges.get(edge.id);
    if (!before) changes.push({ kind: "edge_add", edge: structuredClone(edge) });
    else if (!equal(before, edge)) changes.push({ kind: "edge_update", edge: structuredClone(edge) });
  }

  const previousShared = { name: previous.name, description: previous.description, triggerNodeId: previous.triggerNodeId, settings: sharedSettings(previous) };
  const nextShared = { name: next.name, description: next.description, triggerNodeId: next.triggerNodeId, settings: sharedSettings(next) };
  if (!equal(previousShared, nextShared)) changes.push({ kind: "workflow_update", ...structuredClone(nextShared) });
  if (!changes.length) return undefined;
  return {
    operationId: crypto.randomUUID(),
    workflowId: next.id,
    actorId,
    baseSequence,
    createdAt: new Date().toISOString(),
    changes,
  };
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, structuredClone(item)];
  const next = [...items];
  next[index] = structuredClone(item);
  return next;
}

/** Applies server-sequenced operations. Later sequence wins for one entity. */
export function applyCollaborationOperation(
  workflow: Workflow,
  operation: WorkflowCollaborationOperation,
): Workflow {
  if (workflow.id !== operation.workflowId) throw new Error("Collaboration operation targets another workflow.");
  let next = structuredClone(workflow);
  for (const change of operation.changes) {
    if (change.kind === "node_add") next.nodes = upsertById(next.nodes, change.node);
    if (change.kind === "node_update" && next.nodes.some((node) => node.id === change.node.id)) {
      next.nodes = next.nodes.map((node) => node.id === change.node.id ? { ...structuredClone(change.node), position: node.position } : node);
    }
    if (change.kind === "node_move" && next.nodes.some((node) => node.id === change.nodeId)) {
      next.nodes = next.nodes.map((node) => node.id === change.nodeId ? { ...node, position: { ...change.position } } : node);
    }
    if (change.kind === "node_remove") {
      next.nodes = next.nodes.filter((node) => node.id !== change.nodeId);
      next.edges = next.edges.filter((edge) => edge.sourceNodeId !== change.nodeId && edge.targetNodeId !== change.nodeId);
    }
    if (change.kind === "edge_add" && edgeEndpointsExist(next, change.edge)) next.edges = upsertById(next.edges, change.edge);
    if (change.kind === "edge_update" && next.edges.some((edge) => edge.id === change.edge.id) && edgeEndpointsExist(next, change.edge)) next.edges = upsertById(next.edges, change.edge);
    if (change.kind === "edge_remove") next.edges = next.edges.filter((edge) => edge.id !== change.edgeId);
    if (change.kind === "workflow_update") {
      next = {
        ...next,
        name: change.name,
        description: change.description,
        triggerNodeId: change.triggerNodeId,
        settings: { ...change.settings, permissions: next.settings.permissions },
      };
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function edgeEndpointsExist(workflow: Workflow, edge: WorkflowEdge) {
  return workflow.nodes.some((node) => node.id === edge.sourceNodeId)
    && workflow.nodes.some((node) => node.id === edge.targetNodeId);
}
