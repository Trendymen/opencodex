import { realpathSync } from "node:fs";
import { type as nativeOsType } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

const NODE_PROBE_BUDGET_MS = 5_000;
const NODE_PROBE_STEP_MS = 2_000;
const NODE_PROBE_EXPRESSION = "process.execPath + '\\n' + process.versions.node";
const PROBE_ERRNO = new Set(["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "EIO", "EINVAL", "ENOEXEC"]);

function probeErrorCategory(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  const detail = error as { code?: unknown; status?: unknown } | null;
  if (typeof detail?.code === "string" && PROBE_ERRNO.has(detail.code)) return detail.code;
  return typeof detail?.status === "number" && detail.status !== 0 ? "exit-nonzero" : "probe-failed";
}

async function readNodeProbe(
  binary: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  deadline: number,
): Promise<string> {
  const probeDeadline = Math.min(deadline, Date.now() + timeoutMs);
  const child = Bun.spawn([binary, "-p", NODE_PROBE_EXPRESSION], {
    env, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true,
  });
  const reader = child.stdout.getReader();
  let reading = true;
  const output = (async () => {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (reading) {
        const chunk = await reader.read();
        if (!reading) break;
        if (chunk.done) return text + decoder.decode();
        bytes += chunk.value.byteLength;
        if (bytes > 1024) throw Object.assign(new Error("Node probe output exceeded its limit."), { code: "ENOBUFS" });
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    } finally { reader.releaseLock(); }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([output, child.exited]).then(([text, status]) => {
        if (status !== 0) throw Object.assign(new Error("Node probe exited unsuccessfully."), { status });
        return text;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Node probe deadline exceeded."), { code: "ETIMEDOUT" })), Math.max(0, probeDeadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    reading = false;
    try { child.kill("SIGKILL"); } catch { /* probe already exited */ }
    try { void reader.cancel().catch(() => {}); } catch { /* reader already released */ }
    const reapMs = Math.min(100, Math.max(0, deadline - Date.now()));
    if (reapMs > 0) {
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([child.exited, new Promise(resolve => { reapTimer = setTimeout(resolve, reapMs); })]);
      clearTimeout(reapTimer);
    }
    if (child.exitCode === null) {
      try { child.unref(); } catch { /* reap handle already closed */ }
    }
  }
}

/** Resolve the runtime behind a PATH shim before HOME moves into the test sandbox. */
export async function getTestRunnerNodeDirectory(
  env: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
): Promise<string> {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const nativeOS = nativeOsType();
  const isWindows = nativeOS === "Windows_NT";
  const nodeName = isWindows ? "node.exe" : "node";
  const deadline = Date.now() + NODE_PROBE_BUDGET_MS;
  const failures = new Map<string, number>();
  const record = (stage: "source" | "sandbox" | "realpath", category: string) => {
    const key = `${stage}:${category}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  };
  const probe = async (binary: string, probeEnv: Record<string, string | undefined>, stage: "source" | "sandbox") => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { record(stage, "budget-exhausted"); return undefined; }
    try {
      const output = (await readNodeProbe(binary, probeEnv, Math.min(NODE_PROBE_STEP_MS, remaining), deadline))
        .trim().split(/\r?\n/);
      if (output.length === 2 && /^\d+\.\d+\.\d+$/.test(output[1]!)) return output[0]!;
      record(stage, "invalid-output");
      return undefined;
    } catch (error) {
      record(stage, probeErrorCategory(error));
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
    const binary = await probe(candidate, { ...env }, "source");
    if (!binary) continue;
    if (!isAbsolute(binary) || basename(binary).toLowerCase() !== nodeName) {
      record("source", "invalid-binary");
      continue;
    }
    const sandboxEnv = { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome };
    const direct = await probe(binary, sandboxEnv, "sandbox");
    try {
      if (direct && realpathSync(direct) === realpathSync(binary)) {
        return dirname(binary);
      }
      if (direct) record("realpath", "mismatch");
    } catch (error) {
      record("realpath", probeErrorCategory(error));
      // A probe can report a path that no longer exists; try the next PATH entry.
    }
  }
  const categories = [...failures].map(([key, count]) => `${key}=${count}`).join(",") || "no-probes";
  const safeOS = ["Darwin", "Linux", "Windows_NT"].includes(nativeOS) ? nativeOS : "other";
  const safePlatform = ["darwin", "linux", "win32", "freebsd", "openbsd", "netbsd", "aix", "sunos"].includes(process.platform)
    ? process.platform : "other";
  throw new Error("No usable Node executable on PATH for isolated tests. Put a working Node on PATH; no install was attempted. "
    + `Probe diagnostics: ${categories}; spawn=${typeof Bun.spawn}; realpathSync=${typeof realpathSync}; `
    + `nativeOS=${safeOS}; platform=${safePlatform}; budgetExhausted=${Date.now() >= deadline}.`);
}

export async function pinTestNodePath(
  isolatedEnv: Record<string, string | undefined>,
  sourceEnv: Readonly<Record<string, string | undefined>>,
  isolatedHome: string,
): Promise<void> {
  const pathKey = Object.keys(sourceEnv).find(key => key.toLowerCase() === "path") ?? "PATH";
  const probeEnv = {
    ...isolatedEnv,
    HOME: sourceEnv.HOME,
    USERPROFILE: sourceEnv.USERPROFILE,
    [pathKey]: sourceEnv[pathKey],
  };
  const nodeDirectory = await getTestRunnerNodeDirectory(probeEnv, isolatedHome);
  const sourcePath = sourceEnv[pathKey] ?? "";
  const firstDirectory = sourcePath.split(delimiter, 1)[0];
  const alreadyFirst = nativeOsType() === "Windows_NT"
    ? firstDirectory?.toLowerCase() === nodeDirectory.toLowerCase()
    : firstDirectory === nodeDirectory;
  isolatedEnv[pathKey] = alreadyFirst ? sourcePath : `${nodeDirectory}${delimiter}${sourcePath}`;
}
