export interface ReleaseArtifact {
  kind: "desktop-installer" | "runner-archive" | "checksum" | "signature" | "container-reference" | "supporting-file";
  platform: "windows" | "linux" | "any";
  architecture: "x86_64" | "aarch64" | "multi" | "any";
  name: string;
  bytes: number;
  sha256: string;
  downloadUrl: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: "sndbox";
  version: string;
  tag: string;
  channel: "beta" | "stable";
  source: { repository: string; commit: string };
  artifacts: ReleaseArtifact[];
}

const defaultManifestUrl = "https://github.com/sndboxhq/sandbox/releases/download/v0.7.10-beta.2/release-manifest.json";

export async function loadReleaseManifest(): Promise<ReleaseManifest | undefined> {
  const url = process.env.SANDBOX_RELEASE_MANIFEST_URL ?? defaultManifestUrl;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return undefined;
    return validateManifest(await response.json());
  } catch {
    return undefined;
  }
}

function validateManifest(value: unknown): ReleaseManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== 1 || manifest.product !== "sndbox" || !manifest.version || !manifest.tag || !manifest.source || !Array.isArray(manifest.artifacts)) return undefined;
  const valid = manifest.artifacts.every(artifact => artifact
    && typeof artifact.name === "string"
    && typeof artifact.kind === "string"
    && typeof artifact.bytes === "number"
    && /^[a-f0-9]{64}$/.test(artifact.sha256)
    && artifact.downloadUrl.startsWith("https://github.com/"));
  return valid ? manifest as ReleaseManifest : undefined;
}
