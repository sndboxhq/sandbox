import { isTrigger } from "./catalogue";
import type { Workflow } from "./types";

/** Aligns the stored trigger reference when the graph has one unambiguous trigger. */
export function repairWorkflowTriggerReference(workflow: Workflow): Workflow {
  const triggers = workflow.nodes.filter((node) => isTrigger(node.type));
  if (triggers.length !== 1 || workflow.triggerNodeId === triggers[0].id) return workflow;
  return { ...workflow, triggerNodeId: triggers[0].id };
}
