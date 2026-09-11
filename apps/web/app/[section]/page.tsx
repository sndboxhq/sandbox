import type {
  AccountOrganisation,
  AccountSession,
  OrganisationRole,
  ProductAccountSummary,
  RunnerPool,
  ScimToken,
  SsoConnection,
  TokenSummary,
  UsageMeter,
  WorkflowApproval,
  WorkspaceMember,
  WorkspaceUsageSummary,
} from "@sandbox/api-client";
import { brand } from "@sandbox/brand";
import { launchRelease } from "@sandbox/content";
import { ActionFeedback } from "@sandbox/product-ui";
import {
  Activity,
  ArrowRight,
  Building2,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Cpu,
  Database,
  Download,
  KeyRound,
  LifeBuoy,
  LogOut,
  MonitorSmartphone,
  Network,
  Pause,
  Play,
  Radio,
  Server,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { authenticatedClient } from "../../lib/auth";
import { workspaceContextCookie } from "../../lib/workspace-context";
import {
  createOrganisationAction,
  createRoleAction,
  createSsoConnectionAction,
  decideApprovalAction,
  inviteMemberAction,
  publishWorkflowAction,
  revokeScimTokenAction,
  revokePersonalTokenAction,
  revokeRunnerAction,
  revokeSessionAction,
  transitionDeploymentAction,
  updateRunnerStatusAction,
} from "../actions";
import { ScimTokenForm } from "../ScimTokenForm";
import { PersonalTokenIssuer } from "../SecurityControls";
import { AccountDangerZone } from "../AccountDangerZone";
import { SubmitButton } from "../SubmitButton";
import { RunnerPairing } from "../RunnerPairing";
import { PortalActionForm } from "../PortalActionForm";
import "./workspace.css";

export const dynamic = "force-dynamic";
type Params = Promise<{ section: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const staticSections: Record<
  string,
  { title: string; description: string; items: string[] }
> = {
  downloads: {
    title: "Downloads",
    description: "Access signed releases allowed by your account.",
    items: [
      "Stable, preview and development channels",
      "Checksums and signatures",
      "Platform and architecture selection",
    ],
  },
  releases: {
    title: "Releases",
    description: "Review release notes and update policy before installing.",
    items: [
      `sndbox v${launchRelease.version.replace(/^v/, "")} · ${launchRelease.channel}`,
      launchRelease.summary,
      "Signed desktop, Linux agent and OCI-image pipeline",
    ],
  },
};

export default async function Page({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { section } = await params;
  const requestedQuery = await searchParams;
  const query = requestedQuery.workspaceId ? requestedQuery : { ...requestedQuery, workspaceId: (await cookies()).get(workspaceContextCookie)?.value };
  const api = await authenticatedClient();
  if (!api)
    return (
      <Unavailable message="Your account session is unavailable. Sign in again." />
    );
  if (section === "organisations")
    return <OrganisationsPage api={api} query={query} />;
  if (section === "operations") return <OperationsPage api={api} query={query} />;
  if (section === "security") return <SecurityPage api={api} />;
  if (section === "usage") return <UsagePage api={api} query={query} />;
  if (section === "licences" || section === "purchases")
    return <CommercePage api={api} section={section} />;
  if (section === "settings") return <SettingsPage api={api} />;
  if (section === "support") return <SupportPage api={api} query={query} />;
  const page = staticSections[section];
  if (!page) notFound();
  return (
    <main className="portal-page">
      <PageHead
        title={page.title}
        description={page.description}
      />
      {section === "downloads" ? (
        <section className="resource-launch-card">
          <span className="settings-card-icon"><Download /></span>
          <div><h2>Get the right sndbox build</h2><p>The public download centre checks the live release manifest, then shows only published artifacts with their checksum and provenance.</p></div>
          <a className="portal-primary" href="https://sndbox.app/downloads">Open downloads <ArrowRight /></a>
        </section>
      ) : <section className="section-list">
        <header>
          <h2>
            {section === "releases" ? "Current release" : "Release controls"}
          </h2>
        </header>
        {page.items.map((item) => (
          <article key={item}>
            <span>{section === "releases" ? <CheckCircle2 /> : <CircleAlert />}</span>
            <strong>{item}</strong>
          </article>
        ))}
      </section>}
      {section === "releases" && (
        <a className="cross-link" href="https://sndbox.app/changelog">
          Open public changelog <ArrowRight />
        </a>
      )}
    </main>
  );
}

interface RunnerView {
  runnerId: string;
  displayName: string;
  workspaceId: string | null;
  operatingSystem: string;
  architecture: string;
  applicationVersion: string;
  protocolVersion: number;
  status: "online" | "offline" | "busy" | "paused" | "draining" | "maintenance";
  currentWorkload: number;
  tags: string[];
  pairedAt: string;
  lastSeenAt: string | null;
}

async function OperationsPage({
  api,
  query,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
  query: Record<string, string | string[] | undefined>;
}) {
  const organisations = (await api.listAccountOrganisations()).data.items;
  const workspace = selectWorkspace(organisations, query.workspaceId);
  const results = workspace ? await Promise.allSettled([
    api.listWorkspaceRunners<{ items: RunnerView[] }>(workspace.id),
    api.listRunnerPools(workspace.id),
    api.listWorkspaceEnvironments(workspace.id),
  ]) : [];
  const runners = value<{ items: RunnerView[] }>(results[0])?.items ?? [];
  const pools = value<{ items: RunnerPool[] }>(results[1])?.items ?? [];
  const environments = value<{ items: Array<{ environmentId: string; environment: string }> }>(results[2])?.items ?? [];
  const online = runners.filter((runner) => runner.status === "online" || runner.status === "busy").length;
  const activeWork = runners.reduce((total, runner) => total + runner.currentWorkload, 0);
  const unavailable = ["runners", "runner pools", "environments"].filter((_, index) => results[index]?.status === "rejected");

  return (
    <main className="portal-page operations-page">
      <PageHead title="Runner operations" description="Pair and manage Linux runners for this workspace." />
      {unavailable.length > 0 && <ActionFeedback tone="error" className="overview-degraded">Some runner data is unavailable: {unavailable.join(", ")}. Existing controls remain usable; refresh to retry.</ActionFeedback>}
      {workspace ? (
        <>
          <section className="operations-setup">
            <div><h2>Add a Linux runner</h2><p>Create a one-time, workspace-scoped pairing token and finish setup on the Linux host.</p></div>
            <RunnerPairing organisations={organisations} selectedWorkspaceId={workspace.id} />
          </section>
          <section className="operations-grid operations-metrics">
            <Metric icon={<Radio />} label="Available" value={online} />
            <Metric icon={<Activity />} label="Active work" value={activeWork} />
            <Metric icon={<Server />} label="Runner pools" value={pools.length} />
            <Metric icon={<Cloud />} label="Environments" value={environments.length} />
          </section>
          <section className="fleet-section-head"><div><h2>Paired runners</h2></div><span>{runners.length} runner{runners.length === 1 ? "" : "s"}</span></section>
          <section className="runner-fleet">
            {runners.map((runner) => {
              const nextStatus = runner.status === "online" || runner.status === "busy" ? "draining" : ["paused", "draining", "maintenance"].includes(runner.status) ? "offline" : null;
              return (
                <article key={runner.runnerId}>
                  <span className="runner-device-icon"><Cpu /></span>
                  <div className="runner-identity"><strong>{runner.displayName}</strong><small>{runner.operatingSystem} · {runner.architecture} · v{runner.applicationVersion}</small><span>{runner.tags.map((tag) => <i key={tag}>{tag}</i>)}</span></div>
                  <div className="runner-heartbeat"><small>LAST HEARTBEAT</small><strong>{runner.lastSeenAt ? new Date(runner.lastSeenAt).toLocaleString("en-GB") : "Waiting for first connection"}</strong></div>
                  <div className="runner-workload"><small>WORKLOAD</small><strong>{runner.currentWorkload}</strong></div>
                  <span className={`runner-status ${runner.status}`}><i />{runner.status}</span>
                  <div className="runner-actions">
                    {nextStatus && <PortalActionForm action={updateRunnerStatusAction} hidden={{ workspaceId: workspace.id, runnerId: runner.runnerId, status: nextStatus }} submitLabel={nextStatus === "draining" ? "Drain" : "Resume"} pendingLabel="Updating…" />}
                    <PortalActionForm action={revokeRunnerAction} hidden={{ workspaceId: workspace.id, runnerId: runner.runnerId }} submitLabel="Revoke" pendingLabel="Revoking…" dangerous confirmTitle={`Revoke ${runner.displayName}?`} confirmDescription="This runner will immediately lose access to the workspace. Pair it again to restore access." />
                  </div>
                </article>
              );
            })}
            {!runners.length && <div className="fleet-empty"><Server /><h3>No runners paired yet</h3><p>Create a pairing token above, then run the supplied command on a Linux x64 or ARM64 host.</p></div>}
          </section>
          <section className="operations-guidance"><ShieldCheck /><div><strong>Device verification</strong><p>Runner keys are generated locally. Verify the printed fingerprint before starting the service.</p></div><a href="https://docs.sndbox.app/linux">Linux guide <ArrowRight /></a></section>
        </>
      ) : (
        <section className="resource-launch-card"><span className="settings-card-icon"><Building2 /></span><div><h2>Create a workspace first</h2><p>Every runner belongs to a workspace so permissions, environments and audit history stay scoped.</p></div><Link className="portal-primary" href="/organisations">Create workspace <ArrowRight /></Link></section>
      )}
    </main>
  );
}

async function OrganisationsPage({
  api,
  query,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
  query: Record<string, string | string[] | undefined>;
}) {
  const organisations = (await api.listAccountOrganisations()).data.items;
  const selected = selectWorkspace(organisations, query.workspaceId);
  const workspaceId = selected?.id;
  const organisation = organisations.find((item) =>
    item.workspaces.some((workspace) => workspace.id === workspaceId),
  );
  const results = workspaceId
    ? await Promise.allSettled([
        api.listWorkspaceMembers(workspaceId),
        api.listWorkspaceRunners(workspaceId),
        api.listWorkflowApprovals(workspaceId, "all"),
        api.listDeployments(workspaceId),
        api.listRunnerPools(workspaceId),
        api.listWorkspaceEnvironments(workspaceId),
        api.getWorkspaceGovernance(workspaceId),
      ])
    : [];
  const members = value<{ items: WorkspaceMember[] }>(results[0])?.items ?? [];
  const runners =
    value<{ items: Array<Record<string, unknown>> }>(results[1])?.items ?? [];
  const approvals =
    value<{ items: WorkflowApproval[] }>(results[2])?.items ?? [];
  const deployments =
    value<{ items: Array<Record<string, unknown>> }>(results[3])?.items ?? [];
  const pools =
    value<{ items: Array<Record<string, unknown>> }>(results[4])?.items ?? [];
  const environments =
    value<{ items: Array<{ environmentId: string; environment: string }> }>(
      results[5],
    )?.items ?? [];
  const governance =
    value<{ policies: Record<string, unknown> }>(results[6])?.policies ?? {};
  const enterprise = organisation
    ? await Promise.allSettled([
        api.listOrganisationRoles(organisation.id),
        api.listSsoConnections(organisation.id),
        api.listScimTokens(organisation.id),
      ])
    : [];
  const roles =
    value<{ items: OrganisationRole[] }>(enterprise[0])?.items ?? [];
  const sso = value<{ items: SsoConnection[] }>(enterprise[1])?.items ?? [];
  const scim = value<{ items: ScimToken[] }>(enterprise[2])?.items ?? [];
  const unavailable = [
    ...["members", "runners", "approvals", "deployments", "runner pools", "environments", "governance"].filter((_, index) => results[index]?.status === "rejected"),
    ...["roles", "single sign-on", "SCIM credentials"].filter((_, index) => enterprise[index]?.status === "rejected"),
  ];
  return (
    <main className="portal-page workspace-page">
      <PageHead
        title="Workspaces"
        description="Manage access, reviews and runtime state for each place your team works."
      />
      {unavailable.length > 0 && <ActionFeedback tone="error" className="overview-degraded">Some workspace data is unavailable: {unavailable.join(", ")}. Healthy panels remain usable; refresh to retry.</ActionFeedback>}
      {!workspaceId ? (
        <section className="live-panel">
          <header>
            <div>
              <Building2 />
              <span>
                <strong>Create your first organisation</strong>
                <small>
                  A default workspace and three environments are provisioned
                  together.
                </small>
              </span>
            </div>
          </header>
          <PortalActionForm action={createOrganisationAction} className="portal-form" submitLabel="Create organisation" pendingLabel="Creating…">
            <label>
              Name
              <input name="name" required minLength={2} maxLength={100} />
            </label>
            <label>
              Slug
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={63}
              />
            </label>
          </PortalActionForm>
        </section>
      ) : (
        <>
          <section className="workspace-hero-card">
            <header>
              <div className="workspace-identity">
                <span className="settings-card-icon"><Building2 /></span>
                <div><small>{organisation?.name ?? "Organisation"}</small><h2>{selected.name}</h2><p>{selected.role} access</p></div>
              </div>
              <nav aria-label="Workspace shortcuts">
                <Link href={`/operations?workspaceId=${workspaceId}`}>Operations <ArrowRight /></Link>
                <Link href={`/usage?workspaceId=${workspaceId}`}>Usage <ArrowRight /></Link>
              </nav>
            </header>
            <section className="workspace-metrics" aria-label="Workspace summary">
              <Metric icon={<Users />} label="Members" value={members.length} />
              <Metric icon={<Server />} label="Runners" value={runners.length} />
              <Metric icon={<ShieldCheck />} label="Pending reviews" value={approvals.filter((item) => item.status === "pending").length} />
              <Metric icon={<Cloud />} label="Deployments" value={deployments.length} />
            </section>
          </section>
          <section className="workspace-primary-grid">
          <section className="live-panel">
            <header>
              <div>
                <Users />
                <span>
                  <strong>Members</strong>
                  <small>
                    Workspace roles are enforced at every API operation.
                  </small>
                </span>
              </div>
            </header>
            <div className="live-list">
              {members.map((member) => (
                <article key={member.accountId}>
                  <div>
                    <strong>{member.displayName}</strong>
                    <small>{member.email}</small>
                  </div>
                  <span className="status-pill">{member.role}</span>
                </article>
              ))}
              {!members.length && <EmptyRow text="No members were returned." />}
            </div>
            <PortalActionForm action={inviteMemberAction} hidden={{ workspaceId }} className="portal-form compact invite-member-form" submitLabel="Invite member" pendingLabel="Creating invite…" submitClassName="invite-member-submit" submitIcon={<UserPlus aria-hidden="true" />} resetOnSuccess>
              <label>
                Email
                <input type="email" name="email" required />
              </label>
              <label>
                Role
                <select name="role" defaultValue="developer">
                  <option>developer</option>
                  <option>operator</option>
                  <option>viewer</option>
                  <option>administrator</option>
                </select>
              </label>
            </PortalActionForm>
          </section>
          <section className="live-panel">
            <header>
              <div>
                <ShieldCheck />
                <span>
                  <strong>Publication reviews</strong>
                  <small>
                    Approve an exact immutable revision before publishing it.
                  </small>
                </span>
              </div>
            </header>
            <div className="live-list">
              {approvals.map((approval) => (
                <article key={approval.approvalId} className="approval-row">
                  <div>
                    <strong>{approval.workflowId}</strong>
                    <small>
                      {approval.status} · {approval.approvalCount}/
                      {approval.requiredApprovals} approvals
                    </small>
                  </div>
                  {approval.status === "pending" && (
                    <>
                    <PortalActionForm action={decideApprovalAction} hidden={{ workspaceId, approvalId: approval.approvalId, decision: "approved" }} submitLabel="Approve" pendingLabel="Saving…">
                      <input name="reason" placeholder="Review note" />
                    </PortalActionForm>
                    <PortalActionForm action={decideApprovalAction} hidden={{ workspaceId, approvalId: approval.approvalId, decision: "rejected" }} submitLabel="Reject" pendingLabel="Saving…" dangerous confirmTitle="Reject this revision?" confirmDescription="Add a review note explaining what must change before it can be resubmitted.">
                      <input name="reason" placeholder="Required rejection reason" required />
                    </PortalActionForm>
                    </>
                  )}
                  {approval.status === "approved" && (
                    <PortalActionForm action={publishWorkflowAction} hidden={{ workspaceId, workflowId: approval.workflowId, revisionId: approval.revisionId }} submitLabel="Publish" pendingLabel="Publishing…" confirmTitle="Publish this revision?" confirmDescription="This makes the approved revision current for the workspace.">
                      <input
                        name="changeSummary"
                        placeholder="Change summary"
                        required
                      />
                    </PortalActionForm>
                  )}
                  <span className={`status-pill ${approval.status}`}>
                    {approval.status}
                  </span>
                </article>
              ))}
              {!approvals.length && (
                <EmptyRow text="No publication reviews yet." />
              )}
            </div>
          </section>
          </section>
          <section className="two-panel-grid workspace-resource-grid">
            <DataPanel
              icon={<Server />}
              title="Runner pools"
              rows={pools.map((pool) => [
                String(pool.name),
                `${String(pool.status)} · ${String(pool.memberCount)} members`,
              ])}
              empty="No runner pools configured."
            />
            <DeploymentPanel
              workspaceId={workspaceId}
              deployments={deployments}
            />
            <DataPanel
              icon={<Activity />}
              title="Environments"
              rows={environments.map((environment) => [
                environment.environment,
                environment.environmentId,
              ])}
              empty="No environments returned."
            />
            <DataPanel
              icon={<ShieldCheck />}
              title="Governance"
              rows={Object.entries(governance).map(([key, item]) => [
                key,
                JSON.stringify(item),
              ])}
              empty="Workspace defaults are active."
            />
          </section>
          {organisation && (
            <details className="workspace-enterprise">
              <summary>
                <div><h2>Roles, SSO and SCIM</h2><p>Owner-only controls protected by a fresh passkey or multi-factor session.</p></div>
                <span aria-hidden="true"><ArrowRight /></span>
              </summary>
              <div className="workspace-enterprise-body"><div className="enterprise-control-stack">
                <section className="live-panel enterprise-control enterprise-roles">
                  <header>
                    <div>
                      <Users />
                      <span>
                        <strong>Organisation roles</strong>
                        <small>{roles.length} configured · reusable permission sets</small>
                      </span>
                    </div>
                  </header>
                  <div className="live-list">
                    {roles.map((role) => (
                      <article key={role.id}>
                        <div>
                          <strong>{role.displayName}</strong>
                          <small>
                            {role.builtIn ? "Built in" : "Custom"} ·{" "}
                            {role.permissions.length} permissions
                          </small>
                        </div>
                        <span className="status-pill">{role.key}</span>
                      </article>
                    ))}
                    {!roles.length && <EmptyRow text="No custom roles configured." />}
                  </div>
                  <form
                    action={createRoleAction}
                    className="portal-form role-form"
                  >
                    <input
                      type="hidden"
                      name="organisationId"
                      value={organisation.id}
                    />
                    <label>
                      Role key
                      <input
                        name="key"
                        required
                        pattern="[a-z][a-z0-9_]{1,62}"
                      />
                    </label>
                    <label>
                      Display name
                      <input name="displayName" required />
                    </label>
                    <fieldset>
                      <legend>Permissions</legend>
                      <label>
                        <input
                          type="checkbox"
                          name="permission"
                          value="workflows.view"
                          defaultChecked
                        />
                        View
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          name="permission"
                          value="workflows.run"
                        />
                        Run
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          name="permission"
                          value="workflows.approve"
                        />
                        Approve
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          name="permission"
                          value="audit.view"
                        />
                        Audit
                      </label>
                    </fieldset>
                    <SubmitButton pendingLabel="Creating…">Create role</SubmitButton>
                  </form>
                </section>
                <section className="live-panel enterprise-control enterprise-sso">
                  <header>
                    <div>
                      <KeyRound />
                      <span>
                        <strong>SSO connections</strong>
                        <small>Connect an OIDC or SAML identity provider</small>
                      </span>
                    </div>
                  </header>
                  <div className="live-list">
                    {sso.map((connection) => (
                      <article key={connection.id}>
                        <div>
                          <strong>{connection.displayName}</strong>
                          <small>
                            {connection.connectionType.toUpperCase()} ·{" "}
                            {connection.issuerUrl}
                          </small>
                        </div>
                        <span className="status-pill">
                          {connection.enabled ? "enabled" : "disabled"}
                        </span>
                      </article>
                    ))}
                    {!sso.length && <EmptyRow text="No SSO connections." />}
                  </div>
                  <form
                    action={createSsoConnectionAction}
                    className="portal-form sso-form"
                  >
                    <input
                      type="hidden"
                      name="organisationId"
                      value={organisation.id}
                    />
                    <label>
                      Type
                      <select name="connectionType">
                        <option value="oidc">OIDC</option>
                        <option value="saml">SAML</option>
                      </select>
                    </label>
                    <label>
                      Name
                      <input name="displayName" required />
                    </label>
                    <label>
                      Issuer / metadata URL
                      <input
                        type="url"
                        name="issuerUrl"
                        required
                        placeholder="https://identity.example.com"
                      />
                    </label>
                    <label>
                      Client / entity ID
                      <input name="clientIdentifier" required />
                    </label>
                    <label>
                      Verified domains
                      <input
                        name="verifiedDomains"
                        required
                        placeholder="example.com, subsidiary.com"
                      />
                    </label>
                    <SubmitButton pendingLabel="Adding…">Add disabled connection</SubmitButton>
                  </form>
                </section>
                <section className="live-panel enterprise-control enterprise-scim">
                  <header>
                    <div>
                      <KeyRound />
                      <span>
                        <strong>SCIM credentials</strong>
                        <small>Credentials for automated user provisioning</small>
                      </span>
                    </div>
                  </header>
                  <div className="live-list">
                    {scim.map((token) => (
                      <article key={token.id}>
                        <div>
                          <strong>{token.name}</strong>
                          <small>
                            {token.prefix} ·{" "}
                            {token.revokedAt
                              ? "revoked"
                              : `expires ${new Date(token.expiresAt).toLocaleDateString("en-GB")}`}
                          </small>
                        </div>
                        {!token.revokedAt && <PortalActionForm action={revokeScimTokenAction} hidden={{ organisationId: organisation.id, tokenId: token.id }} submitLabel="Revoke" pendingLabel="Revoking…" dangerous confirmTitle={`Revoke ${token.name}?`} confirmDescription="Automated provisioning clients using this credential will lose access immediately." />}
                      </article>
                    ))}
                    {!scim.length && <EmptyRow text="No SCIM credentials." />}
                  </div>
                  <ScimTokenForm organisationId={organisation.id} />
                </section>
                <DataPanel
                  icon={<Activity />}
                  title="Audit stream"
                  rows={[
                    [
                      "NDJSON feed",
                      `/v1/workspaces/${workspaceId}/audit/stream`,
                    ],
                  ]}
                  empty=""
                />
              </div></div>
            </details>
          )}
        </>
      )}
    </main>
  );
}

async function SecurityPage({
  api,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
}) {
  const [profile, sessions, tokens, organisations] = await Promise.all([
    (await api.getAccountProfile()).data,
    (await api.listAccountSessions()).data.items,
    (await api.listPersonalAccessTokens()).data.items,
    (await api.listAccountOrganisations()).data.items,
  ]);
  return (
    <main className="portal-page">
      <PageHead
        title="Security & API"
        description="Review signed-in devices and manage personal API keys."
      />
      <section className="security-identity-card">
        <div>
          <span className="settings-card-icon"><ShieldCheck /></span>
          <span><strong>{profile.displayName}</strong>
          <small>{profile.email}</small></span>
        </div>
      </section>
      <section className="security-section-head"><div><h2>Signed-in devices</h2><p>End any session you do not recognise. Your current session is marked below.</p></div></section>
      <section className="live-panel security-list-card">
        <div className="live-list">
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
          {!sessions.length && <EmptyRow text="No active sessions were returned." />}
        </div>
      </section>
      <section className="security-section-head token-heading"><div><h2>Personal API keys</h2><p>Use the smallest scope and shortest expiry that will do the job.</p></div><PersonalTokenIssuer organisations={organisations} /></section>
      <section className="live-panel security-list-card">
        <div className="live-list">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
          {!tokens.length && <EmptyRow text="No API keys yet. Create one only when a tool needs access." />}
        </div>
      </section>
    </main>
  );
}

async function UsagePage({
  api,
  query,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
  query: Record<string, string | string[] | undefined>;
}) {
  const organisations = (await api.listAccountOrganisations()).data.items,
    workspace = selectWorkspace(organisations, query.workspaceId);
  const usage = workspace && typeof api.getWorkspaceUsage === "function"
    ? await api.getWorkspaceUsage(workspace.id, 30).then((result) => isWorkspaceUsageSummary(result.data) ? result.data : null).catch(() => null)
    : null;
  return (
    <main className="portal-page usage-page">
      <PageHead
        title="Usage"
        description="Verified hosted infrastructure usage, separate from unmetered local execution."
      />
      {workspace && !usage && <ActionFeedback tone="error" className="overview-degraded">Usage reporting is temporarily unavailable. Workspace controls are unaffected; refresh to retry.</ActionFeedback>}
      {workspace ? <>
        <section className="operations-grid usage-totals">
          <Metric icon={<Cloud />} label="Hosted runner" value={formatDuration(meterQuantity(usage,"hosted_runner_seconds"))} />
          <Metric icon={<MonitorSmartphone />} label="Managed browser" value={formatDuration(meterQuantity(usage,"managed_browser_seconds"))} />
          <Metric icon={<Network />} label="Network egress" value={formatBytes(meterQuantity(usage,"network_egress_bytes"))} />
          <Metric icon={<Database />} label="Artifact storage" value={formatStorageTime(meterQuantity(usage,"artifact_storage_byte_seconds"))} />
        </section>
        <section className="usage-chart-panel">
          <header><div><h2>Hosted compute</h2><p>Runner and managed-browser time recorded each day.</p></div><span>Last 30 days</span></header>
          <UsageChart usage={usage} />
          {!usage && <p className="usage-report-state">The usage reporting endpoint is unavailable in this local preview.</p>}
        </section>
        <section className="usage-notes">
          <article className="usage-token-note"><KeyRound /><div><strong>Usage is not metered in tokens</strong><p>API keys, session tokens and runner pairing tokens are credentials. They do not count toward billing.</p></div></article>
          <div className="usage-meter-list">
            <div><strong>Hosted runner</strong><span>Execution time</span><small>seconds</small></div>
            <div><strong>Managed browser</strong><span>Browser worker time</span><small>seconds</small></div>
            <div><strong>Network egress</strong><span>Data sent out</span><small>bytes</small></div>
            <div><strong>Artifact storage</strong><span>Stored size over time</span><small>byte-seconds</small></div>
          </div>
        </section>
        <p className="support-fallback">Only matched, reconciled ledger events appear here. Local desktop and self-hosted runner execution are not sent to the hosted usage meter.</p>
      </> : <section className="resource-launch-card"><span className="settings-card-icon"><Building2 /></span><div><h2>Create a workspace first</h2><p>Usage is reported per workspace so hosted execution and billing evidence remain scoped.</p></div><Link className="portal-primary" href="/organisations">Create workspace <ArrowRight /></Link></section>}
    </main>
  );
}

function UsageChart({usage}:{usage:WorkspaceUsageSummary|null}) {
  const daily=usage?.daily.length ? usage.daily : emptyUsageDays(30);
  const compute=daily.map((point)=>point.quantities.hosted_runner_seconds+point.quantities.managed_browser_seconds);
  const peak=Math.max(0,...compute),scalePeak=Math.max(1,peak),total=compute.reduce((sum,quantity)=>sum+quantity,0),activeDays=compute.filter(Boolean).length;
  const browserTotal=daily.reduce((sum,point)=>sum+point.quantities.managed_browser_seconds,0);
  const ticks=[0,7,14,21,daily.length-1].filter((index,position,items)=>index>=0&&index<daily.length&&items.indexOf(index)===position);
  return (
    <figure className="usage-chart" aria-label="Daily hosted compute usage">
      <div className="usage-chart-key"><span className="runner-key">Hosted runner</span><span className="browser-key">Managed browser</span><i>unit: time</i></div>
      <div className="usage-chart-body">
        <div className="usage-y-axis" aria-hidden="true"><span>{formatDurationAxis(scalePeak)}</span><span>{formatDurationAxis(scalePeak/2)}</span><span>0</span></div>
        <div className="usage-plot">
          <div className="usage-grid-lines" aria-hidden="true"><i /><i /><i /></div>
          <div className="usage-bars">
            {daily.map((point)=>{
              const runner=point.quantities.hosted_runner_seconds,browser=point.quantities.managed_browser_seconds,dayTotal=runner+browser;
              const description=`${formatUsageDateLong(point.date)}: ${formatDuration(dayTotal)} total — ${formatDuration(runner)} runner, ${formatDuration(browser)} browser`;
              return <div className="usage-day" key={point.date} role="img" aria-label={description} title={description}>
                <div className="usage-stack" style={{height:barHeight(dayTotal,scalePeak)}}>
                  <span className="usage-segment runner" style={{height:segmentHeight(runner,dayTotal)}} />
                  <span className="usage-segment browser" style={{height:segmentHeight(browser,dayTotal)}} />
                </div>
              </div>;
            })}
          </div>
          {!total&&<div className="usage-empty-plot">No verified hosted compute in this period</div>}
        </div>
      </div>
      <div className="usage-x-axis" aria-hidden="true">{ticks.map((index)=><span key={daily[index].date}>{formatUsageDate(daily[index].date)}</span>)}</div>
      <div className="usage-chart-summary">
        <div><small>Peak day</small><strong>{formatDuration(peak)}</strong></div>
        <div><small>Daily average</small><strong>{formatDuration(Math.round(total/daily.length))}</strong></div>
        <div><small>Active days</small><strong>{activeDays} / {daily.length}</strong></div>
        <div><small>Browser share</small><strong>{total?Math.round(browserTotal/total*100):0}%</strong></div>
      </div>
      <figcaption>Daily hosted runner and managed-browser time for the selected workspace. Only matched ledger events are included.</figcaption>
    </figure>
  );
}

async function CommercePage({
  api,
  section,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
  section: string;
}) {
  const account: ProductAccountSummary = (await api.getProductAccount()).data;
  const items =
    section === "licences" ? account.licences : account.subscriptions;
  return (
    <main className="portal-page">
      <PageHead
        title={section === "licences" ? "Licences" : "Purchases"}
        description="Product subscriptions and licence grants from the commerce service."
      />
      <section className="section-list">
        <header>
          <h2>
            {section === "licences" ? "Active licences" : "Subscriptions"}
          </h2>
        </header>
        {items.map((item) => (
          <article key={item.id}>
            <span>
              <KeyRound />
            </span>
            <strong>{item.planId}</strong>
            <span>{item.status}</span>
          </article>
        ))}
        {!items.length && (
          <article>
            <span>—</span>
            <strong>No records for this account.</strong>
            <span>Local remains available</span>
          </article>
        )}
      </section>
    </main>
  );
}

async function SettingsPage({
  api,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
}) {
  const profile = (await api.getAccountProfile()).data;
  return (
    <main className="portal-page">
      <PageHead
        title="Account settings"
        description="Your identity, privacy controls and account lifecycle."
      />
      <section className="settings-layout">
        <div className="settings-overview">
          <article className="settings-identity-panel">
            <header>
              <span className="profile-avatar">{profile.displayName.slice(0, 2).toUpperCase()}</span>
              <div><h2>{profile.displayName}</h2><p>{profile.email}</p></div>
            </header>
            <p>Your profile is managed by your identity provider. sndbox does not store a separate account password.</p>
            <dl>
              <div><dt>Account ID</dt><dd><code>{profile.accountId}</code></dd></div>
              <div><dt>Current session</dt><dd><code>{profile.sessionId}</code></dd></div>
            </dl>
          </article>
          <section className="settings-actions-panel">
            <article>
              <span className="settings-card-icon"><MonitorSmartphone /></span>
              <div><strong>Security & API</strong><p>Manage signed-in devices and personal API keys.</p></div>
              <Link className="portal-secondary" href="/security">Manage <ArrowRight /></Link>
            </article>
            <article>
              <span className="settings-card-icon"><Download /></span>
              <div><strong>Export account data</strong><p>Download your account and workspace membership data.</p></div>
              <a className="portal-secondary" href="/api/account/export">Export <ArrowRight /></a>
            </article>
            <article>
              <span className="settings-card-icon"><LogOut /></span>
              <div><strong>Sign out this device</strong><p>Other signed-in devices will stay connected.</p></div>
              <form action="/auth/sign-out" method="post"><button className="portal-secondary">Sign out</button></form>
            </article>
          </section>
        </div>
        <AccountDangerZone />
      </section>
    </main>
  );
}

async function SupportPage({
  api,
  query,
}: {
  api: NonNullable<Awaited<ReturnType<typeof authenticatedClient>>>;
  query: Record<string, string | string[] | undefined>;
}) {
  const organisations = (await api.listAccountOrganisations()).data.items,
    workspace = selectWorkspace(organisations, query.workspaceId);
  let requests: Array<Record<string, unknown>> = [];
  let requestsUnavailable = false;
  if (workspace)
    try {
      requests = (
        await api.request<{ items: Array<Record<string, unknown>> }>({
          path: `/v1/workspaces/${workspace.id}/support-access-requests`,
        })
      ).data.items;
    } catch { requestsUnavailable = true; }
  return (
    <main className="portal-page">
      <PageHead
        title="Support access"
        description="Temporary diagnostic access is explicit, scoped, auditable and revocable."
      />
      {requestsUnavailable && <ActionFeedback tone="error" className="overview-degraded">Support access requests could not be loaded. Refresh to retry before approving or revoking access.</ActionFeedback>}
      <section className="live-panel">
        <header>
          <div>
            <LifeBuoy />
            <span>
              <strong>Diagnostic access requests</strong>
              <small>
                Support cannot collect diagnostics until a workspace
                administrator approves.
              </small>
            </span>
          </div>
        </header>
        <div className="live-list">
          {requests.map((item) => (
            <article key={String(item.id)}>
              <div>
                <strong>{String(item.reason)}</strong>
                <small>
                  {String(item.status)} · expires{" "}
                  {new Date(String(item.expiresAt)).toLocaleString("en-GB")}
                </small>
              </div>
              <span className="status-pill">{String(item.status)}</span>
            </article>
          ))}
          {!requests.length && <EmptyRow text="No support access requests." />}
        </div>
      </section>
      <p className="support-fallback">
        For product questions, use{" "}
        <a href="https://docs.sndbox.app/troubleshooting">
          sndbox troubleshooting
        </a>
        {" "}or join the{" "}
        <a href={brand.community.discord}>Discord community</a>.{" "}
        Never send credentials or an unreviewed diagnostic bundle.
      </p>
    </main>
  );
}

function PageHead({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <p>{eyebrow}</p>}
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
    </header>
  );
}
function selectWorkspace(
  organisations: AccountOrganisation[],
  requested: string | string[] | undefined,
) {
  const workspaces = organisations.flatMap((item) => item.workspaces);
  return (
    workspaces.find(
      (item) =>
        item.id === (Array.isArray(requested) ? requested[0] : requested),
    ) ?? workspaces[0]
  );
}
function value<T>(
  result: PromiseSettledResult<unknown> | undefined,
): T | undefined {
  return result?.status === "fulfilled"
    ? (result.value as { data: T }).data
    : undefined;
}
function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <article>
      {icon}
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
      </div>
    </article>
  );
}
function meterQuantity(usage:WorkspaceUsageSummary|null,meter:UsageMeter):number {
  return usage?.meters.find((item)=>item.meter===meter)?.quantity ?? 0;
}
function isWorkspaceUsageSummary(value:unknown):value is WorkspaceUsageSummary {
  if(!value||typeof value!=="object")return false;
  const candidate=value as Partial<WorkspaceUsageSummary>;
  return Array.isArray(candidate.meters)&&Array.isArray(candidate.daily);
}
function emptyUsageDays(days:number):WorkspaceUsageSummary["daily"] {
  const end=new Date(),start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()-(days-1)));
  return Array.from({length:days},(_,index)=>{
    const date=new Date(start);date.setUTCDate(date.getUTCDate()+index);
    return{date:date.toISOString().slice(0,10),quantities:{hosted_runner_seconds:0,managed_browser_seconds:0,network_egress_bytes:0,artifact_storage_byte_seconds:0}};
  });
}
function formatDuration(seconds:number):string {
  if(seconds<60)return `${seconds}s`;
  const hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60);
  return hours?`${hours}h ${minutes}m`:`${minutes}m`;
}
function formatDurationAxis(seconds:number):string {
  if(seconds<60)return `${Math.ceil(seconds)}s`;
  if(seconds<3600)return `${Math.ceil(seconds/60)}m`;
  return `${(seconds/3600).toFixed(seconds>=36_000?0:1)}h`;
}
function formatBytes(bytes:number):string {
  if(bytes===0)return "0 B";
  const units=["B","KB","MB","GB","TB"],index=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1),quantity=bytes/(1024**index);
  return `${quantity.toFixed(quantity>=10||index===0?0:1)} ${units[index]}`;
}
function formatStorageTime(byteSeconds:number):string {
  if(byteSeconds===0)return "0 GB-days";
  const megabyteDays=byteSeconds/(1024**2*86_400);
  return megabyteDays<1024?`${megabyteDays.toFixed(megabyteDays>=10?0:1)} MB-days`:`${(megabyteDays/1024).toFixed(megabyteDays>=10_240?0:1)} GB-days`;
}
function barHeight(quantity:number,peak:number):string {
  return quantity===0?"0%":`${Math.max(2,(quantity/peak)*100)}%`;
}
function segmentHeight(quantity:number,total:number):string {
  return total===0?"0%":`${quantity/total*100}%`;
}
function formatUsageDate(date:string|undefined):string {
  return date?new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short",timeZone:"UTC"}).format(new Date(`${date}T00:00:00Z`)):"";
}
function formatUsageDateLong(date:string):string {
  return new Intl.DateTimeFormat("en-GB",{weekday:"short",day:"numeric",month:"short",timeZone:"UTC"}).format(new Date(`${date}T00:00:00Z`));
}
function EmptyRow({ text }: { text: string }) {
  return (
    <article className="empty-row">
      <small>{text}</small>
    </article>
  );
}
function DataPanel({
  icon,
  title,
  rows,
  empty,
}: {
  icon: ReactNode;
  title: string;
  rows: string[][];
  empty: string;
}) {
  return (
    <section className="live-panel">
      <header>
        <div>
          {icon}
          <span>
            <strong>{title}</strong>
          </span>
        </div>
      </header>
      <div className="live-list">
        {rows.map(([name, detail], index) => (
          <article key={`${name}-${index}`}>
            <div>
              <strong>{name}</strong>
              <small>{detail}</small>
            </div>
          </article>
        ))}
        {!rows.length && <EmptyRow text={empty} />}
      </div>
    </section>
  );
}
function DeploymentPanel({
  workspaceId,
  deployments,
}: {
  workspaceId: string;
  deployments: Array<Record<string, unknown>>;
}) {
  return (
    <section className="live-panel">
      <header>
        <div>
          <Cloud />
          <span>
            <strong>Deployments</strong>
            <small>Pause or resume a validated deployment.</small>
          </span>
        </div>
      </header>
      <div className="live-list">
        {deployments.map((deployment) => {
          const deploymentId = String(
            deployment.deploymentId ?? deployment.id,
          );
          const status = String(deployment.status);
          const nextStatus =
            status === "paused"
              ? "active"
              : status === "active"
                ? "paused"
                : null;
          return (
            <article key={deploymentId}>
              <div>
                <strong>{String(deployment.workflowId)}</strong>
                <small>
                  {String(deployment.environment)} · {status}
                </small>
              </div>
              {nextStatus && <PortalActionForm action={transitionDeploymentAction} hidden={{ workspaceId, deploymentId, status: nextStatus, reason: `${nextStatus === "paused" ? "Paused" : "Resumed"} from the account portal` }} submitLabel={nextStatus === "paused" ? "Pause" : "Resume"} pendingLabel="Updating…" confirmTitle={`${nextStatus === "paused" ? "Pause" : "Resume"} this deployment?`} confirmDescription={nextStatus === "paused" ? "New hosted executions will stop until the deployment is resumed." : "Hosted executions can start again as soon as the deployment is active."} />}
            </article>
          );
        })}
        {!deployments.length && <EmptyRow text="No deployments created." />}
      </div>
    </section>
  );
}
function SessionRow({ session }: { session: AccountSession }) {
  return (
    <article className="security-row">
      <span className="row-icon"><MonitorSmartphone /></span>
      <div>
        <strong>
          {session.deviceName}
          {session.current ? " · current" : ""}
        </strong>
        <small>
          Last seen {new Date(session.lastSeenAt).toLocaleString("en-GB")}
        </small>
      </div>
      {session.current ? <span className="status-pill approved">Current</span> : (
        <PortalActionForm action={revokeSessionAction} hidden={{ sessionId: session.id }} submitLabel="Revoke" pendingLabel="Revoking…" dangerous confirmTitle={`Sign out ${session.deviceName}?`} confirmDescription="This device will need to sign in again." />
      )}
    </article>
  );
}
function TokenRow({ token }: { token: TokenSummary }) {
  return (
    <article className="security-row">
      <span className="row-icon"><KeyRound /></span>
      <div>
        <strong>{token.name}</strong>
        <small>
          {token.prefix} · expires{" "}
          {new Date(token.expiresAt).toLocaleDateString("en-GB")}
        </small>
      </div>
      {token.revokedAt ? <span className="status-pill">Revoked</span> : <PortalActionForm action={revokePersonalTokenAction} hidden={{ tokenId: token.id }} submitLabel="Revoke" pendingLabel="Revoking…" dangerous confirmTitle={`Revoke ${token.name}?`} confirmDescription="Clients using this API key will lose access immediately." />}
    </article>
  );
}
function Unavailable({ message }: { message: string }) {
  return (
    <main className="portal-page">
      <section className="blocked-notice">
        <CircleAlert />
        <div>
          <strong>Account unavailable</strong>
          <p>{message}</p>
        </div>
      </section>
    </main>
  );
}
