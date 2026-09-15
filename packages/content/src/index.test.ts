import { describe, expect, it } from "vitest";
import {
  legalPages,
  launchRelease,
  officialIntegrations,
  productPages,
  transactionalEmails,
  useCases,
} from "./index";

describe("v0.6 public content", () => {
  it("uses unique public routes", () => {
    const routes = [
      ...productPages.map((value) => `product/${value.slug}`),
      ...useCases.map((value) => `solutions/${value.slug}`),
      ...legalPages.map((value) => `legal/${value}`),
    ];
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("avoids prohibited vague positioning", () => {
    const copy = JSON.stringify({ productPages, useCases }).toLowerCase();
    for (const phrase of [
      "reimagine your productivity",
      "unlock limitless possibilities",
      "revolutionise your workflow",
      "future of automation is here",
      "supercharge your business with ai",
      "work smarter, not harder",
    ]) expect(copy).not.toContain(phrase);
  });

  it("includes plain-text and html transactional variants", () => {
    expect(transactionalEmails).toHaveLength(13);
    for (const template of transactionalEmails) {
      expect(template.html({})).toContain("<!doctype html>");
      expect(template.text({})).toContain("sndbox");
    }
  });

  it("publishes the supported built-in integrations as an official collection", () => {
    expect(officialIntegrations.map((integration) => integration.id)).toEqual([
      "gmail",
      "slack",
      "discord",
    ]);
    for (const integration of officialIntegrations) {
      expect(integration.summary.length).toBeGreaterThan(40);
      expect(integration.capabilities.length).toBeGreaterThanOrEqual(3);
      expect(integration.connection).toBeTruthy();
    }
  });

  it("publishes substantive sndbox 8 release notes without claiming an artifact", () => {
    expect(launchRelease.version).toBe("0.8.0-beta.1");
    expect(launchRelease.sections.length).toBeGreaterThanOrEqual(6);
    expect(launchRelease.sections.flatMap((section) => section.items).length).toBeGreaterThanOrEqual(20);
    expect(launchRelease.compatibility).toContain(
      "Local schedules stop when the desktop app is fully quit. Use a paired Linux runner for always-on execution.",
    );
    expect(launchRelease.availableArtifacts).toEqual([]);
  });
});
