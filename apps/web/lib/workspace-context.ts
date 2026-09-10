import type { AccountOrganisation } from "@sandbox/api-client";

export const workspaceContextCookie = "sndbox.workspace.v1";

export function workspaceIds(organisations: AccountOrganisation[]): string[] {
  return organisations.flatMap((organisation) => organisation.workspaces.map((workspace) => workspace.id));
}

export function resolveWorkspaceContext(
  explicitWorkspaceId: string | string[] | undefined,
  savedWorkspaceId: string | undefined,
  organisations: AccountOrganisation[],
): string | undefined {
  const allowed = new Set(workspaceIds(organisations));
  const explicit = Array.isArray(explicitWorkspaceId) ? explicitWorkspaceId[0] : explicitWorkspaceId;
  if (explicit && allowed.has(explicit)) return explicit;
  if (savedWorkspaceId && allowed.has(savedWorkspaceId)) return savedWorkspaceId;
  return workspaceIds(organisations)[0];
}

export function withWorkspaceContext(href: string, workspaceId?: string): string {
  if (!workspaceId || !["/", "/organisations", "/operations", "/usage", "/support"].includes(href)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}workspaceId=${encodeURIComponent(workspaceId)}`;
}
