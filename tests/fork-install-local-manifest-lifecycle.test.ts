import { describe, expect, test } from "bun:test";
import {
  finalizeLocalInstallCleanup,
  runLocalInstallLifecycleWithManifestGuard,
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

  test("a post-prepare manifest read failure still cleans the owned stage exactly once", () => {
    let reads = 0;
    let cleanups = 0;
    const readFailure = new Error("manifest temporarily unreadable");
    expect(() => prepareLocalInstallSource({
      readManifestBytes: () => {
        reads += 1;
        if (reads === 4) throw readFailure;
        return ORIGINAL;
      },
      build: () => {},
      patch: () => ({ files: 1, replacements: 1 }),
      prepare: expected => prepared(expected, () => { cleanups += 1; }),
    })).toThrow(readFailure);
    expect(cleanups).toBe(1);
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

  test("lifecycle-admission manifest failure still reaches final staged cleanup", async () => {
    const manifest = new Error("manifest drift before stop");
    const cleanup = new Error("cleanup failed");
    let lifecycleError: unknown;
    let cleanupCalls = 0;
    try {
      await runLocalInstallLifecycleWithManifestGuard(true, {
        stop: () => { throw new Error("stop must not run"); },
        verifyStopped: () => {},
        replace: () => {},
        restart: () => {},
        ready: () => {},
      }, () => { throw manifest; });
    } catch (error) {
      lifecycleError = error;
    }
    try {
      finalizeLocalInstallCleanup({
        cleanup: () => { cleanupCalls += 1; throw cleanup; },
      }, lifecycleError);
      throw new Error("expected finalization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([manifest, cleanup]);
    }
    expect(cleanupCalls).toBe(1);
  });

  test("manifest drift after replacement never blocks restart and ready recovery", async () => {
    for (const replaceFails of [false, true]) {
      const events: string[] = [];
      let drifted = false;
      const replaceError = new Error("replace failed");
      let lifecycleError: unknown;
      try {
        await runLocalInstallLifecycleWithManifestGuard(true, {
          stop: () => { events.push("stop"); },
          verifyStopped: () => { events.push("verify"); },
          replace: () => {
            events.push("replace");
            drifted = true;
            if (replaceFails) throw replaceError;
          },
          restart: () => { events.push("restart"); },
          ready: () => { events.push("ready"); },
        }, phase => {
          if (drifted && phase === "local install lifecycle completion") {
            throw new Error("manifest drift after replacement");
          }
        });
      } catch (error) {
        lifecycleError = error;
      }
      expect(events).toEqual(["stop", "verify", "replace", "restart", "ready"]);
      if (replaceFails) expect(lifecycleError).toBe(replaceError);
      else expect((lifecycleError as Error).message).toMatch(/manifest drift after replacement/);
    }
  });
});
