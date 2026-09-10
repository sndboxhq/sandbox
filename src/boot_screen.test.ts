import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("startup screen", () => {
  it("renders branded progress before the application bundle mounts", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain('class="boot-screen" role="status"');
    expect(html).toContain('src="/sndbox-icon.svg"');
    expect(html).toContain('class="boot-spinner"');
    expect(html.indexOf("boot-screen")).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
  });
});
