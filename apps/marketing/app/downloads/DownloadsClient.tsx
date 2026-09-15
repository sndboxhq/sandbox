"use client";

import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Info,
  Laptop,
  Monitor,
  PackageOpen,
  Server,
  ShieldCheck,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import type { ReleaseArtifact, ReleaseManifest } from "../../lib/release-manifest";
import styles from "./downloads.module.css";

type PlatformId = "windows" | "linux-x64" | "linux-arm64" | "macos";

const platforms: Array<{
  id: PlatformId;
  name: string;
  shortDetail: string;
  detail: string;
}> = [
  { id: "windows", name: "Windows", shortDetail: "Desktop app · x64", detail: "Windows 10 or later · x64 desktop application" },
  { id: "linux-x64", name: "Linux x64", shortDetail: "Self-hosted runner", detail: "Ubuntu or Debian · x64 headless runner" },
  { id: "linux-arm64", name: "Linux ARM64", shortDetail: "Self-hosted runner", detail: "Ubuntu or Debian · ARM64 headless runner" },
  { id: "macos", name: "macOS", shortDetail: "Not yet available", detail: "No signed macOS build in the v0.7 beta" },
];

export function DownloadsClient({ manifest }: { manifest?: ReleaseManifest }) {
  const [selected, setSelected] = useState<PlatformId>("windows");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const platform = navigator.platform.toLowerCase();
    setSelected(platform.includes("mac") ? "macos" : platform.includes("linux") ? "linux-x64" : "windows");
  }, []);

  useEffect(() => setCopied(false), [selected]);

  const platform = platforms.find((item) => item.id === selected)!;
  const artifact = findArtifact(manifest, selected);
  const linuxRunner = selected === "linux-x64" || selected === "linux-arm64";
  const unsignedWindowsBeta = selected === "windows" && manifest?.channel === "beta";
  const releaseLabel = manifest ? `v${manifest.version.replace(/^v/, "")}` : "v0.8.0-beta.1";

  async function copyChecksum() {
    if (!artifact) return;
    try {
      await navigator.clipboard.writeText(artifact.sha256);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  function movePlatformFocus(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const lastIndex = platforms.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? lastIndex
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % platforms.length
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + platforms.length) % platforms.length
            : currentIndex;

    if (nextIndex === currentIndex && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextPlatform = platforms[nextIndex];
    setSelected(nextPlatform.id);
    document.getElementById(`platform-tab-${nextPlatform.id}`)?.focus();
  }

  return (
    <section className={styles.downloads} aria-labelledby="choose-platform-title">
      <div className={styles.sectionHeading}>
        <p>Choose your platform</p>
        <h2 id="choose-platform-title">One release, the right runtime.</h2>
      </div>

      <div className={styles.platformTabs} role="tablist" aria-label="Download platforms">
        {platforms.map((item, index) => (
          <button
            key={item.id}
            id={`platform-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected === item.id}
            aria-controls="platform-download-panel"
            tabIndex={selected === item.id ? 0 : -1}
            onClick={() => setSelected(item.id)}
            onKeyDown={(event) => movePlatformFocus(event, index)}
            className={selected === item.id ? styles.activeTab : undefined}
          >
            <span className={styles.tabNumber}>0{index + 1}</span>
            <span><strong>{item.name}</strong><small>{item.shortDetail}</small></span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        ))}
      </div>

      <div
        id="platform-download-panel"
        className={styles.downloadPanel}
        role="tabpanel"
        aria-labelledby={`platform-tab-${selected}`}
      >
        <div className={styles.primaryCard}>
          <div className={styles.cardHeading}>
            <span className={styles.platformIcon}>{platformIcon(selected)}</span>
            <span className={artifact ? styles.available : styles.unavailable}>
              <i aria-hidden="true" /> {artifact ? "Available now" : selected === "macos" ? "Coming later" : "Publication pending"}
            </span>
          </div>

          <div className={styles.cardCopy}>
            <p>{platform.name}</p>
            <h3>{artifact ? selected === "windows" ? "Desktop beta" : "Runner archive" : selected === "macos" ? "Not in this beta" : "Release pending"}</h3>
            <span>{platform.detail}</span>
          </div>

          <div className={styles.primaryActionRow}>
            {artifact ? (
              <a className={styles.primaryButton} href={artifact.downloadUrl}>
                <Download aria-hidden="true" size={16} /> Download {formatBytes(artifact.bytes)}
              </a>
            ) : (
              <a className={styles.secondaryButton} href="https://github.com/sndboxhq/sandbox/releases">
                <ExternalLink aria-hidden="true" size={15} /> View release status
              </a>
            )}
            {manifest && (
              <a className={styles.releaseLink} href={`https://github.com/${manifest.source.repository}/releases/tag/${manifest.tag}`}>
                Release notes <ExternalLink aria-hidden="true" size={13} />
              </a>
            )}
          </div>

          {unsignedWindowsBeta && (
            <div className={styles.notice}>
              <Info aria-hidden="true" size={17} />
              <p><strong>Unsigned Windows beta</strong>SmartScreen may show an unknown publisher warning. Verify the checksum before installing.</p>
            </div>
          )}

          {linuxRunner && (
            <div className={styles.notice}>
              <Server aria-hidden="true" size={17} />
              <p><strong>Headless runner</strong>Extract the archive, run <code>sudo ./install.sh</code>, then launch <code>sudo sandbox-runner</code>.</p>
            </div>
          )}
        </div>

        <aside className={styles.verificationCard} aria-label="Release verification">
          <div className={styles.verificationTitle}>
            <ShieldCheck aria-hidden="true" size={19} />
            <div><span>Release integrity</span><strong>Verify before you run</strong></div>
          </div>

          <dl>
            <div><dt>Release</dt><dd>{manifest ? releaseLabel : `${releaseLabel} pending`}</dd></div>
            <div><dt>File</dt><dd>{artifact?.name ?? "No published artifact"}</dd></div>
            <div><dt>Verification</dt><dd>{verificationLabel(selected, manifest, unsignedWindowsBeta)}</dd></div>
          </dl>

          <div className={styles.checksum}>
            <div><span>SHA-256 checksum</span>{artifact && <button type="button" onClick={copyChecksum}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>}</div>
            <code>{artifact?.sha256 ?? "Published with the final release artifact"}</code>
          </div>

          <p className={styles.verificationFootnote}>
            Downloads are served from the project’s GitHub release. Checksums let you confirm the file arrived unchanged.
          </p>
        </aside>
      </div>
    </section>
  );
}

function platformIcon(platform: PlatformId) {
  if (platform === "windows") return <Monitor aria-hidden="true" size={23} />;
  if (platform === "macos") return <Laptop aria-hidden="true" size={23} />;
  return <PackageOpen aria-hidden="true" size={23} />;
}

function verificationLabel(platform: PlatformId, manifest: ReleaseManifest | undefined, unsignedWindowsBeta: boolean) {
  if (platform === "windows") {
    if (unsignedWindowsBeta) return "SHA-256 checksum · unsigned beta";
    return manifest ? "Authenticode signature + SHA-256" : "Declared on publication";
  }
  return "Sigstore bundle + SHA-256";
}

function findArtifact(manifest: ReleaseManifest | undefined, platform: PlatformId): ReleaseArtifact | undefined {
  if (!manifest) return undefined;
  if (platform === "windows") return manifest.artifacts.find((item) => item.kind === "desktop-installer" && item.name.endsWith(".exe")) ?? manifest.artifacts.find((item) => item.kind === "desktop-installer");
  if (platform === "linux-x64") return manifest.artifacts.find((item) => item.kind === "runner-archive" && item.architecture === "x86_64");
  if (platform === "linux-arm64") return manifest.artifacts.find((item) => item.kind === "runner-archive" && item.architecture === "aarch64");
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
