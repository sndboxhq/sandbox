export type DashboardWorkflowFilter = "all" | "favorites" | "scheduled" | "failed" | "archived";
export type DashboardSortOrder = "modified" | "name" | "last-run" | "next-run";

export interface DashboardSavedViewState {
  search: string;
  workflowFilter: DashboardWorkflowFilter;
  folder: string;
  sortOrder: DashboardSortOrder;
}

export interface DashboardSavedView {
  id: string;
  name: string;
  state: DashboardSavedViewState;
  createdAt: number;
  updatedAt: number;
}

interface DashboardSavedViewsSnapshot { version: 1; views: DashboardSavedView[] }

export const DASHBOARD_SAVED_VIEWS_KEY = "sandbox.dashboard-saved-views.v1";
export const MAX_DASHBOARD_SAVED_VIEWS = 10;
const filters = new Set<DashboardWorkflowFilter>(["all", "favorites", "scheduled", "failed", "archived"]);
const sorts = new Set<DashboardSortOrder>(["modified", "name", "last-run", "next-run"]);
const asObject = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const safeText = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum ? value : undefined;

export function normaliseSavedViewName(value: string): string { return value.trim().replace(/\s+/g, " "); }
export function validateSavedViewName(value: string, views: DashboardSavedView[], exceptId?: string): string | undefined {
  const name = normaliseSavedViewName(value);
  if (!name || name.length > 48) return undefined;
  return views.some(view => view.id !== exceptId && view.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ? undefined : name;
}

export function normaliseDashboardSavedViewState(value: unknown): DashboardSavedViewState | undefined {
  const input = asObject(value);
  if (!input) return undefined;
  const search = safeText(input.search, 500); const folder = safeText(input.folder, 500);
  if (search === undefined || folder === undefined || !filters.has(input.workflowFilter as DashboardWorkflowFilter) || !sorts.has(input.sortOrder as DashboardSortOrder)) return undefined;
  return { search, folder, workflowFilter: input.workflowFilter as DashboardWorkflowFilter, sortOrder: input.sortOrder as DashboardSortOrder };
}

export function normaliseDashboardSavedViews(value: unknown, now = Date.now()): DashboardSavedView[] | undefined {
  const snapshot = asObject(value);
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.views)) return undefined;
  const views: DashboardSavedView[] = [];
  const names = new Set<string>();
  for (const raw of snapshot.views) {
    const item = asObject(raw); const name = item && typeof item.name === "string" ? normaliseSavedViewName(item.name) : undefined;
    const state = item && normaliseDashboardSavedViewState(item.state);
    if (!item || !name || name.length > 48 || typeof item.id !== "string" || !item.id || item.id.length > 100 || !state || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt) || typeof item.updatedAt !== "number" || !Number.isFinite(item.updatedAt) || item.createdAt > now + 300_000 || item.updatedAt > now + 300_000) return undefined;
    const key = name.toLocaleLowerCase(); if (names.has(key)) return undefined; names.add(key);
    views.push({ id: item.id, name, state, createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  return views.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DASHBOARD_SAVED_VIEWS);
}

export function readDashboardSavedViews(): DashboardSavedView[] {
  try { const value = normaliseDashboardSavedViews(JSON.parse(localStorage.getItem(DASHBOARD_SAVED_VIEWS_KEY) ?? "null")); if (!value) localStorage.removeItem(DASHBOARD_SAVED_VIEWS_KEY); return value ?? []; } catch { try { localStorage.removeItem(DASHBOARD_SAVED_VIEWS_KEY); } catch {} return []; }
}
export function writeDashboardSavedViews(views: DashboardSavedView[]): boolean {
  try { const normalised = normaliseDashboardSavedViews({ version: 1, views }); if (!normalised) return false; localStorage.setItem(DASHBOARD_SAVED_VIEWS_KEY, JSON.stringify({ version: 1, views: normalised } satisfies DashboardSavedViewsSnapshot)); return true; } catch { return false; }
}
export function createDashboardSavedView(views: DashboardSavedView[], name: string, state: DashboardSavedViewState, now = Date.now()): DashboardSavedView | undefined {
  const validName = validateSavedViewName(name, views); if (!validName || views.length >= MAX_DASHBOARD_SAVED_VIEWS) return undefined;
  return { id: crypto.randomUUID(), name: validName, state, createdAt: now, updatedAt: now };
}
export function renameDashboardSavedView(views: DashboardSavedView[], id: string, name: string, now = Date.now()): DashboardSavedView[] | undefined {
  const validName = validateSavedViewName(name, views, id); if (!validName || !views.some(view => view.id === id)) return undefined;
  return views.map(view => view.id === id ? { ...view, name: validName, updatedAt: now } : view);
}
export function deleteDashboardSavedView(views: DashboardSavedView[], id: string): { views: DashboardSavedView[]; deleted?: DashboardSavedView } {
  const deleted = views.find(view => view.id === id); return { deleted, views: views.filter(view => view.id !== id) };
}
export function restoreDashboardSavedView(views: DashboardSavedView[], view: DashboardSavedView): DashboardSavedView[] | undefined {
  if (views.length >= MAX_DASHBOARD_SAVED_VIEWS || !validateSavedViewName(view.name, views) || views.some(item => item.id === view.id)) return undefined;
  return [view, ...views];
}
export const dashboardSavedViewMatches = (state: DashboardSavedViewState, view: DashboardSavedView) => state.search === view.state.search && state.workflowFilter === view.state.workflowFilter && state.folder === view.state.folder && state.sortOrder === view.state.sortOrder;
