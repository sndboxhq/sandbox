import { describe, expect, it, vi } from "vitest";
import { DiscordBugReportSink, formatDiscordBugReport, type BugReportInput } from "./bug_reports.js";

const report: BugReportInput = {
  summary: "Web Builder preview stays blank",
  description: "The generated localhost page has no visible content.",
  diagnostics: { "App version": "0.7.10-beta.1" }
};

describe("DiscordBugReportSink", () => {
  it("formats a designed embed without allowing mentions", () => {
    const body = formatDiscordBugReport(report, "BUG-1234ABCD", new Date("2026-09-01T12:00:00Z"));
    expect(body).toMatchObject({
      username: "sndbox bug reports",
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "Bug: Web Builder preview stays blank",
        color: 14_090_059,
        timestamp: "2026-09-01T12:00:00.000Z"
      }]
    });
    expect(JSON.stringify(body)).toContain("0.7.10-beta.1");
    expect(JSON.stringify(body)).toContain("credentials and workflow content are never included");
  });

  it("keeps the webhook server-side and returns a delivery receipt", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const sink = new DiscordBugReportSink(
      "https://discord.com/api/webhooks/123456789/secret-token",
      request
    );
    const receipt = await sink.submit(report);
    expect(receipt).toMatchObject({ delivered: true, provider: "discord", status: 204 });
    expect(receipt.reportId).toMatch(/^BUG-[A-F0-9]{8}$/);
    expect(request).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123456789/secret-token",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("rejects webhook URLs outside Discord", () => {
    expect(() => new DiscordBugReportSink("https://example.com/api/webhooks/1/token"))
      .toThrow(/discord\.com/);
  });
});
