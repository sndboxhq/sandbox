import {
  Accessibility,
  Cable,
  Copy,
  ExternalLink,
  FlaskConical,
  Globe2,
  LayoutPanelLeft,
  MoreHorizontal,
  Palette,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Workflow,
} from "lucide-react";
import { CustomSelect } from "./ui/CustomSelect";
import { useEffect, useState, type ReactNode } from "react";
import packageMetadata from "../../package.json";
import { api } from "../api";
import { usePreferences } from "../preferences";
import { checkForDesktopUpdateStatus, DESKTOP_UPDATE_AVAILABLE_EVENT, type DesktopUpdateCheckResult } from "../updates";
import type {
  BrowserEngineStatus,
  BrowserProfile,
  BrowserProfileSettings,
} from "../types";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { ConfirmDialog, FocusDialog } from "./ui/Dialog";
import { clearWorkspaceAndRecovery } from "../workspaceState";

const defaults: BrowserProfileSettings = {
  viewportWidth: 1280,
  viewportHeight: 800,
  permissions: [],
};
type SettingsSectionId =
  | "general"
  | "appearance"
  | "accessibility"
  | "nodes"
  | "connections"
  | "browser"
  | "beta";
const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  icon: ReactNode;
}> = [
  { id: "general", label: "General", icon: <Settings2 size={15} /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  {
    id: "accessibility",
    label: "Accessibility",
    icon: <Accessibility size={15} />,
  },
  { id: "nodes", label: "Node editor", icon: <Workflow size={15} /> },
  { id: "connections", label: "Connections", icon: <Cable size={15} /> },
  { id: "browser", label: "Browser", icon: <Globe2 size={15} /> },
  { id: "beta", label: "Beta & updates", icon: <FlaskConical size={15} /> },
];

export function SettingsView() {
  const preferences = usePreferences();
  const [section, setSection] = useState<SettingsSectionId>(() => {
    const requested = window.sessionStorage.getItem("sandbox:settings-section");
    window.sessionStorage.removeItem("sandbox:settings-section");
    return settingsSections.some((item) => item.id === requested)
      ? (requested as SettingsSectionId)
      : "general";
  });
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [engine, setEngine] = useState<BrowserEngineStatus>();
  const [editing, setEditing] = useState<BrowserProfile | "new">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsSearch, setSettingsSearch] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const [clearRecoveryOpen, setClearRecoveryOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<DesktopUpdateCheckResult>();
  const [profileAction, setProfileAction] = useState<{
    kind: "clear" | "delete";
    profile: BrowserProfile;
  }>();
  const searchResults = settingsSearch.trim()
    ? settingsSections.filter(
        (item) =>
          item.label.toLowerCase().includes(settingsSearch.toLowerCase()) ||
          {
            general: "start date unsaved",
            appearance: "theme light dark system accent density sidebar",
            accessibility: "motion contrast keyboard",
            nodes: "grid canvas editor deletion",
            connections: "credentials gmail webhook vault",
            browser: "profile chromium viewport proxy",
            beta: "updates channel",
          }[item.id].includes(settingsSearch.toLowerCase()),
      )
    : [];
  const focusSection = (id: SettingsSectionId) => {
    setSection(id);
    setSettingsSearch("");
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          ".settings-panel input,.settings-panel select,.settings-panel button",
        )
        ?.focus(),
    );
  };

  const load = async () => {
    try {
      const [nextProfiles, nextEngine] = await Promise.all([
        api.listBrowserProfiles(),
        api.browserEngineStatus(),
      ]);
      setProfiles(nextProfiles);
      setEngine(nextEngine);
    } catch (value) {
      setError(`Settings could not load: ${String(value)}`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await load();
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const checkForUpdateNow = async () => {
    setCheckingUpdate(true);
    const result = await checkForDesktopUpdateStatus(preferences.updateChannel);
    setUpdateCheck(result);
    if (result.status === "available") {
      window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_AVAILABLE_EVENT, { detail: result.update }));
    }
    setCheckingUpdate(false);
  };

  return (
    <main className="content settings-page">
      <header className="settings-topbar">
        <span>Settings</span>
        <div className="settings-search">
          <Search size={13} />
          <input
            aria-label="Search settings"
            placeholder="Search settings…"
            value={settingsSearch}
            onChange={(event) => setSettingsSearch(event.target.value)}
          />
          {searchResults.length > 0 && (
            <div className="settings-search-results">
              {searchResults.map((item) => (
                <button key={item.id} onClick={() => focusSection(item.id)}>
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="settings-reset" onClick={() => setResetOpen(true)}>
          <RotateCcw size={13} />
          Restore defaults
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {settingsSections.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "active" : ""}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-panel">
          {section === "general" && (
            <PreferencePanel
              title="General"
              description="Choose how sndbox starts and how everyday workflow information is presented."
            >
              <SelectPreference
                label="Start screen"
                description="The view sndbox opens after launch."
                value={preferences.startView}
                onChange={(value) =>
                  preferences.update({
                    startView: value as "workflows" | "history",
                  })
                }
              >
                <option value="workflows">Workflows</option>
                <option value="history">Run history</option>
              </SelectPreference>
              <PreferenceToggle
                label="Resume previous workspace"
                description="Restore local screens, filters, and editor context when sndbox launches. Recovery drafts stay on this device."
                checked={preferences.restoreLastWorkspace}
                onChange={(restoreLastWorkspace) => preferences.update({ restoreLastWorkspace })}
              />
              <SelectPreference
                label="Date and time"
                description="Show timestamps relative to now or with your system locale."
                value={preferences.dateDisplay}
                onChange={(value) =>
                  preferences.update({
                    dateDisplay: value as "relative" | "absolute",
                  })
                }
              >
                <option value="relative">Relative</option>
                <option value="absolute">Date and time</option>
              </SelectPreference>
              <PreferenceToggle
                label="Confirm unsaved navigation"
                description="Warn before leaving a workflow with local changes."
                checked={preferences.confirmBeforeLeaving}
                onChange={(confirmBeforeLeaving) =>
                  preferences.update({ confirmBeforeLeaving })
                }
              />
              <button className="button" onClick={() => setClearRecoveryOpen(true)}>Clear remembered workspace and recovery drafts</button>
            </PreferencePanel>
          )}
          {section === "appearance" && (
            <PreferencePanel
              title="Appearance"
              description="Tune the workspace for your display without changing workflow content."
            >
              <SelectPreference
                label="Colour scheme"
                description="Follow Windows or keep sndbox light or dark."
                value={preferences.colorScheme}
                onChange={(value) =>
                  preferences.update({
                    colorScheme: value as "system" | "light" | "dark",
                  })
                }
              >
                <option value="system">Use system setting</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </SelectPreference>
              <SelectPreference
                disabled={preferences.colorScheme === "light"}
                label="Dark surface"
                description="Choose the background used when the dark scheme is active."
                value={preferences.darkSurface}
                onChange={(value) =>
                  preferences.update({
                    darkSurface: value as "charcoal" | "oled",
                  })
                }
              >
                <option value="charcoal">Charcoal</option>
                <option value="oled">OLED black</option>
              </SelectPreference>
              <SelectPreference
                label="Accent colour"
                description="Used for focus, active controls, and live workflow state."
                value={preferences.accent}
                onChange={(value) =>
                  preferences.update({
                    accent: value as "lime" | "violet" | "blue",
                  })
                }
              >
                <option value="lime">sndbox lime</option>
                <option value="violet">Violet</option>
                <option value="blue">Electric blue</option>
              </SelectPreference>
              <SelectPreference
                label="Interface density"
                description="Reduce spacing on information-dense screens."
                value={preferences.density}
                onChange={(value) =>
                  preferences.update({
                    density: value as "comfortable" | "compact",
                  })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </SelectPreference>
              <PreferenceToggle
                icon={<LayoutPanelLeft size={14} />}
                label="Compact sidebar"
                description="Give the canvas and wide tables more horizontal room."
                checked={preferences.sidebarCollapsed}
                onChange={(sidebarCollapsed) =>
                  preferences.update({ sidebarCollapsed })
                }
              />
            </PreferencePanel>
          )}
          {section === "accessibility" && (
            <PreferencePanel
              title="Accessibility"
              description="Defaults that reduce visual load and keep the editor usable without drag interactions."
            >
              <PreferenceToggle
                label="Reduce motion"
                description="Stop decorative transitions and pulsing states."
                checked={preferences.reduceMotion}
                onChange={(reduceMotion) =>
                  preferences.update({ reduceMotion })
                }
              />
              <PreferenceToggle
                label="Increase contrast"
                description="Strengthen borders, muted text, and keyboard focus rings."
                checked={preferences.increasedContrast}
                onChange={(increasedContrast) =>
                  preferences.update({ increasedContrast })
                }
              />
              <PreferenceToggle
                label="Accessible editor by default"
                description="Open the structured, keyboard-friendly workflow editor with each workflow."
                checked={preferences.accessibleEditorDefault}
                onChange={(accessibleEditorDefault) =>
                  preferences.update({ accessibleEditorDefault })
                }
              />
            </PreferencePanel>
          )}
          {section === "nodes" && (
            <PreferencePanel
              title="Node editor"
              description="Control canvas guidance, node detail, and placement behaviour."
            >
              <PreferenceToggle
                label="Snap nodes to grid"
                description="Align moved nodes to a consistent canvas grid."
                checked={preferences.snapToGrid}
                onChange={(snapToGrid) => preferences.update({ snapToGrid })}
              />
              <SelectPreference
                disabled={!preferences.snapToGrid}
                label="Grid spacing"
                description="Distance between canvas alignment points."
                value={String(preferences.gridSize)}
                onChange={(value) =>
                  preferences.update({
                    gridSize: Number(value) as 10 | 20 | 40,
                  })
                }
              >
                <option value="10">Fine · 10 px</option>
                <option value="20">Balanced · 20 px</option>
                <option value="40">Wide · 40 px</option>
              </SelectPreference>
              <PreferenceToggle
                label="Show canvas hints"
                description="Display the add-node keyboard and double-click hint."
                checked={preferences.showCanvasHints}
                onChange={(showCanvasHints) =>
                  preferences.update({ showCanvasHints })
                }
              />
              <PreferenceToggle
                label="Show node descriptions"
                description="Keep configuration summaries visible inside node cards."
                checked={preferences.showNodeDescriptions}
                onChange={(showNodeDescriptions) =>
                  preferences.update({ showNodeDescriptions })
                }
              />
              <PreferenceToggle
                label="Ask AI on hover or selection"
                description="Show an Ask AI shortcut above a node when it is hovered or selected."
                checked={preferences.showAskAiOnNodeInteraction}
                onChange={(showAskAiOnNodeInteraction) =>
                  preferences.update({ showAskAiOnNodeInteraction })
                }
              />
              <PreferenceToggle
                label="Ask AI for node issues"
                description="Keep the Ask AI shortcut visible on nodes with validation issues or failed runs."
                checked={preferences.showAskAiOnNodeIssues}
                onChange={(showAskAiOnNodeIssues) =>
                  preferences.update({ showAskAiOnNodeIssues })
                }
              />
              <PreferenceToggle
                label="Confirm configured node deletion"
                description="Ask before deleting a node that already contains configuration."
                checked={preferences.confirmNodeDeletion}
                onChange={(confirmNodeDeletion) =>
                  preferences.update({ confirmNodeDeletion })
                }
              />
            </PreferencePanel>
          )}
          {section === "connections" && <ConnectionsSettings />}
          {section === "browser" && (
            <section className="settings-section settings-browser-section">
              <div className="settings-heading">
                <div>
                  <h2>Browser profiles</h2>
                  <p>
                    Isolated Chromium identities. sndbox never reads your
                    personal browser profile.
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setEditing("new")}
                >
                  <Plus size={14} />
                  New profile
                </button>
              </div>
              <div
                className={`engine-health ${engine?.available ? "available" : "unavailable"}`}
              >
                <span />
                <div>
                  <b>
                    {engine?.available
                      ? `Managed Chromium ${engine.browserVersion ?? "ready"}`
                      : "Browser engine unavailable"}
                  </b>
                  <small>
                    {engine?.available
                      ? `Sidecar ${engine.sidecarVersion} · authenticated protocol v${engine.protocolVersion}`
                      : (engine?.error ?? "Checking the packaged runtime…")}
                  </small>
                </div>
                {!engine?.available && api.isDesktop && (
                  <button
                    className="button"
                    onClick={() => act(() => api.restartBrowserEngine())}
                  >
                    <RefreshCcw size={13} />
                    Restart engine
                  </button>
                )}
              </div>
              {error && (
                <div className="error-banner">
                  <b>{error}</b>
                </div>
              )}
              {profiles.length ? (
                <div className="profile-list">
                  {profiles.map((profile) => (
                    <div className="profile-row" key={profile.id}>
                      <span className="profile-avatar">
                        {profile.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <b>{profile.name}</b>
                        <small>
                          {profile.persistent
                            ? "Persists between runs"
                            : "Clears after each run"}{" "}
                          · {profile.settings?.viewportWidth ?? 1280}×
                          {profile.settings?.viewportHeight ?? 800}
                          {profile.lastUsedAt
                            ? ` · Last used ${new Date(profile.lastUsedAt).toLocaleDateString()}`
                            : " · Never used"}
                        </small>
                      </div>
                      <span className="profile-path">
                        Managed data · {profile.id.slice(0, 8)}
                      </span>
                      <button
                        className="button"
                        disabled={!api.isDesktop}
                        onClick={() =>
                          act(() => api.openBrowserProfile(profile.id))
                        }
                      >
                        <ExternalLink size={13} />
                        Open
                      </button>
                      <button
                        className="icon-button"
                        title="Duplicate without browser data"
                        aria-label={`Duplicate ${profile.name} without browser data`}
                        onClick={() =>
                          act(() => api.duplicateBrowserProfile(profile.id))
                        }
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        className="icon-button"
                        title="Edit profile"
                        aria-label={`Edit ${profile.name}`}
                        onClick={() => setEditing(profile)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="settings-empty">
                  <ShieldCheck size={22} />
                  <h3>No managed profiles</h3>
                  <p>
                    Create an isolated Chromium identity for browser workflows
                    and recording.
                  </p>
                  <button className="button" onClick={() => setEditing("new")}>
                    Create browser profile
                  </button>
                </div>
              )}
            </section>
          )}
          {section === "beta" && (
            <PreferencePanel
              title="Beta & updates"
              description="Control prerelease discovery for this device. Beta updates may change workflow behaviour."
            >
              <PreferenceToggle
                label="Check for desktop updates"
                description="Check the signed GitHub release feed when sndbox starts."
                checked={preferences.checkForUpdates}
                onChange={(checkForUpdates) =>
                  preferences.update({ checkForUpdates })
                }
              />
              <SelectPreference
                disabled={!preferences.checkForUpdates}
                label="Update channel"
                description="Stable ignores prerelease builds; Beta includes newer beta and release-candidate builds."
                value={preferences.updateChannel}
                onChange={(value) =>
                  preferences.update({
                    updateChannel: value as "beta" | "stable",
                  })
                }
              >
                <option value="beta">Beta</option>
                <option value="stable">Stable</option>
              </SelectPreference>
              <div className="settings-release-card">
                <span>Installed version</span>
                <strong>sndbox {packageMetadata.version}</strong>
                <small>
                  Desktop installers and Linux runners are verified against the
                  same immutable release tag.
                </small>
                <div className="settings-release-actions">
                  <button className="button" disabled={!preferences.checkForUpdates || checkingUpdate} onClick={() => void checkForUpdateNow()}>
                    <RefreshCcw className={checkingUpdate ? "spin" : ""} size={13} />
                    {checkingUpdate ? "Checking…" : "Check now"}
                  </button>
                  {updateCheck && <small role={updateCheck.status === "error" ? "alert" : "status"}>
                    {updateCheck.status === "available"
                      ? `sndbox ${updateCheck.update.version} is available. The download action is shown in the sidebar.`
                      : updateCheck.status === "current"
                        ? `No newer ${preferences.updateChannel} release is available. Installed: ${updateCheck.currentVersion}${updateCheck.latestVersion ? `; latest published: ${updateCheck.latestVersion}` : ""}.`
                        : updateCheck.message}
                  </small>}
                </div>
              </div>
            </PreferencePanel>
          )}
        </div>
      </div>
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? undefined : editing}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSave={(name, persistent, settings) =>
            act(() =>
              editing === "new"
                ? api.createBrowserProfile(name, persistent, settings)
                : api.updateBrowserProfile(
                    editing.id,
                    name,
                    persistent,
                    settings,
                  ),
            ).then(() => setEditing(undefined))
          }
          onClear={
            editing !== "new"
              ? () => setProfileAction({ kind: "clear", profile: editing })
              : undefined
          }
          onDelete={
            editing !== "new"
              ? () => setProfileAction({ kind: "delete", profile: editing })
              : undefined
          }
        />
      )}
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Restore all settings?"
        description="Theme, density, accessibility, editor behavior, update preferences, and sidebar layout will return to their defaults. Workflows and credentials are not changed."
        confirmLabel="Restore defaults"
        onConfirm={() => {
          preferences.reset();
          setResetOpen(false);
        }}
      />
      <ConfirmDialog
        open={clearRecoveryOpen}
        onOpenChange={setClearRecoveryOpen}
        title="Clear local workspace recovery?"
        description="This removes remembered screens, recovery drafts, and canvas viewports from this device. Saved workflows, revisions, history, and preferences are unchanged."
        confirmLabel="Clear local recovery"
        dangerous
        onConfirm={() => { clearWorkspaceAndRecovery(); setClearRecoveryOpen(false); }}
      />
      <ConfirmDialog
        open={Boolean(profileAction)}
        onOpenChange={(open) => !open && setProfileAction(undefined)}
        title={
          profileAction?.kind === "delete"
            ? "Delete browser profile?"
            : "Clear browser profile data?"
        }
        description={
          profileAction?.kind === "delete"
            ? "The isolated profile, its cookies, site storage, and downloads will be permanently deleted."
            : "Cookies, site storage, and downloads stored in this isolated profile will be permanently cleared."
        }
        confirmLabel={
          profileAction?.kind === "delete"
            ? "Delete profile"
            : "Clear profile data"
        }
        dangerous
        busy={busy}
        onConfirm={() => {
          if (!profileAction) return;
          const current = profileAction;
          void act(() =>
            current.kind === "delete"
              ? api.deleteBrowserProfile(current.profile.id)
              : api.clearBrowserProfileData(current.profile.id),
          ).then(() => {
            if (current.kind === "delete") setEditing(undefined);
            setProfileAction(undefined);
          });
        }}
      />
    </main>
  );
}

function PreferencePanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="preference-panel">
      <header>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <div className="preference-list">{children}</div>
    </section>
  );
}

function PreferenceToggle({
  label,
  description,
  checked,
  onChange,
  icon,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  icon?: ReactNode;
}) {
  return (
    <label className="preference-row preference-toggle">
      <span>
        {icon}
        <span>
          <b>{label}</b>
          <small>{description}</small>
        </span>
      </span>
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function SelectPreference({
  label,
  description,
  value,
  onChange,
  disabled = false,
  children,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={`preference-row preference-select ${disabled ? "disabled" : ""}`}
    >
      <span>
        <b>{label}</b>
        <small>{description}</small>
      </span>
      <CustomSelect
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </CustomSelect>
    </label>
  );
}

function ProfileEditor({
  profile,
  busy,
  onClose,
  onSave,
  onClear,
  onDelete,
}: {
  profile?: BrowserProfile;
  busy: boolean;
  onClose: () => void;
  onSave: (
    name: string,
    persistent: boolean,
    settings: BrowserProfileSettings,
  ) => void;
  onClear?: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [name, setName] = useState(profile?.name ?? "Work browser");
  const [persistent, setPersistent] = useState(profile?.persistent ?? true);
  const [settings, setSettings] = useState(profile?.settings ?? defaults);
  return (
    <FocusDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={profile ? "Edit browser profile" : "New browser profile"}
      description="Browser data is isolated under this profile ID."
    >
      <div className="settings-modal">
        <header>
          <div>
            <h2>{profile ? "Edit browser profile" : "New browser profile"}</h2>
            <p>Browser data is isolated under this profile ID.</p>
          </div>
        </header>
        <section>
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="field-grid">
            <label className="field">
              <span>Viewport width</span>
              <input
                type="number"
                min="320"
                max="3840"
                value={settings.viewportWidth}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    viewportWidth: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="field">
              <span>Viewport height</span>
              <input
                type="number"
                min="240"
                max="2160"
                value={settings.viewportHeight}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    viewportHeight: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <label className="toggle-row">
            <span>
              <b>Persist between runs</b>
              <small>
                Retain cookies and site storage in this isolated profile.
              </small>
            </span>
            <input
              type="checkbox"
              checked={persistent}
              onChange={(event) => setPersistent(event.target.checked)}
            />
          </label>
          <details>
            <summary>Advanced</summary>
            <label className="field">
              <span>Proxy</span>
              <input
                placeholder="http://proxy.example:8080"
                value={settings.proxy ?? ""}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    proxy: event.target.value || undefined,
                  })
                }
              />
            </label>
            <label className="field">
              <span>User-agent override</span>
              <input
                value={settings.userAgent ?? ""}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    userAgent: event.target.value || undefined,
                  })
                }
              />
            </label>
          </details>
          <div className="security-note">
            <ShieldCheck size={14} />
            <span>
              Passwords are never imported from your normal browser. Duplicates
              copy preferences only.
            </span>
          </div>
        </section>
        <footer>
          {profile && (
            <div className="destructive-actions">
              <button className="button" onClick={onClear}>
                Clear browser data
              </button>
              <button className="button danger-text" onClick={onDelete}>
                <Trash2 size={13} />
                Delete
              </button>
            </div>
          )}
          <span />
          <button className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !name.trim()}
            onClick={() => onSave(name, persistent, settings)}
          >
            {busy ? "Saving…" : "Save profile"}
          </button>
        </footer>
      </div>
    </FocusDialog>
  );
}
