import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledDependenciesForLocalPackage,
  runWithBundledDependencies,
} from "../scripts/install-local-vendor";

const temporaryDirectories: string[] = [];

function tempPackageJson(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ocx-install-local-vendor-"));
  temporaryDirectories.push(directory);
  const packageJsonPath = join(directory, "package.json");
  writeFileSync(packageJsonPath, content, "utf8");
  return packageJsonPath;
}

describe("local installer vendored dependencies", () => {
  test("bundles every runtime dependency in sorted order", () => {
    expect(
      bundledDependenciesForLocalPackage({ zod: "4.4.3", bun: "1.4.0" }),
    ).toEqual(["bun", "zod"]);
    expect(bundledDependenciesForLocalPackage(undefined)).toEqual([]);
  });

  test("injections are restored byte-for-byte after a successful run", () => {
    const original = '{"dependencies":{"zod":"4.4.3","bun":"1.4.0"}}';
    const packageJsonPath = tempPackageJson(original);
    const during = runWithBundledDependencies(packageJsonPath, () =>
      JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bundleDependencies?: string[] },
    );
    expect(during.bundleDependencies).toEqual(["bun", "zod"]);
    expect(readFileSync(packageJsonPath, "utf8")).toBe(original);
  });

  test("original bytes survive a throwing run", () => {
    const original = '{"dependencies":{"bun":"1.4.0"}}';
    const packageJsonPath = tempPackageJson(original);
    expect(() =>
      runWithBundledDependencies(packageJsonPath, () => {
        throw new Error("pack failed");
      }),
    ).toThrow("pack failed");
    expect(readFileSync(packageJsonPath, "utf8")).toBe(original);
  });
});

for (const directory of temporaryDirectories.splice(0)) {
  rmSync(directory, { recursive: true, force: true });
}
