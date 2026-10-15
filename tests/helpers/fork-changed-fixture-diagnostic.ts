import { LIVE_INSTALL_CREDENTIAL_ENV } from "../../scripts/test";
import { TEST_RUN_LOCK_TOKEN_ENV } from "../../scripts/test-run-lock";
import { repoRoot } from "./repo-root";

export function changedFixtureDiagnostic(result: Bun.ReadableSyncSubprocess, args: string[], cwd: string): string {
  const privateValues = [cwd, repoRoot(), process.env.HOME, process.env.USERPROFILE]
    .flatMap(value => value ? [value, value.replaceAll("\\", "/")] : [])
    .concat([process.env[TEST_RUN_LOCK_TOKEN_ENV], ...LIVE_INSTALL_CREDENTIAL_ENV.map(key => process.env[key])]
      .filter((value): value is string => Boolean(value)))
    .flatMap(value => {
      // Fixture source quotes a path once; JSON child output can quote that source again.
      const escaped = JSON.stringify(value).slice(1, -1);
      return [value, escaped, JSON.stringify(escaped).slice(1, -1)];
    }).sort((a, b) => b.length - a.length);
  const redact = (value: string) => {
    for (const privateValue of privateValues) value = value.replaceAll(privateValue, "<redacted>");
    return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<token>").slice(-12_000);
  };
  return JSON.stringify({
    args: args.map(redact), exitCode: result.exitCode, signal: result.signalCode ?? null,
    timeout: result.exitedDueToTimeout ?? false, maxBuffer: result.exitedDueToMaxBuffer ?? false,
    stdout: redact(result.stdout.toString()), stderr: redact(result.stderr.toString()),
  });
}
