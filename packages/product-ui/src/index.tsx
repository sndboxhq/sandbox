import { Handle, Position } from "@xyflow/react";
import { AlertTriangle, Plus, type LucideIcon } from "lucide-react";
import "./node-card.css";

export {
  ActionFeedback,
  EmptyState,
  ErrorState,
  LoadingState,
  ProductButton,
  StatusBadge,
  ToastRegion,
  type ActionFeedbackProps,
  type ProductButtonProps,
  type StatusTone,
} from "./primitives";
export { ProductDialog } from "./dialog";
export { rankAttentionItems, type AttentionItem, type AttentionSeverity } from "./attention";

export type ProductNodeStatus =
  | "idle"
  | "waiting"
  | "running"
  | "successful"
  | "failed"
  | "skipped"
  | "cancelled";

export type ProductWorkflowNodeProps = {
  id: string;
  name: string;
  summary: string;
  icon: LucideIcon;
  status?: ProductNodeStatus;
  selected?: boolean;
  disabled?: boolean;
  warning?: string;
  warningTone?: "info" | "warning" | "error";
  trigger?: boolean;
  condition?: boolean;
  inputCount: number;
  inputPorts?: Array<{ id: string; label: string }>;
  outputLabels: string[];
  outputPorts?: Array<{ id: string; label: string }>;
  onAdd?: (sourceId: string) => void;
  standalone?: boolean;
  annotation?: boolean;
  connectionRole?: "input" | "output" | "both";
  dimmed?: boolean;
  itemCount?: number;
};

export function ProductWorkflowNode({
  id,
  name,
  summary,
  icon: Icon,
  status = "idle",
  selected = false,
  disabled = false,
  warning,
  warningTone = "warning",
  trigger = false,
  condition = false,
  inputCount,
  inputPorts,
  outputLabels,
  outputPorts,
  onAdd,
  standalone = false,
  annotation = false,
  connectionRole,
  dimmed = false,
  itemCount,
}: ProductWorkflowNodeProps) {
  return (
    <div
      className={`node-card ${annotation ? "node-card-annotation" : ""} ${selected ? "selected" : ""} node-${status} ${disabled ? "disabled" : ""} ${inputPorts?.length ? "node-card-multi-input" : ""} ${connectionRole ? `connection-${connectionRole}` : ""} ${dimmed ? "connection-dimmed" : ""}`}
      data-connection-role={connectionRole}
      data-product-node="true"
    >
      {connectionRole && (
        <span className="node-connection-role" aria-label={
          connectionRole === "input"
            ? "Provides input to the selected node"
            : connectionRole === "output"
              ? "Receives output from the selected node"
              : "Both provides input to and receives output from the selected node"
        }>
          {connectionRole === "input" ? "Input" : connectionRole === "output" ? "Output" : "Input + output"}
        </span>
      )}
      {!standalone && !trigger && inputPorts?.length ? (
        <>
          {inputPorts.map((port, index) => {
            const top = `${31 + index * 19}%`;
            return (
              <Handle
                key={port.id}
                type="target"
                position={Position.Left}
                id={port.id}
                className="node-handle node-input-handle"
                style={{ top }}
                aria-label={`${port.label} input`}
              />
            );
          })}
          {inputPorts.map((port, index) => (
            <span
              key={`${port.id}-label`}
              className="node-input-label"
              style={{ top: `${31 + index * 19}%` }}
              aria-hidden="true"
            >
              {port.label}
            </span>
          ))}
        </>
      ) : !standalone && !trigger ? (
        <Handle type="target" position={Position.Left} id="input" className="node-handle" />
      ) : null}
      <div className="node-top">
        <span className="node-icon"><Icon aria-hidden="true" size={15} /></span>
        <span className={`node-state state-${status}`} />
        {warning && <AlertTriangle className={`node-warning node-warning-${warningTone}`} aria-label={`${warningTone}: ${warning}`} size={14} />}
      </div>
      <b>{name}</b>
      <small>{summary}</small>
      <div
        className="node-data-contract"
        aria-label={annotation ? "Canvas note; not executed" : `${inputCount} typed inputs and ${outputLabels.length} typed outputs`}
      >
        {annotation ? <span>Canvas note · not executed</span> : <>
          <span>{inputCount ? `${inputCount} in` : "trigger"}</span>
          <span aria-hidden="true">→</span>
          <span>{outputLabels.slice(0, 2).join(", ") || "done"}</span>
        </>}
      </div>
      {itemCount != null && <span className="node-item-count" aria-label={`${itemCount} output items`}>{itemCount} item{itemCount===1?"":"s"}</span>}
      {!standalone && outputPorts?.length ? (
        <>
          {outputPorts.map((port,index)=><Handle key={port.id} type="source" position={Position.Right} id={port.id} className="node-handle branch" style={{top:`${31+index*19}%`}} aria-label={`${port.label} output`}/>)}
          {outputPorts.map((port,index)=><span key={`${port.id}-label`} className="branch-label" style={{top:`${31+index*19}%`}} aria-hidden="true">{port.label}</span>)}
        </>
      ) : !standalone && condition ? (
        <>
          <Handle type="source" position={Position.Right} id="true" className="node-handle branch true" style={{ top: "42%" }} />
          <Handle type="source" position={Position.Right} id="false" className="node-handle branch false" style={{ top: "76%" }} />
          <span className="branch-label true-label">true</span>
          <span className="branch-label false-label">false</span>
        </>
      ) : !standalone ? (
        <Handle type="source" position={Position.Right} id="output" className="node-handle" />
      ) : null}
      {!standalone && onAdd && (
        <button
          className="node-add nodrag"
          type="button"
          aria-label={`Add after ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onAdd(id);
          }}
        >
          <Plus aria-hidden="true" size={12} />
        </button>
      )}
    </div>
  );
}
