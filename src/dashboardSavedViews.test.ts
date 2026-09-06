import { afterEach, describe, expect, it } from "vitest";
import {
  createDashboardSavedView,
  DASHBOARD_SAVED_VIEWS_KEY,
  deleteDashboardSavedView,
  normaliseDashboardSavedViews,
  readDashboardSavedViews,
  renameDashboardSavedView,
  restoreDashboardSavedView,
  type DashboardSavedView,
  type DashboardSavedViewState,
  writeDashboardSavedViews,
} from "./dashboardSavedViews";

const state: DashboardSavedViewState = { search: "report", workflowFilter: "failed", folder: "Operations", sortOrder: "modified" };
const view = (id = "one", name = "Failures", updatedAt = 1): DashboardSavedView => ({ id, name, state, createdAt: 1, updatedAt });
afterEach(() => localStorage.clear());

describe("dashboard saved views", () => {
  it("round-trips valid local views", () => {
    expect(writeDashboardSavedViews([view()])).toBe(true);
    expect(readDashboardSavedViews()).toEqual([view()]);
  });
  it("rejects malformed, unsupported, and invalid fields", () => {
    expect(normaliseDashboardSavedViews({ version: 2, views: [] })).toBeUndefined();
    expect(normaliseDashboardSavedViews({ version: 1, views: [{ ...view(), state: { ...state, workflowFilter: "unknown" } }] })).toBeUndefined();
    localStorage.setItem(DASHBOARD_SAVED_VIEWS_KEY, "{");
    expect(readDashboardSavedViews()).toEqual([]);
    expect(localStorage.getItem(DASHBOARD_SAVED_VIEWS_KEY)).toBeNull();
  });
  it("enforces unique names, renames, and retains ten newest views", () => {
    const views = Array.from({ length: 11 }, (_, index) => view(`id-${index}`, `View ${index}`, index));
    expect(normaliseDashboardSavedViews({ version: 1, views })!).toHaveLength(10);
    expect(createDashboardSavedView([view()], " failures ", state)).toBeUndefined();
    expect(renameDashboardSavedView([view(), view("two", "Scheduled")], "two", "  Queue  ")?.find(item => item.id === "two")?.name).toBe("Queue");
  });
  it("deletes and restores unless a name collision was created", () => {
    const { views, deleted } = deleteDashboardSavedView([view(), view("two", "Scheduled")], "one");
    expect(views).toHaveLength(1);
    expect(restoreDashboardSavedView(views, deleted!)).toHaveLength(2);
    expect(restoreDashboardSavedView([view("replacement", "Failures")], deleted!)).toBeUndefined();
  });
});
