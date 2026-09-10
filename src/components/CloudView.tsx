import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  Building2,
  CheckCircle2,
  Cloud,
  CloudDownload,
  CloudUpload,
  FolderGit2,
  LogIn,
  LogOut,
  RefreshCcw,
  ShieldCheck,
  TriangleAlert,
  ExternalLink,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WorkspaceActivitySummary } from "@sandbox/contracts";
import { StatusBadge } from "@sandbox/product-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAppStore } from "../store";
import { CustomSelect } from "./ui/CustomSelect";
import type {
  AccountOrganisation,
  AccountStatus,
  CloudWorkflow,
  CloudWorkflowApproval,
} from "../types";
import { EmptyState, LoadingSkeleton } from "./ui/States";
import { useToast } from "./ui/Toast";

const workspaceStorageKey = "sandbox.cloud.workspace";
const deviceStorageKey = "sandbox.cloud.device";

function deviceId(): string {
  const existing = localStorage.getItem(deviceStorageKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(deviceStorageKey, created);
  return created;
}

export function CloudView() {
  const toast = useToast();
  const { workflows, load: loadLocal, openWorkflow } = useAppStore();
  const [status, setStatus] = useState<AccountStatus>();
  const [organisations, setOrganisations] = useState<AccountOrganisation[]>([]);
  const [workspaceId, setWorkspaceId] = useState(
    () => localStorage.getItem(workspaceStorageKey) ?? "",
  );
  const [cloudWorkflows, setCloudWorkflows] = useState<CloudWorkflow[]>([]);
  const [approvals, setApprovals] = useState<CloudWorkflowApproval[]>([]);
  const [activity, setActivity] = useState<WorkspaceActivitySummary>();
  const [activityStale, setActivityStale] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});
  const [organisationName, setOrganisationName] = useState("");
  const [organisationSlug, setOrganisationSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const workspace = useMemo(
    () =>
      organisations
        .flatMap((organisation) => organisation.workspaces)
        .find((item) => item.id === workspaceId),
    [organisations, workspaceId],
  );
  const remoteById = useMemo(
    () => new Map(cloudWorkflows.map((workflow) => [workflow.workflowId, workflow])),
    [cloudWorkflows],
  );

  const loadAccount = useCallback(async () => {
    setError(undefined);
    try {
      const nextStatus = await api.accountStatus();
      setStatus(nextStatus);
      if (!nextStatus.signedIn) {
        setOrganisations([]);
        setCloudWorkflows([]);
        return;
      }
      const nextOrganisations = await api.listAccountOrganisations();
      setOrganisations(nextOrganisations);
      const available = nextOrganisations.flatMap((item) => item.workspaces);
      const selected = available.some((item) => item.id === workspaceId)
        ? workspaceId
        : (available[0]?.id ?? "");
      setWorkspaceId(selected);
      if (selected) localStorage.setItem(workspaceStorageKey, selected);
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const loadRemote = useCallback(async () => {
    if (!workspaceId || !status?.signedIn) {
      setCloudWorkflows([]);
      setApprovals([]);
      setActivity(undefined);
      return;
    }
    const results = await Promise.allSettled([
        api.listCloudWorkflows(workspaceId),
        api.listCloudWorkflowApprovals(workspaceId),
        api.getWorkspaceActivity(workspaceId),
      ]);
    const [workflowResult, approvalResult, activityResult] = results;
    if (workflowResult.status === "fulfilled") setCloudWorkflows(workflowResult.value);
    if (approvalResult.status === "fulfilled") setApprovals(approvalResult.value);
    if (activityResult.status === "fulfilled") {
      setActivity(activityResult.value);
      setActivityStale(false);
    } else {
      setActivityStale(true);
    }
    const failed = ["workflows", "approvals", "activity"].filter((_, index) => results[index].status === "rejected");
    if (failed.length) setError(`Some cloud data could not be refreshed: ${failed.join(", ")}. Last successful data is still shown.`);
    else setError(undefined);
  }, [status?.signedIn, workspaceId]);

  useEffect(() => {
    void loadLocal();
    void loadAccount();
  }, []);
  useEffect(() => {
    void loadRemote();
  }, [loadRemote]);
  useEffect(() => {
    if (!workspaceId || !status?.signedIn) return;
    const refresh = () => { if (document.visibilityState === "visible") void loadRemote(); };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [loadRemote, status?.signedIn, workspaceId]);
  useEffect(() => {
    const openSection = (section?: string) => {
      const value = section ?? localStorage.getItem("sandbox.cloud.section.v1") ?? undefined;
      if (!value) return;
      localStorage.removeItem("sandbox.cloud.section.v1");
      window.setTimeout(() => document.getElementById(`cloud-${value}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    };
    const event = (value: Event) => openSection((value as CustomEvent<string>).detail);
    window.addEventListener("sandbox:cloud-section", event);
    openSection();
    return () => window.removeEventListener("sandbox:cloud-section", event);
  }, [loading, workspaceId]);
  useEffect(() => {
    if (!api.isDesktop) return;
    const stops: Array<() => void> = [];
    void listen("account-session-updated", () => {
      setLoading(true);
      void loadAccount();
    }).then((stop) => stops.push(stop));
    void listen<string>("account-session-error", (event) => {
      setError(event.payload);
      setBusy(undefined);
    }).then((stop) => stops.push(stop));
    return () => stops.forEach((stop) => stop());
  }, [loadAccount]);

  const startAuth = async (createAccount: boolean) => {
    setBusy("auth");
    setError(undefined);
    try {
      await api.startAccountAuth(createAccount);
      toast.push("Finish signing in in your browser.", "success");
    } catch (value) {
      setError(String(value));
      setBusy(undefined);
    }
  };
  const signOut = async () => {
    setBusy("signout");
    try {
      await api.signOutAccount();
      await loadAccount();
      toast.push("Signed out. Local workflows are still available.", "success");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  const createOrganisation = async () => {
    setBusy("organisation");
    setError(undefined);
    try {
      const created = await api.createAccountOrganisation(
        organisationName,
        organisationSlug,
      );
      setOrganisations([created]);
      const selected = created.workspaces[0]?.id ?? "";
      setWorkspaceId(selected);
      if (selected) localStorage.setItem(workspaceStorageKey, selected);
      toast.push("Organisation and default workspace created.", "success");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  const push = async (workflowId: string) => {
    if (!workspaceId) return;
    setBusy(`push:${workflowId}`);
    setError(undefined);
    try {
      const remote = remoteById.get(workflowId);
      const result = await api.pushCloudWorkflow(
        workflowId,
        workspaceId,
        remote?.currentDraftRevisionId ?? undefined,
        deviceId(),
      );
      await loadRemote();
      toast.push(
        result.conflictRevisionId
          ? "Encrypted revision uploaded with a conflict to review."
          : "Encrypted revision synced.",
        result.conflictRevisionId ? "error" : "success",
      );
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  const pull = async (remote: CloudWorkflow) => {
    if (!workspaceId || !remote.currentDraftRevisionId) return;
    setBusy(`pull:${remote.workflowId}`);
    setError(undefined);
    try {
      const imported = await api.importCloudWorkflowRevision(
        workspaceId,
        remote.workflowId,
        remote.currentDraftRevisionId,
      );
      await loadLocal();
      toast.push("Imported the encrypted revision as a disabled local copy.", "success");
      await openWorkflow(imported.id);
    } catch (value) {
      setError(
        `${String(value)} If this revision came from another device, that device's sync key must first be enrolled for this account.`,
      );
    } finally {
      setBusy(undefined);
    }
  };
  const requestReview = async (remote: CloudWorkflow) => {
    if (!workspaceId || !remote.currentDraftRevisionId) return;
    setBusy(`review:${remote.workflowId}`);
    setError(undefined);
    try {
      await api.requestCloudWorkflowApproval(
        workspaceId,
        remote.workflowId,
        remote.currentDraftRevisionId,
      );
      await loadRemote();
      toast.push("Revision sent for workspace approval.", "success");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  const decide = async (approval: CloudWorkflowApproval, decision: "approved" | "rejected") => {
    const reason = approvalNotes[approval.approvalId]?.trim();
    if (decision === "rejected" && !reason) {
      setError("Add a reason before rejecting a revision.");
      return;
    }
    setBusy(`approval:${approval.approvalId}`);
    setError(undefined);
    try {
      await api.decideCloudWorkflowApproval(
        workspaceId,
        approval.approvalId,
        decision,
        reason,
      );
      await loadRemote();
      toast.push(decision === "approved" ? "Revision approved." : "Revision rejected.", "success");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  const publish = async (approval: CloudWorkflowApproval) => {
    const summary = approvalNotes[approval.approvalId]?.trim();
    if (!summary) {
      setError("Add a change summary before publishing the approved revision.");
      return;
    }
    setBusy(`publish:${approval.approvalId}`);
    setError(undefined);
    try {
      await api.publishCloudWorkflow(
        workspaceId,
        approval.workflowId,
        approval.revisionId,
        summary,
      );
      await loadRemote();
      toast.push("Approved revision published to the workspace.", "success");
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };

  if (loading) {
    return (
      <main className="content cloud-page">
        <LoadingSkeleton />
      </main>
    );
  }

  return (
    <main className="content cloud-page">
      <header className="cloud-header">
        <div>
          <p className="eyebrow">ACCOUNT &amp; SYNC</p>
          <h1>Cloud workspace</h1>
          <span>
            Keep local automation optional. Sync only the workflows you choose.
          </span>
        </div>
        {status?.signedIn ? (
          <button className="button" disabled={Boolean(busy)} onClick={() => void signOut()}>
            <LogOut size={14} /> Sign out
          </button>
        ) : null}
      </header>

      {error && (
        <div className="error-banner cloud-error">
          <TriangleAlert size={16} /> <b>{error}</b>
        </div>
      )}

      {!status?.signedIn ? (
        <section className="cloud-signin-card">
          <span className="cloud-hero-icon"><Cloud size={26} /></span>
          <h2>Local by default. Connected when you choose.</h2>
          <p>
            Sign in to discover team workspaces and sync encrypted workflow
            revisions. Running, editing, schedules, and local history keep working
            without an account.
          </p>
          {status?.configured ? (
            <div className="cloud-auth-actions">
              <button className="button primary" disabled={busy === "auth"} onClick={() => void startAuth(false)}>
                <LogIn size={14} /> Sign in
              </button>
              <button className="button" disabled={busy === "auth"} onClick={() => void startAuth(true)}>
                Create account
              </button>
            </div>
          ) : (
            <div className="cloud-unconfigured">
              <ShieldCheck size={16} />
              <span>{status?.configurationError ?? "Account services are not configured in this build."}</span>
            </div>
          )}
          <small>Credentials are stored in the operating-system vault and never exposed to workflow nodes.</small>
        </section>
      ) : (
        <>
          <section className="cloud-account-strip">
            <span className="account-avatar">{status.metadata?.displayName.slice(0, 2).toUpperCase()}</span>
            <div>
              <b>{status.metadata?.displayName}</b>
              <small>{status.metadata?.email}</small>
            </div>
            <CheckCircle2 size={17} />
            <span>Connected</span>
            <button className="icon-button" title="Refresh cloud data" onClick={() => void loadAccount()}>
              <RefreshCcw size={14} />
            </button>
          </section>

          {workspaceId && <nav className="cloud-account-links" aria-label="Workspace account links">
            {[['Operations', 'operations'], ['Usage', 'usage'], ['Workspace', 'organisations'], ['Support', 'support']].map(([label, path]) => <button className="button" key={path} onClick={() => void openUrl(`https://app.sndbox.app/${path}?workspaceId=${encodeURIComponent(workspaceId)}`).catch((value) => toast.push(String(value), "error"))}>{label}<ExternalLink size={12} /></button>)}
          </nav>}

          {organisations.flatMap((item) => item.workspaces).length ? (
            <section className="cloud-workspace-card">
              <div className="cloud-workspace-heading">
                <span><Building2 size={16} /></span>
                <div>
                  <b>Workspace</b>
                  <small>Roles and permissions are enforced by the control plane.</small>
                </div>
                <CustomSelect
                  aria-label="Cloud workspace"
                  value={workspaceId}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                    localStorage.setItem(workspaceStorageKey, event.target.value);
                  }}
                >
                  {organisations.map((organisation) => (
                    <optgroup key={organisation.id} label={organisation.name}>
                      {organisation.workspaces.map((item) => (
                        <option value={item.id} key={item.id}>{item.name} · {item.role}</option>
                      ))}
                    </optgroup>
                  ))}
                </CustomSelect>
              </div>
              {workspace && <small className="cloud-workspace-id">{workspace.name} · {workspace.id}</small>}
            </section>
          ) : (
            <section className="cloud-create-organisation">
              <EmptyState
                icon={<Building2 size={22} />}
                title="Create your first workspace"
                description="Start an organisation here, or ask a workspace owner to invite this email address."
              />
              <div className="cloud-create-fields">
                <label>
                  <span>Organisation name</span>
                  <input
                    value={organisationName}
                    maxLength={100}
                    placeholder="Acme Operations"
                    onChange={(event) => {
                      const name = event.target.value;
                      setOrganisationName(name);
                      setOrganisationSlug(
                        name
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")
                          .replace(/^-|-$/g, "")
                          .slice(0, 63),
                      );
                    }}
                  />
                </label>
                <label>
                  <span>Workspace address</span>
                  <input
                    value={organisationSlug}
                    maxLength={63}
                    placeholder="acme-operations"
                    onChange={(event) => setOrganisationSlug(event.target.value.toLowerCase())}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={busy === "organisation" || organisationName.trim().length < 2 || !organisationSlug}
                  onClick={() => void createOrganisation()}
                >
                  <Building2 size={14} /> {busy === "organisation" ? "Creating…" : "Create organisation"}
                </button>
              </div>
            </section>
          )}

          {workspaceId && (

            <div className="cloud-sync-grid" id="cloud-workflows">
              <section className="cloud-list-card">
                <header>
                  <div><FolderGit2 size={17} /><span><b>Local workflows</b><small>Choose what leaves this device.</small></span></div>
                  <em>{workflows.length}</em>
                </header>
                <div className="cloud-workflow-list">
                  {workflows.map(({ workflow }) => {
                    const remote = remoteById.get(workflow.id);
                    return (
                      <article key={workflow.id}>
                        <div><b>{workflow.name}</b><small>{remote ? `Synced ${remote.updatedAt ? new Date(remote.updatedAt).toLocaleString() : "without revisions"}` : "Local only"}</small></div>
                        <button className="button" disabled={Boolean(busy)} onClick={() => void push(workflow.id)}>
                          <CloudUpload size={13} /> {busy === `push:${workflow.id}` ? "Encrypting…" : remote ? "Sync changes" : "Enable sync"}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="cloud-list-card">
                <header>
                  <div><Cloud size={17} /><span><b>Workspace workflows</b><small>Encrypted revisions available to this workspace.</small></span></div>
                  <em>{cloudWorkflows.length}</em>
                </header>
                {cloudWorkflows.length ? (
                  <div className="cloud-workflow-list">
                    {cloudWorkflows.map((remote) => (
                      <article key={remote.workflowId}>
                        <div><b>{remote.name}</b><small>{remote.currentPublishedRevisionId ? "Published revision available" : "Draft only"}</small></div>
                        {remote.currentDraftRevisionId &&
                          !approvals.some((approval) => approval.revisionId === remote.currentDraftRevisionId) && (
                            <button className="button" disabled={Boolean(busy)} onClick={() => void requestReview(remote)}>
                              <ShieldCheck size={13} /> {busy === `review:${remote.workflowId}` ? "Requesting…" : "Request review"}
                            </button>
                          )}
                        <button className="button" disabled={Boolean(busy) || !remote.currentDraftRevisionId} onClick={() => void pull(remote)}>
                          <CloudDownload size={13} /> {busy === `pull:${remote.workflowId}` ? "Decrypting…" : "Import copy"}
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="cloud-inline-empty">No workflows have been synced to this workspace.</div>
                )}
              </section>
            </div>
          )}
          {workspaceId && approvals.length > 0 && (
            <section className="cloud-approvals-card" id="cloud-approvals">
              <header>
                <div><ShieldCheck size={17} /><span><b>Publication reviews</b><small>Approval and publication are separate, auditable steps.</small></span></div>
                <em>{approvals.filter((item) => item.status === "pending").length} pending</em>
              </header>
              <div className="cloud-approval-list">
                {approvals.map((approval) => {
                  const workflowName = cloudWorkflows.find((item) => item.workflowId === approval.workflowId)?.name ?? approval.workflowId;
                  return (
                    <article key={approval.approvalId}>
                      <div className="cloud-approval-summary">
                        <b>{workflowName}</b>
                        <small>{approval.status} · {approval.approvalCount}/{approval.requiredApprovals} approvals · {new Date(approval.createdAt).toLocaleString()}</small>
                      </div>
                      {(approval.status === "pending" || approval.status === "approved") && (
                        <input
                          aria-label={approval.status === "pending" ? "Optional approval or required rejection reason" : "Publication change summary"}
                          placeholder={approval.status === "pending" ? "Review note or rejection reason" : "Describe the published change"}
                          value={approvalNotes[approval.approvalId] ?? ""}
                          onChange={(event) => setApprovalNotes((current) => ({ ...current, [approval.approvalId]: event.target.value }))}
                        />
                      )}
                      {approval.status === "pending" && (
                        <div className="cloud-approval-actions">
                          <button className="button primary" disabled={Boolean(busy)} onClick={() => void decide(approval, "approved")}>Approve</button>
                          <button className="button" disabled={Boolean(busy)} onClick={() => void decide(approval, "rejected")}>Reject</button>
                        </div>
                      )}
                      {approval.status === "approved" && (
                        <button className="button primary" disabled={Boolean(busy)} onClick={() => void publish(approval)}>
                          <CloudUpload size={13} /> {busy === `publish:${approval.approvalId}` ? "Publishing…" : "Publish"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}
          {workspaceId && <section className="cloud-activity-card" id="cloud-activity">
            <header><div><Activity size={17} /><span><b>Workspace activity</b><small>Remote runner health and recent redacted run summaries.</small></span></div><em>{activityStale ? "Last known data" : activity ? `Updated ${new Date(activity.generatedAt).toLocaleTimeString()}` : "Unavailable"}</em></header>
            {activity && <div className="cloud-activity-summary">
              <div><b>{activity.runners.filter((runner) => runner.status === "online").length}/{activity.runners.length}</b><small>runners online</small></div>
              <div><b>{activity.pendingApprovalCount}</b><small>pending reviews</small></div>
              <div><b>{activity.syncConflictCount}</b><small>sync conflicts</small></div>
              <div><b>{activity.webhookFailureCount}</b><small>webhook failures</small></div>
            </div>}
            {activity?.runs.length ? <div className="cloud-run-list">{activity.runs.slice(0, 8).map((run) => <article key={run.id}><span><b>{cloudWorkflows.find((item) => item.workflowId === run.workflowId)?.name ?? run.workflowId}</b><small>{new Date(run.startedAt ?? activity.generatedAt).toLocaleString()} · {run.trigger}</small></span><StatusBadge tone={run.status === "failed" ? "danger" : run.status === "successful" ? "success" : "info"}>{run.status}</StatusBadge>{run.redactedErrorSummary && <p>{run.redactedErrorSummary}</p>}</article>)}</div> : <div className="cloud-inline-empty">No remote runs have been reported for this workspace.</div>}
          </section>}
        </>
      )}
    </main>
  );
}
