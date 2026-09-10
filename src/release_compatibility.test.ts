import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNNER_PROTOCOL_VERSION } from "@sandbox/contracts";

const root = resolve(import.meta.dirname, "..");
const releaseVersion = "0.7.10-beta.1";
const escapedReleaseVersion = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("v0.7.10 beta release compatibility", () => {
  it("keeps first-party surfaces and runtime components on one beta version", () => {
    const packages = [
      "package.json",
      "apps/web/package.json",
      "apps/marketing/package.json",
      "apps/docs/package.json",
      "browser-sidecar/package.json",
      "packages/api-client/package.json",
      "packages/brand/package.json",
      "packages/content/package.json",
      "packages/contracts/package.json",
      "packages/plugin-sdk/package.json",
      "packages/product-ui/package.json",
      "packages/ui/package.json",
      "services/browser-worker/package.json",
      "services/control-plane/package.json",
      "services/scheduler/package.json"
    ];
    for (const file of packages) {
      expect(JSON.parse(read(file)).version, file).toBe(releaseVersion);
    }

    const crates = [
      "agents/server/Cargo.toml",
      "services/hosted-runner/Cargo.toml",
      "src-tauri/Cargo.toml",
      "src-tauri/engine/Cargo.toml",
      "src-tauri/plugin-runtime/Cargo.toml"
    ];
    for (const file of crates) {
      expect(read(file), file).toMatch(new RegExp(`^version = "${escapedReleaseVersion}"$`, "m"));
    }
    const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(tauriConfig.version).toBe(releaseVersion);
    expect(read("src/components/Sidebar.tsx")).toContain("sndbox <small>v{packageMetadata.version}</small>");
    expect(tauriConfig.bundle.targets).toEqual(["nsis"]);
    expect(tauriConfig.bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
    expect(tauriConfig.bundle.windows.nsis.uninstallerIcon).toBe("icons/icon.ico");
    const browserSidecar = read("src-tauri/src/browser_sidecar.rs");
    expect(browserSidecar).toContain("const CREATE_NO_WINDOW: u32 = 0x0800_0000;");
    expect(browserSidecar).toContain("command.creation_flags(CREATE_NO_WINDOW);");
  });

  it("keeps runtime constants and protocol boundaries aligned", () => {
    expect(RUNNER_PROTOCOL_VERSION).toBe(2);
    expect(read("agents/server/src/lib.rs")).toContain('pub const RUNNER_PROTOCOL_VERSION: u16 = 2;');
    expect(read("agents/server/src/lib.rs")).toContain(`pub const ENGINE_VERSION: &str = "${releaseVersion}";`);
    expect(read("agents/server/src/lib.rs")).toContain(`pub const PLUGIN_RUNTIME_VERSION: &str = "${releaseVersion}";`);
    expect(read("src-tauri/plugin-runtime/src/lib.rs")).toContain(`pub const HOST_VERSION: &str = "${releaseVersion}";`);
    expect(read("agents/server/config.example.toml")).toContain('pinned_version_range = ">=0.7.3-beta.1,<0.8"');
  });

  it("attests prerelease artifacts while keeping stable Windows releases fail-closed", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain('tags: ["v*.*.*"]');
    expect(workflow).toContain("vMAJOR.MINOR.PATCH-beta.NUMBER");
    expect(workflow).toContain("WINDOWS_CERTIFICATE_PASSWORD");
    expect(workflow).toContain("SANDBOX_ACCOUNT_AUTH_URL: ${{ vars.SANDBOX_ACCOUNT_AUTH_URL }}");
    expect(workflow).toContain("SANDBOX_ACCOUNT_TOKEN_URL: ${{ vars.SANDBOX_ACCOUNT_TOKEN_URL }}");
    expect(workflow).toContain("SANDBOX_ACCOUNT_AUDIENCE: ${{ vars.SANDBOX_ACCOUNT_AUDIENCE }}");
    expect(workflow).toContain("SANDBOX_ACCOUNT_CLIENT_ID: ${{ vars.SANDBOX_NATIVE_CLIENT_ID }}");
    expect(workflow).toContain("SANDBOX_CONTROL_PLANE_URL: ${{ vars.SANDBOX_CONTROL_PLANE_URL }}");
    expect(read("src-tauri/src/commands.rs")).toContain("ACCOUNT_AUTH_CALLBACK_PORT: u16 = 53_682");
    expect(read("src-tauri/src/account_auth.rs")).toContain('.append_pair("audience", &configuration.audience)');
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain('echo "prerelease=true"');
    expect(workflow).toContain("Stable releases require WINDOWS_CERTIFICATE");
    expect(workflow).toContain('WINDOWS_INSTALLER_SIGNED=false');
    expect(workflow).toContain('$signature.Status -ne "NotSigned"');
    expect(workflow).toContain("UNSIGNED-WINDOWS-BETA.txt");
    expect(workflow).toContain('if ($signature.Status -ne "Valid")');
    expect(workflow.match(/actions\/attest@[a-f0-9]{40}/g)).toHaveLength(3);
    expect(workflow).toContain("cosign verify-blob");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("cosign verify\n");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("agents/server/Dockerfile");
    expect(workflow).toContain("services/hosted-runner/Dockerfile");
    expect(workflow).toContain("services/browser-worker/Dockerfile");
    expect(workflow).toContain("services/control-plane/Dockerfile");
    expect(workflow).not.toContain("apps/docs/Dockerfile");
    expect(workflow).toContain("apps/web/Dockerfile");
    expect(workflow).toContain("needs: [verify-release, desktop-windows, agent-linux, containers]");
    expect(workflow).toContain("generate-release-manifest.mjs");
    expect(workflow).toContain("--prerelease");
    expect(workflow).not.toContain("--draft");
    expect(workflow).not.toMatch(/uses: [^\n]+@(v\d+|stable|main)\s*$/m);
    expect(workflow.match(/if: github\.event\.repository\.private == false/g)).toHaveLength(3);

    const agentRelease = read("agents/server/packaging/build-release.sh");
    expect(agentRelease).toContain('RELEASE_SIGNING_REQUIRED:-0');
    expect(agentRelease).toContain("cosign is required for a production release.");
    expect(agentRelease).toContain("test -s SHA256SUMS.sigstore.json");
    expect(read("agents/server/Dockerfile")).toContain("COPY src-tauri/engine src-tauri/engine");
    expect(read("agents/server/Dockerfile")).toContain("FROM rust:1.95-bookworm AS build");
    expect(read("agents/server/Dockerfile")).toContain("COPY src-tauri/plugin-runtime src-tauri/plugin-runtime");
    expect(read("agents/server/Dockerfile")).toContain("src-tauri/src/provider_adapter.rs");
    expect(read("agents/server/Dockerfile.dockerignore")).toContain("!src-tauri/plugin-runtime/**");
    expect(read("agents/server/Dockerfile")).toContain("USER nonroot:nonroot");

    const downloads = read("apps/marketing/app/downloads/DownloadsClient.tsx");
    expect(downloads).toContain("Unsigned test build · SHA-256 checksum");
    expect(downloads).toContain("SmartScreen may show an unknown publisher warning");
  });

  it("keeps release container builds cacheable and independently scoped", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("type=registry,ref=${{ steps.image.outputs.name }}:buildcache");
    expect(workflow).toContain("type=gha,scope=container-${{ matrix.name }}");
    expect(workflow).toContain("cache-to: type=registry,ref=${{ steps.image.outputs.name }}:buildcache,mode=max");
    expect(workflow).toContain("timeout-minutes: ${{ needs.verify-release.outputs.prerelease == 'true' && 60 || 180 }}");
    expect(workflow).toContain("platforms: ${{ needs.verify-release.outputs.prerelease == 'true' && 'linux/amd64' || matrix.platforms }}");
    expect(workflow).toContain("if: needs.verify-release.outputs.prerelease != 'true'");
    expect(workflow).not.toContain("Build browser worker distribution");

    const dockerfiles = [
      "agents/server/Dockerfile",
      "apps/marketing/Dockerfile",
      "apps/web/Dockerfile",
      "services/browser-worker/Dockerfile",
      "services/control-plane/Dockerfile",
      "services/hosted-runner/Dockerfile",
    ];
    for (const file of dockerfiles) {
      expect(read(file), file).toMatch(/^# syntax=docker\/dockerfile:1\.7/m);
      expect(read(file), file).toContain("--mount=type=cache");
      expect(read(`${file}.dockerignore`), `${file}.dockerignore`).toMatch(/^\*\*$/m);
    }

    expect(read("apps/marketing/Dockerfile")).not.toContain("COPY . .");
    expect(read("apps/web/Dockerfile")).not.toContain("COPY . .");
    expect(read("apps/marketing/Dockerfile")).toContain("COPY packages/product-ui packages/product-ui");
    expect(read("apps/web/Dockerfile")).toContain("COPY packages/product-ui packages/product-ui");
    expect(read("apps/marketing/Dockerfile")).toContain("FROM deps AS contracts-build");
    expect(read("apps/marketing/Dockerfile")).toContain("npm run build --workspace @sandbox/contracts");
    expect(read("apps/web/Dockerfile")).toContain("FROM deps AS contracts-build");
    expect(read("apps/web/Dockerfile")).toContain("npm run build --workspace @sandbox/contracts");
    expect(read("services/browser-worker/Dockerfile")).toContain("npm prune --omit=dev");
    expect(read("services/control-plane/Dockerfile")).toContain("npm ci --omit=dev");
    expect(read("services/control-plane/Dockerfile")).toContain("/source/services/control-plane/node_modules ./services/control-plane/node_modules");
    expect(read("services/control-plane/Dockerfile")).toContain("services/control-plane/db ./services/control-plane/db");
  });

  it("keeps the beta Droplet deployment repeatable and health-gated", () => {
    const deploymentWorkflow = read(".github/workflows/deploy-digitalocean.yml");
    expect(deploymentWorkflow).toContain("workflow_call:");
    expect(deploymentWorkflow).toContain("workflow_dispatch:");
    expect(deploymentWorkflow).toContain("environment: digitalocean-beta");
    expect(deploymentWorkflow).toContain("packages: read");
    expect(deploymentWorkflow).toContain("StrictHostKeyChecking yes");
    expect(deploymentWorkflow).toContain("DROPLET_SSH_KNOWN_HOSTS");
    expect(deploymentWorkflow).not.toContain("ssh-keyscan");

    const releaseWorkflow = read(".github/workflows/release.yml");
    expect(releaseWorkflow).toContain("vars.DEPLOY_DIGITALOCEAN == 'true'");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/deploy-digitalocean.yml");

    const compose = read("deploy/digitalocean/compose.yml");
    expect(compose).toContain("image: caddy:2.11.4-alpine");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("127.0.0.1}:3100:3100");
    expect(compose).toContain("127.0.0.1}:3300:3300");
    expect(compose).not.toContain("sandbox-docs:${SANDBOX_VERSION");
    expect(compose).toContain("sandbox-account:${SANDBOX_VERSION");
    expect(compose).toContain("OIDC_AUDIENCE: ${OIDC_AUDIENCE");
    expect(compose).toContain('test: ["CMD", "node", "-e"');

    const deployScript = read("deploy/digitalocean/deploy.sh");
    expect(deployScript).toContain("Deployment failed; restoring the previous public-site version.");
    expect(deployScript).toContain("services=(website account caddy)");
    expect(deployScript).toContain("pull account >/dev/null 2>&1");
    expect(deployScript).toContain("OIDC_REDIRECT_URI OIDC_AUDIENCE");
    expect(deployScript).toContain("up -d --no-deps caddy");
    expect(deployScript).toContain("--wait-timeout 180");
    expect(deployScript).toContain("if [[ ! -f .env ]]");
    expect(read("deploy/digitalocean/Caddyfile")).toContain("reverse_proxy website:3100");
    expect(read("deploy/digitalocean/Caddyfile")).not.toContain("reverse_proxy docs:3200");
    expect(read("deploy/digitalocean/Caddyfile")).toContain("reverse_proxy account:3300");
  });

  it("keeps documentation on the generated Mintlify surface", () => {
    const config = JSON.parse(read("apps/docs/docs.json"));
    expect(config.$schema).toBe("https://mintlify.com/docs.json");
    expect(config.name).toBe("sndbox docs");
    expect(config.navigation.tabs).toHaveLength(4);
    expect(JSON.stringify(config)).toContain('"source":"api-reference/openapi.json"');

    const docsPackage = JSON.parse(read("apps/docs/package.json"));
    expect(docsPackage.scripts.build).toBe("mint validate");
    expect(docsPackage.scripts["generate:references"]).toContain("generate-docs-reference.ts");
    expect(read("scripts/generate-docs-reference.ts")).toContain("NODE_DEFINITIONS");
    expect(read(".github/workflows/ci.yml")).toContain("npm run docs:build");
    expect(read(".github/workflows/release.yml")).not.toContain("sandbox-docs");
  });
});

function read(file: string): string {
  return readFileSync(resolve(root, file), "utf8");
}
