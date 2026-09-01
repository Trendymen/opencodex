import { describe, expect, test } from "bun:test";
import {
  finalizeLocalInstallCleanup,
  prepareLocalInstallSource,
  type LocalInstallSourcePreparationDeps,
} from "../scripts/install-local";
import type { PreparedLocalPackage } from "../scripts/install-local-vendor";

const ORIGINAL = JSON.stringify({
  name: "@bitkyc08/opencodex",
  version: "2.38.0-ben.2",
  files: ["bin", "src"],
  dependencies: { bun: "1.4.0" },
});

function prepared(rootManifestBytes = ORIGINAL, cleanup: () => void = () => {}): PreparedLocalPackage {
  return {
    tarball: "/owned/package.tgz",
    npmCache: "/owned/cache",
    rootManifestBytes,
    cleanup,
  };
}

describe("Fork local installer root-manifest lifecycle", () => {
  test("source preparation drift fails before patch, packing, stop, or replacement admission", () => {
    let manifest = ORIGINAL;
    const events: string[] = [];
    const deps: LocalInstallSourcePreparationDeps = {
      readManifestBytes: () => manifest,
      build: () => {
        events.push("build");
        manifest = JSON.stringify({
          ...JSON.parse(ORIGINAL),
          files: ["bin", "src", "unexpected-secret"],
        });
      },
      patch: () => {
        events.push("patch");
        return { files: 1, replacements: 1 };
      },
      prepare: () => {
        events.push("pack");
        return prepared();
      },
    };

    expect(() => prepareLocalInstallSource(deps)).toThrow(/source preparation/i);
    expect(events).toEqual(["build"]);
  });

  test("a prepared-package manifest mismatch cleans the owned stage before failing", () => {
    const events: string[] = [];
    expect(() => prepareLocalInstallSource({
      readManifestBytes: () => ORIGINAL,
      build: () => { events.push("build"); },
      patch: () => { events.push("patch"); return { files: 1, replacements: 1 }; },
      prepare: () => {
        events.push("pack");
        return prepared("mutated", () => { events.push("cleanup"); });
      },
    })).toThrow(/root package.json changed/i);
    expect(events).toEqual(["build", "patch", "pack", "cleanup"]);
  });

  test("a source-preparation error stays primary when prepared cleanup also fails", () => {
    const cleanup = new Error("cleanup failed");
    try {
      prepareLocalInstallSource({
        readManifestBytes: () => ORIGINAL,
        build: () => {},
        patch: () => ({ files: 1, replacements: 1 }),
        prepare: () => prepared("mutated", () => { throw cleanup; }),
      });
      throw new Error("expected source preparation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const errors = (error as AggregateError).errors;
      expect((errors[0] as Error).message).toMatch(/root package.json changed/i);
      expect(errors[1]).toBe(cleanup);
    }
  });

  test("an unchanged source transfers the exact pre-build snapshot to staging", () => {
    let expectedByPrepare = "";
    const result = prepareLocalInstallSource({
      readManifestBytes: () => ORIGINAL,
      build: () => {},
      patch: () => ({ files: 2, replacements: 3 }),
      prepare: expected => {
        expectedByPrepare = expected;
        return prepared(expected);
      },
    });
    expect(expectedByPrepare).toBe(ORIGINAL);
    expect(result.rootManifestBytes).toBe(ORIGINAL);
    expect(result.identity).toEqual({ name: "@bitkyc08/opencodex", version: "2.38.0-ben.2" });
    expect(result.fontPatch).toEqual({ files: 2, replacements: 3 });
  });

  test("lifecycle failure remains primary when final staged cleanup also fails", () => {
    const lifecycle = new Error("lifecycle failed");
    const cleanup = new Error("cleanup failed");
    try {
      finalizeLocalInstallCleanup({ cleanup: () => { throw cleanup; } }, lifecycle);
      throw new Error("expected finalization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([lifecycle, cleanup]);
    }
    expect(() => finalizeLocalInstallCleanup({ cleanup: () => {} }, lifecycle)).toThrow(lifecycle);
    expect(() => finalizeLocalInstallCleanup({ cleanup: () => { throw cleanup; } })).toThrow(cleanup);
  });
});
