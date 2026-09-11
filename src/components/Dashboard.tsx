import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CustomSelect } from "./ui/CustomSelect";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Bookmark,
  Bot,
  Clock3,
  Code2,
  Copy,
  Download,
  FileStack,
  Filter,
  Folder,
  Globe2,
  LayoutTemplate,
  MessagesSquare,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Search,
  Star,
  Tags as TagsIcon,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { rankAttentionItems } from "@sandbox/product-ui";
import { api } from "../api";
import { definitionFor } from "../catalogue";
import { usePreferences } from "../preferences";
import { useAppStore } from "../store";
import type { WorkflowSummary } from "../types";
import {
  ALL_WORKFLOW_STARTERS,
  BLANK_WORKFLOW_TEMPLATE,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
  type WorkflowTemplateCategory,
} from "../workflowTemplates";
import { Status } from "./Status";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { useToast } from "./ui/Toast";
import { DesktopGettingStarted } from "./DesktopGettingStarted";
import { readWorkspaceSnapshot, updateWorkspaceSnapshot } from "../workspaceState";
import { isTextEntryTarget } from "../useKeyboardShortcuts";
import {
  createDashboardSavedView,
  dashboardSavedViewMatches,
  deleteDashboardSavedView,
  MAX_DASHBOARD_SAVED_VIEWS,
  readDashboardSavedViews,
  renameDashboardSavedView,
  restoreDashboardSavedView,
  type DashboardSavedView,
  type DashboardSavedViewState,
  validateSavedViewName,
  writeDashboardSavedViews,
} from "../dashboardSavedViews";

type FilterKey = "all" | "favorites" | "scheduled" | "failed" | "archived";
type DashboardTab = "workflows" | "templates";

const templateIcons = {
  AI: Bot,
  Monitoring: Globe2,
  Browser: LayoutTemplate,
  Communication: MessagesSquare,
  Files: FileStack,
  Developer: Code2,
} satisfies Record<WorkflowTemplateCategory, typeof Bot>;

export function Dashboard() {
  const { openWorkflow, createWorkflow, selectExecution, setView } = useAppStore();
  const dateDisplay = usePreferences((state) => state.dateDisplay);
  const toast = useToast();
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const remembered = useMemo(() => readWorkspaceSnapshot()?.dashboard, []);
  const [tab, setTab] = useState<DashboardTab>(() => remembered?.activeTab ?? "workflows");
  const [search, setSearch] = useState(() => remembered?.search ?? "");
  const [templateCategory, setTemplateCategory] = useState<
    WorkflowTemplateCategory | "all"
  >(() => remembered?.templateCategory as WorkflowTemplateCategory | "all" ?? "all");
  const [sort, setSort] = useState(() => remembered?.sortOrder ?? "modified");
  const [filter, setFilter] = useState<FilterKey>(() => remembered?.workflowFilter ?? "all");
  const [folder, setFolder] = useState(() => remembered?.folder ?? "");
  const [savedViews, setSavedViews] = useState<DashboardSavedView[]>(readDashboardSavedViews);
  const [activeSavedViewId, setActiveSavedViewId] = useState<string>();
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [savedViewName, setSavedViewName] = useState("");
  const [manageViewsOpen, setManageViewsOpen] = useState(false);
  const [renamingViewId, setRenamingViewId] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [running, setRunning] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [template, setTemplate] = useState<WorkflowTemplate>(
    BLANK_WORKFLOW_TEMPLATE,
  );
  const [name, setName] = useState(BLANK_WORKFLOW_TEMPLATE.name);
  const [confirm, setConfirm] = useState<{
    kind: "archive" | "purge";
    item: WorkflowSummary;
  }>();
  const [organize, setOrganize] = useState<WorkflowSummary>();
  const [organizeFolder, setOrganizeFolder] = useState("");
  const [tags, setTags] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkDialog, setBulkDialog] = useState<"folder" | "tags">();
  const [bulkFolder, setBulkFolder] = useState("");
  const [bulkTags, setBulkTags] = useState("");
  const [bulkTagMode, setBulkTagMode] = useState<"add" | "remove">("add");
  const [bulkConfirm, setBulkConfirm] = useState<"archive" | "restore">();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [accountConnected, setAccountConnected] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentViewState = (): DashboardSavedViewState => ({ search, workflowFilter: filter, folder, sortOrder: sort as DashboardSavedViewState["sortOrder"] });
  const persistSavedViews = (next: DashboardSavedView[]) => {
    if (!writeDashboardSavedViews(next)) {
      toast.push("Saved views could not be stored on this device.", "error");
      return false;
    }
    setSavedViews([...next].sort((a, b) => b.updatedAt - a.updatedAt));
    return true;
  };
  const applySavedView = (savedView: DashboardSavedView) => {
    setTab("workflows");
    setSearch(savedView.state.search);
    setFilter(savedView.state.workflowFilter);
    setFolder(savedView.state.folder);
    setSort(savedView.state.sortOrder);
    setActiveSavedViewId(savedView.id);
  };
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setItems(await api.listWorkflows(true));
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    void api.accountStatus().then((status) => setAccountConnected(status.signedIn)).catch(() => undefined);
    const create = () => {
      setTemplate(BLANK_WORKFLOW_TEMPLATE);
      setName(BLANK_WORKFLOW_TEMPLATE.name);
      setCreateOpen(true);
    };
    window.addEventListener("sandbox:create-workflow", create);
    return () => window.removeEventListener("sandbox:create-workflow", create);
  }, []);
  useEffect(() => {
    const known = new Set(items.map((item) => item.workflow.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);
  useEffect(() => {
    updateWorkspaceSnapshot(current => ({ ...current, dashboard: { activeTab: tab, search, workflowFilter: filter, folder, sortOrder: sort, templateCategory } }));
  }, [tab, search, filter, folder, sort, templateCategory]);
  useEffect(() => {
    const active = savedViews.find(view => view.id === activeSavedViewId);
    if (active && !dashboardSavedViewMatches(currentViewState(), active)) setActiveSavedViewId(undefined);
  }, [search, filter, folder, sort, savedViews, activeSavedViewId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !isTextEntryTarget(target) && !(target instanceof Element && target.closest("[role=dialog],[role=alertdialog]"))
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const folders = useMemo(
    () =>
      [
        ...new Set(
          items.map((item) => item.metadata.folder).filter(Boolean) as string[],
        ),
      ].sort(),
    [items],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items
      .filter((item) => {
        const { workflow, metadata, lastExecution, nextRunAt } = item;
        if (filter === "archived" ? !metadata.archivedAt : metadata.archivedAt)
          return false;
        if (filter === "favorites" && !metadata.favorite) return false;
        if (filter === "scheduled" && !nextRunAt) return false;
        if (filter === "failed" && lastExecution?.status !== "failed")
          return false;
        if (folder && metadata.folder !== folder) return false;
        if (
          needle &&
          ![
            workflow.name,
            workflow.description,
            metadata.folder ?? "",
            ...metadata.tags,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)
        )
          return false;
        return true;
      })
      .sort((a, b) =>
        sort === "name"
          ? a.workflow.name.localeCompare(b.workflow.name)
          : sort === "last-run"
            ? (b.lastExecution?.startedAt ?? "").localeCompare(
                a.lastExecution?.startedAt ?? "",
              )
            : sort === "next-run"
              ? (a.nextRunAt ?? "z").localeCompare(b.nextRunAt ?? "z")
              : b.workflow.updatedAt.localeCompare(a.workflow.updatedAt),
      );
  }, [filter, folder, items, search, sort]);
  const filteredTemplates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return WORKFLOW_TEMPLATES.filter(
      (item) =>
        (templateCategory === "all" || item.category === templateCategory) &&
        (!needle ||
          [
            item.name,
            item.description,
            item.flow,
            item.requirements,
            item.category,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [search, templateCategory]);
  const attentionItems = useMemo(
    () =>
      rankAttentionItems(
        items
          .filter((item) => item.lastExecution?.status === "failed")
          .map((item) => ({
            id: item.lastExecution!.id,
            severity: "blocking" as const,
            title: `${item.workflow.name} failed`,
            description:
              item.lastExecution!.error?.message ??
              "Open the failed run to inspect the exact step and retry it.",
            actionLabel: "Review failed run",
          })),
      ),
    [items],
  );
  const openCreate = (item: WorkflowTemplate = BLANK_WORKFLOW_TEMPLATE) => {
    setTemplate(item);
    setName(item.name);
    setCreateOpen(true);
  };
  const run = async (id: string) => {
    setRunning(id);
    try {
      await api.runWorkflow(id);
      toast.push("Workflow run started.", "success");
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    } finally {
      setRunning(undefined);
    }
  };
  const importWorkflow = async () => {
    try {
      const inspection = await api.inspectWorkflowImport();
      if (inspection)
        window.dispatchEvent(
          new CustomEvent("sandbox:workflow-import-inspected", {
            detail: inspection,
          }),
        );
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const submitCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await createWorkflow(
        template.key === "blank" ? undefined : template.key,
        name.trim(),
      );
      setCreateOpen(false);
    } catch (value) {
      toast.push(String(value), "error");
    } finally {
      setCreating(false);
    }
  };
  const updateMetadata = async (
    id: string,
    patch: Parameters<typeof api.updateWorkflowMetadata>[1],
  ) => {
    try {
      await api.updateWorkflowMetadata(id, patch);
      await load();
      return true;
    } catch (value) {
      toast.push(String(value), "error");
      return false;
    }
  };
  const runBulkMetadata = async (
    patch: Parameters<typeof api.batchUpdateWorkflowMetadata>[1],
    success: string,
  ) => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      await api.batchUpdateWorkflowMetadata(ids, patch);
      await load();
      setSelectedIds(new Set());
      setBulkDialog(undefined);
      toast.push(success, "success");
    } catch (value) {
      toast.push(String(value), "error");
    } finally {
      setBulkBusy(false);
    }
  };
  const confirmBulkArchive = async () => {
    const ids = [...selectedIds];
    if (!ids.length || !bulkConfirm) return;
    const action = bulkConfirm;
    setBulkBusy(true);
    try {
      if (action === "archive") await api.archiveWorkflows(ids);
      else await api.restoreWorkflows(ids);
      await load();
      setSelectedIds(new Set());
      setBulkConfirm(undefined);
      toast.push(
        `${ids.length} workflow${ids.length === 1 ? "" : "s"} ${action === "archive" ? "archived" : "restored"}.`,
        "success",
        action === "archive"
          ? {
              label: "Undo",
              onAction: () =>
                void api
                  .restoreWorkflows(ids)
                  .then(load)
                  .catch((value) => toast.push(String(value), "error")),
            }
          : undefined,
      );
    } catch (value) {
      toast.push(String(value), "error");
    } finally {
      setBulkBusy(false);
    }
  };
  const actConfirm = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === "archive")
        await api.archiveWorkflow(confirm.item.workflow.id);
      else await api.purgeWorkflow(confirm.item.workflow.id);
      if (confirm.kind === "archive") {
        const archivedId = confirm.item.workflow.id;
        toast.push("Workflow archived.", "success", { label: "Undo", onAction: () => void api.restoreWorkflow(archivedId).then(load).catch(value => toast.push(String(value), "error")) });
      } else toast.push("Workflow permanently deleted.", "success");
      setConfirm(undefined);
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const duplicate = async (item: WorkflowSummary) => {
    try {
      const created = await api.duplicateWorkflow(item.workflow.id);
      toast.push(`Created ${created.name}.`, "success");
      await load();
    } catch (value) {
      toast.push(String(value), "error");
    }
  };
  const clear = () => {
    setSearch("");
    setFilter("all");
    setFolder("");
    setTemplateCategory("all");
    setActiveSavedViewId(undefined);
  };
  const saveCurrentView = () => {
    const created = createDashboardSavedView(savedViews, savedViewName, currentViewState());
    if (!created) return;
    if (persistSavedViews([created, ...savedViews])) {
      setActiveSavedViewId(created.id);
      setSaveViewOpen(false);
      setSavedViewName("");
      toast.push(`Saved view “${created.name}”.`, "success");
    }
  };
  const renameSavedView = () => {
    if (!renamingViewId) return;
    const next = renameDashboardSavedView(savedViews, renamingViewId, renameValue);
    if (!next) return;
    if (persistSavedViews(next)) {
      setRenamingViewId(undefined);
      setRenameValue("");
    }
  };
  const removeSavedView = (id: string) => {
    const { views, deleted } = deleteDashboardSavedView(savedViews, id);
    if (!deleted || !persistSavedViews(views)) return;
    if (activeSavedViewId === id) setActiveSavedViewId(undefined);
    toast.push(`Deleted view “${deleted.name}”.`, "info", { label: "Undo", onAction: () => {
      const restored = restoreDashboardSavedView(readDashboardSavedViews(), deleted);
      if (!restored || !writeDashboardSavedViews(restored)) {
        toast.push("The saved view could not be restored.", "error");
        return;
      }
      setSavedViews(restored.sort((a, b) => b.updatedAt - a.updatedAt));
    } });
  };
  const activeFilters =
    tab === "templates"
      ? Boolean(search || templateCategory !== "all")
      : Boolean(search || filter !== "all" || folder);
  const selectedItems = items.filter((item) => selectedIds.has(item.workflow.id));
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((item) => selectedIds.has(item.workflow.id));
  const validSavedViewName = validateSavedViewName(savedViewName, savedViews);
  const validRename = renamingViewId ? validateSavedViewName(renameValue, savedViews, renamingViewId) : undefined;
  const describeSavedView = (savedView: DashboardSavedView) => [
    savedView.state.search ? `Search: ${savedView.state.search}` : "All names",
    savedView.state.workflowFilter === "all" ? "All workflows" : savedView.state.workflowFilter,
    savedView.state.folder ? `Folder: ${savedView.state.folder}` : "All folders",
    `Sort: ${savedView.state.sortOrder.replace("-", " ")}`,
  ].join(" · ");
  return (
    <main className="content">
      <header className="page-header">
        <div>
          <h1>Workflows</h1>
          <p>
            {tab === "workflows"
              ? "Build, organise, and run automations on this device."
              : "Start faster with reviewed, fully editable workflow templates."}
          </p>
        </div>
        {tab === "workflows" && (
          <button className="button" onClick={() => void importWorkflow()}>
            <Upload size={14} />
            Import
          </button>
        )}
        <button className="button primary" onClick={() => openCreate()}>
          <Plus size={15} />
          Create workflow
        </button>
      </header>
      <div className="workflow-library-tabs" role="tablist" aria-label="Workflow library">
        <button
          role="tab"
          aria-selected={tab === "workflows"}
          className={tab === "workflows" ? "active" : ""}
          onClick={() => {
            setTab("workflows");
            clear();
          }}
        >
          <FileStack size={15} />
          My workflows
          <span>{items.filter((item) => !item.metadata.archivedAt).length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "templates"}
          className={tab === "templates" ? "active" : ""}
          onClick={() => {
            setTab("templates");
            clear();
          }}
        >
          <LayoutTemplate size={15} />
          Templates
          <span>{WORKFLOW_TEMPLATES.length}</span>
        </button>
      </div>
      {tab === "workflows" && !loading && (
        <DesktopGettingStarted
          steps={[
            {
              id: "create",
              label: "Create or import a workflow",
              complete: items.length > 0,
              actionLabel: items.length ? "View workflows" : "Create workflow",
              onAction: () => items.length ? searchRef.current?.focus() : openCreate(),
            },
            {
              id: "configure",
              label: "Configure its steps and permissions",
              complete: items.some((item) => item.workflow.nodes.length > 1),
              actionLabel: "Open workflow",
              onAction: () => items[0] ? void openWorkflow(items[0].workflow.id) : openCreate(),
            },
            {
              id: "test",
              label: "Test it on this device",
              complete: items.some((item) => Boolean(item.lastExecution)),
              actionLabel: "Start a test run",
              onAction: () => items[0] ? void run(items[0].workflow.id) : openCreate(),
            },
            {
              id: "complete",
              label: "Complete a successful run",
              complete: items.some((item) => item.lastExecution?.status === "successful"),
              actionLabel: "Review activity",
              onAction: () => setView("history"),
            },
            {
              id: "account",
              label: "Connect an account (optional)",
              complete: accountConnected,
              actionLabel: "Open Cloud",
              optional: true,
              onAction: () => setView("cloud"),
            },
          ]}
        />
      )}
      {tab === "workflows" && attentionItems.length > 0 && (
        <section className="desktop-attention" aria-labelledby="desktop-attention-title">
          <header>
            <div>
              <span className="attention-icon"><AlertTriangle size={16} /></span>
              <div><h2 id="desktop-attention-title">Needs attention</h2><p>Resolve failed runs without losing their execution context.</p></div>
            </div>
            <span>{attentionItems.length}</span>
          </header>
          <div className="desktop-attention-list">
            {attentionItems.slice(0, 3).map((attention) => {
              const summary = items.find((item) => item.lastExecution?.id === attention.id);
              return (
                <article key={attention.id}>
                  <div><strong>{attention.title}</strong><small>{attention.description}</small></div>
                  <button className="button" onClick={() => {
                    if (!summary?.lastExecution) return;
                    selectExecution(summary.lastExecution);
                    setView("history");
                  }}>{attention.actionLabel}</button>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <div className="toolbar dashboard-toolbar">
        <div className="search">
          <Search size={15} />
          <input
            ref={searchRef}
            aria-label={
              tab === "workflows" ? "Search workflows" : "Search templates"
            }
            placeholder={
              tab === "workflows"
                ? "Search name, description, folder, or tags…"
                : "Search templates by name, tool, or outcome…"
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button aria-label="Clear search" onClick={() => setSearch("")}>
              <X size={13} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </div>
        {tab === "workflows" ? (
          <>
            <CustomSelect
              aria-label="Filter workflows"
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterKey)}
            >
              <option value="all">All workflows</option>
              <option value="favorites">Favorites</option>
              <option value="scheduled">Scheduled</option>
              <option value="failed">Failed</option>
              <option value="archived">Archived</option>
            </CustomSelect>
            <CustomSelect
              aria-label="Filter by folder"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            >
              <option value="">All folders</option>
              {folders.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </CustomSelect>
            <CustomSelect
              aria-label="Sort workflows"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="modified">Last modified</option>
              <option value="name">Name</option>
              <option value="last-run">Last run</option>
              <option value="next-run">Next run</option>
            </CustomSelect>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="button dashboard-views-trigger" aria-label="Saved workflow views">
                  <Bookmark size={13} />
                  Views
                  {savedViews.length ? <span>{savedViews.length}</span> : null}
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu dashboard-views-menu" align="end">
                  <DropdownMenu.Label className="menu-label">Saved views</DropdownMenu.Label>
                  <DropdownMenu.Item disabled={savedViews.length >= MAX_DASHBOARD_SAVED_VIEWS} onSelect={() => setSaveViewOpen(true)}>
                    Save current view…
                  </DropdownMenu.Item>
                  {savedViews.length > 0 && <DropdownMenu.Separator />}
                  {savedViews.map(savedView => (
                    <DropdownMenu.Item key={savedView.id} onSelect={() => applySavedView(savedView)}>
                      <Bookmark size={12} fill={activeSavedViewId === savedView.id ? "currentColor" : "none"} />
                      {savedView.name}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => setManageViewsOpen(true)}>Manage saved views…</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        ) : (
          <CustomSelect
            aria-label="Filter template category"
            value={templateCategory}
            onChange={(event) =>
              setTemplateCategory(
                event.target.value as WorkflowTemplateCategory | "all",
              )
            }
          >
            <option value="all">All categories</option>
            {Object.keys(templateIcons).map((category) => (
              <option key={category}>{category}</option>
            ))}
          </CustomSelect>
        )}
        {activeFilters && (
          <button className="button" onClick={clear}>
            <Filter size={13} />
            Clear
          </button>
        )}
        <span className="count">
          {tab === "workflows" ? (
            <>
              {filtered.length} workflow{filtered.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              {filteredTemplates.length} template
              {filteredTemplates.length === 1 ? "" : "s"}
            </>
          )}
        </span>
      </div>
      {tab === "workflows" && selectedItems.length > 0 && (
        <div className="bulk-toolbar" role="toolbar" aria-label="Selected workflow actions">
          <strong>{selectedItems.length} selected</strong>
          <button className="button" disabled={bulkBusy} onClick={() => void runBulkMetadata({ favorite: true }, `${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"} favorited.`)}><Star size={13} /> Favorite</button>
          <button className="button" disabled={bulkBusy} onClick={() => void runBulkMetadata({ favorite: false }, `${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"} unfavorited.`)}>Unfavorite</button>
          <button className="button" disabled={bulkBusy} onClick={() => { setBulkFolder(""); setBulkConfirm(undefined); setBulkDialog("folder"); }}><Folder size={13} /> Move</button>
          <button className="button" disabled={bulkBusy} onClick={() => { setBulkTags(""); setBulkDialog("tags"); }}><TagsIcon size={13} /> Tags</button>
          {selectedItems.every((item) => Boolean(item.metadata.archivedAt)) ? (
            <button className="button" disabled={bulkBusy} onClick={() => setBulkConfirm("restore")}><RotateCcw size={13} /> Restore</button>
          ) : (
            <button className="button danger-text" disabled={bulkBusy} onClick={() => setBulkConfirm("archive")}><Archive size={13} /> Archive</button>
          )}
          <button className="icon-button bulk-clear" aria-label="Clear workflow selection" onClick={() => setSelectedIds(new Set())}><X size={14} /></button>
        </div>
      )}
      {tab === "templates" ? (
        filteredTemplates.length ? (
          <section className="workflow-template-grid" aria-label="Workflow templates">
            {filteredTemplates.map((item) => {
              const Icon = templateIcons[item.category];
              return (
                <article className="workflow-template-card" key={item.key}>
                  <header>
                    <span className="workflow-template-icon">
                      <Icon size={18} />
                    </span>
                    <span className="workflow-template-category">
                      {item.category}
                    </span>
                    {item.featured && <em>Popular</em>}
                  </header>
                  <h2>{item.name}</h2>
                  <p>{item.description}</p>
                  <div className="workflow-template-flow">{item.flow}</div>
                  <footer>
                    <small>{item.requirements}</small>
                    <button
                      className="button"
                      aria-label={`Use ${item.name} template`}
                      onClick={() => openCreate(item)}
                    >
                      Use template
                      <ArrowRight size={13} />
                    </button>
                  </footer>
                </article>
              );
            })}
          </section>
        ) : (
          <EmptyState
            title="No matching templates"
            description="Try a different category or search term."
            action={
              <button className="button" onClick={clear}>
                Clear template filters
              </button>
            }
          />
        )
      ) : (
        <>
          {loading ? (
            <LoadingSkeleton rows={6} />
          ) : error ? (
            <ErrorState
              title="Workflows could not load"
              description={error}
              onRetry={load}
            />
          ) : !items.length ? (
            <EmptyState
              title="Create your first workflow"
              description="Start blank or choose a reviewed template. No workflow record is created until you confirm its name."
              action={
                <button className="button primary" onClick={() => openCreate()}>
                  Create workflow
                </button>
              }
            />
          ) : !filtered.length ? (
            <EmptyState
              title="No matching workflows"
              description="No workflow matches the current search and filters."
              action={
                <button className="button" onClick={clear}>
                  Clear search and filters
                </button>
              }
            />
          ) : (
            <section className="workflow-table" aria-label="Workflows">
              <div className="table-head">
                <span className="bulk-name-header">
                  <input
                    type="checkbox"
                    aria-label={allVisibleSelected ? "Deselect visible workflows" : "Select visible workflows"}
                    checked={allVisibleSelected}
                    onChange={(event) => {
                      const visible = new Set(filtered.map((item) => item.workflow.id));
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) visible.forEach((id) => next.add(id));
                        else visible.forEach((id) => next.delete(id));
                        return next;
                      });
                    }}
                  />
                  Name
                </span>
                <span>Trigger</span>
                <span>Last run</span>
                <span>Next run</span>
                <span />
              </div>
              {filtered.map((item) => (
                <WorkflowRow
                  key={item.workflow.id}
                  item={item}
                  dateDisplay={dateDisplay}
                  running={running === item.workflow.id}
                  selected={selectedIds.has(item.workflow.id)}
                  onSelect={(selected) => setSelectedIds((current) => {
                    const next = new Set(current);
                    if (selected) next.add(item.workflow.id);
                    else next.delete(item.workflow.id);
                    return next;
                  })}
                  onOpen={() => void openWorkflow(item.workflow.id)}
                  onRun={() => void run(item.workflow.id)}
                  onFavorite={() =>
                    void updateMetadata(item.workflow.id, {
                      favorite: !item.metadata.favorite,
                    })
                  }
                  onDuplicate={() => void duplicate(item)}
                  onOrganize={() => {
                    setOrganize(item);
                    setOrganizeFolder(item.metadata.folder ?? "");
                    setTags(item.metadata.tags.join(", "));
                  }}
                  onArchive={() => setConfirm({ kind: "archive", item })}
                  onRestore={() =>
                    void api
                      .restoreWorkflow(item.workflow.id)
                      .then(load)
                      .catch((value) => toast.push(String(value), "error"))
                  }
                  onExport={() =>
                    void api
                      .exportWorkflow(item.workflow.id)
                      .then(
                        (path) =>
                          path &&
                          toast.push(`Exported ${item.workflow.name}.`, "success"),
                      )
                      .catch((error) => toast.push(String(error), "error"))
                  }
                  onPurge={() => setConfirm({ kind: "purge", item })}
                />
              ))}
            </section>
          )}
        </>
      )}
      <Dialog
        open={saveViewOpen}
        onOpenChange={(open) => { setSaveViewOpen(open); if (!open) setSavedViewName(""); }}
        title="Save workflow view"
        description="Save the current workflow search, filters, folder, and sort order on this device."
        footer={<><button className="button" onClick={() => setSaveViewOpen(false)}>Cancel</button><button className="button primary" disabled={!validSavedViewName || savedViews.length >= MAX_DASHBOARD_SAVED_VIEWS} onClick={saveCurrentView}>Save view</button></>}
      >
        <label className="field">
          <span>View name</span>
          <input autoFocus aria-label="View name" value={savedViewName} maxLength={48} onChange={(event) => setSavedViewName(event.target.value)} />
        </label>
        {savedViewName && !validSavedViewName && <div className="error-banner">Use a unique name between 1 and 48 characters.</div>}
        {savedViews.length >= MAX_DASHBOARD_SAVED_VIEWS && <div className="info-note">You can save up to {MAX_DASHBOARD_SAVED_VIEWS} views. Delete one before adding another.</div>}
        <div className="saved-view-summary"><b>Current criteria</b><span>{describeSavedView({ id: "current", name: "Current", state: currentViewState(), createdAt: 0, updatedAt: 0 })}</span></div>
      </Dialog>
      <Dialog
        open={manageViewsOpen}
        onOpenChange={(open) => { setManageViewsOpen(open); if (!open) { setRenamingViewId(undefined); setRenameValue(""); } }}
        title="Manage saved views"
        description="Saved views are stored locally on this device."
      >
        <div className="saved-view-list">
          {savedViews.length === 0 ? <p className="muted">No saved views yet.</p> : savedViews.map(savedView => (
            <div className="saved-view-row" key={savedView.id}>
              {renamingViewId === savedView.id ? <div className="saved-view-rename"><input aria-label={`Rename ${savedView.name}`} autoFocus value={renameValue} maxLength={48} onChange={(event) => setRenameValue(event.target.value)} />{renameValue && !validRename && <small>Use a unique name between 1 and 48 characters.</small>}<div><button className="button" onClick={() => { setRenamingViewId(undefined); setRenameValue(""); }}>Cancel</button><button className="button primary" disabled={!validRename} onClick={renameSavedView}>Save</button></div></div> : <><button className="saved-view-apply" onClick={() => { applySavedView(savedView); setManageViewsOpen(false); }}><b>{savedView.name}</b><small>{describeSavedView(savedView)}</small></button><div className="saved-view-row-actions"><button className="button" aria-label={`Rename ${savedView.name}`} onClick={() => { setRenamingViewId(savedView.id); setRenameValue(savedView.name); }}>Rename</button><button className="button danger-text" aria-label={`Delete ${savedView.name}`} onClick={() => removeSavedView(savedView.id)}>Delete</button></div></>}
            </div>
          ))}
        </div>
      </Dialog>
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create workflow"
        description="Choose a starting point, then name the workflow before creating it."
        width="large"
        footer={
          <>
            <button
              className="button"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!name.trim() || creating}
              onClick={() => void submitCreate()}
            >
              {creating ? "Creating…" : "Create workflow"}
            </button>
          </>
        }
      >
        <div className="creation-layout">
          <div
            className="template-choices"
            role="radiogroup"
            aria-label="Workflow templates"
          >
            {ALL_WORKFLOW_STARTERS.map((item) => (
              <button
                role="radio"
                aria-checked={template.key === item.key}
                className={template.key === item.key ? "active" : ""}
                key={item.key}
                onClick={() => {
                  setTemplate(item);
                  setName(item.name);
                }}
              >
                <b>{item.name}</b>
                <span>{item.flow}</span>
                <small>{item.requirements}</small>
              </button>
            ))}
          </div>
          <label className="field">
            <span>Workflow name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
          </label>
        </div>
      </Dialog>
      <Dialog
        open={Boolean(organize)}
        onOpenChange={(open) => !open && setOrganize(undefined)}
        title="Organize workflow"
        description="Folder and tags are local organization data and do not change exported workflows."
        footer={
          <>
            <button className="button" onClick={() => setOrganize(undefined)}>
              Cancel
            </button>
            <button
              className="button primary"
              onClick={() => {
                if (organize)
                  void updateMetadata(organize.workflow.id, {
                    folder: organizeFolder || null,
                    tags: tags.split(","),
                  }).then((saved) => saved && setOrganize(undefined));
              }}
            >
              Save organization
            </button>
          </>
        }
      >
        <label className="field">
          <span>Folder</span>
          <input
            value={organizeFolder}
            maxLength={64}
            onChange={(event) => setOrganizeFolder(event.target.value)}
          />
        </label>
        <label className="field">
          <span>
            Tags <small>Comma separated, up to 10</small>
          </span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
      </Dialog>
      <Dialog
        open={bulkDialog === "folder"}
        onOpenChange={(open) => !open && setBulkDialog(undefined)}
        title={`Move ${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"}`}
        description="Set one local folder for every selected workflow. Leave it empty to remove the folder."
        footer={
          <>
            <button className="button" disabled={bulkBusy} onClick={() => setBulkDialog(undefined)}>Cancel</button>
            <button className="button primary" disabled={bulkBusy} onClick={() => void runBulkMetadata({ folder: bulkFolder.trim() || null }, `${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"} moved.`)}>{bulkBusy ? "Moving…" : "Move workflows"}</button>
          </>
        }
      >
        <label className="field">
          <span>Folder</span>
          <input autoFocus value={bulkFolder} maxLength={64} onChange={(event) => setBulkFolder(event.target.value)} />
        </label>
      </Dialog>
      <Dialog
        open={bulkDialog === "tags"}
        onOpenChange={(open) => !open && setBulkDialog(undefined)}
        title={`Update tags on ${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"}`}
        description="Add or remove the listed tags while keeping every workflow's other tags intact."
        footer={
          <>
            <button className="button" disabled={bulkBusy} onClick={() => setBulkDialog(undefined)}>Cancel</button>
            <button className="button primary" disabled={bulkBusy || !bulkTags.trim()} onClick={() => {
              const values = bulkTags.split(",").map((value) => value.trim()).filter(Boolean);
              void runBulkMetadata(bulkTagMode === "add" ? { addTags: values } : { removeTags: values }, `${bulkTagMode === "add" ? "Added tags to" : "Removed tags from"} ${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"}.`);
            }}>{bulkBusy ? "Saving…" : "Update tags"}</button>
          </>
        }
      >
        <label className="field">
          <span>Action</span>
          <CustomSelect aria-label="Tag action" value={bulkTagMode} onChange={(event) => setBulkTagMode(event.target.value as "add" | "remove")}>
            <option value="add">Add tags</option>
            <option value="remove">Remove tags</option>
          </CustomSelect>
        </label>
        <label className="field">
          <span>Tags <small>Comma separated</small></span>
          <input autoFocus value={bulkTags} onChange={(event) => setBulkTags(event.target.value)} />
        </label>
      </Dialog>
      <ConfirmDialog
        open={Boolean(bulkConfirm)}
        onOpenChange={(open) => !open && setBulkConfirm(undefined)}
        title={bulkConfirm === "restore" ? `Restore ${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"}?` : `Archive ${selectedItems.length} workflow${selectedItems.length === 1 ? "" : "s"}?`}
        description={bulkConfirm === "restore" ? `The ${selectedItems.length} selected workflows will return to the main list and remain disabled.` : `The ${selectedItems.length} selected workflows will move to Archived. Any active schedules will be disabled atomically.`}
        confirmLabel={bulkConfirm === "restore" ? "Restore workflows" : "Archive workflows"}
        dangerous={bulkConfirm !== "restore"}
        busy={bulkBusy}
        onConfirm={() => void confirmBulkArchive()}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => !open && setConfirm(undefined)}
        title={
          confirm?.kind === "purge"
            ? "Permanently delete workflow?"
            : "Archive workflow?"
        }
        description={
          confirm?.kind === "purge"
            ? "The workflow, its execution history, and associated artifacts will be permanently deleted."
            : confirm?.item.workflow.enabled
              ? "This enabled workflow will be disabled before it is archived. Restoring it will not re-enable schedules."
              : "The workflow will move to Archived and remain disabled when restored."
        }
        confirmLabel={
          confirm?.kind === "purge" ? "Delete permanently" : "Archive"
        }
        dangerous
        onConfirm={() => void actConfirm()}
      />
    </main>
  );
}

function WorkflowRow({
  item,
  dateDisplay,
  running,
  selected,
  onSelect,
  onOpen,
  onRun,
  onFavorite,
  onDuplicate,
  onOrganize,
  onArchive,
  onRestore,
  onExport,
  onPurge,
}: {
  item: WorkflowSummary;
  dateDisplay: "relative" | "absolute";
  running: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onOpen: () => void;
  onRun: () => void;
  onFavorite: () => void;
  onDuplicate: () => void;
  onOrganize: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onExport: () => void;
  onPurge: () => void;
}) {
  const { workflow, metadata, lastExecution, nextRunAt } = item;
  const trigger = workflow.nodes.find(
    (node) => node.id === workflow.triggerNodeId,
  );
  const TriggerIcon = trigger ? definitionFor(trigger.type).icon : Clock3;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      className={`workflow-row ${selected ? "selected" : ""}`}
      tabIndex={0}
      role="link"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <div className="workflow-name">
        <input
          className="workflow-select"
          type="checkbox"
          aria-label={`Select ${workflow.name}`}
          checked={selected}
          onClick={stop}
          onChange={(event) => onSelect(event.target.checked)}
        />
        <button
          className={`favorite ${metadata.favorite ? "active" : ""}`}
          aria-label={`${metadata.favorite ? "Remove" : "Add"} ${workflow.name} ${metadata.favorite ? "from" : "to"} favorites`}
          onClick={(event) => {
            stop(event);
            onFavorite();
          }}
        >
          <Star size={14} fill={metadata.favorite ? "currentColor" : "none"} />
        </button>
        <span className={`enable-dot ${workflow.enabled ? "enabled" : ""}`} />
        <div>
          <b>{workflow.name}</b>
          <small title={`Updated ${new Date(workflow.updatedAt).toLocaleString()}`}>
            {workflow.description ||
              `${workflow.nodes.length} ${workflow.nodes.length === 1 ? "node" : "nodes"} · Updated ${formatDate(workflow.updatedAt, dateDisplay)}`}
            {metadata.folder ? ` · ${metadata.folder}` : ""}
          </small>
        </div>
      </div>
      <div className="muted-cell">
        <TriggerIcon size={14} />
        {trigger?.name ?? "Missing trigger"}
      </div>
      <div>
        {lastExecution ? (
          <>
            <Status status={lastExecution.status} />
            <small title={new Date(lastExecution.startedAt).toLocaleString()}>
              {formatDate(lastExecution.startedAt, dateDisplay)}
            </small>
          </>
        ) : (
          <span className="muted">Never run</span>
        )}
      </div>
      <div
        className="muted-cell"
        title={nextRunAt ? new Date(nextRunAt).toLocaleString() : undefined}
      >
        {nextRunAt ? (
          <>
            <Clock3 size={14} />
            {formatDate(nextRunAt, dateDisplay)}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      <div className="row-actions" onClick={stop}>
        <button
          className="icon-button"
          title="Run workflow"
          aria-label={`Run ${workflow.name}`}
          disabled={running || Boolean(metadata.archivedAt)}
          onClick={onRun}
        >
          <Play size={14} fill="currentColor" />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="icon-button"
              aria-label={`More actions for ${workflow.name}`}
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu" align="end">
              <DropdownMenu.Item onSelect={onOpen}>
                Open workflow
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onDuplicate}>
                <Copy size={14} />
                Duplicate
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onOrganize}>
                <Folder size={14} />
                Organize
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onExport}>
                <Download size={14} />
                Export
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              {metadata.archivedAt ? (
                <>
                  <DropdownMenu.Item onSelect={onRestore}>
                    <RotateCcw size={14} />
                    Restore disabled
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="danger" onSelect={onPurge}>
                    <Trash2 size={14} />
                    Delete permanently
                  </DropdownMenu.Item>
                </>
              ) : (
                <DropdownMenu.Item className="danger" onSelect={onArchive}>
                  <Archive size={14} />
                  Archive
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
function formatDate(value: string, display: "relative" | "absolute") {
  const date = new Date(value);
  return display === "relative"
    ? formatDistanceToNow(date, { addSuffix: true })
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
