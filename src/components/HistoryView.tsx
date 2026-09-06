import {
  Clock3,
  ExternalLink,
  Filter,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CustomSelect } from "./ui/CustomSelect";
import { api } from "../api";
import { useAppStore } from "../store";
import type {
  ExecutionQuery,
  ExecutionRecord,
  ExecutionStatus,
} from "../types";
import { ExecutionInspector } from "./ExecutionInspector";
import { Status } from "./Status";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { useToast } from "./ui/Toast";
import { readWorkspaceSnapshot, updateWorkspaceSnapshot } from "../workspaceState";

export function HistoryView() {
  const { workflows, selectedExecution, selectExecution, openWorkflow } =
    useAppStore();
  const toast = useToast();
  const [items, setItems] = useState<ExecutionRecord[]>([]);
  const remembered = useMemo(() => readWorkspaceSnapshot()?.history, []);
  const [search, setSearch] = useState(() => remembered?.search ?? "");
  const [workflowId, setWorkflowId] = useState(() => remembered?.workflowId ?? "");
  const [status, setStatus] = useState<ExecutionStatus | "">(() => remembered?.status as ExecutionStatus | "" ?? "");
  const [trigger, setTrigger] = useState(() => remembered?.trigger ?? "");
  const [after, setAfter] = useState(() => remembered?.startDate ?? "");
  const [before, setBefore] = useState(() => remembered?.endDate ?? "");
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    updateWorkspaceSnapshot(current => ({ ...current, history: { search, workflowId, status, trigger, startDate: after, endDate: before } }));
  }, [search, workflowId, status, trigger, after, before]);
  const query = useMemo<ExecutionQuery>(
    () => ({
      search: debounced || undefined,
      workflowIds: workflowId ? [workflowId] : undefined,
      statuses: status ? [status] : undefined,
      triggerTypes: trigger ? [trigger] : undefined,
      startedAfter: after
        ? new Date(`${after}T00:00:00`).toISOString()
        : undefined,
      startedBefore: before
        ? new Date(`${before}T23:59:59.999`).toISOString()
        : undefined,
      limit: 50,
    }),
    [after, before, debounced, status, trigger, workflowId],
  );
  const load = useCallback(
    async (append = false, next?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await api.queryExecutions({ ...query, cursor: next });
        setItems((current) =>
          append ? [...current, ...page.items] : page.items,
        );
        setCursor(page.nextCursor);
      } catch (value) {
        setError(String(value));
      } finally {
        setLoading(false);
      }
    },
    [query],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const workflow = useMemo(
    () =>
      workflows.find(
        (item) => item.workflow.id === selectedExecution?.workflowId,
      )?.workflow,
    [workflows, selectedExecution],
  );
  const retry = async () => {
    if (!selectedExecution) return;
    try {
      const run = await api.runWorkflow(selectedExecution.workflowId);
      selectExecution(run);
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const retryNode = async (nodeId: string) => {
    if (!selectedExecution) return;
    try {
      const run = await api.retryFailedNode(selectedExecution.id, nodeId);
      selectExecution(run);
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const retryHeaded = async () => {
    if (!selectedExecution) return;
    try {
      const run = await api.retryBrowserExecutionHeaded(selectedExecution.id);
      selectExecution(run);
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const openEditor = async (nodeId?: string) => {
    if (!selectedExecution) return;
    if (nodeId)
      localStorage.setItem(
        "sandbox.editor.focus-node.v1",
        JSON.stringify({ workflowId: selectedExecution.workflowId, nodeId }),
      );
    await openWorkflow(selectedExecution.workflowId);
  };
  const removeSelected = async () => {
    if (!selectedExecution) return;
    try {
      await api.deleteExecution(selectedExecution.id);
      selectExecution();
      setDeleteOpen(false);
      await load();
      toast.push("Execution deleted.", "success");
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const prune = async (keep: number) => {
    try {
      const removed = await api.clearExecutionHistory(keep);
      selectExecution();
      setManageOpen(false);
      await load();
      toast.push(
        `${removed} execution${removed === 1 ? "" : "s"} removed.`,
        "success",
      );
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const clearFilters = () => {
    setSearch("");
    setWorkflowId("");
    setStatus("");
    setTrigger("");
    setAfter("");
    setBefore("");
  };
  const hasFilters = Boolean(
    search || workflowId || status || trigger || after || before,
  );
  if (selectedExecution)
    return (
      <main className="content history-detail">
        <button className="back-link" onClick={() => selectExecution()}>
          ← Run history
        </button>
        <div className="history-detail-actions">
          <button
            className="button"
            disabled={!workflow}
            onClick={() => void openEditor()}
          >
            <ExternalLink size={13} />
            Open workflow
          </button>
          {selectedExecution.nodeExecutions.find(
            (node) => node.status === "failed",
          ) && (
            <button
              className="button"
              onClick={() =>
                void openEditor(
                  selectedExecution.nodeExecutions.find(
                    (node) => node.status === "failed",
                  )!.nodeId,
                )
              }
            >
              Edit failed node
            </button>
          )}
          <button
            className="button danger-text"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={13} />
            Delete execution
          </button>
        </div>
        <ExecutionInspector
          run={selectedExecution}
          workflow={workflow}
          onRetry={retry}
          onRetryNode={retryNode}
          onRetryHeaded={retryHeaded}
          onEditNode={(nodeId) => void openEditor(nodeId)}
          onReviewPermissions={(request) => {
            localStorage.setItem(
              "sandbox.editor.permission-request.v1",
              JSON.stringify({
                workflowId: selectedExecution.workflowId,
                ...request,
              }),
            );
            void openEditor(request.nodeId);
          }}
        />
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete this execution?"
          description="Execution inputs, outputs, logs, and artifacts will be permanently removed."
          confirmLabel="Delete execution"
          dangerous
          onConfirm={() => void removeSelected()}
        />
      </main>
    );
  return (
    <main className="content">
      <header className="page-header">
        <div>
          <h1>Run history</h1>
          <p>Search every local execution, error, output, and diagnostic.</p>
        </div>
        <button
          className="button"
          disabled={!items.length}
          onClick={() => setManageOpen(true)}
        >
          <Settings2 size={14} />
          Manage history
        </button>
      </header>
      <div className="toolbar history-filters">
        <div className="search">
          <Search size={15} />
          <input
            aria-label="Search workflow or error"
            placeholder="Search workflow or error…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              aria-label="Clear history search"
              onClick={() => setSearch("")}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <CustomSelect
          aria-label="Filter workflow"
          value={workflowId}
          onChange={(event) => setWorkflowId(event.target.value)}
        >
          <option value="">All workflows</option>
          {workflows.map((item) => (
            <option key={item.workflow.id} value={item.workflow.id}>
              {item.workflow.name}
            </option>
          ))}
        </CustomSelect>
        <CustomSelect
          aria-label="Filter status"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as ExecutionStatus | "")
          }
        >
          <option value="">All statuses</option>
          {[
            "successful",
            "failed",
            "running",
            "queued",
            "cancelled",
            "skipped",
          ].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </CustomSelect>
        <CustomSelect
          aria-label="Filter trigger"
          value={trigger}
          onChange={(event) => setTrigger(event.target.value)}
        >
          <option value="">All triggers</option>
          <option value="manual">Manual</option>
          <option value="schedule">Schedule</option>
          <option value="file_watch">File watch</option>
          <option value="polling">Polling</option>
        </CustomSelect>
        <label>
          From
          <input
            aria-label="Started after"
            type="date"
            value={after}
            onChange={(event) => setAfter(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            aria-label="Started before"
            type="date"
            value={before}
            onChange={(event) => setBefore(event.target.value)}
          />
        </label>
        {hasFilters && (
          <button className="button" onClick={clearFilters}>
            <Filter size={13} />
            Clear
          </button>
        )}
      </div>
      {loading && !items.length ? (
        <LoadingSkeleton rows={7} />
      ) : error ? (
        <ErrorState
          title="Run history could not load"
          description={error}
          onRetry={() => void load()}
        />
      ) : items.length ? (
        <>
          <section className="history-table">
            <div className="history-head">
              <span>Workflow</span>
              <span>Trigger</span>
              <span>Started</span>
              <span>Duration</span>
              <span>Completed nodes</span>
              <span>Status</span>
            </div>
            {items.map((run) => {
              const item = workflows.find(
                (candidate) => candidate.workflow.id === run.workflowId,
              )?.workflow;
              return (
                <button key={run.id} onClick={() => selectExecution(run)}>
                  <span>
                    <b>{item?.name ?? "Deleted workflow"}</b>
                    {run.error && <small>{run.error.message}</small>}
                  </span>
                  <span className="muted-cell">
                    <Clock3 size={13} />
                    {String(
                      (run.trigger as { type?: string })?.type ?? "manual",
                    ).replaceAll("_", " ")}
                  </span>
                  <span>
                    {format(new Date(run.startedAt), "dd MMM · HH:mm:ss")}
                  </span>
                  <span>{run.durationMs ?? 0} ms</span>
                  <span>
                    {
                      run.nodeExecutions.filter(
                        (node) => node.status === "successful",
                      ).length
                    }{" "}
                    / {run.nodeExecutions.length}
                  </span>
                  <Status status={run.status} />
                </button>
              );
            })}
          </section>
          {cursor && (
            <div className="load-more">
              <button
                className="button"
                disabled={loading}
                onClick={() => void load(true, cursor)}
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          title={hasFilters ? "No matching executions" : "No executions yet"}
          description={
            hasFilters
              ? "Try broadening the search or filters."
              : "Run a workflow to inspect every input, output, and log entry here."
          }
          action={
            hasFilters ? (
              <button className="button" onClick={clearFilters}>
                Clear filters
              </button>
            ) : undefined
          }
        />
      )}
      <Dialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        title="Manage run history"
        description="Deleting history also removes associated browser screenshots and traces from the application artifact directory."
      >
        <div className="manage-history-options">
          <button onClick={() => void prune(100)}>
            <b>Keep latest 100</b>
            <span>Delete older executions</span>
          </button>
          <button onClick={() => void prune(50)}>
            <b>Keep latest 50</b>
            <span>Delete older executions</span>
          </button>
          <button onClick={() => void prune(10)}>
            <b>Keep latest 10</b>
            <span>Delete older executions</span>
          </button>
          <button className="danger-text" onClick={() => void prune(0)}>
            <Trash2 size={14} />
            <b>Delete all history</b>
          </button>
        </div>
      </Dialog>
    </main>
  );
}
