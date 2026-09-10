import type { WorkspaceActivitySummary } from "@sandbox/contracts";
import { rankAttentionItems, type AttentionItem } from "@sandbox/product-ui";

export function portalAttentionItems(activity: WorkspaceActivitySummary | null, workspaceId?: string): AttentionItem[] {
  if (!activity || !workspaceId) return [];
  const query = `workspaceId=${encodeURIComponent(workspaceId)}`;
  const items: AttentionItem[] = [];
  const failedRuns = activity.runs.filter((run) => run.status === "failed");
  const unavailableRunners = activity.runners.filter((runner) => runner.status === "offline" || runner.status === "maintenance");
  if (failedRuns.length) items.push({ id: "failed-runs", severity: "blocking", title: `${failedRuns.length} failed remote run${failedRuns.length === 1 ? "" : "s"}`, description: failedRuns[0].redactedErrorSummary ?? "Inspect the most recent failure before running the workflow again.", href: `/organisations?${query}`, actionLabel: "Review activity" });
  if (activity.pendingApprovalCount) items.push({ id: "approvals", severity: "action_required", title: `${activity.pendingApprovalCount} publication review${activity.pendingApprovalCount === 1 ? "" : "s"} waiting`, description: "Review the immutable revision before it can be published.", href: `/organisations?${query}`, actionLabel: "Review approvals" });
  if (activity.syncConflictCount) items.push({ id: "sync-conflicts", severity: "action_required", title: `${activity.syncConflictCount} sync conflict${activity.syncConflictCount === 1 ? "" : "s"}`, description: "Choose the revision that should remain current before publishing.", href: `/organisations?${query}`, actionLabel: "Resolve conflicts" });
  if (unavailableRunners.length) items.push({ id: "runners", severity: "warning", title: `${unavailableRunners.length} runner${unavailableRunners.length === 1 ? "" : "s"} unavailable`, description: "Check the latest heartbeat and resume or repair the affected runner.", href: `/operations?${query}`, actionLabel: "Open operations" });
  if (activity.webhookFailureCount) items.push({ id: "webhooks", severity: "warning", title: `${activity.webhookFailureCount} failed webhook delivery`, description: "Inspect workspace activity and verify the endpoint before retrying.", href: `/support?${query}`, actionLabel: "Get help" });
  return rankAttentionItems(items);
}
