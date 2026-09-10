import type { View } from "./store";

export const WORKSPACE_STORAGE_KEY = "sandbox.workspace-session.v1";
const VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EDITOR_ENTRIES = 20;

export interface EditorWorkspaceState {
  selectedNodeId?: string;
  executionDrawerOpen: boolean;
  accessibleEditorOpen: boolean;
  visitedAt: number;
}
export interface DashboardWorkspaceState {
  activeTab: "workflows" | "templates";
  search: string;
  workflowFilter: "all" | "favorites" | "scheduled" | "failed" | "archived";
  folder: string;
  sortOrder: string;
  templateCategory: string;
}
export interface HistoryWorkspaceState {
  search: string; workflowId: string; status: string; trigger: string; startDate: string; endDate: string;
}
export interface WorkspaceSnapshot {
  version: 1;
  view: View;
  workflowId?: string;
  editors: Record<string, EditorWorkspaceState>;
  dashboard: DashboardWorkspaceState;
  history: HistoryWorkspaceState;
  updatedAt: number;
}

const views = new Set<View>(["workflows", "history", "editor", "settings", "approvals", "plugins", "cloud"]);
const filters = new Set<DashboardWorkspaceState["workflowFilter"]>(["all", "favorites", "scheduled", "failed", "archived"]);
const tabs = new Set<DashboardWorkspaceState["activeTab"]>(["workflows", "templates"]);
const sorts = new Set(["modified", "name", "last-run", "next-run"]);
const templateCategories = new Set(["all", "AI", "Monitoring", "Browser", "Communication", "Files", "Developer"]);
const statuses = new Set(["", "successful", "failed", "running", "queued", "cancelled", "skipped"]);
const triggers = new Set(["", "manual", "schedule", "file_watch", "polling"]);
const string = (value: unknown, max = 500) => typeof value === "string" && value.length <= max ? value : undefined;
const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const defaultWorkspaceSnapshot = (): WorkspaceSnapshot => ({
  version: VERSION, view: "workflows", editors: {},
  dashboard: { activeTab: "workflows", search: "", workflowFilter: "all", folder: "", sortOrder: "modified", templateCategory: "all" },
  history: { search: "", workflowId: "", status: "", trigger: "", startDate: "", endDate: "" }, updatedAt: Date.now(),
});

export function normaliseWorkspaceSnapshot(value: unknown, now = Date.now()): WorkspaceSnapshot | undefined {
  const input = object(value);
  if (!input || input.version !== VERSION || !views.has(input.view as View) || typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt) || now - input.updatedAt > MAX_AGE_MS || input.updatedAt > now + 5 * 60_000) return undefined;
  const dashboard = object(input.dashboard); const history = object(input.history); const editors = object(input.editors);
  if (!dashboard || !history || !editors || !tabs.has(dashboard.activeTab as DashboardWorkspaceState["activeTab"]) || !filters.has(dashboard.workflowFilter as DashboardWorkspaceState["workflowFilter"])) return undefined;
  const dashboardFields = ["search", "folder", "sortOrder", "templateCategory"].map(key => string(dashboard[key]));
  const historyFields = ["search", "workflowId", "status", "trigger", "startDate", "endDate"].map(key => string(history[key]));
  if (dashboardFields.some(value => value === undefined) || historyFields.some(value => value === undefined) || !sorts.has(dashboard.sortOrder as string) || !templateCategories.has(dashboard.templateCategory as string) || !statuses.has(history.status as string) || !triggers.has(history.trigger as string) || ![history.startDate, history.endDate].every(value => value === "" || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)))) return undefined;
  const validEditors: Record<string, EditorWorkspaceState> = {};
  for (const [id, raw] of Object.entries(editors)) {
    const editor = object(raw); const selectedNodeId = editor && (editor.selectedNodeId === undefined ? undefined : string(editor.selectedNodeId));
    if (!id || id.length > 200 || !editor || bool(editor.executionDrawerOpen) === undefined || bool(editor.accessibleEditorOpen) === undefined || typeof editor.visitedAt !== "number" || !Number.isFinite(editor.visitedAt) || (editor.selectedNodeId !== undefined && selectedNodeId === undefined)) continue;
    validEditors[id] = { selectedNodeId, executionDrawerOpen: editor.executionDrawerOpen as boolean, accessibleEditorOpen: editor.accessibleEditorOpen as boolean, visitedAt: editor.visitedAt };
  }
  const trimmedEditors = Object.fromEntries(Object.entries(validEditors).sort((a, b) => b[1].visitedAt - a[1].visitedAt).slice(0, MAX_EDITOR_ENTRIES));
  const workflowId = input.workflowId === undefined ? undefined : string(input.workflowId, 200);
  if (input.workflowId !== undefined && !workflowId) return undefined;
  return { version: VERSION, view: input.view as View, workflowId, editors: trimmedEditors, dashboard: { activeTab: dashboard.activeTab as DashboardWorkspaceState["activeTab"], search: dashboardFields[0]!, workflowFilter: dashboard.workflowFilter as DashboardWorkspaceState["workflowFilter"], folder: dashboardFields[1]!, sortOrder: dashboardFields[2]!, templateCategory: dashboardFields[3]! }, history: { search: historyFields[0]!, workflowId: historyFields[1]!, status: historyFields[2]!, trigger: historyFields[3]!, startDate: historyFields[4]!, endDate: historyFields[5]! }, updatedAt: input.updatedAt };
}

export function readWorkspaceSnapshot(): WorkspaceSnapshot | undefined {
  try { const parsed = normaliseWorkspaceSnapshot(JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "null")); if (!parsed) localStorage.removeItem(WORKSPACE_STORAGE_KEY); return parsed; } catch { try { localStorage.removeItem(WORKSPACE_STORAGE_KEY); } catch {} return undefined; }
}
export function writeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void { try { localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ ...snapshot, editors: Object.fromEntries(Object.entries(snapshot.editors).sort((a, b) => b[1].visitedAt - a[1].visitedAt).slice(0, MAX_EDITOR_ENTRIES)), updatedAt: Date.now() })); } catch { /* local state must never block the UI */ } }
export function updateWorkspaceSnapshot(update: (current: WorkspaceSnapshot) => WorkspaceSnapshot): void { writeWorkspaceSnapshot(update(readWorkspaceSnapshot() ?? defaultWorkspaceSnapshot())); }
export function clearWorkspaceAndRecovery(): void { try { const keys: string[] = []; for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key && (key === WORKSPACE_STORAGE_KEY || key.startsWith("sandbox.workflow-draft.v1.") || key.startsWith("sandbox.workflow-viewport.v1."))) keys.push(key); } keys.forEach(key => localStorage.removeItem(key)); } catch {} }
