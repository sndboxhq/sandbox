import { AlertCircle, Bot, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { useAiWorkflowStore, type AiWorkflowSession } from "../aiWorkflowStore";
import { useAppStore } from "../store";

const sessionIcon = (session: AiWorkflowSession) => {
  if (session.status === "building") return <LoaderCircle className="spin" size={14} />;
  if (session.status === "failed") return <AlertCircle size={14} />;
  return <CheckCircle2 size={14} />;
};

export function ActiveAiTabs() {
  const sessionMap = useAiWorkflowStore((state) => state.sessions);
  const requestOpen = useAiWorkflowStore((state) => state.requestOpen);
  const dismiss = useAiWorkflowStore((state) => state.dismiss);
  const view = useAppStore((state) => state.view);
  const visible = Object.values(sessionMap)
    .filter((session) => ["building", "ready", "failed"].includes(session.status))
    .filter(() => view !== "editor")
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (!visible.length) return null;
  return (
    <div className="active-ai-tabs" aria-label="AI builder activity">
      {visible.map((session) => (
        <div className={`active-ai-tab-wrap is-${session.status}`} key={session.workflowId}>
          <button
            className="active-ai-tab"
            aria-label={`${session.workflowName}: ${session.statusText}`}
            onClick={() => {
              requestOpen(session.workflowId);
              void useAppStore.getState().openWorkflow(session.workflowId);
            }}
          >
            {sessionIcon(session)}
            <span>
              <b>{session.status === "building" ? "AI active" : session.status === "ready" ? "AI draft ready" : "AI needs attention"}</b>
              <small>{session.workflowName}</small>
            </span>
          </button>
          {session.status !== "building" && (
            <button className="active-ai-dismiss" aria-label={`Dismiss AI status for ${session.workflowName}`} onClick={() => dismiss(session.workflowId)}>
              <X size={11} />
            </button>
          )}
          <div className="active-ai-hover" role="tooltip">
            <span><Bot size={13} /> Current status</span>
            <b>{session.statusText}</b>
            {session.activities.length > 1 && <small>{session.activities.length} build steps recorded</small>}
            <em>Click to return to the AI builder</em>
          </div>
        </div>
      ))}
    </div>
  );
}
