import { describe, expect, test } from "bun:test";
import { buildWindowsServiceScript } from "../src/service";

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
    expect(script).not.toContain('dir /b /ad /o-n "%OCX_PKG_DIR%\\..\\.ocx-backup-*"');
  });
});
