import { describe, expect, it } from "vitest";
import { parseDeepLink } from "./deepLinks";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("desktop handoff links", () => {
  it("accepts only allowlisted read-only cloud destinations", () => {
    expect(parseDeepLink(`sandbox://open?view=cloud&workspaceId=${workspaceId}&section=approvals`)).toEqual({ kind: "view", view: "cloud", workspaceId, section: "approvals" });
    expect(parseDeepLink(`sandbox://open?view=cloud&workspaceId=${workspaceId}`)).toMatchObject({ kind: "view", section: "activity" });
  });

  it("rejects malformed, mutating, and stale-shape links", () => {
    expect(parseDeepLink("sandbox://open?view=cloud&workspaceId=not-a-uuid&section=activity")).toBeUndefined();
    expect(parseDeepLink(`sandbox://open?view=cloud&workspaceId=${workspaceId}&section=publish`)).toBeUndefined();
    expect(parseDeepLink(`sandbox://open?view=settings&workspaceId=${workspaceId}&section=activity`)).toBeUndefined();
    expect(parseDeepLink("https://app.sndbox.app/open")).toBeUndefined();
  });
});
