import {
  Check,
  Clock3,
  ExternalLink,
  FileText,
  Fingerprint,
  Paperclip,
  ShieldQuestion,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PendingApproval, Workflow } from "../types";
import { useAppStore } from "../store";
import { FocusDialog } from "./ui/Dialog";
import { IssueNotice } from "./ui/IssueNotice";

export function ApprovalRequest({
  item,
  modal = false,
  busy = false,
  onResolve,
  onDismiss,
}: {
  item: PendingApproval;
  modal?: boolean;
  busy?: boolean;
  onResolve: (approved: boolean) => void;
  onDismiss?: () => void;
}) {
  const { openWorkflow, selectExecution, setView } = useAppStore();
  const [workflow, setWorkflow] = useState<Workflow>();
  const approveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void api.getWorkflow(item.workflowId).then((value) => setWorkflow(value)).catch(() => setWorkflow(undefined));
  }, [item.workflowId]);
  useEffect(() => {
    if (modal) approveButton.current?.focus();
  }, [modal]);
  useEffect(() => {
    if (!modal || !onDismiss) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [modal, onDismiss]);

  const node = workflow?.nodes.find(
    (candidate) => candidate.id === item.nodeId,
  );
  const attachments = Array.isArray(item.action.attachments)
    ? item.action.attachments
    : [];
  const title = stringValue(
    item.action.proposedAction,
    node?.name ?? "Workflow action",
  );
  const knownKeys = new Set([
    "proposedAction",
    "recipient",
    "subject",
    "messagePreview",
    "attachments",
    "expiresInMinutes",
  ]);
  const extra = Object.entries(item.action).filter(
    ([key, value]) => !knownKeys.has(key) && value !== "" && value != null,
  );
  const created = new Date(item.createdAt);
  const expires = new Date(item.expiresAt);
  const minutes = Math.max(
    0,
    Math.ceil((expires.getTime() - Date.now()) / 60_000),
  );
  const openExecution = async () => {
    const execution = await api.getExecution(item.executionId);
    if (execution) {
      selectExecution(execution);
      setView("history");
    }
  };
  const content = (
    <article
      className={`approval-request ${modal ? "approval-request-modal" : ""}`}
      aria-labelledby={`approval-title-${item.id}`}
    >
      <header>
        <span className="approval-request-icon">
          <ShieldQuestion size={20} />
        </span>
        <div>
          <span className="eyebrow">Your decision is required</span>
          <h2 id={`approval-title-${item.id}`}>{title}</h2>
          <p>
            {workflow?.name ?? "Loading workflow…"} is paused until you respond.
          </p>
        </div>
        <span className="expiry-chip">
          <Clock3 size={12} />
          {minutes > 0 ? `${minutes}m left` : "Expiring"}
        </span>
      </header>
      <section>
        <div className="approval-context-grid">
          <div>
            <WorkflowIcon size={14} />
            <span>
              <small>Workflow</small>
              <b>{workflow?.name ?? item.workflowId}</b>
            </span>
          </div>
          <div>
            <FileText size={14} />
            <span>
              <small>Step</small>
              <b>{node?.name ?? item.nodeId}</b>
            </span>
          </div>
          <div>
            <Clock3 size={14} />
            <span>
              <small>Requested</small>
              <b>{created.toLocaleString()}</b>
            </span>
          </div>
          <div>
            <Fingerprint size={14} />
            <span>
              <small>Run</small>
              <b title={item.executionId}>{shortId(item.executionId)}</b>
            </span>
          </div>
        </div>
        <IssueNotice
          issue={{
            code: "approval_impact",
            severity: "info",
            message: "What happens if you approve",
            suggestion: "The paused workflow continues past this step using the exact details below. Approval applies only to this request.",
            nodeId: item.nodeId,
          }}
          context={{ workflowId: item.workflowId, executionId: item.executionId, nodeId: item.nodeId }}
        />
        <dl className="approval-details">
          <Detail
            label="Recipient"
            value={item.action.recipient}
            fallback="No recipient specified"
          />
          <Detail
            label="Subject"
            value={item.action.subject}
            fallback="No subject specified"
          />
          <Detail
            label="Message preview"
            value={item.action.messagePreview}
            fallback="No message preview provided"
            multiline
          />
          {attachments.length > 0 && (
            <>
              <dt>Attachments</dt>
              <dd className="attachment-list">
                {attachments.map((attachment, index) => (
                  <span key={index}>
                    <Paperclip size={12} />
                    {describe(attachment)}
                  </span>
                ))}
              </dd>
            </>
          )}
          {extra.map(([key, value]) => (
            <Detail key={key} label={humanize(key)} value={value} />
          ))}
        </dl>
        <details className="approval-technical">
          <summary>Technical details</summary>
          <dl>
            <dt>Request ID</dt>
            <dd>{item.id}</dd>
            <dt>Workflow ID</dt>
            <dd>{item.workflowId}</dd>
            <dt>Node ID</dt>
            <dd>{item.nodeId}</dd>
            <dt>Execution ID</dt>
            <dd>{item.executionId}</dd>
            <dt>Expires</dt>
            <dd>{expires.toLocaleString()}</dd>
          </dl>
        </details>
      </section>
      <footer>
        <span>
          <ShieldQuestion size={12} />
          Reviewed locally on this device
        </span>
        <button
          className="button"
          onClick={() => void openWorkflow(item.workflowId)}
        >
          <WorkflowIcon size={13} />
          Open workflow
        </button>
        <button className="button" onClick={() => void openExecution()}>
          <ExternalLink size={13} />
          View execution
        </button>
        {onDismiss && (
          <button className="button" disabled={busy} onClick={onDismiss}>
            Review later
          </button>
        )}
        <button
          className="button danger-text"
          disabled={busy}
          onClick={() => onResolve(false)}
        >
          <X size={13} />
          Reject
        </button>
        <button
          ref={approveButton}
          className="button primary"
          disabled={busy}
          onClick={() => onResolve(true)}
        >
          <Check size={13} />
          {busy ? "Saving…" : "Approve & continue"}
        </button>
      </footer>
    </article>
  );
  return modal ? (
    <FocusDialog
      open
      onOpenChange={(open) => !open && onDismiss?.()}
      title={title}
      description={`${workflow?.name ?? "Workflow"} is paused until you respond.`}
    >
      {content}
    </FocusDialog>
  ) : (
    content
  );
}

function Detail({
  label,
  value,
  fallback = "Not specified",
  multiline = false,
}: {
  label: string;
  value: unknown;
  fallback?: string;
  multiline?: boolean;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={multiline ? "message-preview" : undefined}>
        {value == null || value === "" ? fallback : describe(value)}
      </dd>
    </>
  );
}
function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}
function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
function humanize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (match) => match.toUpperCase());
}
function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (
    value &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string"
  )
    return value.name;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
