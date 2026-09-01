import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledDependenciesForLocalPackage,
  defaultLocalPackageStageOptions,
  prepareBundledLocalPackage,
  type LocalPackageStageOptions,
} from "../scripts/install-local-vendor";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local installer vendored dependencies", () => {
  test("bundles every runtime dependency in sorted order", () => {
    expect(
      bundledDependenciesForLocalPackage({ zod: "4.4.3", bun: "1.4.0" }),
    ).toEqual(["bun", "zod"]);
    expect(bundledDependenciesForLocalPackage(undefined)).toEqual([]);
  });

  test("preparation keeps the primary error ahead of cleanup failure", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "ocx-install-local-vendor-error-"));
    temporaryDirectories.push(packageRoot);
    const stageRoot = join(packageRoot, "owned-stage");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      files: [],
      dependencies: {},
    }));
    mkdirSync(join(packageRoot, "node_modules"));
    const primary = new Error("pack failed");
    const cleanup = new Error("cleanup failed");
    const options: LocalPackageStageOptions = {
      ...defaultLocalPackageStageOptions,
      makeTempRoot: () => stageRoot,
      run: () => { throw primary; },
      removeTree: () => { throw cleanup; },
    };

    try {
      prepareBundledLocalPackage(packageRoot, options);
      throw new Error("expected preparation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, cleanup]);
    }
    expect(existsSync(packageRoot)).toBe(true);
  });
});
