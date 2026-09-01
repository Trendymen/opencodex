import { describe, expect, test } from "bun:test";
import {
  finalizeLocalInstallCleanup,
  runLocalInstallLifecycleWithManifestGuard,
} from "../scripts/install-local";

describe("Fork local installer pre-replacement guard recovery", () => {
  test("restores a stopped service when stop-verification manifest guard fails", async () => {
    const events: string[] = [];
    const manifestError = new Error("manifest drift after stop verification");

    try {
      await runLocalInstallLifecycleWithManifestGuard(true, {
        stop: () => { events.push("stop"); },
        verifyStopped: () => { events.push("verify"); },
        replace: () => { events.push("replace"); },
        restart: () => { events.push("restart"); },
        ready: () => { events.push("ready"); },
      }, phase => {
        if (phase === "local install stop verification") throw manifestError;
      });
      throw new Error("expected manifest guard failure");
    } catch (error) {
      expect(error).toBe(manifestError);
    }

    expect(events).toEqual(["stop", "verify", "restart", "ready"]);
  });

  test("keeps guard failure primary when recovery fails and cleans the stage once", async () => {
    const events: string[] = [];
    const manifestError = new Error("manifest drift after stop verification");
    const recoveryError = new Error("ready failed");
    let lifecycleError: unknown;
    let cleanupCalls = 0;

    try {
      await runLocalInstallLifecycleWithManifestGuard(true, {
        stop: () => { events.push("stop"); },
        verifyStopped: () => { events.push("verify"); },
        replace: () => { events.push("replace"); },
        restart: () => { events.push("restart"); },
        ready: () => { events.push("ready"); throw recoveryError; },
      }, phase => {
        if (phase === "local install stop verification") throw manifestError;
      });
    } catch (error) {
      lifecycleError = error;
    }

    expect(lifecycleError).toBeInstanceOf(AggregateError);
    expect((lifecycleError as AggregateError).errors).toEqual([manifestError, recoveryError]);
    try {
      finalizeLocalInstallCleanup({ cleanup: () => { cleanupCalls += 1; } }, lifecycleError);
      throw new Error("expected lifecycle failure after cleanup");
    } catch (error) {
      expect(error).toBe(lifecycleError);
    }
    expect(cleanupCalls).toBe(1);
    expect(events).toEqual(["stop", "verify", "restart", "ready"]);
  });
});
