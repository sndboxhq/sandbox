"use client";

import { Download, ExternalLink, Monitor, PackageOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReleaseArtifact, ReleaseManifest } from "../../lib/release-manifest";

type PlatformId = "windows" | "linux-x64" | "linux-arm64" | "macos";
const platforms: Array<{id: PlatformId; name: string; detail: string}> = [
  { id: "windows", name: "Windows", detail: "x64 · Windows 10 or later · Desktop application" },
  { id: "linux-x64", name: "Linux runner", detail: "x64 · Ubuntu/Debian · Headless self-hosted runner" },
  { id: "linux-arm64", name: "ARM64 runner", detail: "ARM64 · Ubuntu/Debian · Headless self-hosted runner" },
  { id: "macos", name: "macOS", detail: "No signed macOS build in the v0.7 beta" },
];

export function DownloadsClient({ manifest }: { manifest?: ReleaseManifest }) {
  const [selected, setSelected] = useState<PlatformId>("windows");
  useEffect(() => {
    const platform = navigator.platform.toLowerCase();
    setSelected(platform.includes("mac") ? "macos" : platform.includes("linux") ? "linux-x64" : "windows");
  }, []);
  const platform = platforms.find(item => item.id === selected)!;
  const artifact = findArtifact(manifest, selected);
  const available = Boolean(artifact);
  const linuxRunner = selected === "linux-x64" || selected === "linux-arm64";
  const unsignedWindowsBeta = selected === "windows" && manifest?.channel === "beta";
  return <div className="download-picker">
    <nav aria-label="Platforms">{platforms.map(item => <button key={item.id} onClick={() => setSelected(item.id)} className={selected === item.id ? "active" : ""}>{item.name}</button>)}</nav>
    <section><div>
      <span className="download-icon">{selected === "windows" ? <Monitor size={24}/> : <PackageOpen size={24}/>}</span>
      <small>{platform.name.toUpperCase()}</small>
      <h2>{available ? selected === "windows" ? "Desktop beta ready" : "Runner archive ready" : selected === "macos" ? "Not available in this beta" : "Release pending"}</h2>
      <p>{platform.detail}</p>
      <dl>
        <div><dt>Release</dt><dd>{manifest ? `${manifest.version} ${manifest.channel}` : "0.7.9-beta.1 pending publication"}</dd></div>
        <div><dt>Artifact</dt><dd>{artifact?.name ?? "No published artifact for this platform"}</dd></div>
        <div><dt>Checksum</dt><dd className="download-digest">{artifact?.sha256 ?? "Generated and validated during release"}</dd></div>
        <div><dt>Verification</dt><dd>{selected === "windows" ? unsignedWindowsBeta ? "Unsigned test build · SHA-256 checksum" : manifest ? "Authenticode signature + SHA-256 checksum" : "Declared in the published release" : "Sigstore bundle + SHA-256 checksum"}</dd></div>
      </dl>
      {unsignedWindowsBeta && <p className="download-beta-note"><strong>Unsigned Windows test build.</strong> SmartScreen may show an unknown publisher warning. Only install a checksum-verified copy shared through this release.</p>}
      {linuxRunner && <p className="download-beta-note"><strong>Headless runner.</strong> Extract the archive and run <code>sudo ./install.sh</code>, then launch <code>sudo sandbox-runner</code> for guided setup. For servers and NAS devices, follow the <a href="https://docs.sndbox.app/linux">Linux guide</a>.</p>}
      {artifact
        ? <a className="sb-button sb-button--primary" href={artifact.downloadUrl}><Download size={14}/>Download · {formatBytes(artifact.bytes)}</a>
        : <a className="sb-button" href="https://github.com/sndboxhq/sandbox/releases"><ExternalLink size={14}/>View release status</a>}
      {manifest && <a className="download-release-link" href={`https://github.com/${manifest.source.repository}/releases/tag/${manifest.tag}`}>Release notes and verification files <ExternalLink size={12}/></a>}
    </div></section>
  </div>;
}

function findArtifact(manifest: ReleaseManifest | undefined, platform: PlatformId): ReleaseArtifact | undefined {
  if (!manifest) return undefined;
  if (platform === "windows") return manifest.artifacts.find(item => item.kind === "desktop-installer" && item.name.endsWith(".exe")) ?? manifest.artifacts.find(item => item.kind === "desktop-installer");
  if (platform === "linux-x64") return manifest.artifacts.find(item => item.kind === "runner-archive" && item.architecture === "x86_64");
  if (platform === "linux-arm64") return manifest.artifacts.find(item => item.kind === "runner-archive" && item.architecture === "aarch64");
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
