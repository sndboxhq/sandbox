import { beforeEach, describe, expect, it } from "vitest";
import { applyPreferences, defaultPreferences, normalisePreferences } from "./preferences";

describe("app preferences", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-accent");
    document.documentElement.removeAttribute("data-density");
    document.documentElement.removeAttribute("data-surface");
  });

  it("uses safe defaults for missing and invalid stored values", () => {
    expect(normalisePreferences(undefined)).toEqual(defaultPreferences);
    expect(normalisePreferences({ accent: "red", gridSize: 999, updateChannel: "nightly" })).toEqual(defaultPreferences);
  });

  it("preserves supported preferences while filling new fields", () => {
    expect(normalisePreferences({ accent: "blue", gridSize: 40, reduceMotion: true })).toMatchObject({
      accent: "blue",
      gridSize: 40,
      reduceMotion: true,
      startView: "workflows",
      updateChannel: "beta",
      showAskAiOnNodeInteraction: true,
      showAskAiOnNodeIssues: true,
      restoreLastWorkspace: false,
    });
  });

  it("retains only boolean workspace restore preferences", () => {
    expect(normalisePreferences({ restoreLastWorkspace: true }).restoreLastWorkspace).toBe(true);
    expect(normalisePreferences({ restoreLastWorkspace: "yes" }).restoreLastWorkspace).toBe(false);
  });

  it("preserves Ask AI node shortcut preferences", () => {
    expect(normalisePreferences({
      showAskAiOnNodeInteraction: false,
      showAskAiOnNodeIssues: false,
    })).toMatchObject({
      showAskAiOnNodeInteraction: false,
      showAskAiOnNodeIssues: false,
    });
  });

  it("migrates v1 dark-surface preferences without changing their appearance",()=>{
    expect(normalisePreferences({surfaceTheme:"oled",accent:"blue"},true)).toMatchObject({colorScheme:"dark",darkSurface:"oled",accent:"blue",editorInspectorWidth:320});
  });

  it("applies visual and node preferences to the document", () => {
    applyPreferences({ ...defaultPreferences, accent: "violet", colorScheme: "dark", darkSurface: "oled", increasedContrast: true, showNodeDescriptions: false });
    expect(document.documentElement.dataset).toMatchObject({
      accent: "violet",
      density: "comfortable",
      surface: "oled",
      contrast: "high",
      nodeDescriptions: "false"
    });
  });
});
