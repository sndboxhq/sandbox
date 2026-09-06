import { afterEach, describe, expect, it } from "vitest";
import { clearWorkspaceAndRecovery, defaultWorkspaceSnapshot, normaliseWorkspaceSnapshot, readWorkspaceSnapshot, WORKSPACE_STORAGE_KEY, writeWorkspaceSnapshot } from "./workspaceState";

afterEach(() => localStorage.clear());
describe("workspace state", () => {
  it("round-trips a valid snapshot", () => {
    const snapshot = defaultWorkspaceSnapshot(); snapshot.view = "history"; snapshot.history.search = "failed";
    writeWorkspaceSnapshot(snapshot);
    expect(readWorkspaceSnapshot()).toMatchObject({ view: "history", history: { search: "failed" } });
  });
  it("rejects malformed and stale data", () => {
    expect(normaliseWorkspaceSnapshot({ version: 1 })).toBeUndefined();
    expect(normaliseWorkspaceSnapshot({ ...defaultWorkspaceSnapshot(), updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 })).toBeUndefined();
  });
  it("keeps the twenty most recently visited editor entries", () => {
    const snapshot = defaultWorkspaceSnapshot();
    snapshot.editors = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`workflow-${index}`, { executionDrawerOpen: false, accessibleEditorOpen: false, visitedAt: index }]));
    expect(Object.keys(normaliseWorkspaceSnapshot(snapshot)!.editors)).toHaveLength(20);
  });
  it("clears snapshots, drafts, and viewports together", () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, "{}"); localStorage.setItem("sandbox.workflow-draft.v1.one", "{}"); localStorage.setItem("sandbox.workflow-viewport.v1.one", "{}");
    clearWorkspaceAndRecovery();
    expect(localStorage.length).toBe(0);
  });
});
