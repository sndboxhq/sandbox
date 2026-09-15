import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createScaffoldFiles, type ScaffoldOptions } from "./scaffold-files.js";

export type { ScaffoldFile, ScaffoldOptions } from "./scaffold-files.js";
export { createScaffoldFiles } from "./scaffold-files.js";

export async function scaffold(directory: string, options: ScaffoldOptions): Promise<void> {
  // Preserve the CLI's ready-to-build output directory; the desktop writer
  // creates it on first `plugin dev` when the Wasm artifact is copied.
  await mkdir(path.join(directory, "components"), { recursive: true });
  for (const file of createScaffoldFiles(options)) {
    const destination = path.join(directory, ...file.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.contents);
  }
}
