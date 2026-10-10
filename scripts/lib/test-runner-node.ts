import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { type as nativeOsType } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

const NODE_PROBE_BUDGET_MS = 5_000;
const NODE_PROBE_STEP_MS = 2_000;
const NODE_PROBE_EXPRESSION = "process.execPath + '\\n' + process.versions.node";

/** Resolve the runtime behind a PATH shim before HOME moves into the test sandbox. */
export function getTestRunnerNodeDirectory(
  env: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
): string {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const isWindows = nativeOsType() === "Windows_NT";
  const nodeName = isWindows ? "node.exe" : "node";
  const deadline = Date.now() + NODE_PROBE_BUDGET_MS;
  const probe = (binary: string, probeEnv: Record<string, string | undefined>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    try {
      const output = execFileSync(binary, ["-p", NODE_PROBE_EXPRESSION], {
        env: probeEnv,
        encoding: "utf8",
        timeout: Math.min(NODE_PROBE_STEP_MS, remaining),
        maxBuffer: 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().split(/\r?\n/);
      return output.length === 2 && /^\d+\.\d+\.\d+$/.test(output[1]!)
        ? output[0]!
        : undefined;
    } catch {
      return undefined;
    }
  };
  const seen = new Set<string>();
  for (const entry of (env[pathKey] ?? "").split(delimiter)) {
    if (!entry || Date.now() >= deadline) continue;
    const directory = resolve(entry.replace(/^"(.*)"$/, "$1"));
    if (directory.split(sep).some(segment => segment.toLowerCase() === "node_modules")) continue;
    const candidate = join(directory, nodeName);
    const key = isWindows ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    const binary = probe(candidate, { ...env });
    if (!binary || !isAbsolute(binary) || basename(binary).toLowerCase() !== nodeName) continue;
    const sandboxEnv = { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome };
    const direct = probe(binary, sandboxEnv);
    try {
      if (direct && realpathSync(direct) === realpathSync(binary)) {
        return dirname(binary);
      }
    } catch {
      // A probe can report a path that no longer exists; try the next PATH entry.
    }
  }
  throw new Error("No usable Node executable on PATH for isolated tests. Put a working Node on PATH; no install was attempted.");
}

export function pinTestNodePath(
  isolatedEnv: Record<string, string | undefined>,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
): void {
  const pathKey = Object.keys(sourceEnv).find(key => key.toLowerCase() === "path") ?? "PATH";
  const probeEnv = {
    ...isolatedEnv,
    HOME: sourceEnv.HOME,
    USERPROFILE: sourceEnv.USERPROFILE,
    [pathKey]: sourceEnv[pathKey],
  };
  const nodeDirectory = getTestRunnerNodeDirectory(probeEnv, isolatedHome);
  const sourcePath = sourceEnv[pathKey] ?? "";
  const firstDirectory = sourcePath.split(delimiter, 1)[0];
  const alreadyFirst = nativeOsType() === "Windows_NT"
    ? firstDirectory?.toLowerCase() === nodeDirectory.toLowerCase()
    : firstDirectory === nodeDirectory;
  isolatedEnv[pathKey] = alreadyFirst ? sourcePath : `${nodeDirectory}${delimiter}${sourcePath}`;
}
