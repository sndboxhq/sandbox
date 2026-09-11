import type { NodeProps } from "@xyflow/react";
import { ProductWorkflowNode } from "@sandbox/product-ui";
import { Sparkles } from "lucide-react";
import { definitionFor, isTrigger } from "../catalogue";
import type { NodeStatus, ValidationIssue, WorkflowNode } from "../types";
import { WEB_BUILDER_INPUT_PORTS } from "../workflowConnections";

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  status: NodeStatus;
  warning?: string;
  warningTone?: ValidationIssue["severity"];
  askAiIssue?: string;
  showAskAiOnInteraction: boolean;
  showAskAiOnIssues: boolean;
  onAskAi: (node: WorkflowNode, issue?: string) => void;
  onAdd?: (sourceId: string) => void;
  connectionRole?: "input" | "output" | "both";
  dimmed?: boolean;
  itemCount?: number;
}

export function WorkflowNodeCard({ data, selected }: NodeProps) {
  const {
    node,
    status,
    warning,
    warningTone,
    askAiIssue,
    showAskAiOnInteraction,
    showAskAiOnIssues,
    onAskAi,
    onAdd,
    connectionRole,
    dimmed,
    itemCount,
  } = data as WorkflowNodeData;
  const definition = definitionFor(node.type);
  const annotation = node.type === "note";
  const inputPorts = node.type === "custom_function"
    ? (node.customization?.inputs.map(port=>({id:port.key,label:port.label})) ?? [])
    : node.type === "web_builder"
    ? [...WEB_BUILDER_INPUT_PORTS]
    : node.type === "merge"
      ? ((node.configuration.inputPorts as Array<{id:string;name:string}> | undefined) ?? []).map(port=>({id:port.id,label:port.name}))
      : undefined;
  const outputPorts = dynamicOutputPorts(node);

  return (
    <>
      <ProductWorkflowNode
        id={node.id}
        name={node.name}
        summary={definition.summary(node.configuration)}
        icon={definition.icon}
        status={status}
        selected={selected}
        disabled={node.disabled}
        warning={warning}
        warningTone={warningTone}
        trigger={isTrigger(node.type)}
        condition={node.type === "condition"}
        annotation={annotation}
        standalone={annotation}
        inputCount={inputPorts?.length ?? definition.inputs.length}
        inputPorts={inputPorts}
        outputLabels={outputPorts?.map(port=>port.label) ?? definition.outputs.map((port) => port.label)}
        outputPorts={outputPorts}
        onAdd={onAdd}
        connectionRole={connectionRole}
        dimmed={dimmed}
        itemCount={itemCount}
        fxBadge={node.type === "custom_function"}
      />
      <NodeAskAiAction
        node={node}
        issue={askAiIssue}
        selected={selected}
        showOnInteraction={showAskAiOnInteraction}
        showOnIssues={showAskAiOnIssues}
        onAsk={onAskAi}
      />
    </>
  );
}

function dynamicOutputPorts(node:WorkflowNode):Array<{id:string;label:string}>|undefined{
  if(node.type==="custom_function")return [...(node.customization?.outputs.map(port=>({id:port.key,label:port.label}))??[]),...(node.customization?.branches.map(port=>({id:port.key,label:port.label}))??[]),...(node.errorPolicy?.strategy==="route"?[{id:"error",label:"Error"}]:[])];
  const error=node.errorPolicy?.strategy==="route"?[{id:"error",label:"Error"}]:[];
  if(node.type==="switch")return [
    ...(((node.configuration.cases as Array<{id:string;name:string}>|undefined)??[]).map(item=>({id:item.id,label:item.name}))),
    {id:String(node.configuration.fallbackBranchId??"fallback"),label:String(node.configuration.fallbackName??"Fallback")},...error,
  ];
  if(node.type==="filter")return [{id:"output",label:"Retained"},{id:"rejected",label:"Rejected"},...error];
  if(node.type==="split_out")return [{id:"output",label:"Items"},{id:"rejected",label:"Rejected"},...error];
  if(node.type==="loop_over_items")return [{id:"loop",label:"Loop"},{id:"done",label:"Done"},...error];
  if(node.type==="remove_duplicates")return [{id:"output",label:"Unique"},{id:"duplicates",label:"Duplicates"},...error];
  if(error.length)return[{id:"output",label:"Output"},...error];
  return undefined;
}

export function NodeAskAiAction({
  node,
  issue,
  selected,
  showOnInteraction,
  showOnIssues,
  onAsk,
}: {
  node: WorkflowNode;
  issue?: string;
  selected: boolean;
  showOnInteraction: boolean;
  showOnIssues: boolean;
  onAsk: (node: WorkflowNode, issue?: string) => void;
}) {
  const issueVisible = Boolean(issue && showOnIssues);
  if (!showOnInteraction && !issueVisible) return null;

  return (
    <button
      type="button"
      className={`node-ask-ai nodrag nopan ${selected && showOnInteraction ? "node-ask-ai-selected" : ""} ${issueVisible ? "node-ask-ai-issue" : ""}`}
      aria-label={
        issueVisible ? `Ask AI about the issue on ${node.name}` : `Ask AI about ${node.name}`
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onAsk(node, issue);
      }}
    >
      <Sparkles aria-hidden="true" size={12} />
      <span>Ask AI</span>
    </button>
  );
}
