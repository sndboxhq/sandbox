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

export function snapshotCollaborativeWorkflow(
  workflow: Workflow,
  actorId: string,
  baseSequence = 0,
): WorkflowCollaborationOperation {
  const { enabled: _enabled, settings, ...sharedWorkflow } = structuredClone(workflow);
  const { permissions: _permissions, ...sharedWorkflowSettings } = settings;
  return {
    operationId: crypto.randomUUID(),
    workflowId: workflow.id,
    actorId,
    baseSequence,
    createdAt: new Date().toISOString(),
    changes: [{ kind: "workflow_snapshot", workflow: { ...sharedWorkflow, settings: sharedWorkflowSettings } }],
  };
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
    if (change.kind === "workflow_snapshot") {
      if (change.workflow.id !== workflow.id) throw new Error("Collaboration snapshot targets another workflow.");
      next = {
        ...structuredClone(change.workflow),
        enabled: next.enabled,
        settings: { ...structuredClone(change.workflow.settings), permissions: next.settings.permissions },
      };
    }
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

export function parseCollaborationOperation(
  value: unknown,
  expected: { workflowId: string; operationId: string; baseSequence: number },
): WorkflowCollaborationOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Collaboration operation payload is not an object.");
  const operation = value as Partial<WorkflowCollaborationOperation>;
  if (operation.workflowId !== expected.workflowId || operation.operationId !== expected.operationId || operation.baseSequence !== expected.baseSequence) {
    throw new Error("Collaboration operation identity does not match its encrypted envelope.");
  }
  if (typeof operation.actorId !== "string" || !operation.actorId || typeof operation.createdAt !== "string" || !Number.isFinite(Date.parse(operation.createdAt))) {
    throw new Error("Collaboration operation attribution is invalid.");
  }
  if (!Array.isArray(operation.changes) || operation.changes.length < 1 || operation.changes.length > 500) {
    throw new Error("Collaboration operation must contain between 1 and 500 changes.");
  }
  for (const change of operation.changes) {
    if (!change || typeof change !== "object" || !("kind" in change)) throw new Error("Collaboration change is invalid.");
    if (change.kind === "workflow_snapshot" && (!change.workflow || change.workflow.id !== expected.workflowId || !Array.isArray(change.workflow.nodes) || !Array.isArray(change.workflow.edges))) throw new Error("Collaboration snapshot is invalid.");
    if ((change.kind === "node_add" || change.kind === "node_update") && (!change.node || typeof change.node.id !== "string" || typeof change.node.type !== "string")) throw new Error("Collaborative node change is invalid.");
    if (change.kind === "node_move" && (typeof change.nodeId !== "string" || !Number.isFinite(change.position?.x) || !Number.isFinite(change.position?.y))) throw new Error("Collaborative node movement is invalid.");
    if (change.kind === "node_remove" && typeof change.nodeId !== "string") throw new Error("Collaborative node removal is invalid.");
    if ((change.kind === "edge_add" || change.kind === "edge_update") && (!change.edge || typeof change.edge.id !== "string" || typeof change.edge.sourceNodeId !== "string" || typeof change.edge.targetNodeId !== "string")) throw new Error("Collaborative edge change is invalid.");
    if (change.kind === "edge_remove" && typeof change.edgeId !== "string") throw new Error("Collaborative edge removal is invalid.");
    if (change.kind === "workflow_update" && (typeof change.name !== "string" || typeof change.description !== "string" || typeof change.triggerNodeId !== "string")) throw new Error("Collaborative workflow update is invalid.");
    if (!["workflow_snapshot", "node_add", "node_update", "node_move", "node_remove", "edge_add", "edge_update", "edge_remove", "workflow_update"].includes(change.kind)) throw new Error("Collaboration change kind is unsupported.");
  }
  return operation as WorkflowCollaborationOperation;
}

function edgeEndpointsExist(workflow: Workflow, edge: WorkflowEdge) {
  return workflow.nodes.some((node) => node.id === edge.sourceNodeId)
    && workflow.nodes.some((node) => node.id === edge.targetNodeId);
}
