import {
  ArrowRight,
  CircleAlert,
  Cloud,
  CreditCard,
  Download,
  KeyRound,
  Plus,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { ActionFeedback, StatusBadge } from "@sandbox/product-ui";
import type { WorkspaceActivitySummary } from "@sandbox/contracts";
import { authenticatedClient } from "../lib/auth";
import { portalAttentionItems } from "../lib/attention";
import { resolveWorkspaceContext, workspaceContextCookie, withWorkspaceContext } from "../lib/workspace-context";
import { GettingStarted } from "./GettingStarted";
import { PortalActivitySummary } from "./PortalActivitySummary";
import "./overview.css";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const api = await authenticatedClient();
  if (!api) {
    return (
      <main className="portal-page">
        <section className="blocked-notice">
          <CircleAlert />
          <div><strong>Account unavailable</strong><p>Your account session could not be loaded. Sign in again to continue.</p></div>
        </section>
      </main>
    );
  }

  const [profileResult, organisationsResult, commerceResult, sessionsResult, tokensResult, walletResult] = await Promise.allSettled([
    api.getAccountProfile(),
    api.listAccountOrganisations(),
    api.getProductAccount(),
    api.listAccountSessions(),
    api.listPersonalAccessTokens(),
    api.getAccountWallet(),
  ]);
  const profile = profileResult.status === "fulfilled" ? profileResult.value.data : null;
  const organisations = organisationsResult.status === "fulfilled" ? organisationsResult.value.data.items : [];
  const commerce = commerceResult.status === "fulfilled" ? commerceResult.value.data : null;
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value.data.items : [];
  const tokens = tokensResult.status === "fulfilled" ? tokensResult.value.data.items : [];
  const wallet = walletResult.status === "fulfilled" ? walletResult.value.data : null;
  const subscription = commerce?.subscriptions[0];
  const licence = commerce?.licences[0];
  const workspaces = organisations.flatMap((organisation) => organisation.workspaces.map((workspace) => ({ organisation, workspace })));
  const workspaceCount = workspaces.length;
  const activeTokens = tokens.filter((token) => !token.revokedAt).length;
  const query = await searchParams;
  const selectedWorkspaceId = resolveWorkspaceContext(query.workspaceId, (await cookies()).get(workspaceContextCookie)?.value, organisations);
  const selectedWorkspace = workspaces.find(({ workspace }) => workspace.id === selectedWorkspaceId)?.workspace;
  const [activityResult, syncedResult] = selectedWorkspaceId ? await Promise.allSettled([api.getWorkspaceActivity(selectedWorkspaceId), api.listSyncedWorkflows(selectedWorkspaceId)]) : [];
  const activity = activityResult?.status === "fulfilled" ? activityResult.value.data as WorkspaceActivitySummary : null;
  const syncedWorkflows = syncedResult?.status === "fulfilled" ? syncedResult.value.data.items : [];
  const attention = portalAttentionItems(activity, selectedWorkspaceId);
  const unavailable = [
    profileResult.status === "rejected" ? "profile" : null,
    organisationsResult.status === "rejected" ? "workspaces" : null,
    commerceResult.status === "rejected" ? "plan" : null,
    sessionsResult.status === "rejected" ? "sessions" : null,
    tokensResult.status === "rejected" ? "API keys" : null,
    walletResult.status === "rejected" ? "balance" : null,
    activityResult?.status === "rejected" ? "workspace activity" : null,
  ].filter(Boolean) as string[];

  return (
    <main className="portal-page account-home">
      <header className="account-home-hero">
        <div>
          <h1>Overview</h1>
          <span>{profile ? `${profile.displayName} · ${profile.email}` : "Your sndbox account"}</span>
        </div>
        <div className="account-home-actions">
          <Link href="/downloads" className="portal-secondary"><Download aria-hidden="true" /> Download app</Link>
          <Link href="/organisations" className="portal-primary"><Plus aria-hidden="true" /> New workspace</Link>
        </div>
      </header>

      {unavailable.length > 0 && <ActionFeedback tone="error" className="overview-degraded">Some account data is temporarily unavailable: {unavailable.join(", ")}. Healthy sections remain usable; refresh to retry.</ActionFeedback>}

      <GettingStarted storageKey="sndbox.portal.getting-started.v1" title="Finish setting up this workspace" steps={[
        { id: "workspace", label: "Choose a workspace", description: "Workspace context keeps operations and usage scoped consistently.", complete: Boolean(selectedWorkspace), href: "/organisations" },
        { id: "workflow", label: "Sync a workflow", description: "Choose a desktop workflow to share as an encrypted revision.", complete: syncedWorkflows.length > 0, href: withWorkspaceContext("/organisations", selectedWorkspaceId) },
        { id: "runner", label: "Pair a runner", description: "Use a one-time token to add always-on execution.", complete: Boolean(activity?.runners.length), href: withWorkspaceContext("/operations", selectedWorkspaceId) },
        { id: "activity", label: "Review workspace activity", description: "Confirm runner health, approvals, and recent runs.", complete: Boolean(activity?.runs.length), href: withWorkspaceContext("/organisations", selectedWorkspaceId) },
      ]} />

      <section className="attention-panel" aria-labelledby="attention-title">
        <header><div><small>WORKSPACE HEALTH</small><h2 id="attention-title">Needs attention</h2></div>{selectedWorkspace && <span>{selectedWorkspace.name}</span>}</header>
        {attention.length ? <div>{attention.map((item) => <article key={item.id}><StatusBadge tone={item.severity === "blocking" ? "danger" : item.severity === "action_required" ? "warning" : "info"}>{item.severity.replace("_", " ")}</StatusBadge><span><strong>{item.title}</strong><small>{item.description}</small></span>{item.href && <Link href={item.href}>{item.actionLabel}<ArrowRight /></Link>}</article>)}</div> : <p>{activity ? "Everything reported by this workspace looks healthy." : selectedWorkspace ? "Workspace health could not be loaded." : "Create a workspace to see its health."}</p>}
      </section>

      {selectedWorkspaceId && <PortalActivitySummary workspaceId={selectedWorkspaceId} initialActivity={activity} />}

      <section className="overview-lead-grid">
        <article className="overview-cloud-card">
          <header>
            <div><span className="overview-card-icon"><Cloud aria-hidden="true" /></span><span><small>CLOUD BALANCE</small><strong>Hosted execution</strong></span></div>
            <Link href="/billing">Billing <ArrowRight aria-hidden="true" /></Link>
          </header>
          <strong className="overview-balance">{walletResult.status === "rejected" ? "Unavailable" : formatMicros(wallet?.balanceMicros ?? 0)}</strong>
          <p>{wallet && wallet.balanceMicros > 0 ? `${formatRunway(wallet.balanceMicros, wallet.rates.hostedRunnerMicrosPerMinute)} of hosted runner time at the current rate.` : "Add credit before starting a managed cloud run."}</p>
          <footer>
            <Link href="/billing" className="portal-primary">Add credit</Link>
            <Link href="/usage" className="portal-secondary">View usage</Link>
            <span>Local and self-hosted execution stays free.</span>
          </footer>
        </article>

        <aside className="overview-account-card">
          <div className="overview-plan">
            <small>CURRENT PLAN</small>
            <strong>{commerceResult.status === "rejected" ? "Unavailable" : subscription?.planName ?? "Local"}</strong>
          </div>
          <dl>
            <div><dt>WORKSPACES</dt><dd>{organisationsResult.status === "rejected" ? "—" : workspaceCount}</dd></div>
            <div><dt>SESSIONS</dt><dd>{sessionsResult.status === "rejected" ? "—" : sessions.length}</dd></div>
            <div><dt>API KEYS</dt><dd>{tokensResult.status === "rejected" ? "—" : activeTokens}</dd></div>
          </dl>
          <footer>
            <ShieldCheck aria-hidden="true" />
            <span><strong>{profile?.email ?? "Authenticated account"}</strong><small>{licence ? `${licence.devices} registered device${licence.devices === 1 ? "" : "s"}` : "Local licence"}</small></span>
            <Link href="/settings" aria-label="View account settings"><ArrowRight aria-hidden="true" /></Link>
          </footer>
        </aside>
      </section>

      <section className="overview-detail-grid">
        <section className="overview-workspaces">
          <header><div><h2>Where work runs</h2></div><Link href="/organisations">Manage <ArrowRight aria-hidden="true" /></Link></header>
          <div>
            {workspaces.slice(0, 3).map(({ organisation, workspace }) => <Link href={`/organisations?workspaceId=${workspace.id}`} key={workspace.id}>
              <span className="overview-row-icon"><Users aria-hidden="true" /></span>
              <span><strong>{workspace.name}</strong><small>{organisation.name} · {sentenceCase(workspace.role)}</small></span>
              <ArrowRight aria-hidden="true" />
            </Link>)}
            {!workspaces.length && <div className="overview-workspace-empty"><strong>No workspaces yet</strong><p>Create one to scope runners, environments and access.</p><Link href="/organisations" className="portal-primary">Create workspace</Link></div>}
          </div>
        </section>

        <aside className="overview-actions">
          <header><div><h2>Start here</h2></div></header>
          <nav aria-label="Overview actions">
            <Link href="/operations"><Server aria-hidden="true" /><span><strong>Runner operations</strong><small>Pair and manage Linux hosts</small></span><ArrowRight aria-hidden="true" /></Link>
            <Link href="/security"><KeyRound aria-hidden="true" /><span><strong>Security & API</strong><small>Sessions, keys and access</small></span><ArrowRight aria-hidden="true" /></Link>
            <Link href="/billing"><CreditCard aria-hidden="true" /><span><strong>Plan & billing</strong><small>Credit, rates and plan</small></span><ArrowRight aria-hidden="true" /></Link>
          </nav>
        </aside>
      </section>
    </main>
  );
}

function formatMicros(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 1_000_000); }
function formatRunway(balance: number, rate: number) { const minutes = Math.floor(balance / rate), hours = Math.floor(minutes / 60), remainder = minutes % 60; return hours ? `${hours}h ${remainder}m` : `${minutes}m`; }
function sentenceCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " "); }
