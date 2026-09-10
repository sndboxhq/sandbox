export type DeepLinkRequest =
  | { kind: "marketplace"; pluginId: string; version?: string }
  | { kind: "template"; template: string }
  | { kind: "view"; view: "cloud"; workspaceId: string; section: "activity" | "workflows" | "approvals" };

const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDeepLink(raw?: string): DeepLinkRequest | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "sandbox:") return undefined;
    if (url.hostname === "marketplace" && url.pathname === "/install") {
      const pluginId = url.searchParams.get("plugin")?.trim();
      if (!pluginId || pluginId.length > 200) return undefined;
      return { kind: "marketplace", pluginId, version: url.searchParams.get("version")?.trim() || undefined };
    }
    if (url.hostname === "templates" && url.pathname === "/import") {
      const template = url.searchParams.get("template")?.trim();
      if (!template || !/^[a-z0-9-]{1,80}$/.test(template)) return undefined;
      return { kind: "template", template };
    }
    if (url.hostname === "open" && (url.pathname === "" || url.pathname === "/")) {
      const view = url.searchParams.get("view");
      const workspaceId = url.searchParams.get("workspaceId")?.trim();
      const section = url.searchParams.get("section") ?? "activity";
      if (view !== "cloud" || !workspaceId || !workspaceIdPattern.test(workspaceId) || !["activity", "workflows", "approvals"].includes(section)) return undefined;
      return { kind: "view", view, workspaceId, section: section as "activity" | "workflows" | "approvals" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
