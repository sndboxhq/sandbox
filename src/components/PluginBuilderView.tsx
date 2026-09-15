import { Braces, Check, Clipboard, FolderPlus, KeyRound, PackageCheck, ShieldCheck, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { createScaffoldFiles } from "../../packages/plugin-sdk/src/scaffold-files";
import { api } from "../api";
import { useToast } from "./ui/Toast";

const pluginIdentifier = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const nodeIdentifier = /^[a-z][a-z0-9_.-]{2,127}$/;

export function PluginBuilderView() {
  const [name, setName] = useState("My Plugin");
  const [description, setDescription] = useState("A capability-controlled sndbox integration.");
  const [pluginId, setPluginId] = useState("com.example.my-plugin");
  const [publisherId, setPublisherId] = useState("com.example");
  const [nodeName, setNodeName] = useState("Echo");
  const [nodeType, setNodeType] = useState("example.echo");
  const [folderName, setFolderName] = useState("my-plugin");
  const [creating, setCreating] = useState(false);
  const [createdPath, setCreatedPath] = useState<string>();
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const valid = Boolean(name.trim() && description.trim() && pluginIdentifier.test(pluginId) && pluginIdentifier.test(publisherId) && nodeName.trim() && nodeIdentifier.test(nodeType) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(folderName));
  const options = useMemo(() => ({ name: name.trim(), description: description.trim(), pluginId, publisherId, nodeName: nodeName.trim(), nodeType }), [description, name, nodeName, nodeType, pluginId, publisherId]);
  const files = useMemo(() => valid ? createScaffoldFiles(options) : [], [options, valid]);
  const cliCommand = `sandbox plugin create "${folderName || "my-plugin"}" --plugin-id "${pluginId}" --publisher-id "${publisherId}" --name "${name.trim() || "My Plugin"}"`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast.push("SDK scaffold command copied.", "success");
    } catch {
      toast.push("Could not copy the command. Select it from the preview instead.", "error");
    }
  };
  const createProject = async () => {
    if (!valid || creating) return;
    setCreating(true);
    setCreatedPath(undefined);
    try {
      const path = await api.createPluginProject(folderName, files);
      if (path) {
        setCreatedPath(path);
        toast.push(`${name.trim()} starter created.`, "success");
      }
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "Could not create the plugin starter.", "error");
    } finally {
      setCreating(false);
    }
  };

  return <main className="content plugin-builder-page">
    <header className="plugin-builder-header">
      <span><Braces size={20}/></span>
      <div><h1>Plugin Builder</h1><p>Configure a safe starter visually, then continue with the existing <code>@sandbox/plugin-sdk</code> toolchain.</p></div>
      <div className="plugin-builder-sdk"><PackageCheck size={15}/><span><b>SDK-backed</b><small>v0.8 starter</small></span></div>
    </header>

    <div className="plugin-builder-grid">
      <section className="plugin-builder-form" aria-labelledby="plugin-details-heading">
        <div className="plugin-builder-section-title"><span>1</span><div><h2 id="plugin-details-heading">Plugin details</h2><p>These values are written directly into the SDK manifest.</p></div></div>
        <div className="plugin-builder-fields">
          <label className="field"><span>Display name</span><input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
          <label className="field"><span>Project folder</span><input className="code-input" value={folderName} maxLength={80} onChange={event => setFolderName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} /></label>
          <label className="field plugin-builder-wide"><span>Description</span><input value={description} maxLength={180} onChange={event => setDescription(event.target.value)} /></label>
          <label className="field"><span>Plugin ID <small>reverse domain</small></span><input className="code-input" aria-invalid={pluginId.length > 0 && !pluginIdentifier.test(pluginId)} value={pluginId} onChange={event => setPluginId(event.target.value.toLowerCase().trim())} /></label>
          <label className="field"><span>Publisher ID <small>reverse domain</small></span><input className="code-input" aria-invalid={publisherId.length > 0 && !pluginIdentifier.test(publisherId)} value={publisherId} onChange={event => setPublisherId(event.target.value.toLowerCase().trim())} /></label>
        </div>

        <div className="plugin-builder-section-title"><span>2</span><div><h2>Starter node</h2><p>The first scaffold is a low-risk, read-only Rust/Wasm echo node.</p></div></div>
        <div className="plugin-builder-fields">
          <label className="field"><span>Node name</span><input value={nodeName} maxLength={80} onChange={event => setNodeName(event.target.value)} /></label>
          <label className="field"><span>Node type</span><input className="code-input" aria-invalid={nodeType.length > 0 && !nodeIdentifier.test(nodeType)} value={nodeType} onChange={event => setNodeType(event.target.value.toLowerCase().trim())} /></label>
        </div>
        <div className="plugin-builder-safety"><ShieldCheck size={17}/><div><b>Safe by default</b><span>No network, credentials, storage, or external-write capability is included. Add permissions deliberately in the manifest as the plugin grows.</span></div></div>

        <div className="plugin-builder-actions">
          <button className="button" type="button" onClick={() => void copyCommand()}><Clipboard size={14}/>{copied ? "Copied" : "Copy SDK command"}</button>
          <button className="button primary" type="button" disabled={!valid || creating || !desktop} title={desktop ? "Choose a parent folder and create the project" : "Project creation is available in the desktop app"} onClick={() => void createProject()}><FolderPlus size={14}/>{creating ? "Creating…" : "Choose folder & create"}</button>
        </div>
        {!desktop && <p className="plugin-builder-desktop-note">Open this page in the desktop app to create files, or copy the SDK command above.</p>}
        {createdPath && <div className="plugin-builder-success" role="status"><Check size={16}/><div><b>Starter created</b><code>{createdPath}</code><span>Next: run <code>sandbox plugin dev .</code> from that folder.</span></div></div>}
      </section>

      <aside className="plugin-builder-preview" aria-label="Plugin starter preview">
        <header><Terminal size={15}/><div><b>Starter preview</b><span>{files.length || 6} files · Rust/Wasm</span></div></header>
        <div className="plugin-builder-tree">
          {(files.length ? files : ["manifest.json", "guest/Cargo.toml", "guest/src/lib.rs", "assets/icon.svg", "docs/echo.md", "README.md"].map(path => ({ path }))).map(file => <code key={file.path}>{file.path}</code>)}
        </div>
        <div className="plugin-builder-command"><span>Equivalent SDK command</span><code>{cliCommand}</code></div>
        <div className="plugin-builder-next"><KeyRound size={15}/><div><b>Signing stays in the CLI</b><span>Private publisher keys are never generated or stored by this screen. Use <code>sandbox plugin keygen</code> and <code>sign</code> when the plugin is ready.</span></div></div>
      </aside>
    </div>
  </main>;
}
