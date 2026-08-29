import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { forkBaseVersion } from "../src/fork/version-policy.mjs";
import { redactSecretString, redactUrlForLog, redactUserPath } from "../src/lib/redact";

const ZERO_OID = "0".repeat(40);
const MARKER_REF = "refs/ocx-ci/fork-marker";
const OFFICIAL_TAG_REF = "refs/ocx-ci/official-tag";
const OFFICIAL_URL = "https://github.com/lidge-jun/opencodex.git";
const CLI_REPO_ROOT = resolve(import.meta.dir, "..");
const RESERVED_BEN = /-ben(?:\.|$)/;
const NON_FORK = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview(?:\.[0-9A-Za-z-]+)+)?$/;
const EMBEDDED_URL = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_HEADER_LINE = /(^|\n)[^\n]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*:[^\n]*/gi;
const LOG_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const CREDENTIAL_PLACEHOLDER = "[[OCX-HDR-MASK]]";
const CLEANUP_FAILURE_SUFFIX = "; cleanup also failed";

export type VersionClassification =
  | { kind: "fork"; version: string; base: string; tag: string }
  | { kind: "non-fork"; version: string };

export type PrepareForkOfficialBaseResult =
  | { kind: "not-fork"; version: string }
  | { kind: "prepared"; version: string; tag: string; rawTagOid: string; peeledCommit: string };

export type GitRunner = (cwd: string, args: readonly string[]) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitOperation =
  | "fetch origin marker"
  | "init official verifier"
  | "fetch official refs"
  | "verify official ancestry"
  | "import official tag"
  | "verify official tag"
  | "publish local tag"
  | "cleanup official verifier"
  | "prepare official base";

function hasLeadingZeroNumericPreviewPart(value: string): boolean {
  const preview = value.split("-preview.")[1];
  return preview?.split(".").some(part => /^0\d+$/.test(part)) ?? false;
}

export function classifyPackageVersion(raw: unknown): VersionClassification {
  if (typeof raw !== "string" || raw !== raw.trim()) throw new Error("invalid package version");
  const base = forkBaseVersion(raw);
  if (base) return { kind: "fork", version: raw, base, tag: `v${base}` };
  if (RESERVED_BEN.test(raw) || !NON_FORK.test(raw) || hasLeadingZeroNumericPreviewPart(raw)) {
    throw new Error("invalid or reserved package version");
  }
  return { kind: "non-fork", version: raw };
}

export function safeGitDiagnostic(
  operation: GitOperation,
  error: unknown,
  ownedPaths: readonly string[] = [],
): string {
  const preserveCleanupSuffix = String(error instanceof Error ? error.message : error)
    .endsWith(CLEANUP_FAILURE_SUFFIX);
  let detail = error instanceof Error ? error.message : String(error);
  detail = detail.replace(/\r\n?|\u2028|\u2029/g, "\n");
  detail = detail.replaceAll("[CREDENTIAL HEADER REDACTED]", CREDENTIAL_PLACEHOLDER);
  detail = detail.replace(
    CREDENTIAL_HEADER_LINE,
    (_line, boundary: string) => `${boundary}${CREDENTIAL_PLACEHOLDER}`,
  );
  detail = detail.replace(EMBEDDED_URL, value => redactUrlForLog(value));
  for (const path of [...ownedPaths].filter(Boolean).sort((a, b) => b.length - a.length)) {
    detail = detail.split(path).join("[REDACTED_PATH]");
    detail = detail.split(path.replaceAll("\\", "/")).join("[REDACTED_PATH]");
    detail = detail.split(path.replaceAll("/", "\\")).join("[REDACTED_PATH]");
  }
  detail = redactUserPath(redactSecretString(detail));
  detail = detail.replace(LOG_CONTROL, " ").replace(/\s+/g, " ").trim();
  detail = detail.replaceAll(CREDENTIAL_PLACEHOLDER, "[CREDENTIAL HEADER REDACTED]");
  const prefix = `${operation}: `;
  const value = detail || "git command failed";
  return preserveCleanupSuffix
    ? `${prefix}${value.replace(CLEANUP_FAILURE_SUFFIX, "").slice(0, 512 - prefix.length - CLEANUP_FAILURE_SUFFIX.length)}${CLEANUP_FAILURE_SUFFIX}`
    : `${prefix}${value}`.slice(0, 512);
}

function ownedPathSpellings(paths: readonly string[]): string[] {
  const expanded = [...paths];
  for (const path of paths) {
    try { expanded.push(realpathSync(path)); } catch { /* path may not exist after cleanup */ }
  }
  return [...new Set(expanded)];
}

function gitEnvironment(globalConfig: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_CONFIG")) environment[key] = value;
  }
  for (const key of Object.keys(environment)) {
    if (["GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"].includes(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
  };
}

function productionGitRunner(globalConfig: string): GitRunner {
  const environment = gitEnvironment(globalConfig);
  return (cwd, args) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  };
}

function packageVersion(repoRoot: string): unknown {
  return (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown }).version;
}

function outputOrError(result: ReturnType<GitRunner>): Error | undefined {
  if (result.exitCode === 0) return undefined;
  return new Error(result.stderr || result.stdout || "git command failed");
}

function runOrThrow(
  runGit: GitRunner,
  operation: GitOperation,
  cwd: string,
  args: readonly string[],
  ownedPaths: readonly string[],
) {
  try {
    const result = runGit(cwd, args);
    const error = outputOrError(result);
    if (error) throw error;
    return result;
  } catch (error) {
    throw new Error(safeGitDiagnostic(operation, error, ownedPaths));
  }
}

function readExistingTag(
  runGit: GitRunner,
  repoRoot: string,
  tagRef: string,
  ownedPaths: readonly string[],
): { raw: string; peeled: string } | undefined {
  try {
    const raw = runGit(repoRoot, ["rev-parse", tagRef]);
    if (raw.exitCode !== 0) return undefined;
    const peeled = runGit(repoRoot, ["rev-parse", `${tagRef}^{commit}`]);
    if (peeled.exitCode !== 0) return undefined;
    return { raw: raw.stdout.trim(), peeled: peeled.stdout.trim() };
  } catch (error) {
    throw new Error(safeGitDiagnostic("verify official tag", error, ownedPaths));
  }
}

function cleanup(
  runGit: GitRunner,
  repoRoot: string,
  verifierRoot: string,
  ownedPaths: readonly string[],
): Error | undefined {
  let error: Error | undefined;
  for (const ref of [MARKER_REF, OFFICIAL_TAG_REF]) {
    try {
      runOrThrow(runGit, "cleanup official verifier", repoRoot, ["update-ref", "-d", ref], ownedPaths);
    } catch (caught) {
      error ??= caught instanceof Error ? caught : new Error(String(caught));
    }
  }
  try {
    rmSync(verifierRoot, { recursive: true, force: true });
  } catch (caught) {
    error ??= new Error(safeGitDiagnostic("cleanup official verifier", caught, ownedPaths));
  }
  return error;
}

export function prepareForkOfficialBase(options: {
  repoRoot: string;
  officialRepositoryUrl: string;
  runGit?: GitRunner;
}): PrepareForkOfficialBaseResult {
  let classification: VersionClassification;
  try {
    classification = classifyPackageVersion(packageVersion(options.repoRoot));
  } catch (error) {
    throw new Error(safeGitDiagnostic("prepare official base", error, [options.repoRoot]));
  }
  if (classification.kind === "non-fork") return { kind: "not-fork", version: classification.version };

  let verifierRoot: string;
  try {
    verifierRoot = mkdtempSync(join(tmpdir(), "ocx-fork-official-"));
  } catch (error) {
    throw new Error(safeGitDiagnostic("prepare official base", error, [options.repoRoot]));
  }
  const globalConfig = join(verifierRoot, "gitconfig");
  const bareDir = join(verifierRoot, "repo.git");
  let ownedPaths = ownedPathSpellings([options.repoRoot, verifierRoot]);
  const refreshOwnedPaths = (...paths: string[]) => {
    ownedPaths = ownedPathSpellings([...ownedPaths, ...paths]);
  };
  const runGit = options.runGit ?? productionGitRunner(globalConfig);
  refreshOwnedPaths(globalConfig, bareDir);
  let primary: Error | undefined;
  let result: PrepareForkOfficialBaseResult | undefined;

  try {
    chmodSync(verifierRoot, 0o700);
    writeFileSync(globalConfig, "", { mode: 0o600 });
    chmodSync(globalConfig, 0o600);
    runOrThrow(runGit, "cleanup official verifier", options.repoRoot, ["update-ref", "-d", MARKER_REF], ownedPaths);
    runOrThrow(runGit, "cleanup official verifier", options.repoRoot, ["update-ref", "-d", OFFICIAL_TAG_REF], ownedPaths);
    runOrThrow(runGit, "fetch origin marker", options.repoRoot, [
      "fetch", "--no-tags", "--no-write-fetch-head", "origin",
      "+refs/heads/upstream-release:" + MARKER_REF,
    ], ownedPaths);
    runOrThrow(runGit, "init official verifier", options.repoRoot, ["init", "--bare", bareDir], ownedPaths);
    runOrThrow(runGit, "fetch official refs", options.repoRoot, [
      `--git-dir=${bareDir}`, "fetch", "--no-tags", "--filter=blob:none", options.officialRepositoryUrl,
      "+refs/heads/main:refs/heads/official-main",
      `+refs/tags/${classification.tag}:refs/tags/${classification.tag}`,
    ], ownedPaths);
    const bareTagRef = `refs/tags/${classification.tag}`;
    const bareType = runOrThrow(runGit, "verify official tag", options.repoRoot, [
      `--git-dir=${bareDir}`, "cat-file", "-t", bareTagRef,
    ], ownedPaths).stdout.trim();
    if (bareType !== "tag") throw new Error("official release ref is not an annotated tag");
    const rawTagOid = runOrThrow(runGit, "verify official tag", options.repoRoot, [
      `--git-dir=${bareDir}`, "rev-parse", bareTagRef,
    ], ownedPaths).stdout.trim();
    const peeledCommit = runOrThrow(runGit, "verify official tag", options.repoRoot, [
      `--git-dir=${bareDir}`, "rev-parse", `${bareTagRef}^{commit}`,
    ], ownedPaths).stdout.trim();
    runOrThrow(runGit, "verify official ancestry", options.repoRoot, [
      `--git-dir=${bareDir}`, "merge-base", "--is-ancestor", peeledCommit, "refs/heads/official-main",
    ], ownedPaths);
    runOrThrow(runGit, "import official tag", options.repoRoot, [
      "fetch", "--no-tags", "--no-write-fetch-head", bareDir,
      `+refs/tags/${classification.tag}:${OFFICIAL_TAG_REF}`,
    ], ownedPaths);
    const importedType = runOrThrow(runGit, "verify official tag", options.repoRoot, ["cat-file", "-t", OFFICIAL_TAG_REF], ownedPaths).stdout.trim();
    const importedRaw = runOrThrow(runGit, "verify official tag", options.repoRoot, ["rev-parse", OFFICIAL_TAG_REF], ownedPaths).stdout.trim();
    const importedPeeled = runOrThrow(runGit, "verify official tag", options.repoRoot, ["rev-parse", `${OFFICIAL_TAG_REF}^{commit}`], ownedPaths).stdout.trim();
    if (importedType !== "tag" || importedRaw !== rawTagOid || importedPeeled !== peeledCommit) {
      throw new Error("imported official tag does not match verified official tag");
    }
    const marker = runOrThrow(runGit, "verify official tag", options.repoRoot, ["rev-parse", `${MARKER_REF}^{commit}`], ownedPaths).stdout.trim();
    if (marker !== peeledCommit) throw new Error("official release tag does not match origin upstream-release");
    const localTagRef = `refs/tags/${classification.tag}`;
    const existing = readExistingTag(runGit, options.repoRoot, localTagRef, ownedPaths);
    if (existing) {
      if (existing.raw !== rawTagOid || existing.peeled !== peeledCommit) {
        throw new Error("existing local official tag does not match verified official tag");
      }
    } else {
      runOrThrow(runGit, "publish local tag", options.repoRoot, ["update-ref", localTagRef, rawTagOid, ZERO_OID], ownedPaths);
    }
    result = { kind: "prepared", version: classification.version, tag: classification.tag, rawTagOid, peeledCommit };
  } catch (error) {
    primary = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupError = cleanup(runGit, options.repoRoot, verifierRoot, ownedPaths);
  if (primary) {
    if (cleanupError) {
      throw new Error(primary.message.slice(0, 512 - CLEANUP_FAILURE_SUFFIX.length) + CLEANUP_FAILURE_SUFFIX);
    }
    throw primary;
  }
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error("prepare official base: git command failed");
  return result;
}

export function prepareForkOfficialBaseCli(): PrepareForkOfficialBaseResult {
  return prepareForkOfficialBase({ repoRoot: CLI_REPO_ROOT, officialRepositoryUrl: OFFICIAL_URL });
}

if (import.meta.main) {
  try {
    prepareForkOfficialBaseCli();
  } catch (error) {
    console.error(safeGitDiagnostic("prepare official base", error, [CLI_REPO_ROOT]));
    process.exitCode = 1;
  }
}
