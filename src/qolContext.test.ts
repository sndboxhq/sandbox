import { describe, expect, it } from "vitest";
import type { AccountOrganisation } from "@sandbox/api-client";
import { rankAttentionItems } from "@sandbox/product-ui";
import { resolveWorkspaceContext, withWorkspaceContext } from "../apps/web/lib/workspace-context";

const organisations = [{ workspaces: [{ id: "first" }, { id: "second" }] }] as AccountOrganisation[];

describe("workspace UI context", () => {
  it("prefers an authorized URL workspace, then cookie, then the first authorized workspace", () => {
    expect(resolveWorkspaceContext("second", "first", organisations)).toBe("second");
    expect(resolveWorkspaceContext("unknown", "second", organisations)).toBe("second");
    expect(resolveWorkspaceContext(undefined, "unknown", organisations)).toBe("first");
  });

  it("preserves workspace context only on workspace-aware destinations", () => {
    expect(withWorkspaceContext("/operations", "a/b")).toBe("/operations?workspaceId=a%2Fb");
    expect(withWorkspaceContext("/billing", "first")).toBe("/billing");
  });
});

describe("attention ranking", () => {
  it("places blocking failures before approvals and warnings", () => {
    const ranked = rankAttentionItems([
      { id: "runner", severity: "warning", title: "Runner offline", description: "Resume it" },
      { id: "approval", severity: "action_required", title: "Approval waiting", description: "Review it" },
      { id: "run", severity: "blocking", title: "Run failed", description: "Inspect it" },
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["run", "approval", "runner"]);
  });
});
