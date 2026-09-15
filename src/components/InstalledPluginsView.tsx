import {
  Blocks,
  CheckCircle2,
  Download,
  KeyRound,
  LockKeyhole,
  RefreshCcw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { CustomSelect } from "./ui/CustomSelect";
import type {
  InstalledPlugin,
  PackageTrustMetadata,
  PluginPackageInspection,
} from "../types";
import { FocusDialog } from "./ui/Dialog";
import { IssueNotice } from "./ui/IssueNotice";
import { ErrorState, LoadingSkeleton } from "./ui/States";

const initialTrust: PackageTrustMetadata = {
  publisherId: "com.example.publisher",
  keyId: "development",
  publisherPublicKeyPem: "",
  ownerType: "personal",
  ownerId: "local",
  source: "development",
};

export function InstalledPluginsView() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [trust, setTrust] = useState(initialTrust);
  const [inspection, setInspection] = useState<PluginPackageInspection>();
  const [showLoader, setShowLoader] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const filteredPlugins = useMemo(
    () =>
      plugins.filter(
        (plugin) =>
          (!search ||
            (
              plugin.manifest.name +
              plugin.publisherId +
              plugin.manifest.description
            )
              .toLowerCase()
              .includes(search.toLowerCase())) &&
          (!stateFilter ||
            plugin.state === stateFilter ||
            (stateFilter === "review" && plugin.updateRequiresReview)),
      ),
    [plugins, search, stateFilter],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setPlugins(await api.listInstalledPlugins());
    } catch (value) {
      setError(String(value));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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

  const inspect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.inspectPluginPackage(trust);
      if (result) setInspection(result);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!inspection) return;
    await act(() => api.installInspectedPlugin(inspection.inspectionId));
    setInspection(undefined);
    setShowLoader(false);
  };

  return (
    <main className="content plugins-page">
      <header className="page-header">
        <div>
          <h1>Installed Plugins</h1>
          <p>
            Exact, signed versions available to the current Personal · Local
            workspace.
          </p>
        </div>
        <button className="button" onClick={() => setShowLoader(true)}>
          <Download size={14} />
          Advanced: load package
        </button>
      </header>
      <div className="plugin-safety-strip">
        <ShieldCheck size={17} />
        <div>
          <b>Sandboxed by default</b>
          <span>
            Packages install disabled. Permissions must be approved before a
            version can be enabled.
          </span>
        </div>
      </div>
      <div className="toolbar plugin-filters">
        <div className="search">
          <Search size={14} />
          <input
            aria-label="Search installed plugins"
            placeholder="Search name or publisher…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <CustomSelect
          aria-label="Filter installed plugin state"
          value={stateFilter}
          onChange={(event) => setStateFilter(event.target.value)}
        >
          <option value="">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="revoked">Revoked</option>
          <option value="review">Permission review required</option>
        </CustomSelect>
      </div>
      {error && plugins.length > 0 && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="button" onClick={() => void load()}>
            <RefreshCcw size={13} /> Retry
          </button>
        </div>
      )}
      {loading && !plugins.length ? (
        <LoadingSkeleton rows={5} />
      ) : error && !plugins.length ? (
        <ErrorState
          title="Installed plugins could not load"
          description={error}
          onRetry={() => void load()}
        />
      ) : filteredPlugins.length ? (
        <section className="plugin-grid">
          {filteredPlugins.map((plugin) => {
            const approved =
              JSON.stringify(plugin.requestedPermissions) ===
              JSON.stringify(plugin.approvedPermissions);
            return (
              <article
                className="plugin-card"
                key={`${plugin.pluginId}:${plugin.version}:${plugin.packageIntegrity}`}
              >
                <header>
                  <span className="plugin-icon">
                    <Blocks size={18} />
                  </span>
                  <div>
                    <h2>{plugin.manifest.name}</h2>
                    <p>{plugin.publisherId}</p>
                  </div>
                  <span className={`status-pill ${plugin.state}`}>
                    {plugin.state}
                  </span>
                </header>
                <p>{plugin.manifest.description}</p>
                <div className="plugin-meta">
                  <span>v{plugin.version}</span>
                  <span>
                    {plugin.manifest.nodes.length} node
                    {plugin.manifest.nodes.length === 1 ? "" : "s"}
                  </span>
                  <span>{plugin.packageIntegrity.slice(7, 19)}</span>
                </div>
                {plugin.development && (
                  <div className="development-badge">Development</div>
                )}
                {plugin.updateRequiresReview && (
                  <IssueNotice
                    issue={{ code: "plugin_permission_expansion", severity: "permission", message: "New plugin permissions required", suggestion: "This version requests new permissions and remains pinned off until you approve them." }}
                    onFix={() => void act(() => api.approvePluginPermissions(plugin))}
                    fixLabel="Review permissions"
                  />
                )}
                <details>
                  <summary>
                    {plugin.requestedPermissions.length} requested permission
                    {plugin.requestedPermissions.length === 1 ? "" : "s"}
                  </summary>
                  <ul>
                    {plugin.requestedPermissions.map((permission) => (
                      <li key={permission}>{permission}</li>
                    ))}
                  </ul>
                </details>
                <footer>
                  {plugin.state !== "revoked" && !approved && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        act(() => api.approvePluginPermissions(plugin))
                      }
                    >
                      <LockKeyhole size={13} />
                      Review and approve
                    </button>
                  )}
                  {plugin.state !== "revoked" && approved && (
                    <button
                      className={`button ${plugin.state === "enabled" ? "" : "primary"}`}
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          api.setPluginEnabled(
                            plugin,
                            plugin.state !== "enabled",
                          ),
                        )
                      }
                    >
                      {plugin.state === "enabled" ? (
                        "Disable"
                      ) : (
                        <>
                          <CheckCircle2 size={13} />
                          Enable version
                        </>
                      )}
                    </button>
                  )}
                  {plugin.state === "revoked" && (
                    <span className="revoked-copy">New executions blocked</span>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        <div className="settings-empty plugin-empty">
          <Blocks size={24} />
          <h3>
            {plugins.length
              ? "No matching installed plugins"
              : "No plugins installed"}
          </h3>
          <p>
            Local workflows and built-in nodes continue to work without plugins
            or an account.
          </p>
          <button
            className="button"
            onClick={
              plugins.length
                ? () => {
                    setSearch("");
                    setStateFilter("");
                  }
                : () => setShowLoader(true)
            }
          >
            {plugins.length
              ? "Clear filters"
              : "Load a signed development package"}
          </button>
        </div>
      )}
      <FocusDialog
        open={showLoader}
        onOpenChange={setShowLoader}
        title="Load development package"
        description="Inspect a local package and its publisher trust information before installation."
      >
        {showLoader && (
          <div className="settings-modal plugin-loader">
            <header>
              <div>
                <h2>
                  {inspection
                    ? "Approve installation"
                    : "Load development plugin"}
                </h2>
                <p>
                  {inspection
                    ? "The package is signed and compatible. Inspect host-generated permissions before installation."
                    : "Use the publisher identity and public key produced by sandbox plugin keygen."}
                </p>
              </div>
            </header>
            {!inspection ? (
              <section>
                <IssueNotice
                  issue={{ code: "development_plugin", severity: "info", message: "Development plugin", suggestion: "Development plugins keep the production sandbox and are disabled in production workspaces." }}
                />
                <div className="field-grid">
                  <label className="field">
                    <span>Publisher ID</span>
                    <input
                      value={trust.publisherId}
                      onChange={(event) =>
                        setTrust({ ...trust, publisherId: event.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Signing key ID</span>
                    <input
                      value={trust.keyId}
                      onChange={(event) =>
                        setTrust({ ...trust, keyId: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Ed25519 public key (PEM)</span>
                  <textarea
                    rows={7}
                    spellCheck={false}
                    placeholder="-----BEGIN PUBLIC KEY-----"
                    value={trust.publisherPublicKeyPem}
                    onChange={(event) =>
                      setTrust({
                        ...trust,
                        publisherPublicKeyPem: event.target.value,
                      })
                    }
                  />
                </label>
              </section>
            ) : (
              <section>
                <div className="verified-package">
                  <KeyRound size={18} />
                  <div>
                    <b>
                      {inspection.manifest.name} · v
                      {inspection.manifest.version}
                    </b>
                    <span>
                      Signature, integrity, publisher key, manifest, contents,
                      revocation and host compatibility verified locally.
                    </span>
                  </div>
                </div>
                <h3>Requested permissions</h3>
                <ul className="permission-list">
                  {inspection.requestedPermissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
                {inspection.permissionExpansion.length > 0 && (
                  <IssueNotice
                    issue={{
                      code: "plugin_permission_expansion",
                      severity: "permission",
                      message: plugins.some((item) => item.pluginId === inspection.manifest.pluginId) ? "Plugin permission expansion" : "Initial plugin permission grant",
                      suggestion: inspection.permissionExpansion.join(" · "),
                    }}
                  />
                )}
                <p className="install-note">
                  Installation does not execute the plugin. The new version will
                  remain disabled until its permissions are approved and it is
                  explicitly enabled.
                </p>
              </section>
            )}
            <footer>
              <button
                className="button"
                onClick={() =>
                  inspection ? setInspection(undefined) : setShowLoader(false)
                }
              >
                {inspection ? "Back" : "Cancel"}
              </button>
              <span />
              {!inspection ? (
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !trust.publisherId ||
                    !trust.keyId ||
                    !trust.publisherPublicKeyPem.includes("BEGIN PUBLIC KEY")
                  }
                  onClick={inspect}
                >
                  {busy ? "Verifying…" : "Choose and inspect package"}
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={install}
                >
                  {busy ? "Installing…" : "Install disabled"}
                </button>
              )}
            </footer>
          </div>
        )}
      </FocusDialog>
    </main>
  );
}
