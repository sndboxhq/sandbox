import { beforeEach, describe, expect, it } from "vitest";
import { isRecord, readStoredJson, writeStoredJson } from "./safeStorage";

describe("safe storage", () => {
  beforeEach(() => localStorage.clear());

  it("removes malformed or wrongly shaped state and returns a fallback", () => {
    localStorage.setItem("broken", "{");
    expect(readStoredJson("broken", [], Array.isArray)).toEqual([]);
    expect(localStorage.getItem("broken")).toBeNull();
    localStorage.setItem("wrong", "[]");
    expect(readStoredJson("wrong", {}, isRecord)).toEqual({});
    expect(localStorage.getItem("wrong")).toBeNull();
  });

  it("round-trips valid JSON", () => {
    writeStoredJson("valid", { value: 1 });
    expect(readStoredJson("valid", {}, isRecord)).toEqual({ value: 1 });
  });
});
