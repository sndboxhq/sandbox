import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { listen } from "@tauri-apps/api/event";
import { CustomSelect } from "./ui/CustomSelect";
import {
  ArrowRight,
  Cable,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Pencil,
  RefreshCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { IconType } from "react-icons";
import {
  SiAnthropic,
  SiDiscord,
  SiGithub,
  SiGmail,
  SiGoogle,
  SiNotion,
  SiOllama,
  SiOpenai,
  SiSlack,
} from "react-icons/si";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { ConnectionMetadata } from "../types";
import { AiConnectionDialog } from "./AiConnectionDialog";
import { ConfirmDialog, Dialog, FocusDialog } from "./ui/Dialog";

type WebhookProvider = "discord" | "slack";

export function ConnectionsSettings() {
  const [connections, setConnections] = useState<ConnectionMetadata[]>([]);
  const [adding, setAdding] = useState<WebhookProvider>();
  const [addingAi, setAddingAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "error" | "success";
    text: string;
  }>();
  const [renaming, setRenaming] = useState<ConnectionMetadata>();
  const [githubSetup, setGithubSetup] = useState<ConnectionMetadata>();
  const [githubResources, setGithubResources] = useState<Array<{ id: string; label: string; metadata: Record<string, unknown> }>>([]);
  const [githubInstallation, setGithubInstallation] = useState(0);
  const [githubRepositories, setGithubRepositories] = useState<string[]>([]);
  const [renameName, setRenameName] = useState("");
  const [revoking, setRevoking] = useState<{
    connection: ConnectionMetadata;
    workflows: string[];
  }>();

  const load = () =>
    api
      .listConnections()
      .then(setConnections)
      .catch((value) => setNotice({ kind: "error", text: String(value) }));

  useEffect(() => {
    void load();
    if (!api.isDesktop) return;
    const stops: Array<() => void> = [];
    void listen<ConnectionMetadata>("connection-updated", (event) => {
      setNotice({
        kind: "success",
        text: `${event.payload.displayName} connected securely.`,
      });
      void load();
    }).then((stop) => stops.push(stop));
    void listen<string>("connection-error", (event) =>
      setNotice({ kind: "error", text: event.payload }),
    ).then((stop) => stops.push(stop));
    return () => stops.forEach((stop) => stop());
  }, []);

  const connectGmail = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await api.startGmailOAuth();
      setNotice({
        kind: "success",
        text: "Gmail authorization opened in your default browser. This screen updates after the callback is verified.",
      });
    } catch (value) {
      setNotice({ kind: "error", text: String(value) });
    } finally {
      setBusy(false);
    }
  };

  const connectIntegration = async (
    provider: "google_workspace" | "slack_oauth" | "notion" | "github_app",
    label: string,
  ) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const started = await api.startIntegrationOAuth(provider);
      setNotice({
        kind: "success",
        text: started.userCode
          ? `${label} authorization opened. Enter code ${started.userCode} in the provider page; this screen updates after approval.`
          : `${label} authorization opened in your default browser. This screen updates after the callback is verified.`,
      });
    } catch (value) {
      setNotice({ kind: "error", text: String(value) });
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    action: () => Promise<unknown>,
    success?: string | ((result: unknown) => string),
  ) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await action();
      await load();
      if (success) {
        setNotice({
          kind: "success",
          text: typeof success === "function" ? success(result) : success,
        });
      }
    } catch (value) {
      setNotice({ kind: "error", text: String(value) });
    } finally {
      setBusy(false);
    }
  };

  const prepareDisconnect = (connection: ConnectionMetadata) => {
    void api
      .workflowsUsingConnection(connection.id)
      .then((workflows) => setRevoking({ connection, workflows }))
      .catch((value) => setNotice({ kind: "error", text: String(value) }));
  };

  const prepareGithub = async (connection: ConnectionMetadata) => {
    setBusy(true);setNotice(undefined);
    try {
      const resources=await api.listIntegrationResources(connection.id,"github_repository");
      const installationIds=[...new Set(resources.map((resource)=>Number(resource.metadata.installationId)).filter(Number.isSafeInteger))];
      const current=Number(connection.metadata.installationId ?? installationIds[0] ?? 0);
      const selected=Array.isArray(connection.metadata.selectedRepositories)?connection.metadata.selectedRepositories.flatMap((item)=>typeof item==="string"?[item]:item&&typeof item==="object"&&"fullName" in item?[String((item as {fullName:unknown}).fullName)]:[]):[];
      setGithubResources(resources);setGithubInstallation(current);setGithubRepositories(selected);setGithubSetup(connection);
    } catch(value){setNotice({kind:"error",text:String(value)});} finally{setBusy(false);}
  };

  return (
    <section className="settings-section connections-settings">
      <header className="connections-header">
        <div>
          <h2>Connections</h2>
          <p>
            Give your workflows access to the services they need. Choose a
            provider to get started.
          </p>
        </div>
        <div className="connection-security-badge">
          <ShieldCheck size={16} />
          <span>
            <b>Stored securely</b>
            <small>Secrets stay in your system vault</small>
          </span>
        </div>
      </header>

      {notice && (
        <div
          className={notice.kind === "error" ? "error-banner" : "success-banner"}
        >
          {notice.kind === "success" && <CheckCircle2 size={13} />}
          <span>{notice.text}</span>
        </div>
      )}

      <div className="connection-section-heading">
        <div>
          <h3>Add a connection</h3>
          <p>Select a service and sndbox will guide you through setup.</p>
        </div>
      </div>
      <div className="connection-option-grid">
        <ConnectionOption
          icon={<SiOpenai size={18} />}
          name="AI provider"
          description="Build and edit workflows from the AI chat."
          method="API key"
          badge="AI builder"
          tone="ai"
          disabled={busy}
          onClick={() => setAddingAi(true)}
        />
        <ConnectionOption
          icon={<SiGmail size={18} />}
          name="Gmail"
          description="Use email triggers, messages, and drafts."
          method="Google sign-in"
          tone="gmail"
          disabled={busy}
          onClick={() => void connectGmail()}
        />
        <ConnectionOption
          icon={<SiGoogle size={18} />}
          name="Google Workspace"
          description="Use Calendar, Drive, and Sheets actions and polling triggers."
          method="Google sign-in"
          badge="11 nodes"
          tone="google_workspace"
          disabled={busy}
          onClick={() => void connectIntegration("google_workspace", "Google Workspace")}
        />
        <ConnectionOption
          icon={<SiSlack size={18} />}
          name="Slack OAuth"
          description="Read channels, send messages, react, and upload files."
          method="Slack OAuth v2"
          badge="6 nodes"
          tone="slack_oauth"
          disabled={busy}
          onClick={() => void connectIntegration("slack_oauth", "Slack")}
        />
        <ConnectionOption
          icon={<SiNotion size={18} />}
          name="Notion"
          description="Query and update pages in connected data sources."
          method="Notion OAuth"
          badge="5 nodes"
          tone="notion"
          disabled={busy}
          onClick={() => void connectIntegration("notion", "Notion")}
        />
        <ConnectionOption
          icon={<SiGithub size={18} />}
          name="GitHub"
          description="Automate issues, pull requests, reviews, and Actions."
          method="GitHub App device flow"
          badge="13 nodes"
          tone="github_app"
          disabled={busy}
          onClick={() => void connectIntegration("github_app", "GitHub")}
        />
        <ConnectionOption
          icon={<SiDiscord size={18} />}
          name="Discord"
          description="Send workflow updates to a Discord channel."
          method="Webhook URL"
          tone="discord"
          disabled={busy}
          onClick={() => setAdding("discord")}
        />
        <ConnectionOption
          icon={<SiSlack size={18} />}
          name="Slack"
          description="Post notifications to your Slack workspace."
          method="Webhook URL"
          tone="slack"
          disabled={busy}
          onClick={() => setAdding("slack")}
        />
      </div>

      <div className="connection-section-heading saved-connections-heading">
        <div>
          <h3>Saved connections</h3>
          <p>Test, rename, or disconnect services already linked to sndbox.</p>
        </div>
        <span className="connection-count">
          {connections.length} {connections.length === 1 ? "connection" : "connections"}
        </span>
      </div>
      {connections.length ? (
        <div className="connection-list">
          {connections.map((connection) => (
            <div className="connection-row" key={connection.id}>
              <ProviderIcon provider={connection.provider} />
              <div className="connection-identity">
                <b>{connection.displayName}</b>
                <small>
                  {connection.accountIdentifier ?? providerName(connection.provider)}
                  <span aria-hidden="true"> · </span>
                  {connection.scopes.length
                    ? `${connection.scopes.length} granted scope${connection.scopes.length === 1 ? "" : "s"}`
                    : "Credential stored securely"}
                </small>
              </div>
              <span className={`connection-state ${connection.status}`}>
                <i />
                {connection.status.replaceAll("_", " ")}
              </span>
              <div className="connection-row-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api.testConnection(connection.id),
                      (result) =>
                        (result as { message?: string }).message ??
                        `${connection.displayName} passed its connection test.`,
                    )
                  }
                >
                  <RefreshCcw size={12} />
                  Test connection
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="button connection-manage-button"
                      aria-label={`Manage ${connection.displayName}`}
                    >
                      Manage
                      <ChevronDown size={12} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                      <DropdownMenu.Content className="menu" align="end" sideOffset={5}>
                      {connection.provider === "github_app" && <DropdownMenu.Item onSelect={() => void prepareGithub(connection)}><SiGithub size={13} />Choose repositories</DropdownMenu.Item>}
                      <DropdownMenu.Item
                        onSelect={() => {
                          setRenaming(connection);
                          setRenameName(connection.displayName);
                        }}
                      >
                        <Pencil size={13} />
                        Rename
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        className="danger"
                        onSelect={() => prepareDisconnect(connection)}
                      >
                        <Trash2 size={13} />
                        Disconnect
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="connections-empty">
          <span className="connections-empty-icon">
            <Cable size={18} />
          </span>
          <div>
            <b>No saved connections yet</b>
            <span>Choose a service above. It will appear here once connected.</span>
          </div>
        </div>
      )}
      <div className="vault-assurance">
        <ShieldCheck size={14} />
        <span>
          Credentials never appear in workflow files or exports. Workflows only
          store a reference to the secure credential.
        </span>
      </div>

      {adding && (
        <WebhookModal
          initialProvider={adding}
          busy={busy}
          onClose={() => setAdding(undefined)}
          onSave={(provider, name, url) =>
            act(
              () => api.createConnection(provider, name, { webhookUrl: url }),
              `${name} was stored in the OS credential store.`,
            ).then(() => setAdding(undefined))
          }
        />
      )}
      <AiConnectionDialog
        open={addingAi}
        onOpenChange={setAddingAi}
        onConnected={(connection) => {
          setConnections((current) => [...current, connection]);
          setNotice({
            kind: "success",
            text: `${connection.displayName} connected securely.`,
          });
        }}
      />
      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => !open && setRenaming(undefined)}
        title="Rename connection"
        description="Only the display label changes. The credential remains write-only in the operating-system vault."
        footer={
          <>
            <button className="button" onClick={() => setRenaming(undefined)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!renameName.trim() || busy}
              onClick={() => {
                if (renaming)
                  void act(
                    () => api.renameConnection(renaming.id, renameName.trim()),
                    "Connection renamed.",
                  ).then(() => setRenaming(undefined));
              }}
            >
              Rename
            </button>
          </>
        }
      >
        <label className="field">
          <span>Display name</span>
          <input
            autoFocus
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
          />
        </label>
      </Dialog>
      <Dialog
        open={Boolean(githubSetup)}
        onOpenChange={(open) => !open && setGithubSetup(undefined)}
        title="Choose GitHub App access"
        description="Select one installation and the exact repositories this connection may use. Workflows cannot silently switch repositories."
        footer={<><button className="button" onClick={()=>setGithubSetup(undefined)}>Cancel</button><button className="button primary" disabled={busy||!githubInstallation||!githubRepositories.length} onClick={()=>{if(githubSetup)void act(()=>api.configureGithubInstallation(githubSetup.id,githubInstallation,githubRepositories),"GitHub repository access updated.").then(()=>setGithubSetup(undefined));}}>Save access</button></>}
      >
        <div className="settings-modal connection-modal">
          <Field label="Installation">
            <CustomSelect value={githubInstallation||""} onChange={(event)=>{const next=Number(event.target.value);setGithubInstallation(next);setGithubRepositories([]);}}>
              <option value="">Select installation…</option>
              {[...new Set(githubResources.map((resource)=>Number(resource.metadata.installationId)).filter(Number.isSafeInteger))].map((id)=><option key={id} value={id}>{String(githubResources.find((resource)=>Number(resource.metadata.installationId)===id)?.metadata.owner??`Installation ${id}`)}</option>)}
            </CustomSelect>
          </Field>
          <div className="checks">
            {githubResources.filter((resource)=>Number(resource.metadata.installationId)===githubInstallation).map((resource)=><label key={resource.id}><input type="checkbox" checked={githubRepositories.includes(resource.id)} onChange={(event)=>setGithubRepositories(event.target.checked?[...new Set([...githubRepositories,resource.id])]:githubRepositories.filter((name)=>name!==resource.id))}/>{resource.label}</label>)}
          </div>
          {!githubResources.some((resource)=>Number(resource.metadata.installationId)===githubInstallation)&&<p className="field-hint">No repositories are accessible through this installation.</p>}
        </div>
      </Dialog>
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => !open && setRevoking(undefined)}
        title="Disconnect service?"
        description="The credential will be deleted from your system vault. Affected workflows will need to be reconnected."
        confirmLabel="Disconnect"
        dangerous
        busy={busy}
        onConfirm={() => {
          if (revoking)
            void act(
              () => api.revokeConnection(revoking.connection.id),
              `${revoking.connection.displayName} was disconnected.`,
            ).then(() => setRevoking(undefined));
        }}
      >
        {revoking && (
          <div className="affected-workflows">
            <b>
              {revoking.workflows.length} affected workflow
              {revoking.workflows.length === 1 ? "" : "s"}
            </b>
            {revoking.workflows.length ? (
              <ul>
                {revoking.workflows.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : (
              <p>No workflow currently references this connection.</p>
            )}
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}

function ConnectionOption({
  icon,
  name,
  description,
  method,
  badge,
  tone,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  method: string;
  badge?: string;
  tone: "ai" | "gmail" | "discord" | "slack" | "google_workspace" | "slack_oauth" | "notion" | "github_app";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`connection-option ${tone}`}
      disabled={disabled}
      onClick={onClick}
      aria-label={`Connect ${name}`}
    >
      <span className="connection-option-icon">{icon}</span>
      <span className="connection-option-copy">
        <span className="connection-option-title">
          <b>{name}</b>
          {badge && <em>{badge}</em>}
        </span>
        <small>{description}</small>
        <span className="connection-method">{method}</span>
      </span>
      <span className="connection-option-arrow">
        <ArrowRight size={15} />
      </span>
    </button>
  );
}

function WebhookModal({
  initialProvider,
  busy,
  onClose,
  onSave,
}: {
  initialProvider: WebhookProvider;
  busy: boolean;
  onClose: () => void;
  onSave: (provider: WebhookProvider, name: string, url: string) => void;
}) {
  const [provider, setProvider] = useState(initialProvider);
  const [name, setName] = useState(
    initialProvider === "discord" ? "Discord alerts" : "Slack alerts",
  );
  const [url, setUrl] = useState("");
  const valid = validWebhook(provider, url);

  return (
    <FocusDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Connect ${providerName(initialProvider)}`}
      description="Add an incoming webhook so workflows can send channel updates."
    >
      <div className="settings-modal connection-modal">
        <header>
          <div>
            <h2>Connect {providerName(provider)}</h2>
            <p>
              Paste an incoming webhook URL. It will be encrypted by your
              operating-system credential store.
            </p>
          </div>
        </header>
        <section>
          <Field label="Provider">
            <CustomSelect
              value={provider}
              onChange={(event) => {
                const next = event.target.value as WebhookProvider;
                setProvider(next);
                setName(next === "discord" ? "Discord alerts" : "Slack alerts");
              }}
            >
              <option value="discord">Discord</option>
              <option value="slack">Slack</option>
            </CustomSelect>
          </Field>
          <Field label="Display name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Webhook URL">
            <input
              type="password"
              autoComplete="off"
              placeholder={
                provider === "discord"
                  ? "https://discord.com/api/webhooks/…"
                  : "https://hooks.slack.com/services/…"
              }
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
          {url && !valid && (
            <div className="field-error">
              Enter an HTTPS {providerName(provider)} incoming webhook URL from
              the expected provider domain.
            </div>
          )}
          <div className="security-note">
            <ShieldCheck size={14} />
            <span>
              This value cannot be inspected after saving. Reconnection replaces
              it.
            </span>
          </div>
        </section>
        <footer>
          <span />
          <button className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !name.trim() || !valid}
            onClick={() => onSave(provider, name, url)}
          >
            {busy ? "Saving…" : `Connect ${providerName(provider)}`}
          </button>
        </footer>
      </div>
    </FocusDialog>
  );
}

const providerIcons: Record<string, IconType> = {
  anthropic: SiAnthropic,
  discord: SiDiscord,
  github_app: SiGithub,
  gmail: SiGmail,
  google_workspace: SiGoogle,
  notion: SiNotion,
  openai: SiOpenai,
  openai_compatible: SiOllama,
  slack: SiSlack,
  slack_oauth: SiSlack,
};

function ProviderIcon({ provider }: { provider: string }) {
  const Icon = providerIcons[provider];

  return (
    <span className={`connection-provider ${provider}`} aria-hidden="true">
      {Icon ? <Icon size={17} /> : <ExternalLink size={17} />}
    </span>
  );
}

function providerName(provider: string) {
  if (provider === "google_workspace") return "Google Workspace";
  if (provider === "slack_oauth") return "Slack OAuth";
  if (provider === "github_app") return "GitHub";
  if (provider === "openai_compatible") return "OpenAI-compatible";
  if (provider === "openai") return "OpenAI";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function validWebhook(provider: WebhookProvider, value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (provider === "discord"
        ? ["discord.com", "discordapp.com"].includes(url.hostname) &&
          url.pathname.startsWith("/api/webhooks/")
        : url.hostname === "hooks.slack.com" &&
          url.pathname.startsWith("/services/"))
    );
  } catch {
    return false;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
