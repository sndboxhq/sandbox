"use client";

import type { WorkspaceActivitySummary } from "@sandbox/contracts";
import { Activity, ArrowRight } from "lucide-react";
import { ActionFeedback, StatusBadge } from "@sandbox/product-ui";
import { useCallback, useEffect, useState } from "react";
import { withWorkspaceContext } from "../lib/workspace-context";

export function PortalActivitySummary({ workspaceId, initialActivity }: { workspaceId: string; initialActivity: WorkspaceActivitySummary | null }) {
  const [activity, setActivity] = useState(initialActivity);
  const [stale, setStale] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/activity`, { cache: "no-store" });
      if (!response.ok) throw new Error("Activity refresh failed.");
      setActivity(await response.json() as WorkspaceActivitySummary);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [workspaceId]);
  useEffect(() => {
    setActivity(initialActivity);
    setStale(false);
  }, [initialActivity, workspaceId]);
  useEffect(() => {
    const visibleRefresh = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(visibleRefresh, 15_000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibleRefresh); };
  }, [refresh]);
  return <section className="overview-activity" aria-labelledby="workspace-activity-title">
    <header>
      <div><Activity aria-hidden="true" /><span><small>REMOTE OPERATIONS</small><h2 id="workspace-activity-title">Workspace activity</h2></span></div>
      <span>{stale && activity ? "Last successful data · retrying" : activity ? `Updated ${new Date(activity.generatedAt).toLocaleString()}` : "Temporarily unavailable"}</span>
    </header>
    {activity ? <>
      {stale && <ActionFeedback tone="error" className="overview-activity-stale">Refresh failed. Keeping the last successful workspace data while retrying.</ActionFeedback>}
      <div className="overview-activity-metrics">
        <div><strong>{activity.runners.filter((runner) => runner.status === "online").length}/{activity.runners.length}</strong><small>runners online</small></div>
        <div><strong>{activity.pendingApprovalCount}</strong><small>pending approvals</small></div>
        <div><strong>{activity.webhookFailureCount}</strong><small>webhook failures</small></div>
        <div><strong>{activity.syncConflictCount}</strong><small>sync conflicts</small></div>
      </div>
      <div className="overview-activity-lists">
        <section><header><h3>Recent remote runs</h3><a href={withWorkspaceContext("/organisations", workspaceId)}>View workflows <ArrowRight /></a></header>
          {activity.runs.slice(0, 4).map((run) => <article key={run.id}><span><strong>{run.workflowId}</strong><small title={new Date(run.startedAt ?? activity.generatedAt).toISOString()}>{new Date(run.startedAt ?? activity.generatedAt).toLocaleString()} · {run.trigger}</small></span><StatusBadge tone={run.status === "failed" ? "danger" : run.status === "successful" ? "success" : "info"}>{run.status}</StatusBadge>{run.redactedErrorSummary && <p>{run.redactedErrorSummary}</p>}</article>)}
          {!activity.runs.length && <p className="overview-activity-empty">No remote runs reported yet.</p>}
        </section>
        <section><header><h3>Runner state</h3><a href={withWorkspaceContext("/operations", workspaceId)}>Manage runners <ArrowRight /></a></header>
          {activity.runners.slice(0, 4).map((runner) => <article key={runner.runnerId}><span><strong>{runner.displayName}</strong><small title={runner.lastSeenAt ? new Date(runner.lastSeenAt).toISOString() : undefined}>{runner.lastSeenAt ? `Seen ${new Date(runner.lastSeenAt).toLocaleString()}` : "No heartbeat reported"}</small></span><StatusBadge tone={runner.status === "online" ? "success" : runner.status === "offline" ? "danger" : "warning"}>{runner.status}</StatusBadge></article>)}
          {!activity.runners.length && <p className="overview-activity-empty">No runners paired with this workspace.</p>}
        </section>
      </div>
    </> : <ActionFeedback tone="error" className="overview-activity-error">Workspace activity could not be refreshed. Other account controls remain available; this panel will retry while visible.</ActionFeedback>}
  </section>;
}
