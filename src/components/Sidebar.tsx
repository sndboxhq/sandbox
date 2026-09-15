import * as Popover from "@radix-ui/react-popover";
import { listen } from "@tauri-apps/api/event";
import {
  Bug,
  Clock3,
  Cloud,
  Command,
  GitFork,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plug,
  ShieldQuestion,
  Settings2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { SndboxMark } from "@sandbox/product-ui/brand";
import packageMetadata from "../../package.json";
import { api } from "../api";
import { usePreferences } from "../preferences";
import { useAppStore, type View } from "../store";
import type { RunnerStatus } from "../types";
import { DesktopUpdateNotice } from "./DesktopUpdateNotice";
import { LatestNewsButton } from "./LatestNewsButton";
import { ConfirmDialog } from "./ui/Dialog";
import { Tooltip } from "./ui/Tooltip";
import { useToast } from "./ui/Toast";

const BugReportDialog = lazy(() =>
  import("./BugReportDialog").then((module) => ({
    default: module.BugReportDialog,
  })),
);

const initialRunner: RunnerStatus = {
  paused: false,
  activeWorkflowIds: [],
  localSchedulesStopOnQuit: true,
  scheduledWorkflowCount: 0,
  scheduledWorkflows: [],
};

export function Sidebar({ onCommand }: { onCommand: () => void }) {
  const toast = useToast();
  const {
    sidebarCollapsed: savedCollapsed,
    confirmBeforeLeaving,
    update,
  } = usePreferences();
  const { view, setView, workflows } = useAppStore();
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  const [pendingCount, setPendingCount] = useState(0);
  const [runner, setRunner] = useState<RunnerStatus>(initialRunner);
  const [runnerError, setRunnerError] = useState(false);
  const [activeWorkflowNames, setActiveWorkflowNames] = useState<string[]>([]);
  const [nextView, setNextView] = useState<View>();
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const collapsed = savedCollapsed || (view === "editor" && narrow);
  const refresh = useCallback(() => {
    void api
      .listPendingApprovals()
      .then((items) => setPendingCount(items.length))
      .catch(() => {});
    void api
      .runnerStatus()
      .then(async (status) => {
        setRunnerError(false);
        setRunner(status);
        if (!status.activeWorkflowIds.length) {
          setActiveWorkflowNames([]);
          return;
        }
        const workflows = await api.listWorkflows(true);
        setActiveWorkflowNames(
          status.activeWorkflowIds.map(
            (id) =>
              workflows.find((item) => item.workflow.id === id)?.workflow
                .name ?? id,
          ),
        );
      })
      .catch(() => setRunnerError(true));
  }, []);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 1280);
    const status = () => refresh();
    window.addEventListener("resize", resize);
    window.addEventListener("runner-status-changed", status);
    let stopDesktop: (() => void) | undefined;
    if (api.isDesktop)
      void listen("runner-status-changed", status).then((stop) => {
        stopDesktop = stop;
      }).catch(() => setRunnerError(true));
    const timer = window.setInterval(refresh, 15000);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("runner-status-changed", status);
      stopDesktop?.();
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    void refresh();
  }, [refresh, workflows]);
  const navigate = (next: View) => {
    const dirty = (window as Window & { __sandboxUnsaved?: boolean })
      .__sandboxUnsaved;
    if (dirty && confirmBeforeLeaving) setNextView(next);
    else setView(next);
  };
  const item = (next: View, label: string, icon: ReactNode, badge?: number) => {
    const control = (
      <button
        aria-label={label}
        aria-current={view === next ? "page" : undefined}
        className={view === next ? "active" : ""}
        onClick={() => navigate(next)}
      >
        {icon}
        {!collapsed && <span>{label}</span>}
        {badge ? (
          <em className="nav-badge" aria-label={`${badge} pending`}>
            {badge}
          </em>
        ) : null}
      </button>
    );
    return collapsed ? (
      <Tooltip key={next} content={label}>
        {control}
      </Tooltip>
    ) : (
      <span key={next} className="sidebar-item-wrap">
        {control}
      </span>
    );
  };
  const toggleRunner = async () => {
    setRunnerBusy(true);
    try {
      const status = await api.setRunnerPaused(!runner.paused);
      setRunner(status);
      toast.push(
        status.paused
          ? "Background automations paused."
          : "Background automations resumed.",
        "success",
      );
    } catch (error) {
      toast.push(String(error), "error");
    } finally {
      setRunnerBusy(false);
    }
  };
  return (
    <aside
      className={`sidebar ${collapsed ? "sidebar-collapsed" : ""} ${view === "editor" ? "editor-sidebar" : ""}`}
    >
      <div className="brand">
        <SndboxMark className="brand-mark" size={26} />
        {!collapsed && (
          <span>
            sndbox <small>v{packageMetadata.version}</small>
          </span>
        )}
      </div>
      <DesktopUpdateNotice collapsed={collapsed} />
      <nav aria-label="Primary navigation">
        {item("workflows", "Workflows", <GitFork size={16} />)}
        {item("history", "Run history", <History size={16} />)}
        {item("plugins", "Plugins", <Plug size={16} />)}
        {item("cloud", "Cloud", <Cloud size={16} />)}
        {item("settings", "Settings", <Settings2 size={16} />)}
        {item(
          "approvals",
          "Pending approvals",
          <ShieldQuestion size={16} />,
          pendingCount,
        )}
      </nav>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className={`runner-button ${runnerError ? "unavailable" : runner.paused ? "paused" : runner.activeWorkflowIds.length ? "running" : "active"}`}
            aria-label={`Runner ${runnerError ? "status unavailable" : runner.paused ? "paused" : "active"}`}
          >
            <i />
            {!collapsed && (
              <span>
                <b>
                  {runnerError
                    ? "Runner unavailable"
                    : runner.paused
                    ? "Runner paused"
                    : runner.activeWorkflowIds.length
                      ? "Running workflows"
                      : "Runner active"}
                </b>
                <small>{runnerError ? "Click for details" : `${runner.scheduledWorkflowCount} scheduled`}</small>
              </span>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="runner-popover" side="right" align="end">
            <h3>Local runner</h3>
            <p>
              {runnerError
                ? "Runner status could not be refreshed. Existing workflow data is preserved; retry the connection."
                : runner.paused
                ? "New background triggers are paused. Manual runs are still available."
                : "Schedule, file-watch, and polling triggers can start workflows."}
            </p>
            {runnerError && <button className="button runner-retry" onClick={() => void refresh()}><Clock3 size={12}/>Retry status</button>}
            <dl>
              <div>
                <dt>Running now</dt>
                <dd>{runner.activeWorkflowIds.length}</dd>
              </div>
              <div>
                <dt>Scheduled</dt>
                <dd>{runner.scheduledWorkflowCount}</dd>
              </div>
              <div>
                <dt>Next run</dt>
                <dd>
                  {runner.nextRunAt
                    ? new Date(runner.nextRunAt).toLocaleString()
                    : "None"}
                </dd>
              </div>
            </dl>
            {activeWorkflowNames.length > 0 && (
              <div className="runner-active-list">
                <b>Active workflows</b>
                <ul>
                  {activeWorkflowNames.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {runner.scheduledWorkflows.length > 0 ? (
              <div className="runner-active-list runner-schedule-list">
                <b>Scheduled workflows</b>
                <ul>
                  {runner.scheduledWorkflows.map((workflow) => (
                    <li key={workflow.workflowId}>
                      <span>{workflow.name}</span>
                      <small>
                        {!workflow.ready
                          ? "Needs background permission"
                          : workflow.nextRunAt
                            ? `Next ${new Date(workflow.nextRunAt).toLocaleString()}`
                            : "Ready for the next runner tick"}
                      </small>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="runner-schedule-empty">No enabled schedule workflows.</p>
            )}
            <button
              className="button"
              disabled={runnerBusy}
              onClick={() => void toggleRunner()}
            >
              {runner.paused ? <Play size={14} /> : <Pause size={14} />}
              {runnerBusy
                ? "Updating…"
                : runner.paused
                  ? "Resume automations"
                  : "Pause automations"}
            </button>
            <small>
              <Clock3 size={12} />
              Active executions and manual runs are unaffected.
            </small>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="sidebar-bottom">
        <button
          className="bug-report-sidebar-button"
          aria-label="Report a bug"
          onClick={() => setBugReportOpen(true)}
        >
          <Bug size={16} />
          {!collapsed && <span>Report a bug</span>}
        </button>
        <LatestNewsButton collapsed={collapsed} />
        <button aria-label="Open commands" onClick={onCommand}>
          <Command size={16} />
          {!collapsed && (
            <span>
              Commands <kbd>Ctrl K</kbd>
            </span>
          )}
        </button>
        <button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => update({ sidebarCollapsed: !savedCollapsed })}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} />
          ) : (
            <PanelLeftClose size={16} />
          )}{" "}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(nextView)}
        onOpenChange={(open) => !open && setNextView(undefined)}
        title="Leave unsaved workflow?"
        description="Your local changes have not been saved and will be lost."
        confirmLabel="Leave workflow"
        dangerous
        onConfirm={() => {
          if (nextView) setView(nextView);
          setNextView(undefined);
        }}
      />
      {bugReportOpen && (
        <Suspense fallback={null}>
          <BugReportDialog
            open
            onOpenChange={setBugReportOpen}
            currentView={view}
          />
        </Suspense>
      )}
    </aside>
  );
}
