import { beforeEach, describe, expect, it } from "vitest";
import { blocksAiDraft, isNewAiConversationCommand, useAiWorkflowStore } from "./aiWorkflowStore";

describe("AI workflow draft validation", () => {
  beforeEach(() => useAiWorkflowStore.setState({ sessions: {} }));

  it("allows user-owned setup fields while still blocking malformed graphs", () => {
    expect(blocksAiDraft({ code: "incomplete_node", message: "Add a URL", severity: "error" })).toBe(false);
    expect(blocksAiDraft({ code: "disconnected_node", message: "Not connected", severity: "warning" })).toBe(true);
    expect(blocksAiDraft({ code: "cycle", message: "Graph cycles", severity: "error" })).toBe(true);
  });

  it("keeps a workflow conversation until /clear or /new resets it", () => {
    const workflow = { id: "workflow-1", name: "Daily report" };
    useAiWorkflowStore.getState().ensureSession(workflow);
    const existing = useAiWorkflowStore.getState().sessions[workflow.id];
    useAiWorkflowStore.setState({
      sessions: {
        [workflow.id]: {
          ...existing,
          messages: [...existing.messages, { id: "answer", role: "assistant", text: "Previous answer" }],
        },
      },
    });

    useAiWorkflowStore.getState().ensureSession(workflow);
    expect(useAiWorkflowStore.getState().sessions[workflow.id].messages).toHaveLength(2);
    expect(isNewAiConversationCommand(" /CLEAR ")).toBe(true);
    expect(isNewAiConversationCommand("/new")).toBe(true);
    expect(isNewAiConversationCommand("please clear this")).toBe(false);

    useAiWorkflowStore.getState().resetSession(workflow);
    const reset = useAiWorkflowStore.getState().sessions[workflow.id];
    expect(reset.messages).toHaveLength(1);
    expect(reset.status).toBe("idle");
    expect(reset.activities).toEqual([]);
  });
});
