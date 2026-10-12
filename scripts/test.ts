import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getTestRunnerBun } from "./lib/test-runner-bun";
import { pinTestNodePath } from "./lib/test-runner-node";
import { saveTestLaneDiagnostics } from "./lib/test-runner-diagnostics";
import { discoverTestBatchFiles, runChangedTestBatches } from "./lib/test-runner-batches";
import {
  acquireTestRunLock,
  resolveWrappedTestRunLockPath,
  TEST_RUN_ID_ENV,
  TEST_RUN_LOCK_PATH_ENV,
  TEST_RUN_LOCK_TOKEN_ENV,
} from "./test-run-lock";
import {
  createContainedTestTemp,
  recoverStaleTestTempArtifactsOnce,
  removeTestTempTree,
  writeTestTempOwner,
} from "./test-temp";
import { listQuarantinedTestTemps } from "./test-temp-lock";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

/**
 * Credentials of the developer's own OpenCodex install that the sandbox must not inherit. A
 * Windows install stores its data-plane token as a user environment variable, so every shell on
 * that machine carries it; a test that then builds a service definition or starts a proxy reads
 * the live token instead of its fixture and fails only on a developer machine.
 */
export const LIVE_INSTALL_CREDENTIAL_ENV = [
  "OPENCODEX_API_AUTH_TOKEN",
  "OPENCODEX_ADMIN_AUTH_TOKEN",
  "OCX_API_TOKEN_FILE",
] as const;

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const hostTemp = tmpdir();
  const recovery = recoverStaleTestTempArtifactsOnce({ tempRoot: hostTemp });
  if (recovery && (recovery.removed > 0 || recovery.errors > 0 || recovery.truncated)) {
    console.warn(
      `[test] stale TEMP recovery removed ${recovery.removed} OpenCodex test root(s)`
      + (recovery.errors > 0 ? `; ${recovery.errors} could not be reclaimed` : "")
      + (recovery.truncated ? "; the bounded scan will continue on a later run" : "")
      + ".",
    );
  }
  const root = mkdtempSync(join(hostTemp, "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  const containedTemp = createContainedTestTemp(root);
  const transpilerCache = baseEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? join(root, "bun-transpiler-cache");
  if (baseEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH === undefined) mkdirSync(transpilerCache, { mode: 0o700 });
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  if (process.platform === "win32") {
    // A Windows sandbox has to look like a real profile, because the known-folder APIs
    // resolve relative to USERPROFILE and .NET returns an EMPTY STRING — not an error —
    // when the folder it computes does not exist. `resolveWindowsRuntimeRoot` asks
    // PowerShell for `GetFolderPath(LocalApplicationData)`, so without these directories
    // every Codex coordinator lookup refuses with "Windows effective-account lookup
    // returned an empty value" and each refusal surfaces as an unrelated assertion in
    // whichever suite happened to touch a Codex home.
    mkdirSync(join(root, "AppData", "Local"), { recursive: true });
    mkdirSync(join(root, "AppData", "Roaming"), { recursive: true });
  }
  writeTestTempOwner(root, baseEnv[TEST_RUN_ID_ENV]);
  const inherited = { ...baseEnv };
  for (const name of LIVE_INSTALL_CREDENTIAL_ENV) delete inherited[name];

  return {
    root,
    env: {
      ...inherited,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (devlog 260730_codex_rs_upstream_v2_live_handoff/070.)
      OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
      // Same hand-off for the guard's Claude entry: the child gets a sandboxed
      // CLAUDE_CONFIG_DIR below, so the developer's own value only survives here.
      OCX_REAL_CLAUDE_CONFIG_DIR: baseEnv.OCX_REAL_CLAUDE_CONFIG_DIR
        ?? (baseEnv.CLAUDE_CONFIG_DIR?.trim() || join(baseEnv.OCX_REAL_HOME ?? homedir(), ".claude")),
      // Pin git's global config to the developer's real one before HOME moves.
      //
      // git resolves ~/.gitconfig from HOME, so a sandboxed HOME makes it invisible.
      // That silently drops `safe.directory`, and on a checkout whose directory owner
      // differs from the running account -- ordinary on Windows when a tool or
      // installer created the tree -- every `git` call a test makes then fails with
      // "detected dubious ownership". The test reads that as "this is not a git
      // repository" and asserts against a fallback, which looks like a product bug in
      // whichever adapter collected the metadata. Naming the file keeps the sandbox
      // (git still writes nothing here) while leaving git's own trust decisions intact.
      GIT_CONFIG_GLOBAL: baseEnv.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
      // Cached JavaScript is executable input. Keep the default beneath the exclusively created
      // private root; nested sandboxes and fixture children retain this path even when HOME moves.
      // Independent runs start cold. A protected explicit cache can share across runs; "" and "0"
      // still disable caching. Never adopt, repair or reclaim the old shared host-TEMP cache.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      // Pin per process for both the preload and children that inherit this environment.
      OCX_OWNER_REGISTRY_DIR: join(opencodexHome, "ocx-homes"),
      CODEX_HOME: codexHome,
      // Client homes that otherwise default to os.homedir(). Bun keeps the home it read at
      // startup, so a preload that only rewrites HOME leaves these at the developer's real
      // directories, and Claude agent sync prunes generated files there (#6775). Pin them in
      // the sandbox; never inherit a live override.
      CLAUDE_CONFIG_DIR: join(root, ".claude"),
      GROK_HOME: join(root, ".grok"),
      TEMP: containedTemp,
      TMP: containedTemp,
      TMPDIR: containedTemp,
    },
    cleanup() {
      removeTestTempTree(root);
    },
  };
}

function hasCliFlag(requested: string[], name: string): boolean {
  return wrapperOptionIndices(requested).some(index => (
    requested[index] === name || requested[index]!.startsWith(`${name}=`)
  ));
}

function wrapperOptionIndices(requested: string[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < requested.length && requested[index] !== "--"; index++) {
    const arg = requested[index]!;
    if (!arg.startsWith("-")) continue;
    indices.push(index);
    if (!arg.includes("=") && BUN_TEST_OPTIONS_REQUIRING_VALUES.has(arg)) index++;
  }
  return indices;
}

const DEFAULT_TEST_PARALLELISM = 4;

// Bun 1.4.0 builds `bun test` options from its test, runtime, transpiler, and base tables.
// Only required values consume the next argument. Optional values such as `--parallel=2`
// must stay attached so a bare option cannot hide the positional filter that follows it.
const BUN_TEST_OPTIONS_REQUIRING_VALUES = new Set([
  // Test options.
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "-t",
  "--test-name-pattern",
  "--grep",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  // Runtime options accepted by `bun test`.
  "--watch-kill-signal",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--install",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--port",
  "--origin",
  "--conditions",
  "--fetch-preconnect",
  "--max-http-header-size",
  "--dns-result-order",
  "--redirect-warnings",
  "--disable-warning",
  "--title",
  "--unhandled-rejections",
  "--console-depth",
  "--user-agent",
  "--cron-title",
  "--cron-period",
  "--trace-event-categories",
  "--trace-event-file-pattern",
  "--stack-trace-limit",
  // Transpiler and base options accepted by `bun test`.
  "--main-fields",
  "--extension-order",
  "--tsconfig-override",
  "-d",
  "--define",
  "--drop",
  "--feature",
  "-l",
  "--loader",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--env-file",
  "--cwd",
  "-c",
  "--config",
]);

export interface ChangedRunPreflight {
  comparisonRef: string;
  comparisonCommit: string;
  changedFiles: string[];
}

const changedComparisonRefs = ["upstream/dev", "origin/dev", "dev"] as const;

/** Choose the highest-priority conventional dev ref without assuming which remote is canonical. */
export function selectChangedComparisonRef(refExists: (ref: string) => boolean): string | null {
  return changedComparisonRefs.find(refExists) ?? null;
}

function decodeOutput(output: Uint8Array | undefined): string {
  return output ? new TextDecoder().decode(output) : "";
}

function changedComparisonRef(requested: string[]): string | null {
  const changedIndex = wrapperOptionIndices(requested)
    .find(index => requested[index] === "--changed" || requested[index]!.startsWith("--changed="));
  const changedArg = changedIndex === undefined ? undefined : requested[changedIndex];
  if (!changedArg) return null;
  if (changedArg === "--changed" || changedArg === "--changed=") {
    throw new Error(
      "[test] changed mode requires an explicit comparison ref; use --changed=<ref> so the selection can be validated.",
    );
  }
  return changedArg.slice("--changed=".length);
}

function gitRefExists(
  ref: string,
  cwd: string,
  env: Record<string, string | undefined>,
): boolean {
  const result = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function gitOutput(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = decodeOutput(result.stderr).trim() || `exit ${result.exitCode ?? "unknown"}`;
    throw new Error(`[test] git ${args[0]} failed while validating changed mode: ${detail}`);
  }
  return decodeOutput(result.stdout);
}

/** Resolve changed mode and inventory the diff against that commit before invoking Bun. */
export function inspectChangedRun(
  requested: string[],
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): ChangedRunPreflight | null {
  const requestedComparisonRef = changedComparisonRef(requested);
  if (!requestedComparisonRef) return null;
  if (requestedComparisonRef.startsWith("-")) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(requestedComparisonRef)} is invalid.`,
    );
  }

  const comparisonRef = requestedComparisonRef === "dev"
    ? selectChangedComparisonRef(ref => gitRefExists(ref, cwd, env))
    : requestedComparisonRef;
  if (!comparisonRef) {
    throw new Error(
      `[test] --changed=dev could not resolve a comparison ref; none of ${changedComparisonRefs.join(", ")} exists.`,
    );
  }

  if (!gitRefExists(comparisonRef, cwd, env)) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(comparisonRef)} does not resolve to a commit.`,
    );
  }

  const comparisonCommit = gitOutput(["merge-base", "HEAD", comparisonRef], cwd, env).trim();
  if (!comparisonCommit) {
    throw new Error(
      `[test] --changed comparison ref ${JSON.stringify(comparisonRef)} has no merge base with HEAD.`,
    );
  }

  const diff = gitOutput(["diff", "--name-only", comparisonCommit, "--"], cwd, env);
  const changedFiles = [...new Set(diff.split("\n").filter(Boolean))];
  return { comparisonRef, comparisonCommit, changedFiles };
}

/** Refuse a successful changed-mode run when Bun silently selected no tests for a real diff. */
export function changedSelectionFailure(
  preflight: ChangedRunPreflight,
  output: string,
): string | null {
  if (preflight.changedFiles.length === 0) return null;
  const summaries = [...output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .matchAll(/Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\b/gi)];
  if (summaries.length === 0) {
    return `[test] could not validate --changed=${preflight.comparisonCommit} (${preflight.comparisonRef} merge base): Bun did not emit a recognizable selection summary for a diff containing ${preflight.changedFiles.length} changed file(s).`;
  }
  if (summaries.some(summary => Number(summary[1]) !== 0 || Number(summary[2]) !== 0)) return null;
  return `[test] --changed=${preflight.comparisonCommit} (${preflight.comparisonRef} merge base) selected 0 tests across 0 files, but the diff contains ${preflight.changedFiles.length} changed file(s). Bun follows only the parsed module graph; run the relevant focused tests for subprocess, read-as-data, or golden-file dependencies, or run the full suite.`;
}

/**
 * True for a filter-less `bun run test`: no file arguments and no `--changed`.
 * `--timeout` / `--dots` / `--parallel=N` still count as full.
 */
/** True for a filter-less `bun run test`. `--timeout` / `--dots` / `--parallel=N` still count. */
function isFullSuiteRun(requested: string[]): boolean {
  const delimiterIndex = requested.indexOf("--");
  const wrapperArgs = delimiterIndex === -1 ? requested : requested.slice(0, delimiterIndex);
  const passedThrough = delimiterIndex === -1 ? [] : requested.slice(delimiterIndex + 1);
  if (passedThrough.length > 0) return false;
  if (hasCliFlag(requested, "--changed")) return false;

  for (let index = 0; index < wrapperArgs.length; index++) {
    const arg = wrapperArgs[index];
    if (arg === "-" || !arg.startsWith("-")) return false;
    if (!arg.includes("=") && BUN_TEST_OPTIONS_REQUIRING_VALUES.has(arg)) index++;
  }
  return true;
}

/**
 * Default `bun test` argv for this repo.
 *
 * `--isolate` keeps a fresh global per file. Bounded parallelism is what makes the suite
 * finishable: with isolate alone Bun re-evaluates
 * the module graph once per file on a single core, so past ~900 files the run stops looking slow
 * and starts looking hung — measured here at 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS,
 * against a few minutes for the identical suite with four workers. Leaving Bun to select all ten
 * workers made deadline-sensitive tests fail under load, so the repository default is deterministic.
 * A caller-supplied `--parallel` or `--parallel=N` is left alone.
 */
export function resolveBunTestArgs(
  requested: string[],
  comparisonCommit?: string,
): string[] {
  const optionIndices = new Set(wrapperOptionIndices(requested));
  const effectiveRequested = comparisonCommit
    ? requested.map((arg, index) => (
        optionIndices.has(index)
          && (arg === "--changed" || arg.startsWith("--changed="))
          ? "--changed=" + comparisonCommit
          : arg
      ))
    : requested;
  const args = ["--isolate"];
  if (!hasCliFlag(effectiveRequested, "--parallel")) {
    args.push(`--parallel=${DEFAULT_TEST_PARALLELISM}`);
  }
  args.push(...effectiveRequested);
  if (isFullSuiteRun(effectiveRequested)) args.push("./tests/");
  return args;
}

// Paths relative to tests/. An entry moves with its file (scripts/test-layout/move.ts rewrites
// it); the lane label, the ignore glob, and the timeout table all key on the basename.
export const SERIAL_FULL_SUITE_FILES = [
  "codex-integration/codex-shim.test.ts",
  "providers/cursor/cursor-native-exec-shell.test.ts",
  // The FIFO safety case hit its existing deadline in the full suite;
  // the file passes alone on candidate and official without changing that budget.
  "providers/cursor/cursor-effort-table.test.ts",
  // Full-suite Cursor catalog setup failed in these three helper-backed files;
  // run each in a fresh process with unchanged assertions and test budgets.
  "providers/cursor/cursor-effort-rows.test.ts",
  "providers/cursor/cursor-integration-status.test.ts",
  "providers/cursor/cursor-local-models-schema.test.ts",
  // Full-suite runs timed out Antigravity subprocesses and Grok local HTTP/WS;
  // both files pass alone with unchanged assertions and test budgets.
  "providers/provider-antigravity-wire-snapshot.test.ts",
  "providers/xai/grok-47-fast-model-wire.test.ts",
  "codex-integration/issue-452-empty-503.test.ts",
  "adapters/openai/openai-provider-option-e2e.test.ts",
  // Three Linux runs in a row timed out mid-file inside a 12-file batch while
  // every case passed alone (37730984813, 37732846946, 37735238354, all test
  // 1/4 batch 4): the same multi-file process-state class as the entries below.
  "ci-workflows/ci-gui-typecheck-gate.test.ts",
  "ci-workflows/release-helper.test.ts",
  // The full macOS isolate pool stalled in the structure gate's synchronous Git
  // child after earlier files; fresh-process execution retains the same assertions.
  "ci-workflows/structure-ssot.test.ts",
  // A full pool left this file unfinished; all cases pass alone with unchanged budgets.
  "ci-workflows/fork-ci-official-baseline.test.ts",
  // CI shard 1/2 batch 8 stalled in a shared Bun process; every file passed alone.
  "ci-workflows/ci-gui-if-changed.test.ts",
  // Synchronous injection subprocesses can wedge the long-lived macOS isolate
  // parent while reaping a history Worker; contain them in a fresh bounded lane.
  "codex-integration/codex-inject-write-lock.test.ts",
  // Its management API import stalled the long-lived macOS isolate pool before
  // any case ran; the complete file finishes in under a second in a fresh process.
  "routing/subagent-roster-retention.test.ts",
  // Linux run 36610213506 stalled this file after its WebSocket admission case
  // in a multi-file process; all 11 cases completed in the attribution process.
  // Keep its real listener lifecycle in a fresh process on every platform.
  "codex-integration/active-registry-admission.test.ts",
  // Real CLI spawnSync children timed out in the four-worker full pool while the same
  // file passed alone; run this file in a fresh process without changing its assertions.
  "cli/cli-help.test.ts",
  // A full-pool run failed this file's version projection; all cases passed alone.
  "cli/cli-status-json.test.ts",
  // The help-paths CLI children reached their 40s deadline in the full pool;
  // the complete file passes alone with the same assertions and child budget.
  "cli/cli-help-paths.test.ts",
  // Full-suite runs timed out the real CLI children in these help fixtures;
  // both files complete alone with the same assertions and child budget.
  "cli/cli-help-navigation.test.ts",
  "cli/cli-help-recovery.test.ts",
  // In the full pool, provider CLI children reached their 40s deadline; the file
  // passes in a fresh process with the same assertions and child budget.
  "cli/cli-provider.test.ts",
  // These CLI subprocess and global-fetch fixtures passed alone but failed in the four-worker pool.
  "cli/cli-models.test.ts",
  "cli/cli-headless-parity.test.ts",
  "clients/client-connect.test.ts",
  "clients/client-link-connect.test.ts",
  // Full-pool contention timed out catalog requests and ACL subprocess probes.
  // Fresh processes keep the same per-test deadlines and main-pool parallelism.
  "claude-integration/claude-management-api.test.ts",
  "claude-integration/claude-models-discovery.test.ts",
  "lib/plugin-loader.test.ts",
  "cli/cli-connect-readiness.test.ts",
  "update/update-stop-first.test.ts",
  // Relays a 50 MiB WebSocket frame end to end against a 15s deadline, so its result is a
  // measurement of the whole process, not of the relay. On a healthy 3-CPU macOS runner the
  // echo leg alone spends 7.4s of that budget; whichever half of `--shard=N/2` it lands in
  // decides whether it finishes. It has been passing by accident: it sat in the lighter half
  // until three unrelated test files were added elsewhere in the tree, Bun repartitioned, and
  // it went from 7.4s to over 15s twice in a row without anything on the sideband path
  // changing. Quarantining it here is what keeps it a test of the relay instead of a test of
  // its neighbours.
  "server/server-live.test.ts",
  // Local four-worker pool refused a fixture sideband join; the complete file passed alone.
  "server/server-live-realtime-fixtures.test.ts",
  // A full-suite local-read timeout preceded owner-home conflicts in this file;
  // the complete file passes alone with its original security assertions and budgets.
  "server/server-management-auth.test.ts",
  // A full-suite run exceeded this file's policy-run POST response bound;
  // the complete file passes alone with its original Worker and health checks.
  "storage/storage-policy-job-responsive.test.ts",
  "responses/responses-opaque-blob-recovery.test.ts",
  "ci-workflows/fork-install-local-staging.test.ts",
  "ci-workflows/fork-install-local-volta-root.test.ts",
  "ci-workflows/install-scripts.test.ts",
  "codex-integration/codex-journal.test.ts",
  "codex-integration/codex-cli-update-zero-effect.test.ts",
  "providers/cursor/cursor-native-exec.test.ts",
  "update/update-npm-cache-preflight.test.ts",
  "update/fork-update-monotonicity.test.ts",
  "clients/aside-profile-sync-owner.test.ts",
  "adapters/translator-budget.test.ts",
  "codex-integration/doctor.test.ts",
  "claude-integration/claude-messages-endpoint.test.ts",
  "server/memory-watchdog.test.ts",
  // These files failed in the long-lived changed pool and passed in fresh processes.
  // Isolate their environment and subprocess lifecycles with unchanged test budgets.
  "claude-integration/claude-picker-runtime.test.ts",
  "claude-integration/claude-picker-startup.test.ts",
  // These writers share an effective OS-user SQLite lifecycle lock across HOME/configDir.
  // Serial lanes prevent contention between files in the same parallel pool.
  "claude-integration/claude-desktop-picker-routes.test.ts",
  "claude-integration/claude-desktop-picker-profile.test.ts",
  "claude-integration/claude-desktop-first-party.test.ts",
  "claude-integration/claude-desktop-first-party-guards.test.ts",
  "cli/cli-config-default-show.test.ts",
  "lab/lab-live-probe.test.ts",
  "lab/lab-live-receipt-integrity.test.ts",
  // This cumulative-deadline fixture failed in the changed pool and passed alone with its original budget.
  "web-search/web-search-pacing-deadline.test.ts",
  // These exercise the default-home service authority, shared by parallel Bun workers.
  // A fresh process/home prevents another file's authority from becoming this fixture's input.
  "service/service-claim.test.ts",
  "service/service-wsl-home-ownership.test.ts",
  "service/service-ownership-state.test.ts",
  "service/service-sqlite-home.test.ts",
  "service/service.test.ts",
  "service/launchd-repair.test.ts",
  "cli/cli-update-restart-home.test.ts",
  "codex-integration/native-codex-toggle.test.ts",
  "codex-integration/native-grok-toggle.test.ts",
] as const;

type SerialLaneBasename = (typeof SERIAL_FULL_SUITE_FILES)[number] extends infer P
  ? P extends `${string}/${infer B}` ? B : P
  : never;
const SERIAL_LANE_TIMEOUT_MS: Partial<Record<SerialLaneBasename, number>> = {
  // This file intentionally exercises 33 complete release-script subprocess trees.
  // It is ~90s on an idle machine and measured at ~170s under unrelated host load.
  "release-helper.test.ts": 5 * 60 * 1000,
};

export interface BunTestLane {
  label: string;
  args: string[];
  timeoutMs: number;
  deadlineAt?: number;
}

function withoutParallelOverride(requested: string[]): string[] {
  const indices = new Set(wrapperOptionIndices(requested));
  return requested.filter((arg, index) => !indices.has(index)
    || (arg !== "--parallel" && !arg.startsWith("--parallel=")));
}

function canUseSerialLanes(requested: string[]): boolean {
  if (hasCliFlag(requested, "--changed")
    && (requested.includes("--") || hasCliFlag(requested, "--path-ignore-patterns")
      || ["-c", "--config", "--cwd", "--no-isolate", "--watch", "--hot", "--coverage", "--coverage-dir", "--coverage-reporter",
        "--only-failures", "--bail", "--rerun-each", "--retry"].some(flag => hasCliFlag(requested, flag)))) return false;
  const indices = new Set(wrapperOptionIndices(requested));
  const withoutChanged = requested.filter((arg, index) => !indices.has(index) || !arg.startsWith("--changed="));
  if (!isFullSuiteRun(withoutChanged)) return false;
  return !["--shard", "--reporter-outfile", "--update-timings"].some(flag => hasCliFlag(requested, flag));
}

export function canBatchChangedMain(requested: string[]): boolean {
  return hasCliFlag(requested, "--changed") && canUseSerialLanes(requested);
}

export function resolveChangedBatchConcurrency(requested: string[], cpus = availableParallelism()): 1 | 2 {
  return canBatchChangedMain(requested) && cpus >= 8 && !hasCliFlag(requested, "--parallel") ? 2 : 1;
}

/** Keep sensitive files in fresh processes for full and unfiltered changed runs. */
export function resolveBunTestPlan(
  requested: string[], comparisonCommit?: string,
  env: Record<string, string | undefined> = process.env,
): BunTestLane[] {
  const rawTimeout = env.OCX_TEST_MAIN_TIMEOUT_MS;
  const mainTimeout = rawTimeout === undefined ? 900_000 : Number(rawTimeout);
  if (rawTimeout !== undefined && (!/^\d+$/.test(rawTimeout)
    || !Number.isSafeInteger(mainTimeout) || mainTimeout < 60_000 || mainTimeout > 3_600_000)) {
    throw new Error("OCX_TEST_MAIN_TIMEOUT_MS must be an integer between 60000 and 3600000");
  }
  if (!canUseSerialLanes(requested)) {
    return [{ label: "suite", args: resolveBunTestArgs(requested, comparisonCommit), timeoutMs: mainTimeout }];
  }

  const mainArgs = resolveBunTestArgs(requested, comparisonCommit);
  const rootIndex = isFullSuiteRun(requested) ? mainArgs.length - 1 : -1;
  const ignores = SERIAL_FULL_SUITE_FILES.flatMap(file => ["--path-ignore-patterns", `**/${basename(file)}`]);
  mainArgs.splice(rootIndex === -1 ? mainArgs.length : rootIndex, 0, ...ignores);
  const serialRequested = withoutParallelOverride(requested);
  const serialFiles = hasCliFlag(requested, "--changed")
    ? SERIAL_FULL_SUITE_FILES.filter(file => existsSync(join(process.cwd(), "tests", file)))
    : SERIAL_FULL_SUITE_FILES;
  return [
    { label: "parallel suite", args: mainArgs, timeoutMs: mainTimeout },
    ...serialFiles.map(file => ({
      label: basename(file),
      args: resolveBunTestArgs(["--parallel=1", ...serialRequested, `./tests/${file}`], comparisonCommit),
      timeoutMs: SERIAL_LANE_TIMEOUT_MS[basename(file) as SerialLaneBasename] ?? 3 * 60 * 1000,
    })),
  ];
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Read continuously so a timeout can still report output received before EOF. */
export function captureTestOutput(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
) {
  const collect = (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let reading = true;
    let complete = false;
    const done = (async () => {
      try {
        while (reading) {
          const chunk = await reader.read();
          if (!reading) break;
          if (chunk.done) {
            complete = true;
            break;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // Retain the prefix without turning a pipe error into an unhandled rejection.
      } finally {
        if (reading) text += decoder.decode();
        reading = false;
        reader.releaseLock();
      }
    })();
    return {
      done,
      snapshot: () => ({ text, complete }),
      cancel() {
        if (!reading) return;
        reading = false;
        text += decoder.decode();
        // A descendant may own a pipe, or a stream's cancellation may never settle.
        // Cancellation is best effort; neither it nor EOF may extend the drain bound.
        void reader.cancel().catch(() => {});
      },
    };
  };
  const out = collect(stdout);
  const err = collect(stderr);
  return {
    async finish(timeoutMs: number) {
      const drained = await waitWithTimeout(Promise.all([out.done, err.done]), timeoutMs);
      if (drained === null) {
        out.cancel();
        err.cancel();
      }
      const stdout = out.snapshot();
      const stderr = err.snapshot();
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        complete: drained !== null && stdout.complete && stderr.complete,
      };
    },
  };
}

/**
 * Remove a sandbox root after its lane exits.
 *
 * A contained subtree that was only renamed aside (`.trash-*`) is still inside this root.
 * If that rename-aside is still locked when the root itself cannot be removed, the lane
 * fails: swallowing it would hide a hold that outlasted the whole batch. A root that cannot
 * be removed and has no quarantine left keeps the previous deferral, because a later run's
 * stale-temp recovery is what retries that case.
 */
/** A green lane does not stay green when a quarantined tree is still locked at the end of the run. */
export function exitCodeAfterTempSweep(
  exitCode: number,
  sweep: "removed" | "deferred" | "quarantine-remains",
): number {
  return sweep === "quarantine-remains" && exitCode === 0 ? 1 : exitCode;
}

export function settleIsolatedTestRoot(
  root: string,
  remove: (path: string) => void = removeTestTempTree,
  report: (message: string) => void = message => { console.error(message); },
): "removed" | "deferred" | "quarantine-remains" {
  try {
    remove(root);
    return "removed";
  } catch (error) {
    const remaining = listQuarantinedTestTemps(root);
    if (remaining.length === 0) {
      report("[test] deferred cleanup of one test root after Windows kept a handle open; a later run will retry it.");
      return "deferred";
    }
    report(`[test] quarantined temp still could not be deleted: ${remaining.join(", ")}`);
    report(error instanceof Error ? error.message : String(error));
    return "quarantine-remains";
  }
}

export async function runTestLane(
  lane: BunTestLane,
  runId: string,
  inheritedLock: { lockPath: string; ownerToken: string } | undefined,
  capture = false,
  writers = {
    stdout: (value: string) => { process.stdout.write(value); },
    stderr: (value: string) => { process.stderr.write(value); },
  },
  testRunner = getTestRunnerBun(),
  cancellation?: AbortSignal,
  report?: (message: string, level: "warn" | "error") => void,
): Promise<{ exitCode: number; output: string }> {
  const reportLane = report ?? ((message: string, level: "warn" | "error") => { console[level](message); });
  const reportCleanup = report ? (message: string) => { report(`[test] ${lane.label} cleanup: ${message}`, "error"); } : undefined;
  const cancellationCode = () => [124, 130, 143].includes(cancellation?.reason) ? cancellation!.reason as number : 143;
  if (cancellation?.aborted) return { exitCode: cancellationCode(), output: "" };
  const sourceEnv = {
    ...process.env,
    [TEST_RUN_ID_ENV]: runId,
    [TEST_RUN_LOCK_PATH_ENV]: inheritedLock?.lockPath,
    [TEST_RUN_LOCK_TOKEN_ENV]: inheritedLock?.ownerToken,
    // Lanes run many files in parallel, so a test that shortened a PRODUCT timing budget
    // (not its own test timeout) needs headroom for process startup on a busy machine.
    // See tests/helpers/ci-watchdog.ts `isolationBudgetMs`.
    OCX_TEST_FULL_SUITE: "1",
  };
  const isolated = createIsolatedTestEnvironment(sourceEnv);
  let interrupted: number | null = null;
  let terminateChild: ((signal: NodeJS.Signals) => void) | undefined;
  let wakeCancellation: () => void;
  const cancelled = new Promise<null>(resolve => { wakeCancellation = () => resolve(null); });
  const forward = (code: number) => {
    interrupted ??= code;
    if (code !== 124) terminateChild?.(code === 130 ? "SIGINT" : "SIGTERM");
    wakeCancellation();
  };
  const onInterrupt = () => forward(130);
  const onTerminate = () => forward(143);
  const onCancellation = () => forward(cancellationCode());
  if (cancellation) cancellation.addEventListener("abort", onCancellation, { once: true });
  else {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  }
  let laneResult: { exitCode: number; output: string } | undefined;
  try {
    try {
      await pinTestNodePath(isolated.env, sourceEnv, isolated.root);
    } catch (error) {
      if (interrupted === null && (lane.deadlineAt === undefined || Date.now() < lane.deadlineAt)) throw error;
    }
    const startedAt = Date.now();
    if (interrupted !== null || (lane.deadlineAt !== undefined && startedAt >= lane.deadlineAt)) {
      if (interrupted === null) reportLane(`[test] ${lane.label} exhausted its shared deadline during setup.`, "error");
      laneResult = { exitCode: interrupted ?? 124, output: "" };
      return laneResult;
    }
    const child = Bun.spawn([testRunner, "test", ...lane.args], {
      env: isolated.env,
      stdin: "inherit",
      stdout: capture ? "pipe" : "inherit",
      stderr: capture ? "pipe" : "inherit",
    });
    terminateChild = signal => { try { child.kill(signal); } catch { /* child already exited */ } };
    const captured = capture ? captureTestOutput(child.stdout!, child.stderr!) : undefined;
    const exited = child.exited;
    const remainingMs = lane.deadlineAt === undefined ? lane.timeoutMs : Math.max(0, lane.deadlineAt - Date.now());
    let exitCode = await waitWithTimeout(Promise.race([exited, cancelled]), remainingMs);
    if (exitCode === null) {
      if (interrupted === null || interrupted === 124) {
        reportLane(`[test] ${lane.label} exceeded ${Math.round(remainingMs / 1000)}s; terminating pid ${child.pid}.`, "error");
        try {
          const diagnostics = saveTestLaneDiagnostics(child.pid);
          reportLane(`[test] deadline diagnostics: ${diagnostics}`, "error");
        } catch {
          reportLane("[test] deadline diagnostics unavailable; termination will continue.", "error");
        }
      }
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
      const graceful = await waitWithTimeout(exited, 5_000);
      if (graceful === null) {
        try { child.kill("SIGKILL"); } catch { /* child already exited */ }
        await waitWithTimeout(exited, 2_000);
      }
    }
    // Process exit does not guarantee EOF when a descendant inherited the pipe.
    const result = await captured?.finish(1_000);
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    if (stdout) writers.stdout(stdout);
    if (stderr) writers.stderr(stderr);
    const output = stdout + "\n" + stderr;
    if (result && !result.complete) {
      reportLane("[test] captured output is incomplete; collected output is shown above.", "error");
      if (exitCode === 0) exitCode = 1;
    }
    if (interrupted !== null || exitCode === null) {
      laneResult = { exitCode: interrupted ?? 124, output };
      return laneResult;
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    reportLane(`[test] ${lane.label} finished in ${seconds}s (exit ${exitCode}).`, "warn");
    laneResult = { exitCode, output };
    return laneResult;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    cancellation?.removeEventListener("abort", onCancellation);
    if (laneResult) {
      laneResult.exitCode = exitCodeAfterTempSweep(laneResult.exitCode, settleIsolatedTestRoot(isolated.root, undefined, reportCleanup));
    } else {
      settleIsolatedTestRoot(isolated.root, undefined, reportCleanup);
    }
  }
}

/**
 * `gui` is not a workspace of the root package and declares React only in `gui/package.json`, so a
 * root `bun install` never creates `gui/node_modules`. Twenty-six files under `tests/` import
 * modules from `gui/src`, which makes those tests fail on a fresh clone or worktree with
 * `Cannot find package 'react'` — reported as an "Unhandled error between tests" that names no
 * test, so the cause is not obvious from the output.
 *
 * `.github/workflows/ci.yml` already installs them explicitly for exactly this reason; the local
 * runner had no equivalent. Install on demand rather than fail, because the tests genuinely
 * require the dependency and `gui/node_modules` is a gitignored build artifact, not source.
 */
export function ensureGuiDependencies(io: {
  cwd?: string;
  exists?: (path: string) => boolean;
  install?: (guiDir: string) => { ok: boolean; detail: string };
  log?: (message: string) => void;
} = {}): { kind: "present" | "installed" | "absent" | "failed"; detail?: string } {
  const cwd = io.cwd ?? process.cwd();
  const exists = io.exists ?? existsSync;
  const log = io.log ?? (message => console.warn(message));
  const guiDir = join(cwd, "gui");
  if (!exists(join(guiDir, "package.json"))) return { kind: "absent" };
  if (exists(join(guiDir, "node_modules", "react", "package.json"))) return { kind: "present" };

  log("[test] gui dependencies are missing or incomplete; installing them so tests importing gui/src can resolve React.");
  const install = io.install ?? ((dir: string) => {
    const result = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: result.exitCode === 0,
      detail: decodeOutput(result.stderr) || decodeOutput(result.stdout),
    };
  });
  const outcome = install(guiDir);
  if (outcome.ok) return { kind: "installed" };
  return { kind: "failed", detail: outcome.detail };
}

if (import.meta.main) {
  let testRunner: string;
  try { testRunner = getTestRunnerBun(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const requestedTests = process.argv.slice(2);
  const guiDependencies = ensureGuiDependencies();
  if (guiDependencies.kind === "failed") {
    console.error(
      "[test] could not install gui/node_modules, which tests importing gui/src need to resolve React.\n"
      + "       Run it manually: cd gui && bun install --frozen-lockfile\n"
      + (guiDependencies.detail ? `       ${guiDependencies.detail.trim().split("\n").slice(-3).join("\n       ")}` : ""),
    );
    process.exitCode = 1;
  }
  let changedRun: ReturnType<typeof inspectChangedRun> = null;
  if (process.exitCode !== 1) {
    try {
      changedRun = inspectChangedRun(requestedTests);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    if (changedRun) {
      console.warn(
        `[test] changed mode comparison ref: ${changedRun.comparisonRef}; merge base: ${changedRun.comparisonCommit}`,
      );
    }
    const runId = randomUUID();
    const lockPath = resolveWrappedTestRunLockPath({ env: process.env });
    const lock = await acquireTestRunLock({
      runId,
      lockPath,
      validatedRuntimePath: lockPath !== undefined,
      onWait: owner => console.warn(
        `[test] another Bun test run${owner ? ` (pid ${owner.pid})` : ""} holds the user lock; waiting. `
        + "Set OCX_TEST_NO_QUEUE=1 only for intentional overlap.",
      ),
      onAcquiredAfterWait: elapsedMs => console.warn(`[test] acquired the user lock after ${Math.round(elapsedMs / 1000)}s.`),
    });
    const startedAt = Date.now();
    try {
      const inheritedLock = process.platform === "win32" && lockPath && lock.owner
        ? { lockPath, ownerToken: lock.owner.token }
        : undefined;
      let exitCode = 0;
      let captured = "";
      for (const lane of resolveBunTestPlan(requestedTests, changedRun?.comparisonCommit)) {
        const execute = (batch: BunTestLane) => runTestLane(batch, runId, inheritedLock, Boolean(changedRun), undefined, testRunner);
        let result: Awaited<ReturnType<typeof execute>>;
        if (lane.label === "parallel suite" && canBatchChangedMain(requestedTests)) {
          const deadlineAt = Date.now() + lane.timeoutMs;
          const files = discoverTestBatchFiles(join(process.cwd(), "tests"), SERIAL_FULL_SUITE_FILES);
          const concurrency = resolveChangedBatchConcurrency(requestedTests);
          const args = concurrency === 2 ? lane.args.map((arg, index) => index === 1 ? "--parallel=2" : arg) : lane.args;
          const logs: { stdout: string; stderr: string }[] = [];
          result = await runChangedTestBatches({ ...lane, args, deadlineAt }, files,
            (batch, cancellation) => {
              const log = { stdout: "", stderr: "" };
              logs.push(log);
              return runTestLane(batch, runId, inheritedLock, true,
                { stdout: value => { log.stdout += value; }, stderr: value => { log.stderr += value; } }, testRunner, cancellation,
                message => { log.stderr += message + "\n"; });
            }, { concurrency, onResult: (_result, index) => {
              if (logs[index]!.stdout) process.stdout.write(logs[index]!.stdout);
              if (logs[index]!.stderr) process.stderr.write(logs[index]!.stderr);
              logs[index] = { stdout: "", stderr: "" };
            } });
        } else {
          result = await execute(lane);
        }
        captured += result.output;
        if (result.exitCode !== 0 && exitCode === 0) exitCode = result.exitCode;
        if ([124, 130, 143].includes(result.exitCode)) break;
      }
      if (exitCode === 0 && changedRun) {
        const selectionFailure = changedSelectionFailure(changedRun, captured);
        if (selectionFailure) {
          console.error(selectionFailure);
          exitCode = 1;
        }
      }
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (isFullSuiteRun(requestedTests) && elapsedSeconds > 600) {
        console.warn(
          `[test] the suite took ${elapsedSeconds}s; with --parallel=${DEFAULT_TEST_PARALLELISM} it should finish in a few minutes on an idle machine. `
          + "Check for another test runner, a busy CPU, or a test that started polling something real.",
        );
      }
      process.exitCode = exitCode;
    } finally {
      lock.release();
    }
  }
}
