import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProviderDebugLaunchdDefault,
  launchdProxyPlistPath,
  localInstallAfterReplace,
  localInstallRestartEnv,
  refreshProviderDebugLaunchd,
  restartLocalInstall,
} from "../scripts/install-local";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const basePlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opencodex.proxy</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCX_SERVICE</key><string>1</string>
  </dict>
</dict>
</plist>
`;

function tempPlist(content = basePlist): string {
  const directory = mkdtempSync(join(tmpdir(), "ocx-install-local-"));
  temporaryDirectories.push(directory);
  const plist = join(directory, "com.opencodex.proxy.plist");
  writeFileSync(plist, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(plist, 0o600);
  return plist;
}

describe("local installer provider debug handling", () => {
  test.skipIf(process.platform !== "darwin")(
    "uses plutil to update a temporary plist before replacing the original and is idempotent",
    () => {
      const plist = tempPlist();
      const original = readFileSync(plist, "utf8");

      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(true);
      expect(readFileSync(plist, "utf8")).toMatch(/<key>OCX_DEBUG<\/key>\s*<string>1<\/string>/);
      expect(statSync(plist).mode & 0o777).toBe(0o600);
      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(false);
      expect(readFileSync(plist, "utf8")).not.toBe(original);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "replaces an existing non-default OCX_DEBUG value without duplicating it",
    () => {
      const plist = tempPlist(basePlist.replace(
        "    <key>OCX_SERVICE</key><string>1</string>",
        "    <key>OCX_SERVICE</key><string>1</string>\n    <key>OCX_DEBUG</key><string>0</string>",
      ));
      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(true);
      const updated = readFileSync(plist, "utf8");
      expect(updated.match(/<key>OCX_DEBUG<\/key>/g)).toHaveLength(1);
      expect(updated).toMatch(/<key>OCX_DEBUG<\/key>\s*<string>1<\/string>/);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "normalizes a non-string OCX_DEBUG value to the required string environment value",
    () => {
      const plist = tempPlist(basePlist.replace(
        "    <key>OCX_SERVICE</key><string>1</string>",
        "    <key>OCX_SERVICE</key><string>1</string>\n    <key>OCX_DEBUG</key><integer>1</integer>",
      ));
      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(true);
      expect(readFileSync(plist, "utf8")).toMatch(/<key>OCX_DEBUG<\/key>\s*<string>1<\/string>/);
      expect(readFileSync(plist, "utf8")).not.toContain("<integer>1</integer>");
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "normalizes a string OCX_DEBUG value containing whitespace",
    () => {
      const plist = tempPlist(basePlist.replace(
        "    <key>OCX_SERVICE</key><string>1</string>",
        "    <key>OCX_SERVICE</key><string>1</string>\n    <key>OCX_DEBUG</key><string> 1 </string>",
      ));
      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(true);
      expect(readFileSync(plist, "utf8")).toMatch(/<key>OCX_DEBUG<\/key>\s*<string>1<\/string>/);
      expect(readFileSync(plist, "utf8")).not.toContain("<string> 1 </string>");
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "keeps the original plist when temporary validation fails",
    () => {
      const plist = tempPlist();
      const original = readFileSync(plist, "utf8");
      expect(() => ensureProviderDebugLaunchdDefault(plist, {
        validate: () => { throw new Error("synthetic plist validation failure"); },
      })).toThrow("synthetic plist validation failure");
      expect(readFileSync(plist, "utf8")).toBe(original);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "reloads launchd in lint, unload, load order after changing the plist",
    () => {
      const plist = tempPlist();
      const events: string[] = [];
      refreshProviderDebugLaunchd(plist, {
        validate: path => { events.push(`lint:${path}`); },
        launchctl: args => {
          events.push(args.join(" "));
          return { ok: true, stdout: "", stderr: "", status: 0 };
        },
      });
      expect(events).toHaveLength(3);
      expect(events[0]?.startsWith(`lint:${plist}.ocx.`)).toBe(true);
      expect(events.slice(1)).toEqual([`unload ${plist}`, `load -w ${plist}`]);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "fails when launchctl reports a load failure on stderr despite exit status zero",
    () => {
      const plist = tempPlist();
      expect(() => refreshProviderDebugLaunchd(plist, {
        validate: () => {},
        launchctl: args => args[0] === "load"
          ? { ok: true, stdout: "", stderr: "Load failed: 5: Input/output error", status: 0 }
          : { ok: true, stdout: "", stderr: "", status: 0 },
      })).toThrow("launchctl could not load");
    },
  );

  test("does not invoke the post-replace plist hook for a restart or absent service", () => {
    const events: string[] = [];
    localInstallAfterReplace(true, false, () => { events.push("ensure"); }, "darwin");
    localInstallAfterReplace(true, true, () => { events.push("unexpected-restart"); }, "darwin");
    localInstallAfterReplace(false, false, () => { events.push("unexpected-absent"); }, "darwin");
    localInstallAfterReplace(true, false, () => { events.push("unexpected-non-darwin"); }, "linux");
    expect(events).toEqual(["ensure"]);
  });

  test("repair/start commands inherit provider debug and only repaired services reload launchd", () => {
    const events: string[] = [];
    restartLocalInstall(true, {
      run: (command, options) => { events.push(`run:${command.join(" ")}:${options?.env?.OCX_DEBUG}`); },
      refresh: () => { events.push("refresh"); },
    }, "darwin");
    restartLocalInstall(false, {
      run: (command, options) => { events.push(`run:${command.join(" ")}:${options?.env?.OCX_DEBUG}`); },
      refresh: () => { events.push("unexpected-refresh"); },
    }, "darwin");
    restartLocalInstall(true, {
      run: (command, options) => { events.push(`run:${command.join(" ")}:${options?.env?.OCX_DEBUG}`); },
      refresh: () => { events.push("unexpected-non-darwin-refresh"); },
    }, "linux");
    expect(events).toEqual([
      "run:ocx service repair:1",
      "refresh",
      "run:ocx start:1",
      "run:ocx service repair:undefined",
    ]);
  });

  test("restart environment preserves existing variables while forcing provider debug", () => {
    expect(localInstallRestartEnv({ PATH: "/usr/bin", OCX_DEBUG: "0" })).toEqual({
      PATH: "/usr/bin",
      OCX_DEBUG: "1",
    });
  });

  test("non-Darwin restart environments remain unchanged", () => {
    expect(localInstallRestartEnv({ PATH: "/usr/bin" }, "linux")).toEqual({ PATH: "/usr/bin" });
  });

  test.skipIf(process.platform !== "darwin")(
    "fails closed for malformed plist input without replacing the original",
    () => {
      const plist = tempPlist("<plist><dict><key>Label</key><string>broken</string></dict></plist>");
      const original = readFileSync(plist, "utf8");
      expect(() => ensureProviderDebugLaunchdDefault(plist)).toThrow(/could not set OCX_DEBUG|validation failed/);
      expect(readFileSync(plist, "utf8")).toBe(original);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "tightens a legacy world-readable plist while enabling provider debug",
    () => {
      const plist = tempPlist();
      chmodSync(plist, 0o644);
      expect(ensureProviderDebugLaunchdDefault(plist)).toBe(true);
      expect(statSync(plist).mode & 0o777).toBe(0o600);
    },
  );

  test("builds the launchd plist path under the requested home", () => {
    expect(launchdProxyPlistPath("/tmp/example-home")).toBe(
      "/tmp/example-home/Library/LaunchAgents/com.opencodex.proxy.plist",
    );
  });
});
