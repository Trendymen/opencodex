import { describe, expect, test } from "bun:test";
import { buildWindowsServiceScript } from "../../src/service";

describe("Windows service pending package transaction recovery", () => {
  test("restores only the marker-owned backup and rejects reparse points", () => {
    const script = buildWindowsServiceScript({
      bun: "C:\\OpenCodex\\bun.exe",
      bunRuntimeSource: "bundled",
      cli: "C:\\OpenCodex\\src\\cli\\index.ts",
    });

    expect(script).toContain(".ocx-transaction.json");
    expect(script).toContain("ConvertFrom-Json");
    expect(script).toContain(".ocx-recovery.json");
    expect(script).toContain("restored package failed verification");
    expect(script).toContain("[IO.FileAttributes]::ReparsePoint");
    expect(script).toContain("$root.Parent.FullName -ieq $scope");
    // The exact-marker hardening runs first inside a sentinel-guarded span; the
    // official dir-scan survives only as the fallback after it (probe recognition
    // requires the official bytes, and the probe strips exactly the guarded span).
    expect(script).toContain("rem OCX-FORK-RESTORE-BEGIN");
    expect(script).toContain("rem OCX-FORK-RESTORE-END");
    expect(script).toContain(":fork_official_fallback");
    const fallback = script.indexOf(":fork_official_fallback");
    const scan = script.indexOf('dir /b /ad /o-n "%OCX_PKG_DIR%\\..\\.ocx-backup-*"');
    expect(scan).toBeGreaterThan(fallback);
    expect(script).toContain("goto backup_restored");
  });
});
