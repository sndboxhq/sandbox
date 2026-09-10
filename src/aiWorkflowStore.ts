import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "./api";
import type { AiWorkflowActivity, AiWorkflowProposal, Workflow } from "./types";

export interface AiWorkflowMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  proposal?: AiWorkflowProposal;
}

export type AiWorkflowSessionStatus = "idle" | "building" | "ready" | "failed" | "applied";

export interface AiWorkflowSession {
  workflowId: string;
  workflowName: string;
  messages: AiWorkflowMessage[];
  activities: string[];
  status: AiWorkflowSessionStatus;
  statusText: string;
  error?: string;
  openRequested: boolean;
  updatedAt: number;
}

const welcomeMessage = (): AiWorkflowMessage => ({
  id: "hello",
  role: "assistant",
  text: "Tell me what you want this workflow to do. I’ll build the graph, check it, and keep working even if you leave this screen.",
});

export const createAiWorkflowSession = (workflow: Pick<Workflow, "id" | "name">): AiWorkflowSession => ({
  workflowId: workflow.id,
  workflowName: workflow.name,
  messages: [welcomeMessage()],
  activities: [],
  status: "idle",
  statusText: "Ready for an instruction",
  openRequested: false,
  updatedAt: Date.now(),
});

const readableError = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/^Error:\s*/i, "");
};

export const blocksAiDraft = (issue: AiWorkflowProposal["issues"][number]) =>
  issue.code !== "incomplete_node" && (issue.severity === "error" || issue.code === "disconnected_node");

export const isNewAiConversationCommand = (value: string) =>
  ["/clear", "/new"].includes(value.trim().toLowerCase());

interface AiWorkflowState {
  sessions: Record<string, AiWorkflowSession>;
  ensureSession: (workflow: Pick<Workflow, "id" | "name">) => void;
  resetSession: (workflow: Pick<Workflow, "id" | "name">) => void;
  startBuild: (connectionId: string, text: string, workflow: Workflow) => Promise<void>;
  markApplied: (workflowId: string, messageId: string) => void;
  requestOpen: (workflowId: string) => void;
  consumeOpenRequest: (workflowId: string) => void;
  dismiss: (workflowId: string) => void;
}

export const useAiWorkflowStore = create<AiWorkflowState>((set, get) => {
  const update = (workflowId: string, recipe: (session: AiWorkflowSession) => AiWorkflowSession) =>
    set((state) => {
      const current = state.sessions[workflowId];
      if (!current) return state;
      return { sessions: { ...state.sessions, [workflowId]: recipe(current) } };
    });

  return {
    sessions: {},
    ensureSession: (workflow) => set((state) => state.sessions[workflow.id]
      ? state
      : { sessions: { ...state.sessions, [workflow.id]: createAiWorkflowSession(workflow) } }),
    resetSession: (workflow) => set((state) => ({
      sessions: { ...state.sessions, [workflow.id]: createAiWorkflowSession(workflow) },
    })),
    startBuild: async (connectionId, text, workflow) => {
      const request = text.trim();
      if (!request) return;
      get().ensureSession(workflow);
      if (get().sessions[workflow.id]?.status === "building") return;

      const requestId = crypto.randomUUID();
      update(workflow.id, (session) => ({
        ...session,
        workflowName: workflow.name,
        messages: [...session.messages, { id: crypto.randomUUID(), role: "user", text: request }],
        activities: ["Preparing the workflow and request context"],
        status: "building",
        statusText: "Preparing the workflow and request context",
        error: undefined,
        updatedAt: Date.now(),
      }));

      let stopListening: (() => void) | undefined;
      try {
        stopListening = await listen<AiWorkflowActivity>("ai-workflow-activity", (event) => {
          if (event.payload.requestId !== requestId) return;
          update(workflow.id, (session) => {
            const message = event.payload.message;
            const activities = session.activities.at(-1) === message
              ? session.activities
              : [...session.activities, message];
            return { ...session, activities, statusText: message, updatedAt: Date.now() };
          });
        });
        const proposal = await api.buildWorkflowWithAi(connectionId, request, workflow, requestId);
        update(workflow.id, (session) => ({
          ...session,
          activities: [...session.activities, "Checking the returned draft in the editor"],
          statusText: "Checking the returned draft in the editor",
          updatedAt: Date.now(),
        }));
        const issues = await api.validateWorkflow(proposal.workflow);
        const blocking = issues.filter(blocksAiDraft);
        if (blocking.length) throw new Error(`The draft still has a structural problem: ${blocking[0].message}`);

        const reviewCount = issues.filter((issue) => issue.code === "incomplete_node").length;
        const checkedProposal = { ...proposal, issues, tested: issues.length === 0 };
        update(workflow.id, (session) => ({
          ...session,
          messages: [...session.messages, { id: crypto.randomUUID(), role: "assistant", text: checkedProposal.message, proposal: checkedProposal }],
          activities: [...session.activities, reviewCount
            ? `Draft ready — ${reviewCount} field${reviewCount === 1 ? "" : "s"} need your input`
            : "Draft ready to review"],
          status: "ready",
          statusText: reviewCount
            ? `Draft ready · ${reviewCount} field${reviewCount === 1 ? "" : "s"} need your input`
            : "Draft ready to review",
          updatedAt: Date.now(),
        }));
      } catch (value) {
        const error = readableError(value);
        update(workflow.id, (session) => ({
          ...session,
          messages: [...session.messages, { id: crypto.randomUUID(), role: "assistant", text: `I couldn’t create that draft. ${error}` }],
          activities: [...session.activities, "Build stopped"],
          status: "failed",
          statusText: error,
          error,
          updatedAt: Date.now(),
        }));
      } finally {
        stopListening?.();
      }
    },
    markApplied: (workflowId, messageId) => update(workflowId, (session) => ({
      ...session,
      messages: session.messages.map((message) => message.id === messageId
        ? { ...message, proposal: undefined, text: `${message.text} Applied to the canvas.` }
        : message),
      status: "applied",
      statusText: "Draft applied to the canvas",
      updatedAt: Date.now(),
    })),
    requestOpen: (workflowId) => update(workflowId, (session) => ({ ...session, openRequested: true })),
    consumeOpenRequest: (workflowId) => update(workflowId, (session) => ({ ...session, openRequested: false })),
    dismiss: (workflowId) => set((state) => {
      const sessions = { ...state.sessions };
      delete sessions[workflowId];
      return { sessions };
    }),
  };
});
