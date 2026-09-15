#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { watch } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { generateDocumentation } from "./docs.js";
import { inspectPackage, packDirectory, readManifest, signDirectory } from "./package.js";
import { scaffold } from "./scaffold.js";
import { permissionSummary, validateManifest } from "./validation.js";

const program = new Command().name("sandbox").description("sndbox developer CLI").version("8.0.0-beta.1");
const plugin = program.command("plugin").description("Build, validate, test, sign, and publish sandboxed plugins");

plugin.command("create <directory>")
  .requiredOption("--plugin-id <id>", "Reverse-domain plugin ID")
  .requiredOption("--publisher-id <id>", "Publisher ID")
  .option("--name <name>", "Display name", "sndbox plugin")
  .action(async (directory, options) => {
    await scaffold(path.resolve(directory), { pluginId: options.pluginId, publisherId: options.publisherId, name: options.name });
    console.log(`Created ${options.name} in ${path.resolve(directory)}.`);
  });

plugin.command("validate [directory]").option("--signed", "Require package signature").action(async (directory = ".", options) => {
  const manifest = await readManifest(path.resolve(directory));
  const result = validateManifest(manifest, Boolean(options.signed));
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (!result.valid) throw new Error(result.errors.join("\n"));
  console.log(`${manifest.pluginId}@${manifest.version} is valid.`);
  for (const permission of permissionSummary(manifest)) console.log(`  permission: ${permission}`);
});

plugin.command("test [directory]").action(async (directory = ".") => {
  const root = path.resolve(directory);
  await run("cargo", ["test", "--manifest-path", path.join(root, "guest", "Cargo.toml")], root);
});

plugin.command("pack [directory]").option("-o, --output <file>").action(async (directory = ".", options) => {
  const root = path.resolve(directory);
  const manifest = await readManifest(root);
  const output = path.resolve(options.output ?? path.join(root, "dist", `${filename(manifest.pluginId)}-${manifest.version}.unsigned.sandbox-plugin`));
  await mkdir(path.dirname(output), { recursive: true });
  await packDirectory(root, output);
  console.log(`Packed unsigned development package ${output}.`);
});

plugin.command("sign [directory]").requiredOption("--key <pem>", "Ed25519 PKCS#8 private key").requiredOption("--key-id <id>", "Publisher key ID").option("-o, --output <file>").action(async (directory = ".", options) => {
  const root = path.resolve(directory);
  const manifest = await readManifest(root);
  const output = path.resolve(options.output ?? path.join(root, "dist", `${filename(manifest.pluginId)}-${manifest.version}.sandbox-plugin`));
  await mkdir(path.dirname(output), { recursive: true });
  const signed = await signDirectory(root, path.resolve(options.key), options.keyId, output);
  console.log(`Signed ${signed.manifest.packageIntegrity} as ${output}.`);
});

plugin.command("keygen <directory>").option("--key-id <id>", "Key ID", "development").action(async (directory, options) => {
  const target = path.resolve(directory);
  await mkdir(target, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(path.join(target, `${options.keyId}.private.pem`), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  await writeFile(path.join(target, `${options.keyId}.public.pem`), publicKey.export({ format: "pem", type: "spki" }));
  console.log(`Generated Ed25519 key '${options.keyId}'. Keep the private PEM outside plugin packages.`);
});

plugin.command("inspect <package>").action(async packageFile => {
  const inspection = await inspectPackage(path.resolve(packageFile));
  console.log(JSON.stringify({ pluginId: inspection.manifest.pluginId, version: inspection.manifest.version, publisherId: inspection.manifest.publisherId, integrity: inspection.manifest.packageIntegrity, files: inspection.files, permissions: permissionSummary(inspection.manifest), validation: inspection.validation }, null, 2));
});

plugin.command("docs [directory]").option("-o, --output <file>").action(async (directory = ".", options) => {
  const root = path.resolve(directory);
  const docs = generateDocumentation(await readManifest(root));
  const output = path.resolve(options.output ?? path.join(root, "dist", "PLUGIN.md"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, docs);
  console.log(`Generated ${output}.`);
});

plugin.command("publish <package>").option("--api <url>", "Control-plane API", process.env.SANDBOX_API_URL).option("--token <token>", "Publisher access token", process.env.SANDBOX_PUBLISH_TOKEN).action(async (packageFile, options) => {
  if (!options.api || !options.token) throw new Error("--api/SANDBOX_API_URL and --token/SANDBOX_PUBLISH_TOKEN are required.");
  const inspection = await inspectPackage(path.resolve(packageFile));
  if (!inspection.validation.valid) throw new Error(inspection.validation.errors.join("\n"));
  const response = await fetch(`${String(options.api).replace(/\/$/, "")}/v1/publishers/${encodeURIComponent(inspection.manifest.publisherId)}/submissions`, {
    method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/vnd.sandbox.plugin+zip", "idempotency-key": inspection.manifest.packageIntegrity },
    body: new Uint8Array(await readFile(path.resolve(packageFile))), signal: AbortSignal.timeout(60_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Publishing failed with HTTP ${response.status}: ${body.slice(0, 2_000)}`);
  console.log(body);
});

plugin.command("dev [directory]").option("--once", "Build once instead of watching").action(async (directory = ".", options) => {
  const root = path.resolve(directory);
  const build = async () => {
    await buildGuest(root);
    const manifest = await readManifest(root);
    const output = path.join(root, "dist", `${filename(manifest.pluginId)}-${manifest.version}.development.sandbox-plugin`);
    await mkdir(path.dirname(output), { recursive: true });
    await packDirectory(root, output);
    console.log(`Development package rebuilt: ${output}. sndbox will still require capability approval and the production sandbox.`);
  };
  await build();
  if (options.once) return;
  let timer: NodeJS.Timeout | undefined;
  watch(root, { recursive: true }, (_event, changed) => {
    if (!changed || changed.startsWith("dist") || changed.includes("target")) return;
    clearTimeout(timer);
    timer = setTimeout(() => void build().catch(error => console.error(error)), 200);
  });
  console.log("Watching for development plugin changes. Development packages remain disabled in production workspaces.");
});

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function buildGuest(root: string): Promise<void> {
  const manifest = await readManifest(root);
  await run("cargo", ["build", "--manifest-path", path.join(root, "guest", "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"], root);
  const crateName = manifest.pluginId.replace(/[^a-z0-9]+/g, "_") + "_guest";
  const built = path.join(root, "guest", "target", "wasm32-unknown-unknown", "release", `${crateName}.wasm`);
  const destination = path.join(root, manifest.entrypoints[0].path);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(built, destination);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}.`)));
  });
}

function filename(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-");
}
