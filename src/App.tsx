import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { api } from "./api";
import type { PendingApproval, PluginPackageInspection } from "./types";
import { useAppStore } from "./store";
import { useApplyPreferences, usePreferences } from "./preferences";
import { AsyncErrorBoundary } from "./components/ui/AsyncErrorBoundary";
import { LoadingSkeleton } from "./components/ui/States";
import { useToast } from "./components/ui/Toast";
import { ConfirmDialog } from "./components/ui/Dialog";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { CommandShell } from "./components/CommandShell";
import { isTextEntryTarget, useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { readWorkspaceSnapshot, updateWorkspaceSnapshot } from "./workspaceState";
import { parseDeepLink, type DeepLinkRequest } from "./deepLinks";
import { WORKFLOW_TEMPLATES } from "./workflowTemplates";
import "./plugins.css";

const Dashboard = lazy(() =>
  import("./components/Dashboard").then((module) => ({
    default: module.Dashboard,
  })),
);
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((module) => ({ default: module.CommandPalette })),
);
const HistoryView = lazy(() =>
  import("./components/HistoryView").then((module) => ({
    default: module.HistoryView,
  })),
);
const WorkflowEditor = lazy(() =>
  import("./components/WorkflowEditor").then((module) => ({
    default: module.WorkflowEditor,
  })),
);
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((module) => ({
    default: module.SettingsView,
  })),
);
const PendingApprovalsView = lazy(() =>
  import("./components/PendingApprovalsView").then((module) => ({
    default: module.PendingApprovalsView,
  })),
);
const PluginsHub = lazy(() =>
  import("./components/PluginsHub").then((module) => ({
    default: module.PluginsHub,
  })),
);
const CloudView = lazy(() =>
  import("./components/CloudView").then((module) => ({
    default: module.CloudView,
  })),
);
const ApprovalRequest = lazy(() =>
  import("./components/ApprovalRequest").then((module) => ({
    default: module.ApprovalRequest,
  })),
);
const ActiveAiTabs = lazy(() =>
  import("./components/ActiveAiTabs").then((module) => ({
    default: module.ActiveAiTabs,
  })),
);

export default function App() {
  const toast = useToast();
  useApplyPreferences();
  const { view, activeWorkflow, workflows, setView } = useAppStore();
  const startView = usePreferences((state) => state.startView);
  const restoreLastWorkspace = usePreferences((state) => state.restoreLastWorkspace);
  const initialViewApplied = useRef(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [approvalPrompt, setApprovalPrompt] = useState<PendingApproval>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [deepLinks, setDeepLinks] = useState<string[]>([]);
  const [deepLinkInspection, setDeepLinkInspection] =
    useState<PluginPackageInspection>();
  const [deepLinkError, setDeepLinkError] = useState<string>();
  const [deepLinkBusy, setDeepLinkBusy] = useState(false);
  const deepLink = parseDeepLink(deepLinks[0]);
  useEffect(() => {
    const raw = deepLinks[0];
    if (!raw || deepLink) return;
    setDeepLinks((current) => current.slice(1));
    toast.push("That sndbox link is malformed or unsupported.", "error");
  }, [deepLink, deepLinks, toast]);
  useEffect(() => {
    if (initialViewApplied.current) return;
    initialViewApplied.current = true;
    if (startView !== "workflows") setView(startView);
  }, [setView, startView]);
  useEffect(() => {
    if (!restoreLastWorkspace) return;
    const snapshot = readWorkspaceSnapshot();
    if (!snapshot) return;
    if (snapshot.view !== "editor") { setView(snapshot.view); return; }
    if (!snapshot.workflowId) return;
    void api.listWorkflows(true).then(async (items) => {
      const item = items.find((candidate) => candidate.workflow.id === snapshot.workflowId);
      if (!item || item.metadata.archivedAt) {
        updateWorkspaceSnapshot(current => ({ ...current, workflowId: undefined }));
        return;
      }
      await useAppStore.getState().openWorkflow(snapshot.workflowId!);
    }).catch(() => updateWorkspaceSnapshot(current => ({ ...current, workflowId: undefined })));
  }, [restoreLastWorkspace, setView]);
  useEffect(() => {
    updateWorkspaceSnapshot(current => ({ ...current, view, workflowId: view === "editor" ? activeWorkflow?.id : undefined }));
  }, [view, activeWorkflow?.id]);
  useKeyboardShortcuts((event) => {
    if (event.target instanceof Element && event.target.closest("[role=dialog],[role=alertdialog]")) return;
    if (isTextEntryTarget(event.target)) return;
    if (event.key === "?" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); setShortcutsOpen(true); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        window.dispatchEvent(new CustomEvent("sandbox:open-command-shell"));
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "`") { event.preventDefault(); setCommandOpen(value => !value); }
  }, [view]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let stop: (() => void) | undefined;
    void listen<string>("navigate", (event) => {
      if (event.payload === "approvals") setView("approvals");
    }).then((unlisten) => (stop = unlisten));
    return () => stop?.();
  }, [setView]);
  useEffect(() => {
    if (!api.isDesktop) return;
    let stop: (() => void) | undefined;
    void api
      .listPendingApprovals()
      .then((items) => setApprovalPrompt(items[0]));
    void listen<PendingApproval>("approval-requested", (event) =>
      setApprovalPrompt(event.payload),
    ).then((unlisten) => (stop = unlisten));
    return () => stop?.();
  }, []);
  useEffect(() => {
    if (deepLink?.kind !== "view") return;
    let cancelled = false;
    setDeepLinkBusy(true);
    void api.listAccountOrganisations().then(async (organisations) => {
      if (cancelled) return;
      const allowed = organisations.some((organisation) => organisation.workspaces.some((workspace) => workspace.id === deepLink.workspaceId));
      if (!allowed) throw new Error("That workspace is no longer available to this account.");
      if (deepLink.section === "activity")
        await api.getWorkspaceActivity(deepLink.workspaceId);
      else if (deepLink.section === "workflows")
        await api.listCloudWorkflows(deepLink.workspaceId);
      else
        await api.listCloudWorkflowApprovals(deepLink.workspaceId, "all");
      if (cancelled) return;
      localStorage.setItem("sandbox.cloud.workspace", deepLink.workspaceId);
      localStorage.setItem("sandbox.cloud.section.v1", deepLink.section);
      setView("cloud");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("sandbox:cloud-section", { detail: deepLink.section })), 0);
      toast.push("Opened the requested cloud workspace.", "success");
      dismissDeepLink();
    }).catch((error) => {
      if (cancelled) return;
      setDeepLinkError(String(error));
      toast.push(String(error), "error");
      dismissDeepLink();
    }).finally(() => !cancelled && setDeepLinkBusy(false));
    return () => { cancelled = true; };
  }, [deepLink, setView, toast]);
  useEffect(() => {
    if (!api.isDesktop) return;
    let stop: (() => void) | undefined;
    const add = (urls: string[]) =>
      setDeepLinks((current) => [...current, ...urls.filter((url) => !current.includes(url))]);
    void api.takeDeepLinkRequests().then(add);
    void listen<string[]>("deep-link-requested", (event) => add(event.payload)).then(
      (unlisten) => (stop = unlisten),
    );
    return () => stop?.();
  }, []);
  useEffect(() => {
    setDeepLinkInspection(undefined);
    setDeepLinkError(undefined);
    if (deepLink?.kind !== "marketplace") return;
    void api
      .inspectMarketplacePlugin(deepLink.pluginId)
      .then((inspection) => {
        if (
          deepLink.version &&
          String(inspection.manifest.version) !== deepLink.version
        )
          throw new Error(
            `The link requested ${deepLink.version}, but the marketplace currently serves ${String(inspection.manifest.version)}.`,
          );
        setDeepLinkInspection(inspection);
      })
      .catch((error) => setDeepLinkError(String(error)));
  }, [deepLinks[0]]);
  useEffect(() => {
    if (deepLinks[0] && !deepLink)
      setDeepLinks((current) => current.slice(1));
  }, [deepLink, deepLinks]);
  const resolvePrompt = async (approved: boolean) => {
    if (!approvalPrompt) return;
    setApprovalBusy(true);
    try {
      await api.resolvePendingApproval(approvalPrompt.id, approved);
      setApprovalPrompt(undefined);
    } catch (error) {
      toast.push(String(error), "error");
    } finally {
      setApprovalBusy(false);
    }
  };
  const openCommands = () => { setCommandOpen(true); window.dispatchEvent(new CustomEvent("sandbox:open-command-shell")); };
  const dismissDeepLink = () => setDeepLinks((current) => current.slice(1));
  const confirmDeepLink = async () => {
    if (!deepLink) return;
    setDeepLinkBusy(true);
    try {
      if (deepLink.kind === "template") {
        await useAppStore.getState().createWorkflow(deepLink.template);
        toast.push("Template imported as a disabled local workflow.", "success");
      } else if (deepLink.kind === "marketplace") {
        if (!deepLinkInspection)
          throw new Error("The signed plugin package is still being inspected.");
        const installed = await api.installInspectedPlugin(
          deepLinkInspection.inspectionId,
        );
        setView("plugins");
        toast.push(`Installed ${installed.manifest.name}.`, "success");
      } else return;
      dismissDeepLink();
    } catch (error) {
      setDeepLinkError(String(error));
    } finally {
      setDeepLinkBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <Sidebar onCommand={openCommands} />
      <div className="app-main">
        <div className="app-content-frame">
        <AsyncErrorBoundary onHome={() => setView("workflows")}>
          <Suspense
            fallback={
              <main className="content route-loading" role="status">
                <LoadingSkeleton />
              </main>
            }
          >
            {view === "workflows" && <Dashboard />}
            {view === "history" && <HistoryView />}
            {view === "settings" && <SettingsView />}
            {view === "approvals" && <PendingApprovalsView />}
            {view === "plugins" && <PluginsHub />}
            {view === "cloud" && <CloudView />}
            {view === "editor" && activeWorkflow && <WorkflowEditor />}
          </Suspense>
        </AsyncErrorBoundary>
        </div>
        <CommandShell open={commandOpen} onOpenChange={setCommandOpen} onShortcuts={() => setShortcutsOpen(true)} onLauncher={() => window.dispatchEvent(new CustomEvent("sandbox:open-quick-launcher"))} />
      </div>
      <Suspense fallback={null}><ActiveAiTabs /></Suspense>
      <Suspense fallback={null}><CommandPalette
        open={false}
        onClose={() => setCommandOpen(false)}
        onCreate={() => {
          setView("workflows");
          window.setTimeout(
            () =>
              window.dispatchEvent(new CustomEvent("sandbox:create-workflow")),
            0,
          );
        }}
        actions={[
          {
            id: "keyboard-shortcuts",
            name: "Keyboard shortcuts",
            description: "View available keyboard commands.",
            group: "Help",
            action: () => setShortcutsOpen(true),
          },
          {
            id: "import-workflow",
            name: "Import workflow",
            description: "Choose a sndbox workflow file from this device.",
            group: "Actions",
            action: () =>
              void api
                .importWorkflow()
                .then(async (workflow) => {
                  if (!workflow) return;
                  await useAppStore.getState().load();
                  await useAppStore.getState().openWorkflow(workflow.id);
                  toast.push(`Imported ${workflow.name}.`, "success");
                })
                .catch((error) => toast.push(String(error), "error")),
          },
          {
            id: "workflows",
            name: "Go to Workflows",
            description: "Browse and organise local workflows.",
            action: () => setView("workflows"),
          },
          {
            id: "history",
            name: "Go to Run history",
            description: "Search execution diagnostics.",
            action: () => setView("history"),
          },
          {
            id: "plugins",
            name: "Go to Plugins",
            description: "Discover and manage plugins.",
            action: () => setView("plugins"),
          },
          {
            id: "cloud",
            name: "Go to Cloud workspace",
            description: "Manage account workspaces and encrypted sync.",
            action: () => setView("cloud"),
          },
          {
            id: "settings",
            name: "Go to Settings",
            description: "Change appearance and editor preferences.",
            action: () => setView("settings"),
          },
          {
            id: "approvals",
            name: "Go to Pending approvals",
            description: "Review paused workflow actions.",
            action: () => setView("approvals"),
          },
          ...[
            ["general", "General settings", "Start view, dates, and unsaved-change behavior."],
            ["appearance", "Appearance settings", "Theme, accent, density, and sidebar layout."],
            ["accessibility", "Accessibility settings", "Motion, contrast, and keyboard-friendly editing."],
            ["nodes", "Node editor settings", "Canvas, grid, AI hints, and deletion preferences."],
            ["connections", "Connection settings", "Credentials, OAuth connections, and the local vault."],
            ["browser", "Browser settings", "Profiles, viewport, proxy, and browser runtime."],
            ["beta", "Updates and beta settings", "Update channel and preview features."],
          ].map(([section, name, description]) => ({
            id: `settings-${section}`,
            name,
            description,
            group: "Settings",
            action: () => {
              sessionStorage.setItem("sandbox:settings-section", section);
              setView("settings");
              window.setTimeout(() => window.dispatchEvent(new CustomEvent("sandbox:settings-section", { detail: section })), 0);
            },
          })),
          ...WORKFLOW_TEMPLATES.map((template) => ({
            id: `template-${template.key}`,
            name: template.name,
            description: template.description,
            group: "Templates",
            action: () => void useAppStore.getState().createWorkflow(template.key, template.name),
          })),
          ...workflows.map((item) => ({
              id: `workflow-${item.workflow.id}`,
              name: item.workflow.name,
              description: `${item.metadata.folder ? `${item.metadata.folder} · ` : ""}${item.workflow.description || `${item.workflow.nodes.length} nodes`}`,
              group: item.metadata.archivedAt ? "Archived workflows" : "Workflows",
              action: () =>
                void useAppStore.getState().openWorkflow(item.workflow.id),
            })),
        ]}
      /></Suspense>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} editor={view === "editor"} />
      {approvalPrompt && (
        <Suspense fallback={null}>
          <ApprovalRequest
            item={approvalPrompt}
            modal
            busy={approvalBusy}
            onDismiss={() => {
              setApprovalPrompt(undefined);
              setView("approvals");
            }}
            onResolve={(approved) => void resolvePrompt(approved)}
          />
        </Suspense>
      )}
      <ConfirmDialog
        open={Boolean(deepLink && deepLink.kind !== "view")}
        onOpenChange={(open) => !open && dismissDeepLink()}
        title={deepLink?.kind === "marketplace" ? "Install marketplace plugin?" : "Import workflow template?"}
        description={deepLink?.kind === "marketplace"
          ? "sndbox verified the link format and will install only the exact signed package shown below."
          : "The template contains no credentials and will remain disabled until you review its nodes and permissions."}
        confirmLabel={deepLink?.kind === "marketplace" ? "Install plugin" : "Import template"}
        busy={deepLinkBusy || (deepLink?.kind === "marketplace" && !deepLinkInspection && !deepLinkError)}
        onConfirm={() => void confirmDeepLink()}
      >
        {deepLink?.kind === "marketplace" && deepLinkInspection && (
          <div className="deep-link-review">
            <b>{String(deepLinkInspection.manifest.name)} · v{String(deepLinkInspection.manifest.version)}</b>
            <small>Publisher: {String(deepLinkInspection.manifest.publisherId)}</small>
            <small>{deepLinkInspection.requestedPermissions.length
              ? `Requests: ${deepLinkInspection.requestedPermissions.join(", ")}`
              : "Requests no additional host permissions."}</small>
          </div>
        )}
        {deepLink?.kind === "template" && <div className="deep-link-review"><b>{deepLink.template.replaceAll("-", " ")}</b><small>Local workflow · disabled by default</small></div>}
        {deepLinkError && <div className="error-banner">{deepLinkError}</div>}
      </ConfirmDialog>
    </div>
  );
}
