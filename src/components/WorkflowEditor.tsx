import { listen } from "@tauri-apps/api/event";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Background,
  BackgroundVariant,
  Controls,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Accessibility,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Command,
  History,
  Play,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Wrench,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "../api";
import { isCanvasDoubleClickTarget } from "../canvasInteractions";
import {
  createNode,
  createPluginNode,
  definitionFor,
  enabledPluginNodes,
  isTrigger,
  type PluginNodeChoice,
} from "../catalogue";
import { usePreferences } from "../preferences";
import { useAppStore } from "../store";
import { issueFingerprint, issuePriority } from "../issues";
import { useIssueTracking } from "../issueTracking";
import {
  connectWorkflowNodes,
  connectedNodeRoles,
  isValidWorkflowConnection,
  WEB_BUILDER_INPUT_PORTS,
} from "../workflowConnections";
import type {
  BrowserProfile,
  ExecutionRecord,
  InstalledPlugin,
  NodeStatus,
  NodeType,
  PermissionSummary,
  RecordedStep,
  ValidationIssue,
  Workflow,
  WorkflowNode,
  WorkflowRevisionSummary,
} from "../types";
import { BrowserRecorder } from "./BrowserRecorder";
import {
  AiWorkflowChat,
  type AiWorkflowChatContext,
} from "./AiWorkflowChat";
import { CommandPalette } from "./CommandPalette";
import {
  ExecutionInspector,
  type PermissionReviewRequest,
} from "./ExecutionInspector";
import { NodeInspector } from "./NodeInspector";
import { WorkflowNodeCard, type WorkflowNodeData } from "./WorkflowNodeCard";
import { ConfirmDialog, Dialog, FocusDialog } from "./ui/Dialog";
import { IssueNotice, IssueSummary } from "./ui/IssueNotice";
import { useToast } from "./ui/Toast";
import { Tooltip } from "./ui/Tooltip";
import { clearWorkflowDraft, draftUsesEarlierBase, readWorkflowDraft, writeWorkflowDraft, type WorkflowDraft } from "../workflowDrafts";
import { readWorkspaceSnapshot, updateWorkspaceSnapshot } from "../workspaceState";
import { isTextEntryTarget, useKeyboardShortcuts } from "../useKeyboardShortcuts";

const nodeTypes = { workflow: WorkflowNodeCard };
const AccessibleWorkflowEditor = lazy(() =>
  import("./AccessibleWorkflowEditor").then((module) => ({ default: module.AccessibleWorkflowEditor })),
);
const workflowNodeDimensions = { width: 194, height: 112 } as const;

function workflowNodeHandles(node: WorkflowNode): Node<WorkflowNodeData>["handles"] {
  const handles: NonNullable<Node<WorkflowNodeData>["handles"]> = [];
  const handleSize = 9;
  const centeredHandleOffset = (workflowNodeDimensions.height - handleSize) / 2;

  const configuredInputPorts = node.type === "web_builder"
    ? WEB_BUILDER_INPUT_PORTS.map(port=>({id:port.id}))
    : node.type === "merge"
      ? ((node.configuration.inputPorts as Array<{id:string}>|undefined)??[])
      : [];
  if (configuredInputPorts.length) {
    configuredInputPorts.forEach((port, index) => {
      handles.push({
        id: port.id,
        type: "target",
        position: Position.Left,
        x: -handleSize / 2,
        y: workflowNodeDimensions.height * (0.31 + index * 0.19) - handleSize / 2,
        width: handleSize,
        height: handleSize,
      });
    });
  } else if (!isTrigger(node.type)) {
    handles.push({
      id: "input",
      type: "target",
      position: Position.Left,
      x: -handleSize / 2,
      y: centeredHandleOffset,
      width: handleSize,
      height: handleSize,
    });
  }

  const dynamicOutputs = workflowOutputHandles(node);
  if (dynamicOutputs.length) {
    dynamicOutputs.forEach((id,index)=>handles.push({id,type:"source",position:Position.Right,x:workflowNodeDimensions.width-handleSize/2,y:workflowNodeDimensions.height*(0.31+index*0.19)-handleSize/2,width:handleSize,height:handleSize}));
  } else if (node.type === "condition") {
    handles.push(
      {
        id: "true",
        type: "source",
        position: Position.Right,
        x: workflowNodeDimensions.width - handleSize / 2,
        y: workflowNodeDimensions.height * 0.42 - handleSize / 2,
        width: handleSize,
        height: handleSize,
      },
      {
        id: "false",
        type: "source",
        position: Position.Right,
        x: workflowNodeDimensions.width - handleSize / 2,
        y: workflowNodeDimensions.height * 0.76 - handleSize / 2,
        width: handleSize,
        height: handleSize,
      },
    );
  } else {
    handles.push({
      id: "output",
      type: "source",
      position: Position.Right,
      x: workflowNodeDimensions.width - handleSize / 2,
      y: centeredHandleOffset,
      width: handleSize,
      height: handleSize,
    });
  }

  return handles;
}

function workflowOutputHandles(node:WorkflowNode):string[]{
  if(node.type==="switch")return [...(((node.configuration.cases as Array<{id:string}>|undefined)??[]).map(item=>item.id)),String(node.configuration.fallbackBranchId??"fallback")];
  if(node.type==="filter"||node.type==="split_out")return ["output","rejected"];
  if(node.type==="loop_over_items")return ["loop","done"];
  if(node.type==="remove_duplicates")return ["output","duplicates"];
  return [];
}

export function WorkflowEditor() {
  const toast = useToast();
  const { activeWorkflow, setView, saveWorkflow } = useAppStore();
  const [workflow, setWorkflow] = useState(() =>
    structuredClone(activeWorkflow!),
  );
  const [initialViewport] = useState(() => {
    try {
      return (
        JSON.parse(
          localStorage.getItem(
            `sandbox.workflow-viewport.v1.${activeWorkflow!.id}`,
          ) ?? "null",
        ) ?? { x: 80, y: 80, zoom: 0.9 }
      );
    } catch {
      return { x: 80, y: 80, zoom: 0.9 };
    }
  });
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(activeWorkflow),
  );
  const rememberedEditor = useMemo(() => readWorkspaceSnapshot()?.editors[activeWorkflow!.id], [activeWorkflow]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(() => rememberedEditor?.selectedNodeId);
  const [auxiliaryTab, setAuxiliaryTab] = useState<"accessible" | "inspector">(
    "inspector",
  );
  const [picker, setPicker] = useState<{
    open: boolean;
    sourceId?: string;
    position: { x: number; y: number };
  }>({ open: false, position: { x: 360, y: 220 } });
  const [instance, setInstance] =
    useState<ReactFlowInstance<Node<WorkflowNodeData>, Edge>>();
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const issueTracking = useIssueTracking(workflow.id, issues);
  const [runningNode, setRunningNode] = useState<string>();
  const [run, setRun] = useState<ExecutionRecord>();
  const [testDataExecutions,setTestDataExecutions]=useState<ExecutionRecord[]>([]);
  const [testDataExecutionId,setTestDataExecutionId]=useState("");
  const [bottomOpen, setBottomOpen] = useState(() => rememberedEditor?.executionDrawerOpen ?? false);
  const [saveState, setSaveState] = useState<
    "saved" | "unsaved" | "saving" | "failed"
  >("saved");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionRequest, setPermissionRequest] =
    useState<PermissionReviewRequest>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisions, setRevisions] = useState<WorkflowRevisionSummary[]>([]);
  const [pendingRevisionId, setPendingRevisionId] = useState<string>();
  const [pendingSideEffectTest, setPendingSideEffectTest] = useState(false);
  const [testingNode, setTestingNode] = useState(false);
  const [accessibleEditorOpen, setAccessibleEditorOpen] = useState(() => rememberedEditor?.accessibleEditorOpen ?? false);
  const [draftPrompt, setDraftPrompt] = useState<WorkflowDraft>();
  const draftWarningShown = useRef(false);
  const wasDirty = useRef(false);
  const actionSerial = useRef(0);
  const undoRef = useRef<() => void>(() => undefined);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiChatContext, setAiChatContext] =
    useState<AiWorkflowChatContext>();
  const [announcement, setAnnouncement] = useState("");
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfile[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>(
    [],
  );
  const past = useRef<Workflow[]>([]);
  const future = useRef<Workflow[]>([]);
  const validationRequest = useRef(0);
  const dirty = useMemo(
    () => JSON.stringify(workflow) !== baseline,
    [workflow, baseline],
  );
  const selectedNode = workflow.nodes.find((n) => n.id === selectedNodeId);
  const connectionRoles = useMemo(
    () => connectedNodeRoles(workflow.edges, selectedNodeId),
    [selectedNodeId, workflow.edges],
  );
  const openPermissionReview = (request?: PermissionReviewRequest) => {
    setPermissionRequest(request);
    setPermissionOpen(true);
  };
  const closePermissionReview = () => {
    setPermissionOpen(false);
    setPermissionRequest(undefined);
  };
  useEffect(() => {
    if (selectedNodeId) setAuxiliaryTab("inspector");
  }, [selectedNodeId]);
  useEffect(()=>{void api.listExecutions(workflow.id,25).then(items=>setTestDataExecutions(items)).catch(()=>setTestDataExecutions([]));},[workflow.id,run?.id]);
  const {
    accessibleEditorDefault,
    confirmBeforeLeaving,
    snapToGrid,
    gridSize,
    showCanvasHints,
    showAskAiOnNodeInteraction,
    showAskAiOnNodeIssues,
    confirmNodeDeletion,
    editorInspectorWidth,
    update: updatePreferences,
  } = usePreferences();
  const snapGrid = useMemo<[number, number]>(
    () => [gridSize, gridSize],
    [gridSize],
  );
  const resizeInspector = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = editorInspectorWidth;
    const move = (next: PointerEvent) =>
      updatePreferences({
        editorInspectorWidth: startWidth - (next.clientX - startX),
      });
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  const commit = useCallback(
    (next: Workflow) => {
      actionSerial.current += 1;
      past.current.push(structuredClone(workflow));
      if (past.current.length > 50) past.current.shift();
      future.current = [];
      setWorkflow(next);
    },
    [workflow],
  );
  const patchWorkflow = useCallback(
    (patch: Partial<Workflow>) => commit({ ...workflow, ...patch }),
    [workflow, commit],
  );
  const goBack = () =>
    dirty && confirmBeforeLeaving ? setLeaveOpen(true) : setView("workflows");
  useEffect(() => {
    updateWorkspaceSnapshot(current => ({ ...current, workflowId: workflow.id, editors: { ...current.editors, [workflow.id]: { selectedNodeId, executionDrawerOpen: bottomOpen, accessibleEditorOpen, visitedAt: Date.now() } } }));
  }, [workflow.id, selectedNodeId, bottomOpen, accessibleEditorOpen]);
  useEffect(() => {
    const draft = readWorkflowDraft(workflow.id);
    if (draft) setDraftPrompt(draft);
  }, [workflow.id]);
  useEffect(() => {
    if (!dirty) { if (wasDirty.current) clearWorkflowDraft(workflow.id); wasDirty.current = false; return; }
    wasDirty.current = true;
    const timer = window.setTimeout(() => {
      const result = writeWorkflowDraft(workflow, activeWorkflow!.updatedAt);
      if (result !== "saved" && !draftWarningShown.current) {
        draftWarningShown.current = true;
        toast.push(result === "too-large" ? "Recovery draft is too large to store locally." : "Recovery draft could not be saved on this device.", "info");
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, workflow, activeWorkflow, toast]);
  useEffect(() => {
    if (accessibleEditorDefault) setAccessibleEditorOpen(true);
  }, [accessibleEditorDefault]);
  useEffect(() => {
    try {
      const key = "sandbox.editor.focus-node.v1";
      const target = JSON.parse(localStorage.getItem(key) ?? "null") as {
        workflowId?: string;
        nodeId?: string;
      } | null;
      if (target?.workflowId === workflow.id && target.nodeId) {
        setSelectedNodeId(target.nodeId);
        localStorage.removeItem(key);
      }
    } catch {
      /* ignore invalid local UI state */
    }
  }, [workflow.id]);
  useEffect(() => {
    try {
      const key = "sandbox.editor.permission-request.v1";
      const request = JSON.parse(localStorage.getItem(key) ?? "null") as
        | (PermissionReviewRequest & { workflowId?: string })
        | null;
      if (request?.workflowId === workflow.id && request.message) {
        setPermissionRequest({
          nodeId: request.nodeId,
          message: request.message,
        });
        setPermissionOpen(true);
        localStorage.removeItem(key);
      }
    } catch {
      /* ignore invalid local UI state */
    }
  }, [workflow.id]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    (window as Window & { __sandboxUnsaved?: boolean }).__sandboxUnsaved =
      dirty;
    return () => {
      (window as Window & { __sandboxUnsaved?: boolean }).__sandboxUnsaved =
        false;
    };
  }, [dirty]);
  useEffect(() => {
    const openPicker = () =>
      setPicker({ open: true, position: { x: 360, y: 220 } });
    window.addEventListener("sandbox:open-node-picker", openPicker);
    return () =>
      window.removeEventListener("sandbox:open-node-picker", openPicker);
  }, []);
  useEffect(() => {
    if (accessibleEditorOpen)
      requestAnimationFrame(() =>
        document.getElementById("accessible-workflow-editor")?.focus(),
      );
  }, [accessibleEditorOpen]);
  useEffect(() => {
    void api.listBrowserProfiles().then(setBrowserProfiles);
  }, []);
  useEffect(() => {
    const owner = workflow.owner ?? {
      ownerType: "personal" as const,
      ownerId: "local",
    };
    void api
      .listInstalledPlugins(owner.ownerType, owner.ownerId)
      .then(setInstalledPlugins);
  }, [workflow.owner?.ownerType, workflow.owner?.ownerId]);
  useEffect(() => {
    if (!api.isDesktop) return;
    let stop: undefined | (() => void);
    listen<{ type: string; node_id?: string; record?: ExecutionRecord }>(
      "runner-event",
      (event) => {
        if (event.payload.type === "node_started")
          setRunningNode(event.payload.node_id);
        if (
          event.payload.type === "execution_updated" &&
          event.payload.record?.workflowId === workflow.id
        ) {
          setRun(event.payload.record);
          setBottomOpen(true);
          if (event.payload.record.status !== "running")
            setRunningNode(undefined);
        }
      },
    ).then((fn) => (stop = fn));
    return () => stop?.();
  }, [workflow.id]);
  const doSave = useCallback(async (): Promise<boolean> => {
    setSaveState("saving");
    try {
      const saved = await saveWorkflow(workflow);
      setWorkflow(saved);
      setBaseline(JSON.stringify(saved));
      setSaveState("saved");
      clearWorkflowDraft(saved.id);
      toast.push("Workflow saved.", "success");
      return true;
    } catch (error) {
      setSaveState("failed");
      setIssues((current) => [
        {
          code: "save_failed",
          message: String(error),
          severity: "error",
          suggestion: "Retry saving before you run the workflow.",
        },
        ...current.filter((issue) => issue.code !== "save_failed"),
      ]);
      setBottomOpen(true);
      toast.push(
        "Save failed. Your changes are still available to retry.",
        "error",
      );
      return false;
    }
  }, [workflow, saveWorkflow, toast]);
  const test = useCallback(async () => {
    const result = await api.validateWorkflow(workflow);
    setIssues(result);
    if (result.length) setBottomOpen(true);
    return result;
  }, [workflow]);
  const loadRevisions = useCallback(async () => {
    const history = await api.listWorkflowRevisions(workflow.id);
    setRevisions(history);
    return history;
  }, [workflow.id]);
  const openRevisionHistory = useCallback(async () => {
    if (dirty && !(await doSave())) return;
    try {
      await loadRevisions();
      setRevisionOpen(true);
    } catch (error) {
      toast.push(`Revision history could not be loaded: ${String(error)}`, "error");
    }
  }, [dirty, doSave, loadRevisions, toast]);
  const testSelectedNode = useCallback(async (allowSideEffects = false) => {
    if (!selectedNode || testingNode) return;
    if (definitionFor(selectedNode.type).sideEffect && !allowSideEffects) {
      setPendingSideEffectTest(true);
      return;
    }
    setTestingNode(true);
    setBottomOpen(true);
    try {
      const execution = await api.testWorkflowNode(
        workflow,
        selectedNode.id,
        {},
        testDataExecutionId || undefined,
        allowSideEffects,
      );
      setRun(execution);
      setIssues([]);
      toast.push(`${selectedNode.name} test completed.`, "success");
    } catch (error) {
      setIssues([{code:"node_test_failed",message:String(error),severity:"error",nodeId:selectedNode.id}]);
    } finally {
      setTestingNode(false);
      setPendingSideEffectTest(false);
    }
  }, [testDataExecutionId, selectedNode, testingNode, toast, workflow]);
  useEffect(() => {
    const request = ++validationRequest.current;
    const timer = window.setTimeout(() => {
      void api
        .validateWorkflow(workflow)
        .then((result) => {
          if (request === validationRequest.current)
            setIssues((current) => [
              ...current.filter((issue) => issue.code === "save_failed"),
              ...result,
            ]);
        })
        .catch((error) => {
          if (request === validationRequest.current)
            setIssues([
              {
                code: "validation_unavailable",
                message: String(error),
                severity: "warning",
                suggestion: "Try Validate again.",
              },
            ]);
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [workflow]);
  const doRun = useCallback(async () => {
    if (!(await doSave())) return;
    const result = await test();
    if (result.some((issue) => issue.severity === "error")) return;
    setRunning(true);
    setBottomOpen(true);
    try {
      const execution = await api.runWorkflow(workflow.id);
      setRun(execution);
    } catch (error) {
      setIssues([
        { code: "runner_error", message: String(error), severity: "error" },
      ]);
    } finally {
      setRunning(false);
      setRunningNode(undefined);
    }
  }, [doSave, test, workflow.id]);
  const retryNode = useCallback(
    async (nodeId: string) => {
      if (!run) return;
      setRunning(true);
      try {
        setRun(await api.retryFailedNode(run.id, nodeId));
        setIssues([]);
      } catch (error) {
        setIssues([
          { code: "runner_error", message: String(error), severity: "error" },
        ]);
      } finally {
        setRunning(false);
      }
    },
    [run],
  );
  const retryHeaded = useCallback(async () => {
    if (!run) return;
    setRunning(true);
    try {
      setRun(await api.retryBrowserExecutionHeaded(run.id));
      setIssues([]);
    } catch (error) {
      setIssues([
        { code: "runner_error", message: String(error), severity: "error" },
      ]);
    } finally {
      setRunning(false);
    }
  }, [run]);
  const removeNode = useCallback(
    (id: string, confirmed = false) => {
      const node = workflow.nodes.find((n) => n.id === id);
      if (!node) return;
      const configured =
        Object.keys(node.configuration).length > 0 &&
        Object.values(node.configuration).some((v) => v !== "" && v != null);
      if (confirmNodeDeletion && configured && !confirmed) {
        setPendingDeleteNodeId(id);
        return;
      }
      const nodes = workflow.nodes
        .filter((candidate) => candidate.id !== id)
        .map((candidate) => {
          const inputBindings = Object.fromEntries(
            Object.entries(candidate.inputBindings ?? {}).filter(
              ([, binding]) =>
                binding.kind !== "node_output" || binding.nodeId !== id,
            ),
          );
          return { ...candidate, inputBindings };
        });
      const deletionAction = actionSerial.current + 1;
      commit({
        ...workflow,
        nodes,
        edges: workflow.edges.filter(
          (e) => e.sourceNodeId !== id && e.targetNodeId !== id,
        ),
      });
      setSelectedNodeId(undefined);
      toast.push("Node deleted.", "info", { label: "Undo", onAction: () => {
        if (actionSerial.current !== deletionAction) return;
        undoRef.current();
      } });
    },
    [workflow, commit, confirmNodeDeletion, toast],
  );
  const duplicate = useCallback(
    (id: string) => {
      const original = workflow.nodes.find((n) => n.id === id);
      if (!original || isTrigger(original.type)) return;
      const copy = {
        ...structuredClone(original),
        id: `${original.type}_${crypto.randomUUID().slice(0, 8)}`,
        name: `${original.name} copy`,
        position: { x: original.position.x + 32, y: original.position.y + 96 },
      };
      commit({ ...workflow, nodes: [...workflow.nodes, copy] });
      setSelectedNodeId(copy.id);
    },
    [workflow, commit],
  );
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous) {
      actionSerial.current += 1;
      future.current.push(structuredClone(workflow));
      setWorkflow(previous);
    }
  }, [workflow]);
  undoRef.current = undo;
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next) {
      actionSerial.current += 1;
      past.current.push(structuredClone(workflow));
      setWorkflow(next);
    }
  }, [workflow]);
  useKeyboardShortcuts((e) => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[role=dialog],[role=alertdialog]")) return;
      if (isTextEntryTarget(target)) {
        if (e.key === "Escape") (target as HTMLElement).blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        doSave();
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        doRun();
      } else if (mod && e.key.toLowerCase() === "d" && selectedNodeId) {
        e.preventDefault();
        duplicate(selectedNodeId);
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void test();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedNodeId
      ) {
        e.preventDefault();
        removeNode(selectedNodeId);
      } else if (e.key === "Escape") {
        setSelectedNodeId(undefined);
        setPicker((p) => ({ ...p, open: false }));
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPicker({ open: true, position: { x: 360, y: 220 } });
      } else if (e.key.toLowerCase() === "a" && !mod) {
        setPicker({ open: true, position: { x: 360, y: 220 } });
      }
    };
    handler(e);
  }, [doSave, doRun, duplicate, redo, removeNode, selectedNodeId, undo, test]);
  const addNode = (type: NodeType) => {
    if (isTrigger(type) && workflow.nodes.some((n) => isTrigger(n.type))) {
      setIssues([
        {
          code: "trigger_count",
          message:
            "A workflow can contain only one trigger. Replace the existing trigger instead.",
          severity: "error",
        },
      ]);
      setBottomOpen(true);
      return;
    }
    const node = createNode(type, picker.position);
    let edges = workflow.edges;
    if (picker.sourceId)
      edges = [
        ...edges,
        {
          id: `edge_${crypto.randomUUID().slice(0, 8)}`,
          sourceNodeId: picker.sourceId,
          sourceHandle:
            workflow.nodes.find((n) => n.id === picker.sourceId)?.type ===
            "condition"
              ? "true"
              : "output",
          targetNodeId: node.id,
          targetHandle: "input",
        },
      ];
    commit({ ...workflow, nodes: [...workflow.nodes, node], edges });
    setSelectedNodeId(node.id);
  };
  const addPluginNode = (choice: PluginNodeChoice) => {
    const node = createPluginNode(choice, picker.position);
    let edges = workflow.edges;
    if (picker.sourceId)
      edges = [
        ...edges,
        {
          id: `edge_${crypto.randomUUID().slice(0, 8)}`,
          sourceNodeId: picker.sourceId,
          sourceHandle:
            workflow.nodes.find((n) => n.id === picker.sourceId)?.type ===
            "condition"
              ? "true"
              : "output",
          targetNodeId: node.id,
          targetHandle: "input",
        },
      ];
    commit({ ...workflow, nodes: [...workflow.nodes, node], edges });
    setSelectedNodeId(node.id);
  };
  const applyRecording = (profileId: string, steps: RecordedStep[]) => {
    const outgoing = new Set(workflow.edges.map((edge) => edge.sourceNodeId));
    const source =
      [...workflow.nodes]
        .filter((node) => !outgoing.has(node.id))
        .sort((a, b) => b.position.x - a.position.x)[0] ??
      workflow.nodes.find((node) => node.id === workflow.triggerNodeId);
    let x = (source?.position.x ?? 60) + 280;
    const y = source?.position.y ?? 160;
    const openNode = {
      ...createNode("open_browser", { x, y }),
      configuration: {
        ...createNode("open_browser", { x, y }).configuration,
        profileId,
        headed: true,
      },
    };
    const supported = new Set<NodeType>([
      "navigate",
      "click_element",
      "fill_field",
      "select_option",
      "press_key",
      "download_file",
      "upload_file",
    ]);
    const recorded = steps
      .filter((step) => supported.has(step.action as NodeType))
      .map((step, index) => ({
        ...createNode(step.action as NodeType, { x: x + (index + 1) * 280, y }),
        name: step.name,
        configuration: {
          ...createNode(step.action as NodeType, { x: 0, y: 0 }).configuration,
          ...step.configuration,
        },
      }));
    const added = [openNode, ...recorded];
    const edges = [...workflow.edges];
    if (source)
      edges.push({
        id: `edge_${crypto.randomUUID().slice(0, 8)}`,
        sourceNodeId: source.id,
        sourceHandle: source.type === "condition" ? "true" : "output",
        targetNodeId: openNode.id,
        targetHandle: "input",
      });
    for (let index = 1; index < added.length; index++)
      edges.push({
        id: `edge_${crypto.randomUUID().slice(0, 8)}`,
        sourceNodeId: added[index - 1].id,
        sourceHandle: "output",
        targetNodeId: added[index].id,
        targetHandle: "input",
      });
    commit({
      ...workflow,
      nodes: [...workflow.nodes, ...added],
      edges,
      settings: {
        ...workflow.settings,
        permissions: {
          ...workflow.settings.permissions,
          browserAutomationPermitted: false,
          approvedBrowserProfileIds:
            workflow.settings.permissions.approvedBrowserProfileIds.filter(
              (id) => id !== profileId,
            ),
        },
      },
    });
    setSelectedNodeId(openNode.id);
  };
  const tidy = () => {
    const levels = new Map<string, number>([[workflow.triggerNodeId, 0]]);
    for (let i = 0; i < workflow.nodes.length; i++)
      for (const edge of workflow.edges) {
        const source = levels.get(edge.sourceNodeId);
        if (source != null)
          levels.set(
            edge.targetNodeId,
            Math.max(levels.get(edge.targetNodeId) ?? 0, source + 1),
          );
      }
    const counts = new Map<number, number>();
    patchWorkflow({
      nodes: workflow.nodes.map((n) => {
        const level = levels.get(n.id) ?? 0;
        const count = counts.get(level) ?? 0;
        counts.set(level, count + 1);
        return {
          ...n,
          position: { x: 60 + level * 280, y: 160 + count * 180 },
        };
      }),
    });
  };
  const nodeIssues = useMemo(() => {
    const result = new Map<string, ValidationIssue>();
    issues.filter((issue) => issue.nodeId).forEach((issue) => {
      const current = result.get(issue.nodeId!);
      if (!current || issuePriority(issue.severity) > issuePriority(current.severity)) {
        result.set(issue.nodeId!, issue);
      }
    });
    return result;
  }, [issues]);
  const nodeExecutions = useMemo(
    () => new Map(run?.nodeExecutions.map((item) => [item.nodeId, item]) ?? []),
    [run?.nodeExecutions],
  );
  const openAiForNode = useCallback((node: WorkflowNode, issue?: string) => {
    const summary = definitionFor(node.type).summary(node.configuration);
    setAiChatContext({
      key: crypto.randomUUID(),
      label: node.name,
      prompt: issue
        ? `Help me fix the "${node.name}" node in this workflow. The current issue is: ${issue}\n\nReview the node configuration and suggest the safest correction before changing the workflow.`
        : `Help me improve the "${node.name}" node in this workflow. It is a ${node.type.replaceAll("_", " ")} step configured as: ${summary}. Explain what you would improve before drafting any changes.`,
    });
    setAiChatOpen(true);
  }, []);
  const flowNodes = useMemo<Node<WorkflowNodeData>[]>(
    () =>
      workflow.nodes.map((node) => {
        const execution = nodeExecutions.get(node.id);
        const status = (runningNode === node.id
          ? "running"
          : (execution?.status ?? "idle")) as NodeStatus;
        const nodeIssue = nodeIssues.get(node.id);
        const warning = nodeIssue?.message;
        const askAiIssue =
          warning ??
          execution?.error?.message ??
          (status === "failed"
            ? "This node failed during the latest run."
            : undefined);
        const connectionRole = connectionRoles.get(node.id);

        return {
          id: node.id,
          type: "workflow",
          position: node.position,
          initialWidth: workflowNodeDimensions.width,
          initialHeight: workflowNodeDimensions.height,
          handles: workflowNodeHandles(node),
          selected: node.id === selectedNodeId,
          ariaLabel: `${node.name}, ${node.type.replaceAll("_", " ")}${connectionRole ? `, ${connectionRole} of selected node` : ""}, position x ${Math.round(node.position.x)}, y ${Math.round(node.position.y)}`,
          data: {
            node,
            status,
            warning,
            warningTone: nodeIssue?.severity,
            itemCount: execution?.collection?.outputItemCount,
            askAiIssue,
            showAskAiOnInteraction: showAskAiOnNodeInteraction,
            showAskAiOnIssues: showAskAiOnNodeIssues,
            onAskAi: openAiForNode,
            connectionRole,
            dimmed: Boolean(selectedNodeId && node.id !== selectedNodeId && !connectionRole),
            onAdd: (sourceId: string) => {
              const source = workflow.nodes.find(
                (item) => item.id === sourceId,
              )!;
              setPicker({
                open: true,
                sourceId,
                position: { x: source.position.x + 280, y: source.position.y },
              });
            },
          },
        };
      }),
    [
      workflow.nodes,
      selectedNodeId,
      runningNode,
      nodeExecutions,
      nodeIssues,
      showAskAiOnNodeInteraction,
      showAskAiOnNodeIssues,
      openAiForNode,
      connectionRoles,
    ],
  );
  const [displayNodes, setDisplayNodes, onDisplayNodesChange] =
    useNodesState<Node<WorkflowNodeData>>(flowNodes);
  useEffect(() => {
    setDisplayNodes((current) =>
      flowNodes.map((node) => {
        const existing = current.find((item) => item.id === node.id);
        return existing ? { ...existing, ...node } : node;
      }),
    );
  }, [flowNodes, setDisplayNodes]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      workflow.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: "smoothstep",
        animated: Boolean(runningNode && edge.sourceNodeId === runningNode),
        className: [
          nodeExecutions.get(edge.sourceNodeId)?.status === "successful" ? "edge-success" : "",
          selectedNodeId && edge.targetNodeId === selectedNodeId ? "edge-input" : "",
          selectedNodeId && edge.sourceNodeId === selectedNodeId ? "edge-output" : "",
          selectedNodeId && edge.targetNodeId !== selectedNodeId && edge.sourceNodeId !== selectedNodeId ? "edge-dimmed" : "",
        ].filter(Boolean).join(" "),
      })),
    [workflow.edges, runningNode, nodeExecutions, selectedNodeId],
  );
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<WorkflowNodeData>>[]) => {
      onDisplayNodesChange(changes);
      const settledPositions = new Map<string, WorkflowNode["position"]>();
      for (const change of changes) {
        if (change.type === "select" && change.selected) {
          setSelectedNodeId(change.id);
        }
        if (
          change.type === "position" &&
          change.position &&
          change.dragging !== true
        ) {
          settledPositions.set(change.id, change.position);
        }
      }
      if (settledPositions.size === 0) return;

      commit({
        ...workflow,
        nodes: workflow.nodes.map((node) => {
          const position = settledPositions.get(node.id);
          return position ? { ...node, position } : node;
        }),
      });
    },
    [onDisplayNodesChange, workflow, commit],
  );
  const onConnect = (connection: Connection) => {
    const next = connectWorkflowNodes(workflow, connection);
    if (next) commit(next);
  };
  return (
    <main
      className="editor"
      style={
        { "--inspector-width": `${editorInspectorWidth}px` } as CSSProperties
      }
    >
      <header className="editor-topbar">
        <Tooltip content="Back to workflows">
          <button
            className="icon-button"
            onClick={goBack}
            aria-label="Back to workflows"
          >
            <ArrowLeft size={16} />
          </button>
        </Tooltip>
        <input
          className="workflow-title-input"
          aria-label="Workflow name"
          value={workflow.name}
          onChange={(e) => setWorkflow({ ...workflow, name: e.target.value })}
        />
        {dirty && <span className="unsaved-dot" title="Unsaved changes" />}
        <label className="enabled-toggle">
          <input
            type="checkbox"
            aria-label="Workflow enabled"
            checked={workflow.enabled}
            onChange={(e) =>
              setWorkflow({ ...workflow, enabled: e.target.checked })
            }
          />
          <span />
          {workflow.enabled ? "Enabled" : "Disabled"}
        </label>
        <div className="topbar-spacer" />
        <Tooltip content={aiChatOpen ? "Close AI builder" : "Open AI builder"}>
          <button
            className={`ai-chat-trigger ${aiChatOpen ? "active" : ""}`}
            aria-label={
              aiChatOpen ? "Close AI workflow builder" : "Open AI workflow builder"
            }
            aria-expanded={aiChatOpen}
            aria-controls="ai-workflow-chat"
            onClick={() => {
              if (!aiChatOpen) setAiChatContext(undefined);
              setAiChatOpen((value) => !value);
            }}
          >
            <Sparkles aria-hidden="true" size={16} />
          </button>
        </Tooltip>
        <span className="browser-recorder-wrap browser-recorder-menu-source" aria-hidden="true">
          <BrowserRecorder
            profiles={browserProfiles}
            onProfileCreated={(profile) =>
              setBrowserProfiles((current) => [...current, profile])
            }
            onApply={applyRecording}
          />
        </span>
        <span
          className={`save-state save-state-${dirty && saveState === "saved" ? "unsaved" : saveState}`}
          role="status"
        >
          {saveState === "saving"
            ? "Saving…"
            : saveState === "failed"
              ? "Save failed"
              : dirty
                ? "Unsaved"
                : "Saved"}
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="button toolbar-overflow editor-menu-trigger"
              aria-label="Workflow actions"
              title="Workflow actions"
            >
              <Wrench size={14} />
              <span>Actions</span>
              <ChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end">
              <DropdownMenu.Label className="menu-label">
                Editor actions
              </DropdownMenu.Label>
              <DropdownMenu.Item
                onSelect={() =>
                  document
                    .querySelector<HTMLElement>(".browser-recorder-wrap>button")
                    ?.click()
                }
              >
                Record browser actions
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() =>
                  setAccessibleEditorOpen((value) => {
                    if (!value) setAuxiliaryTab("accessible");
                    return !value;
                  })
                }
              >
                Accessible editor
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={tidy}>
                Tidy workflow
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => openPermissionReview()}>
                Review permissions
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void openRevisionHistory()}>
                Revision history
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!selectedNode} onSelect={() => void testSelectedNode()}>
                Test selected step
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void test()}>
                Validate workflow <kbd>Ctrl Shift V</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                disabled={!past.current.length}
                onSelect={undo}
              >
                Undo <kbd>Ctrl Z</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!future.current.length}
                onSelect={redo}
              >
                Redo <kbd>Ctrl Shift Z</kbd>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Tooltip content="Save workflow (Ctrl+S)">
          <span className="tooltip-control-wrap">
            <button
              className="button"
              aria-label="Save workflow"
              disabled={!dirty || saveState === "saving"}
              onClick={doSave}
            >
              <Save size={14} />
              {saveState === "saving"
                ? "Saving…"
                : saveState === "failed"
                  ? "Retry save"
                  : "Save"}
            </button>
          </span>
        </Tooltip>
        <button
          className="button primary"
          disabled={running || saveState === "failed"}
          onClick={doRun}
        >
          <Play size={14} fill="currentColor" />
          {running ? "Running…" : "Run"}
        </button>
      </header>
      <AiWorkflowChat
        id="ai-workflow-chat"
        open={aiChatOpen}
        workflow={workflow}
        context={aiChatContext}
        onOpenChange={setAiChatOpen}
        onApply={(next, message) => {
          commit(next);
          setSelectedNodeId(undefined);
          setAnnouncement(message);
          toast.push("AI draft applied. Review and save when it looks right.", "success");
        }}
      />
      <div
        className={`editor-body ${selectedNode ? "with-inspector" : ""} ${accessibleEditorOpen ? "with-accessible-editor" : ""}`}
        data-auxiliary-tab={auxiliaryTab}
      >
        <div
          className="canvas-wrap"
          onDoubleClickCapture={(event) => {
            if (!isCanvasDoubleClickTarget(event.target)) return;
            const position = instance?.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            }) ?? { x: 360, y: 220 };
            setPicker({ open: true, position });
          }}
        >
          <ReactFlow<Node<WorkflowNodeData>, Edge>
            className={selectedNodeId ? "has-node-focus" : undefined}
            nodes={displayNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onInit={setInstance}
            onMoveEnd={(_, viewport) =>
              localStorage.setItem(
                `sandbox.workflow-viewport.v1.${workflow.id}`,
                JSON.stringify(viewport),
              )
            }
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(undefined)}
            onConnect={onConnect}
            isValidConnection={(connection) =>
              isValidWorkflowConnection(workflow, connection)
            }
            snapToGrid={snapToGrid}
            snapGrid={snapGrid}
            minZoom={0.45}
            maxZoom={1.8}
            defaultViewport={initialViewport}
            deleteKeyCode={null}
            multiSelectionKeyCode="Shift"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={gridSize}
              size={1}
              color="var(--border-strong)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
          {showCanvasHints && (
            <div className="canvas-hint">
              <Command size={13} />
              Double-click canvas or press A to add a node
            </div>
          )}
        </div>
        {accessibleEditorOpen && selectedNode && (
          <div
            className="auxiliary-tabs"
            role="tablist"
            aria-label="Editor auxiliary panel"
          >
            <button
              role="tab"
              aria-selected={auxiliaryTab === "accessible"}
              onClick={() => setAuxiliaryTab("accessible")}
            >
              <Accessibility size={13} />
              Accessible graph
            </button>
            <button
              role="tab"
              aria-selected={auxiliaryTab === "inspector"}
              onClick={() => setAuxiliaryTab("inspector")}
            >
              <ShieldCheck size={13} />
              Inspector
            </button>
          </div>
        )}
        {accessibleEditorOpen && (
          <Suspense fallback={<div className="drawer-empty" role="status">Loading accessible editor…</div>}>
            <AccessibleWorkflowEditor
              workflow={workflow}
              selectedNodeId={selectedNodeId}
              onSelect={setSelectedNodeId}
              onAddNode={() =>
                setPicker({ open: true, position: { x: 360, y: 220 } })
              }
              onChange={(next, message) => {
                if (next !== workflow) commit(next);
                setAnnouncement(message);
              }}
            />
          </Suspense>
        )}
        {selectedNode && (
          <>
            <div
              className="inspector-resize"
              role="separator"
              aria-label="Resize inspector"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={resizeInspector}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft")
                  updatePreferences({
                    editorInspectorWidth: editorInspectorWidth + 10,
                  });
                if (event.key === "ArrowRight")
                  updatePreferences({
                    editorInspectorWidth: editorInspectorWidth - 10,
                  });
              }}
            />
            <NodeInspector
              workflow={workflow}
              node={selectedNode}
              sampleRun={testDataExecutions.find(item=>item.id===testDataExecutionId)??run}
              testDataExecutions={testDataExecutions}
              testDataExecutionId={testDataExecutionId}
              onTestDataExecutionChange={setTestDataExecutionId}
              issues={issues.filter(
                (issue) => issue.nodeId === selectedNode.id,
              )}
              onChange={(node, workflowPatch) => {
                const next = {
                  ...workflow,
                  ...workflowPatch,
                  nodes: workflow.nodes.map((n) =>
                    n.id === node.id ? node : n,
                  ),
                };
                commit(next);
              }}
              onDelete={() => removeNode(selectedNode.id)}
            />
          </>
        )}
      </div>
      <section className={`execution-drawer ${bottomOpen ? "open" : ""}`}>
        <button
          className="drawer-handle"
          onClick={() => setBottomOpen((v) => !v)}
        >
          <History size={14} />
          <span>Execution & data</span>
          {run && (
            <span className={`drawer-status status-${run.status}`}>
              {run.status}
            </span>
          )}
          {issues.length > 0 && <IssueSummary issues={issues} />}
          <span className="topbar-spacer" />
          {bottomOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        {bottomOpen && (
          <div className="drawer-content">
            {issues.length > 0 ? (
              <div className="validation-list">
                <h3>Workflow needs attention</h3>
                {issues.map((issue, i) => (
                  <IssueNotice
                    key={`${issue.code}:${issue.nodeId ?? "workflow"}:${i}`}
                    issue={issue}
                    compact
                    context={{ workflowId: workflow.id, nodeId: issue.nodeId, fieldPath: issue.fieldPath }}
                    tracking={issueTracking[issueFingerprint(issue)]}
                    onFix={issue.nodeId ? () => setSelectedNodeId(issue.nodeId) : undefined}
                    fixLabel={issue.nodeId ? "Open node" : "Review workflow"}
                  />
                ))}
              </div>
            ) : run ? (
              <ExecutionInspector
                compact
                run={run}
                workflow={workflow}
                onRetry={doRun}
                onRetryNode={retryNode}
                onRetryHeaded={retryHeaded}
                onEditNode={(nodeId) => {
                  setSelectedNodeId(nodeId);
                  setBottomOpen(false);
                }}
                onReviewPermissions={openPermissionReview}
              />
            ) : (
              <div className="drawer-empty">
                <TestTube2 size={18} />
                <b>No execution selected</b>
                <span>
                  Validate the workflow or run it to inspect live data.
                </span>
              </div>
            )}
          </div>
        )}
      </section>
      <CommandPalette
        open={picker.open}
        onClose={() => setPicker((p) => ({ ...p, open: false }))}
        onAdd={addNode}
        onAddPlugin={addPluginNode}
        pluginNodes={enabledPluginNodes(installedPlugins)}
        unavailablePluginNodes={installedPlugins
          .filter((plugin) => plugin.state !== "enabled")
          .flatMap((plugin) =>
            plugin.manifest.nodes.map((node) => ({ plugin, node })),
          )}
        sourceType={
          workflow.nodes.find((node) => node.id === picker.sourceId)?.type
        }
        hasTrigger={workflow.nodes.some((node) => isTrigger(node.type))}
        actions={[
          {
            id: "editor-run",
            group: "Editor",
            name: "Run workflow",
            description: "Save, validate, and start a manual run.",
            action: () => void doRun(),
          },
          {
            id: "editor-save",
            group: "Editor",
            name: "Save workflow",
            description: "Persist the current workflow explicitly.",
            action: () => void doSave(),
          },
          {
            id: "editor-validate",
            group: "Editor",
            name: "Validate workflow",
            description: "Check configuration without executing.",
            action: () => void test(),
          },
          {
            id: "editor-undo",
            group: "Edit",
            name: "Undo",
            description: "Undo the most recent editor change.",
            action: undo,
          },
          {
            id: "editor-redo",
            group: "Edit",
            name: "Redo",
            description: "Redo the most recently undone change.",
            action: redo,
          },
          {
            id: "editor-tidy",
            group: "Edit",
            name: "Tidy workflow",
            description: "Arrange nodes into a readable layout.",
            action: tidy,
          },
          {
            id: "editor-permissions",
            group: "Editor",
            name: "Review permissions",
            description: "Inspect local workflow capabilities.",
            action: () => openPermissionReview(),
          },
          {
            id: "editor-back",
            group: "Navigation",
            name: "Back to workflows",
            description: "Return to workflow management.",
            action: goBack,
          },
          ...(selectedNode
            ? [
                {
                  id: "editor-duplicate-node",
                  group: "Selected node",
                  name: "Duplicate selected node",
                  description: selectedNode.name,
                  action: () => duplicate(selectedNode.id),
                },
              ]
            : []),
        ]}
      />
      {permissionOpen && (
        <PermissionReview
          workflow={workflow}
          request={permissionRequest}
          onClose={closePermissionReview}
          onApply={(permissions) => {
            setWorkflow({
              ...workflow,
              settings: { ...workflow.settings, permissions },
            });
            if (permissionRequest)
              toast.push("Permission granted. Retry the workflow when ready.", "success");
            closePermissionReview();
          }}
        />
      )}
      <Dialog
        open={revisionOpen}
        onOpenChange={setRevisionOpen}
        title="Revision history"
        description="Every content-changing save is immutable. Restoring creates a new revision and keeps this history intact."
        width="large"
      >
        <div className="revision-list">
          {revisions.map((revision) => (
            <div className="revision-row" key={revision.revisionId}>
              <div>
                <b>{revision.changeSummary}</b>
                <small>{new Date(revision.createdAt).toLocaleString()} · {revision.contentHash.slice(0,20)}</small>
              </div>
              {revision.current ? <span className="revision-current">Current</span> : <button className="button" onClick={()=>setPendingRevisionId(revision.revisionId)}>Restore</button>}
            </div>
          ))}
          {!revisions.length && <div className="drawer-empty"><History size={18}/><b>No saved revisions</b></div>}
        </div>
      </Dialog>
      <Dialog
        open={Boolean(draftPrompt)}
        onOpenChange={(open) => { if (!open) setDraftPrompt(undefined); }}
        title="Restore recovery draft?"
        description={draftPrompt && draftUsesEarlierBase(draftPrompt, activeWorkflow!) ? "This draft was made against an earlier saved version. Restoring it replaces only the in-memory editor state; it is not saved until you explicitly Save." : "Restoring replaces only the in-memory editor state; it is not saved until you explicitly Save."}
        footer={<><button className="button" onClick={() => { if (draftPrompt) clearWorkflowDraft(draftPrompt.workflowId); setDraftPrompt(undefined); }}>Discard draft</button><button className="button primary" onClick={() => { if (!draftPrompt) return; setWorkflow(structuredClone(draftPrompt.workflow)); setDraftPrompt(undefined); }}>Restore draft</button></>}
      >
        <p>This recovery draft is stored only on this device. Choosing Restore keeps it until a successful explicit Save.</p>
      </Dialog>
      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title="Leave unsaved workflow?"
        description="Your local changes have not been saved and will be lost."
        confirmLabel="Leave workflow"
        dangerous
        onConfirm={() => setView("workflows")}
      />
      <ConfirmDialog
        open={Boolean(pendingRevisionId)}
        onOpenChange={(open)=>!open&&setPendingRevisionId(undefined)}
        title="Restore this revision?"
        description="The selected snapshot becomes a new current revision. Existing revisions and executions remain unchanged."
        confirmLabel="Restore revision"
        onConfirm={()=>{
          if (!pendingRevisionId) return;
          void api.restoreWorkflowRevision(workflow.id,pendingRevisionId).then(async restored=>{
            setWorkflow(restored);
            setBaseline(JSON.stringify(restored));
            setPendingRevisionId(undefined);
            await loadRevisions();
            toast.push("Revision restored as a new head.","success");
          }).catch(error=>toast.push(String(error),"error"));
        }}
      />
      <ConfirmDialog
        open={pendingSideEffectTest}
        onOpenChange={setPendingSideEffectTest}
        title="Run a side-effecting step test?"
        description="This selected step can change files, send data, notify someone, or update workflow state. Upstream and downstream steps will not run."
        confirmLabel="Run step test"
        dangerous
        onConfirm={()=>void testSelectedNode(true)}
      />
      <ConfirmDialog
        open={Boolean(pendingDeleteNodeId)}
        onOpenChange={(open) => !open && setPendingDeleteNodeId(undefined)}
        title="Delete configured node?"
        description="This node contains configuration. Deleting it also removes its incoming and outgoing connections."
        confirmLabel="Delete node"
        dangerous
        onConfirm={() => {
          if (pendingDeleteNodeId) removeNode(pendingDeleteNodeId, true);
          setPendingDeleteNodeId(undefined);
        }}
      />
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </main>
  );
}

type WorkflowPermissionKind =
  | "network"
  | "files"
  | "browser"
  | "communication"
  | "external_write"
  | "command"
  | "background"
  | "other";

function PermissionReview({
  workflow,
  request,
  onClose,
  onApply,
}: {
  workflow: Workflow;
  request?: PermissionReviewRequest;
  onClose: () => void;
  onApply: (permissions: PermissionSummary) => void;
}) {
  const [permissions, setPermissions] = useState(workflow.settings.permissions);
  const reviewBody = useRef<HTMLElement>(null);
  const domains = workflow.nodes
    .filter((node) => node.type === "http_request")
    .map((node) => {
      try {
        return new URL(String(node.configuration.url)).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const commandNodes = workflow.nodes.filter(
    (node) => node.type === "run_command" || (["code","javascript_code","python_code"].includes(node.type) && node.configuration.executionMode === "run"),
  );
  const browserProfiles = [
    ...new Set(
      workflow.nodes
        .filter((node) => node.type === "open_browser")
        .map((node) => String(node.configuration.profileId ?? ""))
        .filter(Boolean),
    ),
  ];
  const communicationNodes = workflow.nodes.filter((node) =>
    [
      "gmail_create_draft",
      "gmail_send_email",
      "discord_webhook",
      "discord_embed",
      "slack_webhook",
    ].includes(node.type),
  );
  const sendNodes = workflow.nodes.filter(
    (node) => node.type === "gmail_send_email",
  );
  const externalWriteNodes = workflow.nodes.filter((node) =>
    definitionFor(node.type).externalEffect === "external_write" ||
    definitionFor(node.type).externalEffect === "destructive_or_high_impact"
  );
  const collectionRiskNotes=workflow.nodes.flatMap(node=>{
    if(node.type==="loop_over_items")return [`${node.name}: up to ${Number(node.configuration.maxIterations??10000)} batches, ${Number(node.configuration.concurrency??1)} active at once; downstream actions may run once per item.`];
    if(node.type==="switch"&&node.configuration.mode==="all_matches")return [`${node.name}: one item may be copied to several branches.`];
    if(node.type==="merge"&&node.configuration.mode==="cartesian")return [`${node.name}: may multiply inputs up to ${Number(node.configuration.maxResults??25000)} result items.`];
    if(node.type==="remove_duplicates"&&node.configuration.scope==="workflow_state")return [`${node.name}: uses staged workflow state, committed only after complete success.`];
    return [];
  });
  const requestedNode = request?.nodeId
    ? workflow.nodes.find((node) => node.id === request.nodeId)
    : undefined;
  const requestedKind = permissionKindFor(
    requestedNode?.type,
    request?.message,
  );
  const requestedPath =
    requestedKind === "files" && request
      ? permissionPathFromMessage(request.message)
      : undefined;

  useEffect(() => {
    if (!request) return;
    const frame = window.requestAnimationFrame(() => {
      const target = reviewBody.current?.querySelector<HTMLElement>(
        '[data-permission-requested="true"]',
      );
      target?.scrollIntoView({ block: "center" });
      target?.querySelector<HTMLInputElement>("input")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request, requestedKind]);

  const applyPermissions = () => {
    let next = { ...permissions };
    if (request) next = grantRequestedPermission(next, requestedKind, sendNodes.length > 0);
    const grantNetwork = !request || requestedKind === "network";
    const grantBrowser = !request || requestedKind === "browser";
    onApply({
      ...next,
      approvedNetworkDomains: grantNetwork
        ? [...new Set([...next.approvedNetworkDomains, ...domains])]
        : next.approvedNetworkDomains,
      approvedBrowserProfileIds: grantBrowser
        ? [...new Set([...next.approvedBrowserProfileIds, ...browserProfiles])]
        : next.approvedBrowserProfileIds,
      approvedFolders:
        request && requestedKind === "files" && requestedPath
          ? [...new Set([...next.approvedFolders, requestedPath])]
          : next.approvedFolders,
    });
  };

  return (
    <FocusDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={request ? "Permission required" : "Workflow permissions"}
      description={
        request
          ? "Review the permission that paused this workflow run."
          : "Review exactly what this workflow may access and send."
      }
    >
      <div className="permission-modal">
        <header>
          <span className={`permission-icon ${request ? "locked" : "granted"}`}>
            {request ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
          </span>
          <div>
            <h2>{request ? "Review permission request" : "Workflow permissions"}</h2>
            <p>
              {request
                ? `${requestedNode?.name ?? "This workflow"} paused until you decide.`
                : "Review exactly what this workflow may access and send."}
            </p>
          </div>
        </header>
        <section ref={reviewBody}>
          {request && (
            <IssueNotice
              issue={{
                code: "permission_required",
                severity: "permission",
                message: request.message,
                suggestion: "Grant only if you trust this workflow. Declining leaves its permissions unchanged.",
                nodeId: request.nodeId,
              }}
              context={{ workflowId: workflow.id, nodeId: request.nodeId }}
            />
          )}
          <label>Approved network domains</label>
          {domains.length ? (
            domains.map((domain) => (
              <div
                className={`permission-row ${requestedKind === "network" ? "permission-requested" : ""}`}
                data-permission-requested={requestedKind === "network" || undefined}
                key={domain}
              >
                <span>↗</span>
                <b>{domain}</b>
                <em>Required by HTTP Request</em>
              </div>
            ))
          ) : (
            <div className="permission-empty">
              No direct network domains requested.
            </div>
          )}
          <label>Approved folders and paths</label>
          {requestedPath &&
            !permissions.approvedFolders.includes(requestedPath) && (
              <div
                className="permission-row permission-requested"
                data-permission-requested="true"
              >
                <span>+</span>
                <b>{requestedPath}</b>
                <em>Requested by this run</em>
              </div>
            )}
          {permissions.approvedFolders.length ? (
            permissions.approvedFolders.map((folder) => (
              <div className="permission-row" key={folder}>
                <span>⌁</span>
                <b>{folder}</b>
              </div>
            ))
          ) : (
            <div className="permission-empty">No folder access approved.</div>
          )}
          {(browserProfiles.length > 0 || requestedKind === "browser") && (
            <>
              <label>Managed browser profiles</label>
              {browserProfiles.length ? (
                browserProfiles.map((profileId) => (
                  <div className="permission-row" key={profileId}>
                    <span>◎</span>
                    <b>{profileId}</b>
                    <em>Isolated application profile</em>
                  </div>
                ))
              ) : (
                <div className="permission-empty">
                  No managed browser profile is configured.
                </div>
              )}
              <label
                className={`toggle-row ${requestedKind === "browser" ? "permission-requested" : ""}`}
                data-permission-requested={requestedKind === "browser" || undefined}
              >
                <span>
                  <b>Permit browser automation</b>
                  <small>
                    Changing any browser action revokes this approval.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={permissions.browserAutomationPermitted}
                  onChange={(event) =>
                    setPermissions({
                      ...permissions,
                      browserAutomationPermitted: event.target.checked,
                    })
                  }
                />
              </label>
            </>
          )}
          {communicationNodes.length > 0 && (
            <>
              <label>External communication</label>
              {communicationNodes.map((node) => (
                <IssueNotice
                  key={node.id}
                  issue={{
                    code: "external_communication_review",
                    severity: "info",
                    message: node.name,
                    suggestion: node.type === "gmail_send_email"
                      ? `${String(node.configuration.credentialId || "No connection")} → ${String(node.configuration.to || "No recipient")}${String(node.configuration.to || "").includes("{{") ? " (dynamic)" : " (static)"}`
                      : String(node.configuration.credentialId || "Connection not configured"),
                    nodeId: node.id,
                  }}
                  compact
                  context={{ workflowId: workflow.id, nodeId: node.id }}
                />
              ))}
              <label
                className={`toggle-row ${requestedKind === "communication" ? "permission-requested" : ""}`}
                data-permission-requested={
                  requestedKind === "communication" || undefined
                }
              >
                <span>
                  <b>Permit external communication</b>
                  <small>
                    Connection or message logic changes revoke approval.
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={permissions.externalCommunicationPermitted}
                  onChange={(event) =>
                    setPermissions({
                      ...permissions,
                      externalCommunicationPermitted: event.target.checked,
                      communicationApprovalRevision:
                        event.target.checked && sendNodes.length
                          ? crypto.randomUUID()
                          : null,
                    })
                  }
                />
              </label>
            </>
          )}
          {externalWriteNodes.length > 0 && (
            <>
              <label>External data changes</label>
              {externalWriteNodes.map((node) => (
                <IssueNotice
                  key={node.id}
                  issue={{ code: definitionFor(node.type).externalEffect === "destructive_or_high_impact" ? "high_impact_external_write" : "external_write_review", severity: definitionFor(node.type).externalEffect === "destructive_or_high_impact" ? "warning" : "info", message: node.name, suggestion: definitionFor(node.type).externalEffect?.replaceAll("_", " "), nodeId: node.id }}
                  compact
                  context={{ workflowId: workflow.id, nodeId: node.id }}
                />
              ))}
              <label className={`toggle-row ${requestedKind === "external_write" ? "permission-requested" : ""}`} data-permission-requested={requestedKind === "external_write" || undefined}>
                <span><b>Permit external data writes</b><small>Allows these nodes to change provider data; connection secrets remain host-only.</small></span>
                <input type="checkbox" checked={Boolean(permissions.externalDataWritePermitted)} onChange={(event) => setPermissions({ ...permissions, externalDataWritePermitted: event.target.checked })} />
              </label>
            </>
          )}
          {collectionRiskNotes.length>0&&<><label>Collection amplification and state</label>{collectionRiskNotes.map(note=><IssueNotice key={note} issue={{code:"collection_state_review",severity:"warning",message:note,suggestion:"Review runner limits, repeated trusted-path access, ordering, and idempotency before publishing."}} compact context={{workflowId:workflow.id}}/>)}</>}
          {commandNodes.length > 0 && (
            <>
              <label>Command execution</label>
              {commandNodes.map((node) => (
                <IssueNotice
                  key={node.id}
                  issue={{ code: "high_risk_capability", severity: "warning", message: ["code","javascript_code","python_code"].includes(node.type) ? `${String(node.configuration.language ?? "javascript")} code` : String(node.configuration.executable || "Executable not configured"), suggestion: ["code","javascript_code","python_code"].includes(node.type) ? `${String(node.configuration.sourceCode ?? "").split("\n").length} lines · restricted local runtime` : (((node.configuration.arguments as string[]) ?? []).join(" ") || "No arguments"), nodeId: node.id }}
                  compact
                  context={{ workflowId: workflow.id, nodeId: node.id }}
                />
              ))}
              <label
                className={`toggle-row ${requestedKind === "command" ? "permission-requested" : ""}`}
                data-permission-requested={requestedKind === "command" || undefined}
              >
                <span>
                  <b>Permit command execution</b>
                  <small>Changing a command revokes this approval.</small>
                </span>
                <input
                  type="checkbox"
                  checked={permissions.commandExecutionPermitted}
                  onChange={(event) =>
                    setPermissions({
                      ...permissions,
                      commandExecutionPermitted: event.target.checked,
                      approvalRevision: event.target.checked
                        ? crypto.randomUUID()
                        : null,
                    })
                  }
                />
              </label>
            </>
          )}
          <label
            className={`toggle-row ${requestedKind === "background" ? "permission-requested" : ""}`}
            data-permission-requested={requestedKind === "background" || undefined}
          >
            <span>
              <b>Permit background execution</b>
              <small>
                Required for schedules, email polling, and file watches while in
                the tray.
              </small>
            </span>
            <input
              type="checkbox"
              checked={permissions.backgroundExecutionPermitted}
              onChange={(event) =>
                setPermissions({
                  ...permissions,
                  backgroundExecutionPermitted: event.target.checked,
                })
              }
            />
          </label>
          <div className="quit-note">
            Local schedules and polling stop when sndbox is fully quit.
          </div>
        </section>
        <footer>
          <button className="button" onClick={onClose}>
            {request ? "Decline" : "Cancel"}
          </button>
          <button
            className="button primary"
            onClick={applyPermissions}
          >
            {request ? "Grant permission" : "Apply permissions"}
          </button>
        </footer>
      </div>
    </FocusDialog>
  );
}

function permissionKindFor(
  nodeType?: NodeType,
  message = "",
): WorkflowPermissionKind {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("approved folder") ||
    normalized.includes("outside the workflow's approved folders")
  )
    return "files";
  if (normalized.includes("network access") || normalized.includes("network domain"))
    return "network";
  if (nodeType === "run_command" || ["code","javascript_code","python_code"].includes(nodeType ?? "")) return "command";
  if (
    nodeType &&
    [
      "gmail_create_draft",
      "gmail_send_email",
      "gmail_add_label",
      "discord_webhook",
      "discord_embed",
      "slack_webhook",
    ].includes(nodeType)
  )
    return "communication";
  if (
    nodeType &&
    [
      "open_browser",
      "navigate",
      "click_element",
      "fill_field",
      "select_option",
      "press_key",
      "wait_for",
      "extract_data",
      "screenshot",
      "download_file",
      "upload_file",
      "close_browser",
    ].includes(nodeType)
  )
    return "browser";
  if (nodeType === "http_request") return "network";
  if (
    nodeType &&
    [
      "file_watch_trigger",
      "move_file",
      "read_file",
      "write_file",
      "copy_path",
      "delete_path",
      "list_folder",
      "parse_csv",
      "parse_json",
      "parse_text",
    ].includes(nodeType)
  )
    return "files";
  if (normalized.includes("background execution")) return "background";
  if (normalized.includes("external communication")) return "communication";
  if (normalized.includes("external data write")) return "external_write";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("command")) return "command";
  return "other";
}

function permissionPathFromMessage(message: string) {
  return message.match(/^'([^']+)' is outside the workflow's approved folders\./)?.[1];
}

function grantRequestedPermission(
  permissions: PermissionSummary,
  kind: WorkflowPermissionKind,
  hasSendEmail: boolean,
): PermissionSummary {
  if (kind === "command")
    return {
      ...permissions,
      commandExecutionPermitted: true,
      approvalRevision: crypto.randomUUID(),
    };
  if (kind === "communication")
    return {
      ...permissions,
      externalCommunicationPermitted: true,
      communicationApprovalRevision: hasSendEmail
        ? crypto.randomUUID()
        : permissions.communicationApprovalRevision,
    };
  if (kind === "external_write")
    return { ...permissions, externalDataWritePermitted: true };
  if (kind === "browser")
    return { ...permissions, browserAutomationPermitted: true };
  if (kind === "background")
    return { ...permissions, backgroundExecutionPermitted: true };
  return permissions;
}
