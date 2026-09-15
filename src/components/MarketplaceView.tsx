import {
  BadgeCheck,
  Box,
  Download,
  Hash,
  Mail,
  MessageCircle,
  RefreshCcw,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  officialIntegrations,
  type OfficialIntegration,
} from "@sandbox/content";
import { api } from "../api";
import { CustomSelect } from "./ui/CustomSelect";
import { useAppStore } from "../store";
import type {
  InstalledPlugin,
  MarketplaceListing,
  PluginPackageInspection,
} from "../types";
import { FocusDialog } from "./ui/Dialog";
import "../marketplace.css";

export function MarketplaceView() {
  const setView = useAppStore((state) => state.setView);
  const [items, setItems] = useState<MarketplaceListing[]>([]);
  const [search, setSearch] = useState("");
  const [pricing, setPricing] = useState("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [sort, setSort] = useState("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inspection, setInspection] = useState<PluginPackageInspection>();
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  useEffect(() => {
    void api
      .listInstalledPlugins()
      .then(setInstalled)
      .catch(() => undefined);
  }, []);
  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const page = await api.searchMarketplace({
        search: search || undefined,
        pricing,
        verifiedOnly,
        sort,
        limit: 30,
      });
      setItems(page.items);
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    void load();
  }, [pricing, verifiedOnly, sort]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };
  const inspect = async (pluginId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      setInspection(await api.inspectMarketplacePlugin(pluginId));
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    if (!inspection) return;
    setBusy(true);
    try {
      await api.installInspectedPlugin(inspection.inspectionId);
      setInspection(undefined);
      setView("plugins");
      setInstalled(await api.listInstalledPlugins());
      window.dispatchEvent(new CustomEvent("sandbox:plugins-installed"));
    } catch (value) {
      setError(String(value));
    } finally {
      setBusy(false);
    }
  };
  const normalizedSearch = search.trim().toLowerCase();
  const matchingOfficialIntegrations = officialIntegrations.filter(
    (integration) =>
      pricing !== "paid" &&
      (!normalizedSearch ||
        [
          integration.name,
          integration.summary,
          integration.connection,
          ...integration.capabilities,
          "sndbox Official",
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedSearch)),
  );
  const resultCount = matchingOfficialIntegrations.length + items.length;
  return (
    <main className="content desktop-marketplace">
      <header className="page-header">
        <div>
          <h1>Marketplace</h1>
          <p>
            Discover immutable, signed plugins compatible with this sndbox
            version.
          </p>
        </div>
      </header>
      <form className="market-controls" onSubmit={submit}>
        <Search size={15} />
        <input
          aria-label="Search marketplace"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search plugins and publishers"
        />
        <CustomSelect
          aria-label="Pricing"
          value={pricing}
          onChange={(event) => setPricing(event.target.value)}
        >
          <option value="all">Free & paid</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </CustomSelect>
        <CustomSelect
          aria-label="Sort marketplace"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="recent">Recently updated</option>
          <option value="installs">Most installed</option>
          <option value="rating">Highest rated</option>
        </CustomSelect>
        <label>
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(event) => setVerifiedOnly(event.target.checked)}
          />
          Verified
        </label>
        <button className="button" disabled={busy}>
          {busy ? "Loading…" : "Search"}
        </button>
        {(search || pricing !== "all" || verifiedOnly || sort !== "recent") && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setSearch("");
              setPricing("all");
              setVerifiedOnly(false);
              setSort("recent");
            }}
          >
            Clear filters
          </button>
        )}
      </form>
      {error && (
        <div className="error-banner">
          <b>Marketplace unavailable</b>
          <span>
            {error} Existing local workflows and installed plugins continue to
            work.
          </span>
          <button className="button" onClick={() => void load()}>
            <RefreshCcw size={13} />
            Retry
          </button>
        </div>
      )}
      <div className="market-result-head">
        <span>
          {resultCount} compatible integration{resultCount === 1 ? "" : "s"}
        </span>
        <small>Revenue is not the sole ranking signal.</small>
      </div>
      {resultCount ? (
        <section className="market-card-grid">
          {matchingOfficialIntegrations.map((integration) => (
            <article className="market-card" key={`official-${integration.id}`}>
              <header>
                <span>
                  <IntegrationIcon integration={integration} />
                </span>
                <em>Included</em>
              </header>
              <h2>{integration.name}</h2>
              <div className="market-publisher official-mark">
                <BadgeCheck size={13} aria-hidden="true" />
                <span>Official</span>
              </div>
              <p>{integration.summary}</p>
              <div className="chips">
                {integration.capabilities.map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
              </div>
              <footer>
                <div>
                  <span>
                    <ShieldCheck size={12} />
                    {integration.connection}
                  </span>
                </div>
                <button
                  className="button"
                  onClick={() => {
                    try { window.sessionStorage.setItem("sandbox:settings-section", "connections"); } catch { /* direct navigation still works */ }
                    setView("settings");
                  }}
                >
                  Configure
                </button>
              </footer>
            </article>
          ))}
          {items.map((plugin) => {
            const installedVersion = installed.find(
              (item) => item.pluginId === plugin.pluginId,
            );
            const exactVersion = installedVersion?.version === plugin.version;
            return (
              <article className="market-card" key={plugin.pluginId}>
                <header>
                  <span>
                    <Box size={18} />
                  </span>
                  <em>v{plugin.version}</em>
                </header>
                <h2>{plugin.name}</h2>
                <div className="market-publisher">
                  {plugin.publisher.publicName}
                  {plugin.publisher.verified && <BadgeCheck size={13} />}
                </div>
                <p>{plugin.summary}</p>
                {installedVersion && (
                  <div
                    className="market-plugin-states"
                    aria-label="Plugin state"
                  >
                    <span>
                      {exactVersion ? "Installed" : "Update available"}
                    </span>
                    {installedVersion.state === "disabled" && (
                      <span>Disabled</span>
                    )}
                    {installedVersion.updateRequiresReview && (
                      <span>Permission review required</span>
                    )}
                  </div>
                )}
                <div className="chips">
                  {plugin.categories.slice(0, 3).map((category) => (
                    <span key={category}>{category}</span>
                  ))}
                </div>
                <footer>
                  <div>
                    <span>
                      <Download size={12} />
                      {compact(plugin.installCount)}
                    </span>
                    <span>
                      <Star size={12} />
                      {plugin.ratingAverage?.toFixed(1) ?? "New"}
                    </span>
                  </div>
                  {exactVersion ? (
                    <button
                      className="button"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent("sandbox:plugins-installed"),
                        )
                      }
                    >
                      View installed
                    </button>
                  ) : plugin.pricing.model === "free" ? (
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void inspect(plugin.pluginId)}
                    >
                      Inspect & install
                    </button>
                  ) : (
                    <strong>Licence required</strong>
                  )}
                </footer>
              </article>
            );
          })}
        </section>
      ) : (
        !busy &&
        !error && (
          <div className="settings-empty">
            <Box size={23} />
            <h3>
              {search || pricing !== "all" || verifiedOnly
                ? "No matching integrations"
                : "Integration catalogue is empty"}
            </h3>
            <p>Try broadening the search or pricing filters.</p>
          </div>
        )
      )}
      <FocusDialog
        open={Boolean(inspection)}
        onOpenChange={(open) => !open && setInspection(undefined)}
        title={`Install ${inspection?.manifest.name ?? "plugin"}`}
        description="Review the verified package and requested permissions before installing it disabled."
      >
        {inspection && (
          <div className="settings-modal market-permission-modal">
            <header>
              <div>
                <h2>Install {inspection.manifest.name}</h2>
                <p>
                  Verified {inspection.manifest.pluginId} · v
                  {inspection.manifest.version}
                </p>
              </div>
            </header>
            <section>
              <div className="verified-package">
                <ShieldCheck size={17} />
                <div>
                  <b>Package verified locally</b>
                  <span>
                    Signature, integrity, manifest, compatibility, entrypoints
                    and revocation status passed.
                  </span>
                </div>
              </div>
              <h3>Requested permissions</h3>
              <ul className="permission-list">
                {inspection.requestedPermissions.map((permission) => (
                  <li key={permission}>{permission}</li>
                ))}
              </ul>
              <p className="install-note">
                The package will be installed disabled. It cannot execute until
                you separately approve these permissions and enable this exact
                version.
              </p>
            </section>
            <footer>
              <button
                className="button"
                onClick={() => setInspection(undefined)}
              >
                Cancel
              </button>
              <span />
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void install()}
              >
                {busy ? "Installing…" : "Install disabled"}
              </button>
            </footer>
          </div>
        )}
      </FocusDialog>
    </main>
  );
}
function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function IntegrationIcon({
  integration,
}: {
  integration: OfficialIntegration;
}) {
  if (integration.id === "gmail") return <Mail size={18} />;
  if (integration.id === "slack") return <Hash size={18} />;
  return <MessageCircle size={18} />;
}
