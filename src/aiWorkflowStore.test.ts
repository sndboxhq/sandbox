import { describe, expect, it } from "vitest";
import { blocksAiDraft } from "./aiWorkflowStore";

describe("AI workflow draft validation", () => {
  it("allows user-owned setup fields while still blocking malformed graphs", () => {
    expect(blocksAiDraft({ code: "incomplete_node", message: "Add a URL", severity: "error" })).toBe(false);
    expect(blocksAiDraft({ code: "disconnected_node", message: "Not connected", severity: "warning" })).toBe(true);
    expect(blocksAiDraft({ code: "cycle", message: "Graph cycles", severity: "error" })).toBe(true);
  });
});
