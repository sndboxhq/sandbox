import type { PluginManifest } from "./types.js";

export interface ScaffoldOptions {
  pluginId: string;
  name: string;
  publisherId: string;
  description?: string;
  nodeType?: string;
  nodeName?: string;
}

export interface ScaffoldFile {
  path: string;
  contents: string;
}

/** The canonical starter shared by the SDK CLI and desktop Plugin Builder. */
export function createScaffoldFiles(options: ScaffoldOptions): ScaffoldFile[] {
  const description = options.description?.trim() || `${options.name} integration`;
  const nodeType = options.nodeType?.trim() || `${options.pluginId}.echo`;
  const nodeName = options.nodeName?.trim() || "Echo";
  const manifest: PluginManifest = {
    manifestVersion: 1, pluginId: options.pluginId, name: options.name, description, version: "0.1.0", publisherId: options.publisherId,
    minimumHostVersion: ">=0.8.0", homepage: "https://example.com", documentation: "https://example.com/docs", supportUrl: "https://example.com/support", licence: "MIT",
    categories: ["developer-tools"], keywords: [], icon: "assets/icon.svg",
    nodes: [{ nodeType, nodeVersion: 1, displayName: nodeName, description: "Returns typed input.", category: "Data", riskLevel: "low", inputSchema: { type: "object" }, outputSchema: { type: "object" }, configurationSchema: { type: "object", properties: {}, additionalProperties: false }, credentialRequirements: [], capabilities: ["workflow_input", "structured_logging"], timeoutMs: 10_000, retryBehavior: "safe", idempotencySupport: "read_only", documentation: "docs/echo.md", migrationHandlers: [], executionEntrypoint: "main" }],
    credentials: [], capabilities: [{ type: "workflow_input" }, { type: "structured_logging" }], networkDomains: [], storageRequirements: { temporaryBytes: 0, persistentBytes: 0, isolateByMajorVersion: false }, migrations: [],
    entrypoints: [{ id: "main", path: "components/main.wasm", export: "execute" }], packageIntegrity: "", signature: { algorithm: "ed25519", keyId: "", value: "" }, pricing: { model: "free" }
  };
  return [
    { path: "manifest.json", contents: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "guest/Cargo.toml", contents: cargoToml(options.pluginId) },
    { path: "guest/src/lib.rs", contents: rustGuest },
    { path: "assets/icon.svg", contents: icon },
    { path: "docs/echo.md", contents: `# ${nodeName}\n\nReturns the JSON input using the production sndbox JSON ABI.\n` },
    { path: "README.md", contents: `# ${options.name}\n\n${description}\n\nBuild with \`sandbox plugin dev .\`. The development package still uses the production sandbox and requires permission approval.\n` }
  ];
}

function cargoToml(pluginId: string): string {
  const name = pluginId.replace(/[^a-z0-9]+/g, "-");
  return `[package]\nname = "${name}-guest"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\nserde_json = "1"\n\n[profile.release]\nopt-level = "s"\nlto = true\npanic = "abort"\nstrip = true\n`;
}

const rustGuest = `use serde_json::{json, Value};

#[no_mangle]
pub extern "C" fn alloc(length: i32) -> i32 {
    let mut value = Vec::<u8>::with_capacity(length.max(0) as usize);
    let pointer = value.as_mut_ptr();
    std::mem::forget(value);
    pointer as i32
}

#[no_mangle]
pub unsafe extern "C" fn execute(pointer: i32, length: i32) -> i64 {
    let input = std::slice::from_raw_parts(pointer as *const u8, length.max(0) as usize);
    let value: Value = serde_json::from_slice(input).unwrap_or_else(|_| json!({"error":"invalid input"}));
    return_json(json!({"echo":value}))
}

fn return_json(value: Value) -> i64 {
    let mut output = serde_json::to_vec(&value).unwrap_or_else(|_| b"null".to_vec());
    let pointer = output.as_mut_ptr() as u32;
    let length = output.len() as u32;
    std::mem::forget(output);
    ((pointer as i64) << 32) | length as i64
}
`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1266c4"/><path d="M18 32h28M32 18v28" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>\n`;
