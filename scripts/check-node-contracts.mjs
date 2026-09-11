import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = resolve(root, "src/generated/node-contracts.json");
const result = spawnSync(
  process.platform === "win32" ? "cargo.exe" : "cargo",
  ["run", "--quiet", "--manifest-path", "src-tauri/engine/Cargo.toml", "--bin", "export_node_contracts"],
  { cwd: root, encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "Could not generate node contracts.\n");
  process.exit(result.status ?? 1);
}

const generated = `${result.stdout.trim()}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(snapshotPath, generated, "utf8");
  process.stdout.write(`Updated ${snapshotPath}\n`);
  process.exit(0);
}

let current = "";
try { current = readFileSync(snapshotPath, "utf8").replaceAll("\r\n", "\n"); } catch { /* reported as drift below */ }
if (current !== generated.replaceAll("\r\n", "\n")) {
  process.stderr.write("Frontend node contract snapshot drifted from the engine registry. Run `npm run node-contracts:write`.\n");
  process.exit(1);
}
process.stdout.write("Node contract snapshot matches the engine registry.\n");
