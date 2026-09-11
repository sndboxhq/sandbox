import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Sidebar } from "./components/Sidebar";
import { api } from "./api";
import type {
  PendingApproval,
  PluginPackageInspection,
  CollaborationSessionHandle,
  WorkflowImportInspection,
} from "./types";
import { useAppStore } from "./store";
import { useApplyPreferences, usePreferences } from "./preferences";
import { AsyncErrorBoundary } from "./components/ui/AsyncErrorBoundary";
import { LoadingSkeleton } from "./components/ui/States";
import { useToast } from "./components/ui/Toast";
import { ConfirmDialog } from "./components/ui/Dialog";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { isTextEntryTarget, useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { readWorkspaceSnapshot, updateWorkspaceSnapshot } from "./workspaceState";
import { parseDeepLink, type DeepLinkRequest } from "./deepLinks";
import "./plugins.css";
import { collaborationDeviceColor, collaborationDeviceIdentity, rememberCollaborationSession } from "./collaborationSession";

const Dashboard = lazy(() =>
  import("./components/Dashboard").then((module) => ({
    default: module.Dashboard,
  })),
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
const CommandShell = lazy(() =>
  import("./components/CommandShell").then((module) => ({ default: module.CommandShell })),
);
const JoinCollaborationDialog = lazy(() =>
  import("./components/JoinCollaborationDialog").then((module) => ({ default: module.JoinCollaborationDialog })),
);
const QuickLauncher = lazy(() =>
  import("./components/QuickLauncher").then((module) => ({ default: module.QuickLauncher })),
);

export default function App() {
  return new URLSearchParams(window.location.search).get("window") ===
    "quick-launcher" ? (
    <Suspense fallback={null}><QuickLauncher /></Suspense>
  ) : (
    <MainApp />
  );
}

function MainApp() {
  const toast = useToast();
  useApplyPreferences();
  const { view, activeWorkflow, setView } = useAppStore();
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
  const [workflowImport, setWorkflowImport] =
    useState<WorkflowImportInspection>();
  const [workflowImportBusy, setWorkflowImportBusy] = useState(false);
  const [workflowImportError, setWorkflowImportError] = useState<string>();
  const [joinCollaborationOpen,setJoinCollaborationOpen]=useState(false);
  const [joinCollaborationCode,setJoinCollaborationCode]=useState("");
  const [joinCollaborationBusy,setJoinCollaborationBusy]=useState(false);
  const [joinCollaborationError,setJoinCollaborationError]=useState<string>();
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
    const receiveInspection = (event: Event) => {
      setWorkflowImport(
        (event as CustomEvent<WorkflowImportInspection>).detail,
      );
      setWorkflowImportError(undefined);
    };
    const openLauncher = () => {
      void api.openQuickLauncher().catch((error) =>
        toast.push(String(error), "error"),
      );
    };
    window.addEventListener(
      "sandbox:workflow-import-inspected",
      receiveInspection,
    );
    window.addEventListener("sandbox:open-quick-launcher", openLauncher);
    return () => {
      window.removeEventListener(
        "sandbox:workflow-import-inspected",
        receiveInspection,
      );
      window.removeEventListener("sandbox:open-quick-launcher", openLauncher);
    };
  }, [toast]);
  useEffect(()=>{
    const open=(event:Event)=>{
      const code=(event as CustomEvent<{inviteCode?:string}>).detail?.inviteCode??"";
      setJoinCollaborationCode(code);setJoinCollaborationError(undefined);setJoinCollaborationOpen(true);
    };
    window.addEventListener("sandbox:join-collaboration",open);
    return()=>window.removeEventListener("sandbox:join-collaboration",open);
  },[]);
  useEffect(() => {
    if (!api.isDesktop) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    const inspectPaths = async (paths: string[]) => {
      if (paths.length !== 1) {
        if (paths.length > 1)
          toast.push("Drop or open one workflow file at a time.", "error");
        return;
      }
      try {
        const inspection = await api.inspectWorkflowPath(paths[0]);
        if (!cancelled) {
          setWorkflowImport(inspection);
          setWorkflowImportError(undefined);
        }
      } catch (error) {
        if (!cancelled) toast.push(String(error), "error");
      }
    };
    void api.takeWorkflowFileRequests().then(inspectPaths);
    void listen<string[]>("workflow-file-requested", (event) =>
      void inspectPaths(event.payload),
    ).then((unlisten) => cleanups.push(unlisten));
    void listen<string>("quick-launcher-workflow", (event) =>
      void useAppStore.getState().openWorkflow(event.payload),
    ).then((unlisten) => cleanups.push(unlisten));
    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") void inspectPaths(event.payload.paths);
      })
      .then((unlisten) => cleanups.push(unlisten));
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [toast]);
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
  const dismissWorkflowImport = () => {
    if (workflowImport)
      void api.cancelWorkflowImport(workflowImport.inspectionId);
    setWorkflowImport(undefined);
    setWorkflowImportError(undefined);
  };
  const confirmWorkflowImport = async () => {
    if (!workflowImport) return;
    setWorkflowImportBusy(true);
    setWorkflowImportError(undefined);
    try {
      const workflow = await api.confirmWorkflowImport(
        workflowImport.inspectionId,
      );
      setWorkflowImport(undefined);
      await useAppStore.getState().load();
      await useAppStore.getState().openWorkflow(workflow.id);
      toast.push(`Imported ${workflow.name} disabled for review.`, "success");
    } catch (error) {
      setWorkflowImportError(String(error));
    } finally {
      setWorkflowImportBusy(false);
    }
  };
  const joinSharedCanvas=async()=>{
    const inviteCode=joinCollaborationCode.trim();if(!inviteCode)return;
    setJoinCollaborationBusy(true);setJoinCollaborationError(undefined);
    const deviceId=collaborationDeviceIdentity(),color=collaborationDeviceColor(deviceId);
    let handle:CollaborationSessionHandle|undefined;
    try{
      handle=await api.joinWorkflowCollaboration(inviteCode,deviceId,color);
      const existing=await api.getWorkflow(handle.session.workflowId);
      const {bootstrapCollaborativeWorkflow}=await import("./collaborationBootstrap");
      const bootstrapped=await bootstrapCollaborativeWorkflow(handle,existing,after=>api.pollWorkflowCollaborationOperations(handle!,after));
      const saved=await api.saveCollaborationBootstrap(bootstrapped.workflow);
      rememberCollaborationSession({handle,appliedSequence:bootstrapped.appliedSequence,clientSequence:0});
      localStorage.setItem("sandbox.cloud.workspace",handle.session.workspaceId);
      setJoinCollaborationOpen(false);setJoinCollaborationCode("");
      await useAppStore.getState().load();
      await useAppStore.getState().openWorkflow(saved.id);
      toast.push(`Joined ${saved.name}. It is disabled until you review local permissions.`,"success");
    }catch(error){
      if(handle)void api.leaveWorkflowCollaboration(handle,deviceId).catch(()=>undefined);
      setJoinCollaborationError(String(error));
    }finally{setJoinCollaborationBusy(false)}
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
        <Suspense fallback={null}><CommandShell open={commandOpen} onOpenChange={setCommandOpen} onShortcuts={() => setShortcutsOpen(true)} onLauncher={() => window.dispatchEvent(new CustomEvent("sandbox:open-quick-launcher"))} /></Suspense>
      </div>
      <Suspense fallback={null}><ActiveAiTabs /></Suspense>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} editor={view === "editor"} />
      <Suspense fallback={null}><JoinCollaborationDialog open={joinCollaborationOpen} onOpenChange={open=>{setJoinCollaborationOpen(open);if(!open){setJoinCollaborationCode("");setJoinCollaborationError(undefined)}}} inviteCode={joinCollaborationCode} onInviteCodeChange={setJoinCollaborationCode} busy={joinCollaborationBusy} error={joinCollaborationError} onJoin={()=>void joinSharedCanvas()}/></Suspense>
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
      <ConfirmDialog
        open={Boolean(workflowImport)}
        onOpenChange={(open) => !open && dismissWorkflowImport()}
        title="Import this workflow?"
        description="The file has been inspected but has not been added. Importing creates fresh IDs, disables the workflow, and clears every inherited approval. It will never run automatically."
        confirmLabel="Import disabled workflow"
        busy={workflowImportBusy}
        onConfirm={() => void confirmWorkflowImport()}
      >
        {workflowImport && (
          <div className="deep-link-review workflow-import-review">
            <b>{workflowImport.name}</b>
            {workflowImport.description && <small>{workflowImport.description}</small>}
            <small>
              Schema {workflowImport.sourceSchemaVersion} · {workflowImport.nodeCount} nodes
            </small>
            <small>
              Uses: {workflowImport.requiredNodeTypes.join(", ") || "No executable nodes"}
            </small>
            {workflowImport.warnings.map((warning) => (
              <small key={warning} className="warning-banner">{warning}</small>
            ))}
          </div>
        )}
        {workflowImportError && <div className="error-banner">{workflowImportError}</div>}
      </ConfirmDialog>
    </div>
  );
}
