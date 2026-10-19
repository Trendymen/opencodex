import { expect, test } from "bun:test";
import { LIVE_INSTALL_CREDENTIAL_ENV } from "../../scripts/test";
import { TEST_RUN_LOCK_TOKEN_ENV } from "../../scripts/test-run-lock";
import { changedFixtureDiagnostic } from "../helpers/fork-changed-fixture-diagnostic";

test.each(["raw", "json", "source", "json-source", "slash-raw", "slash-json", "slash-source", "slash-json-source"] as const)(
  "changed fixture diagnostics redact private values in %s output",
  representation => {
    const home = String.raw`C:\Synthetic "Profile"`;
    const cwd = home + String.raw`\fixture`;
    const env: Record<string, string> = {
      HOME: home, USERPROFILE: home + String.raw`\profile`,
      [TEST_RUN_LOCK_TOKEN_ENV]: String.raw`owner\"token`,
      ...Object.fromEntries(LIVE_INSTALL_CREDENTIAL_ENV.map((key, index) => [key, `credential-${index}\\ "value"`])),
    };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    const path = (value: string) => representation.startsWith("slash-") ? value.replaceAll("\\", "/") : value;
    const input = ["fixture selection failed", path(cwd + "\\records.json"), path(home + "\\keep"), path(env.USERPROFILE! + "\\settings"),
      env[TEST_RUN_LOCK_TOKEN_ENV], ...LIVE_INSTALL_CREDENTIAL_ENV.map(key => env[key])].join("|") + "|SAFE_SUFFIX";
    const expected = ["fixture selection failed", path("<redacted>\\records.json"), path("<redacted>\\keep"), path("<redacted>\\settings"),
      "<redacted>", ...LIVE_INSTALL_CREDENTIAL_ENV.map(() => "<redacted>")].join("|") + "|SAFE_SUFFIX";
    const render = (value: string) => {
      const format = representation.replace(/^slash-/, "");
      const source = `writeFileSync(${JSON.stringify(value)}, "fixture");`;
      return format === "raw" ? value : format === "json" ? JSON.stringify({ value })
        : format === "source" ? source : JSON.stringify({ source });
    };
    try {
      Object.assign(process.env, env);
      const child = Bun.spawnSync([process.execPath, "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]);", render(input)],
      { stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
      const diagnostic = JSON.parse(changedFixtureDiagnostic(child, [render(input)], cwd));
      expect(diagnostic.args).toEqual([render(expected)]);
      expect(diagnostic.stdout).toBe(render(expected));
      expect(diagnostic.stderr).toBe(render(expected));
      expect(diagnostic.exitCode).toBe(0);
      expect(diagnostic.signal).toBeNull();
      expect(diagnostic.timeout).toBe(false);
      expect(diagnostic.maxBuffer).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  },
);
