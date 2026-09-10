import { cookies } from "next/headers";
import { authenticatedClient } from "../lib/auth";
import { resolveWorkspaceContext, workspaceContextCookie } from "../lib/workspace-context";
import { PortalCommandPalette } from "./PortalCommandPalette";
import { PortalNavigation } from "./PortalNavigation";
import { WorkspaceSelector, type WorkspaceChoice } from "./WorkspaceSelector";

export async function PortalWorkspaceChrome() {
  const api = await authenticatedClient();
  let choices: WorkspaceChoice[] = [];
  if (api) {
    try {
      const organisations = (await api.listAccountOrganisations()).data.items;
      choices = organisations.flatMap((organisation) => organisation.workspaces.map((workspace) => ({ id: workspace.id, label: `${organisation.name} / ${workspace.name}`, role: workspace.role })));
    } catch { /* individual pages surface account availability */ }
  }
  const saved = (await cookies()).get(workspaceContextCookie)?.value;
  const organisations = choices.length ? [{ id: "context", name: "", slug: "", role: "viewer" as const, createdAt: "", workspaces: choices.map((choice) => ({ id: choice.id, organisationId: "context", name: choice.label, slug: "", role: choice.role as "owner" | "administrator" | "developer" | "operator" | "viewer", createdAt: "" })) }] : [];
  const selectedId = resolveWorkspaceContext(undefined, saved, organisations);
  return <><WorkspaceSelector choices={choices} selectedId={selectedId} /><PortalNavigation workspaceId={selectedId} /><PortalCommandPalette workspaces={choices} workspaceId={selectedId} /><footer><div><span>Local execution</span><strong>Unmetered</strong></div><form action="/auth/sign-out" method="post"><button type="submit">Sign out</button></form></footer></>;
}
