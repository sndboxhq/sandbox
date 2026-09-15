import { listen } from "@tauri-apps/api/event";
import { ShieldQuestion } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { PendingApproval } from "../types";
import { ApprovalRequest } from "./ApprovalRequest";
import { ErrorState, LoadingSkeleton } from "./ui/States";

export function PendingApprovalsView() {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await api.listPendingApprovals();
      setItems(next);
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    if (!api.isDesktop) return () => window.clearInterval(timer);
    const stops: Array<() => void> = [];
    for (const eventName of ["approval-requested", "approval-resolved"]) {
      void listen(eventName, () => void load()).then((value) =>
        stops.push(value),
      ).catch((value) => setError(`Approval updates are unavailable: ${String(value)}`));
    }
    return () => {
      window.clearInterval(timer);
      stops.forEach((stop) => stop());
    };
  }, [load]);
  const resolve = async (id: string, approved: boolean) => {
    setBusy(id);
    setError(undefined);
    try {
      await api.resolvePendingApproval(id, approved);
      await load();
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <main className="content approvals-page">
      <header className="page-header">
        <div>
          <h1>Pending Approvals</h1>
          <p>
            Review local actions that are paused before execution continues.
          </p>
        </div>
        <span className="approval-count">{items.length} pending</span>
      </header>
      {error && items.length > 0 && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="button" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {loading && !items.length ? (
        <LoadingSkeleton rows={4} />
      ) : error && !items.length ? (
        <ErrorState
          title="Pending approvals could not load"
          description={error}
          onRetry={() => void load()}
        />
      ) : items.length ? (
        <div className="approval-list">
          {items.map((item) => (
            <ApprovalRequest
              key={item.id}
              item={item}
              busy={busy === item.id}
              onResolve={(approved) => void resolve(item.id, approved)}
            />
          ))}
        </div>
      ) : (
        <div className="settings-empty approval-empty">
          <ShieldQuestion size={22} />
          <h3>No pending approvals</h3>
          <p>
            Workflows waiting for a local decision appear here and in the system
            tray.
          </p>
        </div>
      )}
    </main>
  );
}
