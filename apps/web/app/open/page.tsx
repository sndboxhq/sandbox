import { ArrowRight, Download, MonitorUp } from "lucide-react";
import Link from "next/link";
import { authenticatedClient } from "../../lib/auth";
import "./open.css";

const sections = new Set(["activity", "workflows", "approvals"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function OpenDesktop({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const view = typeof query.view === "string" ? query.view : undefined;
  const workspaceId = typeof query.workspaceId === "string" && uuid.test(query.workspaceId) ? query.workspaceId : undefined;
  const section = typeof query.section === "string" && sections.has(query.section) ? query.section : undefined;
  const inputValid = view === "cloud" && Boolean(workspaceId && section);
  const api = await authenticatedClient();
  let available = false;
  let notice = "Return to an account workspace and choose Open in desktop again.";
  if (inputValid && api) {
    try {
      const organisations = (await api.listAccountOrganisations()).data.items;
      const member = organisations.some((organisation) => organisation.workspaces.some((workspace) => workspace.id === workspaceId));
      if (!member) notice = "This workspace is no longer available to your account. Choose another workspace.";
      else {
        if (section === "activity") await api.getWorkspaceActivity(workspaceId!);
        if (section === "workflows") await api.listSyncedWorkflows(workspaceId!);
        if (section === "approvals") await api.listWorkflowApprovals(workspaceId!, "all");
        available = true;
      }
    } catch {
      notice = "The workspace could not be verified right now. Refresh to retry; no account data was changed.";
    }
  } else if (inputValid && !api) {
    notice = "Sign in to verify this workspace before opening it in the desktop app.";
  }
  const desktopHref = available
    ? `sandbox://open?view=cloud&workspaceId=${encodeURIComponent(workspaceId!)}&section=${section}`
    : undefined;
  return (
    <main className="portal-page open-desktop-page">
      <section className="open-desktop-card">
        <span><MonitorUp aria-hidden="true" /></span>
        <p>DESKTOP HANDOFF</p>
        <h1>{available ? `Open workspace ${section}` : "This desktop link needs attention"}</h1>
        <p>{available ? "The destination has been verified. The desktop app will check membership again before navigating, and this link cannot run, approve, publish, or change anything." : notice}</p>
        <div>
          {desktopHref && <a className="portal-primary" href={desktopHref}>Open desktop app <ArrowRight aria-hidden="true" /></a>}
          <a className="portal-secondary" href="https://sndbox.app/downloads"><Download aria-hidden="true" /> Download sndbox</a>
          <Link href={workspaceId ? `/organisations?workspaceId=${encodeURIComponent(workspaceId)}` : "/"}>Back to account</Link>
        </div>
      </section>
    </main>
  );
}
