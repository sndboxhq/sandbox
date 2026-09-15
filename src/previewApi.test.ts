import { beforeEach, describe, expect, it } from "vitest";
import { previewApi } from "./previewApi";

describe("preview API recovery", () => {
  beforeEach(() => localStorage.clear());

  it("recovers from malformed workflow storage", async () => {
    localStorage.setItem("sandbox-preview-workflows", "{");

    await expect(previewApi.listWorkflows()).resolves.toEqual([]);
    expect(localStorage.getItem("sandbox-preview-workflows")).toBeNull();
  });

  it("recovers from the wrong browser profile storage shape", async () => {
    localStorage.setItem("sandbox-preview-profiles", "{}");

    await expect(previewApi.listBrowserProfiles()).resolves.toEqual([]);
    expect(localStorage.getItem("sandbox-preview-profiles")).toBeNull();
  });

  it("reports stale browser profile edits without throwing internally", async () => {
    await expect(
      previewApi.updateBrowserProfile("missing", "Missing", true, {
        viewportWidth: 1280,
        viewportHeight: 800,
        permissions: [],
      }),
    ).rejects.toThrow("browser profile no longer exists");
  });
});
