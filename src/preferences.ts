import { useEffect } from "react";
import { create } from "zustand";

export type Accent = "lime" | "violet" | "blue";
export type Density = "comfortable" | "compact";
export type ColorScheme = "system" | "light" | "dark";
export type DarkSurface = "charcoal" | "oled";
export type StartView = "workflows" | "history";
export type DateDisplay = "relative" | "absolute";
export type UpdateChannel = "beta" | "stable";

export interface AppPreferences {
  accent: Accent;
  density: Density;
  colorScheme: ColorScheme;
  darkSurface: DarkSurface;
  startView: StartView;
  restoreLastWorkspace: boolean;
  dateDisplay: DateDisplay;
  reduceMotion: boolean;
  increasedContrast: boolean;
  accessibleEditorDefault: boolean;
  snapToGrid: boolean;
  gridSize: 10 | 20 | 40;
  showCanvasHints: boolean;
  showNodeDescriptions: boolean;
  showAskAiOnNodeInteraction: boolean;
  showAskAiOnNodeIssues: boolean;
  confirmNodeDeletion: boolean;
  confirmBeforeLeaving: boolean;
  checkForUpdates: boolean;
  updateChannel: UpdateChannel;
  sidebarCollapsed: boolean;
  editorInspectorWidth: number;
}

export const defaultPreferences: AppPreferences = {
  accent: "lime",
  density: "comfortable",
  colorScheme: "system",
  darkSurface: "charcoal",
  startView: "workflows",
  restoreLastWorkspace: false,
  dateDisplay: "relative",
  reduceMotion: false,
  increasedContrast: false,
  accessibleEditorDefault: false,
  snapToGrid: true,
  gridSize: 20,
  showCanvasHints: true,
  showNodeDescriptions: true,
  showAskAiOnNodeInteraction: true,
  showAskAiOnNodeIssues: true,
  confirmNodeDeletion: true,
  confirmBeforeLeaving: true,
  checkForUpdates: true,
  updateChannel: "beta",
  sidebarCollapsed: false,
  editorInspectorWidth: 320,
};

const STORAGE_KEY = "sandbox.app-preferences.v2";
const LEGACY_STORAGE_KEY = "sandbox.app-preferences.v1";
const accents = new Set<Accent>(["lime", "violet", "blue"]);
const densities = new Set<Density>(["comfortable", "compact"]);
const schemes = new Set<ColorScheme>(["system", "light", "dark"]);
const surfaces = new Set<DarkSurface>(["charcoal", "oled"]);
const startViews = new Set<StartView>(["workflows", "history"]);
const dateDisplays = new Set<DateDisplay>(["relative", "absolute"]);
const gridSizes = new Set([10, 20, 40]);
const updateChannels = new Set<UpdateChannel>(["beta", "stable"]);

export function normalisePreferences(value: unknown, legacy = false): AppPreferences {
  if (!value || typeof value !== "object") return { ...defaultPreferences };
  const input = value as Partial<AppPreferences> & { surfaceTheme?: DarkSurface };
  return {
    accent: accents.has(input.accent as Accent) ? input.accent as Accent : defaultPreferences.accent,
    density: densities.has(input.density as Density) ? input.density as Density : defaultPreferences.density,
    colorScheme: schemes.has(input.colorScheme as ColorScheme) ? input.colorScheme as ColorScheme : legacy ? "dark" : defaultPreferences.colorScheme,
    darkSurface: surfaces.has((input.darkSurface ?? input.surfaceTheme) as DarkSurface) ? (input.darkSurface ?? input.surfaceTheme) as DarkSurface : defaultPreferences.darkSurface,
    startView: startViews.has(input.startView as StartView) ? input.startView as StartView : defaultPreferences.startView,
    restoreLastWorkspace: typeof input.restoreLastWorkspace === "boolean" ? input.restoreLastWorkspace : defaultPreferences.restoreLastWorkspace,
    dateDisplay: dateDisplays.has(input.dateDisplay as DateDisplay) ? input.dateDisplay as DateDisplay : defaultPreferences.dateDisplay,
    reduceMotion: typeof input.reduceMotion === "boolean" ? input.reduceMotion : defaultPreferences.reduceMotion,
    increasedContrast: typeof input.increasedContrast === "boolean" ? input.increasedContrast : defaultPreferences.increasedContrast,
    accessibleEditorDefault: typeof input.accessibleEditorDefault === "boolean" ? input.accessibleEditorDefault : defaultPreferences.accessibleEditorDefault,
    snapToGrid: typeof input.snapToGrid === "boolean" ? input.snapToGrid : defaultPreferences.snapToGrid,
    gridSize: gridSizes.has(input.gridSize as number) ? input.gridSize as 10 | 20 | 40 : defaultPreferences.gridSize,
    showCanvasHints: typeof input.showCanvasHints === "boolean" ? input.showCanvasHints : defaultPreferences.showCanvasHints,
    showNodeDescriptions: typeof input.showNodeDescriptions === "boolean" ? input.showNodeDescriptions : defaultPreferences.showNodeDescriptions,
    showAskAiOnNodeInteraction: typeof input.showAskAiOnNodeInteraction === "boolean" ? input.showAskAiOnNodeInteraction : defaultPreferences.showAskAiOnNodeInteraction,
    showAskAiOnNodeIssues: typeof input.showAskAiOnNodeIssues === "boolean" ? input.showAskAiOnNodeIssues : defaultPreferences.showAskAiOnNodeIssues,
    confirmNodeDeletion: typeof input.confirmNodeDeletion === "boolean" ? input.confirmNodeDeletion : defaultPreferences.confirmNodeDeletion,
    confirmBeforeLeaving: typeof input.confirmBeforeLeaving === "boolean" ? input.confirmBeforeLeaving : defaultPreferences.confirmBeforeLeaving,
    checkForUpdates: typeof input.checkForUpdates === "boolean" ? input.checkForUpdates : defaultPreferences.checkForUpdates,
    updateChannel: updateChannels.has(input.updateChannel as UpdateChannel) ? input.updateChannel as UpdateChannel : defaultPreferences.updateChannel,
    sidebarCollapsed: typeof input.sidebarCollapsed === "boolean" ? input.sidebarCollapsed : defaultPreferences.sidebarCollapsed,
    editorInspectorWidth: typeof input.editorInspectorWidth === "number" ? Math.max(280, Math.min(480, Math.round(input.editorInspectorWidth))) : defaultPreferences.editorInspectorWidth,
  };
}

function readPreferences(): AppPreferences {
  if (typeof window === "undefined") return { ...defaultPreferences };
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current) return normalisePreferences(JSON.parse(current));
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = normalisePreferences(JSON.parse(legacy), true);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return { ...defaultPreferences };
  }
  catch { return { ...defaultPreferences }; }
}

interface PreferenceStore extends AppPreferences {
  update: (patch: Partial<AppPreferences>) => void;
  reset: () => void;
}

export const usePreferences = create<PreferenceStore>((set) => ({
  ...readPreferences(),
  update: (patch) => set((current) => {
    const next = normalisePreferences({ ...current, ...patch });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }),
  reset: () => set(() => {
    const next = { ...defaultPreferences };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }),
}));

export function applyPreferences(preferences: AppPreferences): void {
  const root = document.documentElement;
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  const effectiveTheme = preferences.colorScheme === "system" ? (systemDark ? "dark" : "light") : preferences.colorScheme;
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.dataset.theme = effectiveTheme;
  root.dataset.surface = preferences.darkSurface;
  root.style.colorScheme = effectiveTheme;
  root.dataset.reduceMotion = String(preferences.reduceMotion);
  root.dataset.contrast = preferences.increasedContrast ? "high" : "standard";
  root.dataset.nodeDescriptions = String(preferences.showNodeDescriptions);
}

export function useApplyPreferences(): void {
  const preferences = usePreferences();
  useEffect(() => {
    applyPreferences(preferences);
    if (preferences.colorScheme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyPreferences(usePreferences.getState());
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [
    preferences.accent,
    preferences.density,
    preferences.colorScheme,
    preferences.darkSurface,
    preferences.reduceMotion,
    preferences.increasedContrast,
    preferences.showNodeDescriptions,
  ]);
}
