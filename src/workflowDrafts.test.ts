import { afterEach, describe, expect, it } from "vitest";
import { canSaveDraft, clearWorkflowDraft, draftUsesEarlierBase, draftKey, readWorkflowDraft, writeWorkflowDraft } from "./workflowDrafts";
import type { Workflow } from "./types";

const workflow = { id: "one", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [], edges: [] } as unknown as Workflow;
afterEach(() => localStorage.clear());
describe("workflow drafts", () => {
  it("writes only eligible, bounded drafts", () => {
    expect(canSaveDraft(false, workflow)).toBe(false);
    expect(writeWorkflowDraft(workflow, workflow.updatedAt)).toBe("saved");
    expect(readWorkflowDraft("one")).toMatchObject({ workflowId: "one" });
  });
  it("cleans corrupted and expired drafts", () => {
    localStorage.setItem(draftKey("one"), "bad"); expect(readWorkflowDraft("one")).toBeUndefined(); expect(localStorage.getItem(draftKey("one"))).toBeNull();
    writeWorkflowDraft(workflow, workflow.updatedAt); expect(readWorkflowDraft("one", Date.now() + 31 * 24 * 60 * 60 * 1000)).toBeUndefined();
  });
  it("detects earlier saved bases and clears explicit discards", () => {
    writeWorkflowDraft(workflow, "old"); const draft = readWorkflowDraft("one")!;
    expect(draftUsesEarlierBase(draft, workflow)).toBe(true); clearWorkflowDraft("one"); expect(readWorkflowDraft("one")).toBeUndefined();
  });
});
