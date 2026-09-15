import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockHost } from "./mock-host.js";
import { inspectPackage, packDirectory, signDirectory } from "./package.js";
import { scaffold } from "./scaffold.js";
import { createScaffoldFiles } from "./scaffold-files.js";
import { permissionDiff, validateManifest } from "./validation.js";

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-sdk-"));
  await scaffold(root, { pluginId: "com.example.echo", publisherId: "com.example.publisher", name: "Echo" });
  await writeFile(path.join(root, "components", "main.wasm"), "wasm");
  await mkdir(path.join(root, "dist"), { recursive: true });
  return root;
}

describe("plugin SDK", () => {
  it("uses the same configurable starter files in every host", () => {
    const files = createScaffoldFiles({ pluginId: "uk.sndbox.weather", publisherId: "uk.sndbox", name: "Weather", description: "Local forecasts", nodeType: "weather.lookup", nodeName: "Look up weather" });
    const manifest = JSON.parse(files.find(file => file.path === "manifest.json")!.contents);
    expect(files.map(file => file.path)).toContain("guest/src/lib.rs");
    expect(manifest).toMatchObject({ minimumHostVersion: ">=0.8.0", description: "Local forecasts", nodes: [{ nodeType: "weather.lookup", displayName: "Look up weather" }] });
  });

  it("scaffolds and reproducibly packages a project", async () => {
    const root = await project();
    const one = path.join(root, "dist", "one.zip");
    const two = path.join(root, "dist", "two.zip");
    await packDirectory(root, one);
    await packDirectory(root, two);
    expect(await readFile(one)).toEqual(await readFile(two));
    expect((await inspectPackage(one)).manifest.pluginId).toBe("com.example.echo");
  });

  it("signs a package with Ed25519 and validates it", async () => {
    const root = await project();
    const { privateKey } = generateKeyPairSync("ed25519");
    const key = path.join(root, "development.private.pem");
    await writeFile(key, privateKey.export({ format: "pem", type: "pkcs8" }));
    const output = path.join(root, "dist", "signed.sandbox-plugin");
    const result = await signDirectory(root, key, "development", output);
    expect(result.manifest.packageIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await inspectPackage(output)).validation.valid).toBe(true);
  });

  it("reports validation and permission-expansion failures", async () => {
    const root = await project();
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    const next = structuredClone(manifest);
    next.capabilities.push({ type: "network" });
    next.networkDomains.push({ domain: "api.example.com", methods: ["get"] });
    next.privacyPolicy = "https://example.com/privacy";
    expect(permissionDiff(manifest, next)).toContain("Connect to api.example.com using GET");
    next.nodes[0].executionEntrypoint = "missing";
    expect(validateManifest(next).valid).toBe(false);
  });

  it("provides a typed mock host that blocks secret-shaped responses", async () => {
    const host = new MockHost().on("time", () => ({ value: { unixTimeMs: 1 }, diagnostics: [] }));
    expect((await host.call({ operation: "time" })).value).toEqual({ unixTimeMs: 1 });
    const unsafe = new MockHost().on("credential_operation", () => ({ value: { accessToken: "secret" }, diagnostics: [] }));
    await expect(unsafe.call({ operation: "credential_operation", credentialReference: "mail", credentialType: "gmail", action: "list" })).rejects.toThrow(/secret-like/);
  });
});
