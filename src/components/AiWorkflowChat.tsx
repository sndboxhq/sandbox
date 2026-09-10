import { Bot, Check, Plus, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { createAiWorkflowSession, isNewAiConversationCommand, useAiWorkflowStore } from "../aiWorkflowStore";
import type { AiWorkflowProposal, ConnectionMetadata, Workflow } from "../types";
import { AiActivityStatus } from "./AiActivityStatus";
import { AiConnectionDialog } from "./AiConnectionDialog";
import { CustomSelect } from "./ui/CustomSelect";

const AI_PROVIDERS = new Set(["openai", "anthropic", "openai_compatible"]);
const proposalReviewLabel = (proposal: AiWorkflowProposal) => {
  const incomplete = proposal.issues.filter((issue) => issue.code === "incomplete_node").length;
  if (incomplete) return `${incomplete} setup field${incomplete === 1 ? "" : "s"} need your input`;
  return `${proposal.issues.length} validator note${proposal.issues.length === 1 ? "" : "s"} to review`;
};
export interface AiWorkflowChatContext {
  key: string;
  label: string;
  prompt: string;
}

export function AiWorkflowChat({
  id,
  open,
  workflow,
  context,
  onOpenChange,
  onApply,
}: {
  id?: string;
  open: boolean;
  workflow: Workflow;
  context?: AiWorkflowChatContext;
  onOpenChange: (open: boolean) => void;
  onApply: (workflow: Workflow, message: string) => void;
}) {
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [connectOpen, setConnectOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const session = useAiWorkflowStore((state) => state.sessions[workflow.id]) ?? createAiWorkflowSession(workflow);
  const ensureSession = useAiWorkflowStore((state) => state.ensureSession);
  const startBuild = useAiWorkflowStore((state) => state.startBuild);
  const resetSession = useAiWorkflowStore((state) => state.resetSession);
  const markApplied = useAiWorkflowStore((state) => state.markApplied);
  const busy = session.status === "building";
  const { activities, messages } = session;
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) ensureSession(workflow);
  }, [ensureSession, open, workflow.id, workflow.name]);

  const loadConnections = () =>
    api.listConnections().then((items) => {
      const ai = items.filter((item) => AI_PROVIDERS.has(item.provider) && item.status === "connected");
      setConnections(ai);
      setConnectionId((current) => ai.some((item) => item.id === current) ? current : (ai[0]?.id ?? ""));
    });
  useEffect(() => {
    if (open) void loadConnections();
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);
  useEffect(() => {
    if (!open || !context) return;
    setDraft(context.prompt);
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, context]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (isNewAiConversationCommand(text)) {
      setDraft("");
      resetSession(workflow);
      window.requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (!connectionId) return;
    setDraft("");
    await startBuild(connectionId, text, workflow);
  };

  if (!open) return null;
  return (
    <aside id={id} className="ai-chat-panel" aria-label="AI workflow builder">
      <header>
        <div className="ai-chat-title">
          <span><Sparkles size={15} /></span>
          <div><b>AI builder</b><small>Draft with your model</small></div>
        </div>
        <button type="button" className="icon-button" onClick={() => onOpenChange(false)} aria-label="Close AI builder">
          <X size={15} />
        </button>
      </header>
      {connections.length ? (
        <div className="ai-provider-bar">
          <label>
            <Bot size={13} />
            <CustomSelect aria-label="AI connection" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName} · {String(connection.metadata.model ?? "model")}
                </option>
              ))}
            </CustomSelect>
          </label>
          <button type="button" className="icon-button" onClick={() => setConnectOpen(true)} aria-label="Connect another AI">
            <Plus size={14} />
          </button>
        </div>
      ) : (
        <div className="ai-empty">
          <span className="ai-empty-mark"><Sparkles size={20} /></span>
          <h3>Bring your own AI</h3>
          <p>Connect a model to describe workflows in plain language and refine them in chat.</p>
          <button type="button" className="button primary" onClick={() => setConnectOpen(true)}>
            <Plus size={13} /> Connect your AI
          </button>
          <small>Keys stay in the OS credential vault.</small>
        </div>
      )}
      {connections.length > 0 && (
        <>
          <div className="ai-chat-messages" aria-live="polite">
            {messages.map((message) => (
              <div className={`ai-message ai-message-${message.role}`} key={message.id}>
                {message.role === "assistant" && <span className="ai-avatar"><Sparkles size={12} /></span>}
                <div>
                  <p>{message.text}</p>
                  {message.proposal && (
                    <div className="ai-proposal">
                      <div>
                        <b>{message.proposal.workflow.name}</b>
                        <small>
                          {message.proposal.workflow.nodes.length} nodes · {message.proposal.workflow.edges.length} connections
                        </small>
                      </div>
                      <span className={message.proposal.tested ? "ai-proposal-verified" : "ai-proposal-review"}>
                        <ShieldCheck size={12} /> {message.proposal.tested
                          ? "Tested · no validation errors"
                          : proposalReviewLabel(message.proposal)}
                        {message.proposal.validationAttempts > 1 ? ` · repaired in ${message.proposal.validationAttempts} passes` : ""}
                      </span>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => {
                          onApply(message.proposal!.workflow, message.text);
                          markApplied(workflow.id, message.id);
                        }}
                      >
                        <Check size={13} /> {message.proposal.tested ? "Apply tested workflow" : "Apply draft and finish setup"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="ai-message ai-message-assistant">
                <span className="ai-avatar"><Sparkles size={12} /></span>
                <AiActivityStatus active activities={activities} />
              </div>
            )}
            <div ref={endRef} />
          </div>
          <div className="ai-chat-composer">
            <textarea
              ref={composerRef}
              aria-label="Message AI builder"
              value={draft}
              placeholder="e.g. Every morning, check my site and alert me if it’s down"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  void send();
                }
              }}
            />
            <div>
              <small>Drafts never run automatically · /new or /clear resets chat</small>
              <button type="button" className="ai-send" disabled={!draft.trim() || busy} aria-label="Send message" onClick={() => void send()}>
                <Send size={14} />
              </button>
            </div>
          </div>
        </>
      )}
      <AiConnectionDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(connection) => {
          setConnections((current) => [...current, connection]);
          setConnectionId(connection.id);
        }}
      />
    </aside>
  );
}
