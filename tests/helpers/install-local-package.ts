import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pkgName = "@bitkyc08/opencodex";

export function packageTree(packageDir: string, version: string): void {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: pkgName,
    version,
    bin: { ocx: "bin/ocx.mjs" },
    dependencies: { zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "x".repeat(2_048));
  writeFileSync(join(packageDir, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod" }));
}

export function version(packageDir: string): string {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
}
