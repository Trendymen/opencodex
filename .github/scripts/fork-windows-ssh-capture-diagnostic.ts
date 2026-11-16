import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED = {
  candidate: "826cacdc6b4cd8e202eeebcb7a432bf0300aa918",
  official: "873ec9b3b8ddf63f06738748d9132d779abefb42",
} as const;
type Source = keyof typeof EXPECTED;
const TARGET = "verbose stderr past 64 KiB neither ends the tunnel nor changes its exit class, and is stored sanitized";
const CAPTURE_TEST = "tests/clients/link-ssh-capture-tunnels.test.ts";
const BATCH = [
  "tests/clients/desktop-telemetry-installer.test.ts",
  "tests/clients/integrations-writer-guard.test.ts",
  "tests/clients/link-ocx-child-e2e.test.ts",
  "tests/clients/link-pinned-sync-overwrite.test.ts",
  CAPTURE_TEST,
  "tests/clients/link-ssh-capture.test.ts",
] as const;
const TEST_LIMIT_MS = 480_000;
const PROBE_LIMIT_MS = 120_000;
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const scriptPath = resolve(import.meta.path);
const diagnosticRoot = resolve(import.meta.dir, "../..");
const workspace = resolve(import.meta.dir, "../../..");
const sources: Record<Source, string> = { candidate: join(workspace, "candidate"), official: join(workspace, "official") };
const tempRoot = process.env.RUNNER_TEMP;

function requireEnvironment(): string {
  if (process.platform !== "win32" || Bun.version !== "1.4.4" || !tempRoot || !isAbsolute(tempRoot)) throw new Error("unsupported_environment");
  if (basename(diagnosticRoot).toLowerCase() !== "diagnostic" || !existsSync(tempRoot)) throw new Error("invalid_layout");
  return resolve(tempRoot);
}

function safeError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return ["EACCES", "EPERM", "ETIMEDOUT", "EICACLS", "EACLIDENTITY", "ENOENT"].includes(code) ? code : "unknown";
}

function sandboxEnvironment(root: string): Record<string, string> {
  const temp = join(root, "temp");
  const local = join(root, "AppData", "Local");
  const roaming = join(root, "AppData", "Roaming");
  const markerDir = join(root, "ssh-sentinel");
  for (const dir of [root, temp, local, roaming, markerDir, join(root, ".opencodex"), join(root, ".codex")]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "PATH", "PATHEXT", "ComSpec", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: root, USERPROFILE: root, LOCALAPPDATA: local, APPDATA: roaming,
    TEMP: temp, TMP: temp, TMPDIR: temp,
    OPENCODEX_HOME: join(root, ".opencodex"), CODEX_HOME: join(root, ".codex"), CLAUDE_CONFIG_DIR: join(root, ".claude"),
    RUNNER_TEMP: requireEnvironment(), CI: "true", GITHUB_ACTIONS: "true", OCX_TEST_NO_QUEUE: "1",
    OCX_TEST_SSH_SENTINEL: join(markerDir, "attempts"),
    OCX_DISABLE_UPDATE_CHECK: "1", OCX_TELEMETRY: "0", OPENCODEX_KIRO_MODEL_DISCOVERY: "0",
  };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ settled: true as const, value })),
      new Promise<{ settled: false }>(done => { timer = setTimeout(() => done({ settled: false }), ms); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  const kept: Uint8Array[] = [];
  let bytes = 0;
  let size = 0;
  const done = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        hash.update(next.value);
        if (size < LOG_LIMIT_BYTES) {
          const part = next.value.subarray(0, LOG_LIMIT_BYTES - size);
          kept.push(part);
          size += part.byteLength;
        }
      }
      return { bytes, truncated: bytes > LOG_LIMIT_BYTES, digest: hash.digest("hex"), text: Buffer.concat(kept).toString("utf8") };
    } finally { reader.releaseLock(); }
  })();
  return { done, cancel: () => { void reader.cancel().catch(() => {}); } };
}

type ProcessResult = {
  exitCode: number | null; timedOut: boolean; exitConfirmed: boolean; treeReaped: boolean | null; streamsClosed: boolean | null; spawnFailed: boolean; elapsedMs: number;
  stdout: { bytes: number; truncated: boolean; digest: string; text: string } | null;
  stderr: { bytes: number; truncated: boolean; digest: string; text: string } | null;
};

async function runProcess(executable: string, args: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<ProcessResult> {
  const started = performance.now();
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try { child = Bun.spawn([executable, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true }); }
  catch { return { exitCode: null, timedOut: false, exitConfirmed: false, treeReaped: null, streamsClosed: null, spawnFailed: true, elapsedMs: Math.round(performance.now() - started), stdout: null, stderr: null }; }
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const first = await within(child.exited, timeoutMs);
  let exitCode: number | null = first.settled ? first.value : null;
  let exitConfirmed = first.settled;
  let treeReaped: boolean | null = null;
  if (!first.settled) {
    treeReaped = false;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot && isAbsolute(systemRoot)) {
      try {
        const termination = Bun.spawnSync([join(systemRoot, "System32", "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"],
          { env, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 5_000 });
        treeReaped = termination.success && termination.exitCode === 0 && termination.exitedDueToTimeout !== true && termination.signalCode == null;
      } catch { /* The direct kill below is still attempted. */ }
    }
    try { child.kill(); } catch { /* The child may already have exited. */ }
    const afterKill = await within(child.exited, 5_000);
    if (afterKill.settled) { exitCode = afterKill.value; exitConfirmed = true; }
  }
  const outputs = await within(Promise.all([stdout.done, stderr.done]).catch(() => null), 5_000);
  const streamsClosed = outputs.settled && outputs.value !== null;
  if (!streamsClosed) { stdout.cancel(); stderr.cancel(); }
  return {
    exitCode, timedOut: !first.settled, exitConfirmed, treeReaped, streamsClosed, spawnFailed: false, elapsedMs: Math.round(performance.now() - started),
    stdout: outputs.settled && outputs.value ? outputs.value[0] : null,
    stderr: outputs.settled && outputs.value ? outputs.value[1] : null,
  };
}

function safeLog(result: ProcessResult) {
  const text = `${result.stdout?.text ?? ""}\n${result.stderr?.text ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const matches = text.split(/\r?\n/).filter(line => line.includes(TARGET)).map(line => /\((pass|fail|skip)\)/.exec(line)?.[1]).filter(Boolean);
  const target = matches.includes("fail") ? "fail" : matches.includes("pass") ? "pass" : matches.includes("skip") ? "skip" : "unknown";
  const count = (kind: string) => {
    const values = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${kind}\\b`, "gm"))];
    return values.length ? Number(values.at(-1)![1]) : null;
  };
  return {
    target, pass: count("pass"), fail: count("fail"), skip: count("skip"),
    undefinedPathTypeError: text.includes("ERR_INVALID_ARG_TYPE") && text.includes("paths[1]"),
    streams: [result.stdout, result.stderr].map(stream => stream && ({ bytes: stream.bytes, truncated: stream.truncated, sha256: stream.digest })),
  };
}

function fixedResult(result: ProcessResult) {
  return { exitCode: result.exitCode, timedOut: result.timedOut, exitConfirmed: result.exitConfirmed, treeReaped: result.treeReaped, streamsClosed: result.streamsClosed, spawnFailed: result.spawnFailed, elapsedMs: result.elapsedMs };
}

async function probe(source: Source): Promise<void> {
  const temp = requireEnvironment();
  if (process.cwd().toLowerCase() !== sources[source].toLowerCase()
    || !process.env.OPENCODEX_HOME?.toLowerCase().startsWith(`${temp.toLowerCase()}\\`)
    || !process.env.HOME?.toLowerCase().startsWith(`${temp.toLowerCase()}\\`)) throw new Error("invalid_probe_context");
  const fixture = mkdtempSync(join(temp, "ocx-ssh-capture-probe-"));
  const linkDirectory = join(fixture, "link");
  const captureModule = await import(pathToFileURL(join(sources[source], "src/link/ssh-capture.ts")).href);
  const supervisorModule = await import(pathToFileURL(join(sources[source], "src/link/supervisor.ts")).href);
  const runnerModule = await import(pathToFileURL(join(sources[source], "src/link/ssh-runner.ts")).href);
  const started = performance.now();
  const data: Record<string, unknown> = { source, acl: "unknown", releaseEvidence: false, captureOpen: 0, tapCalls: 0 };
  let flush: Promise<void> | undefined;
  let flushSettled = false;
  const elapsed = () => Math.round(performance.now() - started);
  try {
    captureModule.startSshCapture({ linkDirectory, now: Date.now() });
    const dir = captureModule.sshCaptureDir(linkDirectory) as string;
    const opener = captureModule.defaultSshCaptureOpener(linkDirectory);
    captureModule.retainSshCapture(linkDirectory);
    const snapshot = () => {
      try {
        const names = readdirSync(dir).filter(name => /^ssh-\d{13}\.jsonl$/.test(name));
        const bytes = names.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
        return { elapsedMs: elapsed(), windowOpen: captureModule.readSshCaptureControl(dir, Date.now()) !== null, files: names.length, bytes };
      } catch { return { elapsedMs: elapsed(), windowOpen: "unknown", files: null, bytes: null }; }
    };
    const observed = (tunnel: string, linkId: string) => {
      const capture = opener(tunnel, linkId);
      if (!capture) return null;
      data.captureOpen = Number(data.captureOpen) + 1;
      return { logLevel: capture.logLevel, stderrLine(line: string) { data.tapCalls = Number(data.tapCalls) + 1; return capture.stderrLine(line); } };
    };
    const encoder = new TextEncoder();
    const exits: Array<(value: number) => void> = [];
    let kills = 0;
    const lines = [
      [...Array.from({ length: 1_500 }, (_, index) => `debug1: channel ${index}: connected to 127.0.0.1 port 19001\n`),
        "channel 3: open failed: connect failed: Connection refused\n",
        "debug1: connect_next: connect to 127.0.0.1 port 19001: Connection refused\n",
        "Transferred: sent 10, received 20 bytes, in 30.0 seconds\n"],
      ["debug1: Connecting to child.example.test [203.0.113.9] port 22.\n", "debug1: No more authentication methods to try.\n",
        "alice@child.example.test: Permission denied (publickey).\n"],
    ];
    const spawn = (argv: string[]) => {
      let exit!: (value: number) => void;
      const exited = new Promise<number>(done => { exit = done; });
      exits.push(exit);
      const script = lines[exits.length - 1] ?? [];
      return {
        pid: 700 + exits.length, argv,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { for (const line of script) controller.enqueue(encoder.encode(line)); controller.close(); } }),
        exited, kill() { kills++; exit(143); },
      };
    };
    const runner = runnerModule.createSshRunner({ spawn });
    let current = 0;
    let tick: (() => void) | undefined;
    const id = "lnk_0123456789abcdef";
    const supervisor = supervisorModule.createLinkSupervisor({
      readStore: () => ({ version: 1, listenerPort: 19001, links: [{
        id, alias: "child.example.test", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
        tunnelPort: 19002, apiKeyId: "fixture", createdAt: "2026-09-25T00:00:00.000Z",
      }] }),
      runner, pidfileDir: linkDirectory, random: () => 0.5, now: () => current, sshCapture: observed,
      readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
      setTimer: (callback: () => void) => { tick = callback; return 1; }, clearTimer: () => {},
    });
    supervisor.start();
    try {
      await Bun.sleep(20);
      exits[0]?.(255);
      await Bun.sleep(20);
      current = 1_000;
      tick?.();
      exits[1]?.(255);
      await Bun.sleep(20);
      data.spawnCount = exits.length;
      data.killCountBeforeStop = kills;
      const state = supervisor.status()[0]?.state;
      data.authFailed = state?.kind === "failed" && state.reason === "auth";
    } finally {
      data.beforeStop = snapshot();
      await supervisor.stop();
      data.afterStop = snapshot();
      data.killCountAfterStop = kills;
    }
    const flushFlight: Promise<void> = opener.flush().then(() => { flushSettled = true; });
    flush = flushFlight;
    const bounded = await within(flushFlight, 5_000);
    data.flush = bounded.settled ? "settled" : "timeout";
    data.afterFlushBound = snapshot();
    await Bun.sleep(500);
    data.after500ms = snapshot();
    data.outcome = "observed";
  } catch (error) {
    data.outcome = "probe_error";
    data.error = safeError(error);
  }
  console.log(`OCX_PROBE_RESULT=${JSON.stringify(data)}`);
  if (flush && !flushSettled) await flush;
  try { rmSync(fixture, { recursive: true, force: true }); } catch { /* The hosted runner later discards its temporary files. */ }
}

async function main(): Promise<void> {
  const temp = requireEnvironment();
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || process.env.GITHUB_REF !== "refs/heads/codex/ben2-ssh-capture-diagnostic"
    || process.env.GITHUB_REPOSITORY !== "Trendymen/opencodex"
    || !/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "")
    || !process.env.GITHUB_WORKSPACE
    || realpathSync(process.env.GITHUB_WORKSPACE).toLowerCase() !== realpathSync(workspace).toLowerCase()) throw new Error("invalid_dispatch_context");
  const outputDir = join(temp, "ocx-ssh-capture-diagnostic");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "results.json");
  const summary: Record<string, unknown> = { kind: "ssh-capture-diagnostic", releaseEvidence: false, bun: Bun.version, platform: process.platform, architecture: arch(), osRelease: release(), checks: {}, runs: [] };
  const runs = summary.runs as Array<Record<string, unknown>>;
  const save = () => { const value = JSON.stringify(summary, null, 2); writeFileSync(outputPath, `${value}\n`); console.log(value); };
  try {
    for (const [label, dir, expected] of [["diagnostic", diagnosticRoot, process.env.GITHUB_SHA!], ...Object.entries(EXPECTED).map(([key, sha]) => [key, sources[key as Source], sha])] as const) {
      if (realpathSync(dir).toLowerCase() !== resolve(workspace, label).toLowerCase()) throw new Error("checkout_mismatch");
      const env = sandboxEnvironment(join(outputDir, `head-${label}`));
      const result = await runProcess("git", ["rev-parse", "HEAD"], dir, env, 30_000);
      const actual = result.stdout?.text.trim();
      if (result.exitCode !== 0 || result.timedOut || actual !== expected) throw new Error("checkout_mismatch");
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown; testRunnerBun?: unknown };
      if (pkg.testRunnerBun !== "1.4.4" || typeof pkg.version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version)) throw new Error("package_mismatch");
      (summary.checks as Record<string, unknown>)[label] = { head: actual, packageVersion: pkg.version, testRunnerBun: pkg.testRunnerBun };
    }
    for (const [kind, source, round] of [
      ["case", "candidate", 1], ["case", "official", 1], ["case", "official", 2], ["case", "candidate", 2],
      ["batch", "candidate", 1], ["batch", "official", 1],
    ] as const) {
      const env = sandboxEnvironment(join(outputDir, `test-${kind}-${source}-${round}`));
      const files = kind === "case" ? [CAPTURE_TEST] : [...BATCH];
      const args = ["test", "--isolate", "--timeout", "60000", "--preload", "./tests/helpers/ssh-spawn-sentinel-preload.ts", ...(kind === "case" ? ["--test-name-pattern", TARGET] : []), ...files];
      const result = await runProcess(process.execPath, args, sources[source], env, TEST_LIMIT_MS);
      const sshAttempt = existsSync(env.OCX_TEST_SSH_SENTINEL!);
      runs.push({ kind, source, round, ...fixedResult(result), log: safeLog(result), sshAttempt });
      if (result.timedOut && result.treeReaped !== true) throw new Error("process_tree_unconfirmed");
      if (!result.exitConfirmed && !result.spawnFailed) throw new Error("child_exit_unconfirmed");
      if (result.streamsClosed === false) throw new Error("output_streams_unconfirmed");
      if (sshAttempt) throw new Error("ssh_attempt_detected");
    }
    for (const source of ["candidate", "official"] as const) {
      const env = sandboxEnvironment(join(outputDir, `probe-${source}`));
      const result = await runProcess(process.execPath, [scriptPath, `--probe-${source}`], sources[source], env, PROBE_LIMIT_MS);
      const line = result.stdout?.text.split(/\r?\n/).find(value => value.startsWith("OCX_PROBE_RESULT="));
      const raw = line ? line.slice("OCX_PROBE_RESULT=".length) : "";
      let observation: Record<string, unknown> | null = null;
      try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const scalar = (key: string) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 ? value[key] : null;
        const snapshot = (key: string) => {
          const item = value[key];
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const v = item as Record<string, unknown>;
          const number = (name: string) => typeof v[name] === "number" && Number.isSafeInteger(v[name]) && Number(v[name]) >= 0 ? v[name] : null;
          return { elapsedMs: number("elapsedMs"), windowOpen: typeof v.windowOpen === "boolean" ? v.windowOpen : "unknown", files: number("files"), bytes: number("bytes") };
        };
        observation = {
          outcome: value.outcome === "observed" ? "observed" : "probe_error", acl: "unknown",
          error: ["EACCES", "EPERM", "ETIMEDOUT", "EICACLS", "EACLIDENTITY", "ENOENT"].includes(String(value.error)) ? value.error : "unknown",
          captureOpen: scalar("captureOpen"), tapCalls: scalar("tapCalls"), spawnCount: scalar("spawnCount"),
          killCountBeforeStop: scalar("killCountBeforeStop"), killCountAfterStop: scalar("killCountAfterStop"),
          authFailed: typeof value.authFailed === "boolean" ? value.authFailed : "unknown",
          beforeStop: snapshot("beforeStop"), afterStop: snapshot("afterStop"), afterFlushBound: snapshot("afterFlushBound"), after500ms: snapshot("after500ms"),
          flush: value.flush === "settled" || value.flush === "timeout" ? value.flush : "unknown",
        };
      } catch { /* A missing or malformed result remains unknown. */ }
      runs.push({ kind: "probe", source, ...fixedResult(result), observation, aclDetail: "unknown" });
      if (result.timedOut && result.treeReaped !== true) throw new Error("process_tree_unconfirmed");
      if (!result.exitConfirmed && !result.spawnFailed) throw new Error("child_exit_unconfirmed");
      if (result.streamsClosed === false) throw new Error("output_streams_unconfirmed");
    }
    summary.collection = "complete";
    summary.testFailures = runs.filter(run => run.kind !== "probe" && (run.exitCode !== 0 || run.timedOut || (run.log as { target: string }).target !== "pass")).length;
    save();
    if (Number(summary.testFailures) > 0 || runs.some(run => run.kind === "probe" && (run.exitCode !== 0 || run.timedOut || (run.observation as { outcome?: string } | null)?.outcome !== "observed"))) process.exitCode = 1;
  } catch (error) {
    summary.collection = "incomplete";
    summary.error = error instanceof Error && ["checkout_mismatch", "package_mismatch", "child_exit_unconfirmed", "process_tree_unconfirmed", "output_streams_unconfirmed", "ssh_attempt_detected"].includes(error.message) ? error.message : "unknown";
    save();
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
try {
  if (args.length === 0) await main();
  else if (args.length === 1 && (args[0] === "--probe-candidate" || args[0] === "--probe-official")) await probe(args[0] === "--probe-candidate" ? "candidate" : "official");
  else throw new Error("invalid_invocation");
} catch {
  console.error("diagnostic_context_error");
  process.exitCode = 1;
}
