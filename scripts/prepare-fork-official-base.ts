import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { forkBaseVersion } from "../src/fork/version-policy.mjs";
import { redactSecretString, redactUrlForLog, redactUserPath } from "../src/lib/redact";

const ZERO_OID = "0".repeat(40);
const OFFICIAL_TAG_REF = "refs/ocx-ci/official-tag";
const OFFICIAL_URL = "https://github.com/lidge-jun/opencodex.git";
const OFFICIAL_RELEASE_API = "https://api.github.com/repos/lidge-jun/opencodex/releases/tags";
const RELEASE_RESPONSE_LIMIT = 1_048_576;
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
  | {
    kind: "prepared";
    version: string;
    tag: string;
    refKind: "lightweight" | "annotated";
    rawTagOid: string;
    peeledCommit: string;
  };

export type GitRunner = (cwd: string, args: readonly string[], input?: string) => {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GitOperation =
  | "fetch Fork version history"
  | "init official verifier"
  | "fetch official refs"
  | "verify official ancestry"
  | "import official tag"
  | "verify official tag"
  | "publish local tag"
  | "cleanup official verifier"
  | "prepare official base";

class OfficialReleaseEvidenceRequiredError extends Error {
  constructor(readonly tag: string) {
    super("official release evidence required");
  }
}

export async function fetchOfficialReleaseEvidence(
  tag: string,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  token?: string,
): Promise<unknown> {
  let failure = "request-failed";
  const signal = AbortSignal.timeout(10_000);
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await request(`${OFFICIAL_RELEASE_API}/${encodeURIComponent(tag)}`, {
      headers,
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const status = response.status;
      failure = Number.isInteger(status) && status >= 100 && status <= 599 ? `http-${status}` : "http-invalid-status";
      if (status === 403 && response.headers.get("x-ratelimit-remaining") === "0") failure += " rate-limit-exhausted";
      throw new Error();
    }
    if (!response.body) {
      failure = "body-missing";
      throw new Error();
    }
    failure = "body-read-failed";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > RELEASE_RESPONSE_LIMIT) {
          failure = "response-too-large";
          void reader.cancel().catch(() => {});
          throw new Error();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    failure = "invalid-json";
    return JSON.parse(text);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) {
      if (failure === "request-failed") failure = "request-timeout";
      if (failure === "body-read-failed") failure = "body-read-timeout";
    }
    throw new Error(`fetch official release evidence failed: ${failure}`);
  }
}

function matchesOfficialRelease(evidence: unknown, tag: string, peeledCommit: string): boolean {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  const release = evidence as Record<string, unknown>;
  return release.draft === false
    && release.prerelease === false
    && release.tag_name === tag
    && typeof release.target_commitish === "string"
    && /^[0-9a-f]{40}$/.test(release.target_commitish)
    && release.target_commitish === peeledCommit;
}

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
  const ignored = new Set([
    "OCX_OFFICIAL_RELEASE_API_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INDEX_FILE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_NAMESPACE",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (value !== undefined && !name.startsWith("GIT_CONFIG") && !ignored.has(name)) {
      environment[key] = value;
    }
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
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: devNull,
  };
}

function productionGitRunner(globalConfig: string): GitRunner {
  const environment = gitEnvironment(globalConfig);
  return (cwd, args, input) => {
    const result = Bun.spawnSync(["git", "--no-lazy-fetch", ...args], {
      cwd, env: environment, stdin: input === undefined ? undefined : Buffer.from(input), stdout: "pipe", stderr: "pipe",
    });
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
  input?: string,
) {
  try {
    const result = runGit(cwd, args, input);
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
): { type: string; raw: string; peeled: string } | undefined {
  try {
    const exists = runGit(repoRoot, ["show-ref", "--exists", tagRef]);
    if (exists.exitCode === 2) return undefined;
    if (exists.exitCode !== 0) throw outputOrError(exists);
    const type = runGit(repoRoot, ["cat-file", "-t", tagRef]);
    if (type.exitCode !== 0) throw outputOrError(type);
    const refType = type.stdout.trim();
    if (refType !== "commit" && refType !== "tag") {
      throw new Error("existing local official tag has unsupported object type");
    }
    const raw = runGit(repoRoot, ["rev-parse", tagRef]);
    if (raw.exitCode !== 0) throw outputOrError(raw);
    const peeled = runGit(repoRoot, ["rev-parse", `${tagRef}^{commit}`]);
    if (peeled.exitCode !== 0) throw outputOrError(peeled);
    const rawOid = raw.stdout.trim();
    const peeledCommit = peeled.stdout.trim();
    if (refType === "commit" && rawOid !== peeledCommit) {
      throw new Error("lightweight local official tag does not equal its peeled commit");
    }
    return { type: refType, raw: rawOid, peeled: peeledCommit };
  } catch (error) {
    throw new Error(safeGitDiagnostic("verify official tag", error, ownedPaths));
  }
}

function cleanup(
  runGit: GitRunner | undefined,
  repoRoot: string,
  verifierRoot: string,
  ownedPaths: readonly string[],
): Error | undefined {
  let error: Error | undefined;
  if (runGit) {
    try {
      runOrThrow(runGit, "cleanup official verifier", repoRoot, ["update-ref", "-d", OFFICIAL_TAG_REF], ownedPaths);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
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
  filesystem?: Pick<typeof import("node:fs"), "chmodSync" | "writeFileSync">;
  officialReleaseEvidence?: unknown;
}): PrepareForkOfficialBaseResult {
  let classification: VersionClassification;
  try {
    classification = classifyPackageVersion(packageVersion(options.repoRoot));
  } catch (error) {
    throw new Error(safeGitDiagnostic("prepare official base", error, [options.repoRoot]));
  }
  if (classification.kind === "non-fork") return { kind: "not-fork", version: classification.version };
  if (options.officialReleaseEvidence === undefined) {
    throw new OfficialReleaseEvidenceRequiredError(classification.tag);
  }

  let verifierRoot: string;
  try {
    verifierRoot = mkdtempSync(join(tmpdir(), "ocx-fork-official-"));
  } catch (error) {
    throw new Error(safeGitDiagnostic("prepare official base", error, [options.repoRoot]));
  }
  const filesystem = options.filesystem ?? { chmodSync, writeFileSync };
  let globalConfig = "";
  let bareDir = "";
  let ownedPaths = ownedPathSpellings([options.repoRoot, verifierRoot]);
  const refreshOwnedPaths = (...paths: string[]) => {
    ownedPaths = ownedPathSpellings([...ownedPaths, ...paths]);
  };
  let runGit: GitRunner | undefined = options.runGit;
  let primary: Error | undefined;
  let result: PrepareForkOfficialBaseResult | undefined;
  try {
    runGit ??= productionGitRunner(join(verifierRoot, "gitconfig"));
    filesystem.chmodSync(verifierRoot, 0o700);
    globalConfig = join(verifierRoot, "gitconfig");
    bareDir = join(verifierRoot, "repo.git");
    refreshOwnedPaths(globalConfig, bareDir);
    filesystem.writeFileSync(globalConfig, "", { mode: 0o600 });
    filesystem.chmodSync(globalConfig, 0o600);
    runOrThrow(runGit, "init official verifier", options.repoRoot, ["init", "--bare", bareDir], ownedPaths);
    refreshOwnedPaths(bareDir);
    runOrThrow(runGit, "cleanup official verifier", options.repoRoot, ["update-ref", "-d", OFFICIAL_TAG_REF], ownedPaths);
    const head = runOrThrow(runGit, "fetch Fork version history", options.repoRoot,
      ["rev-parse", "HEAD"], ownedPaths).stdout.trim();
    const forkTag = runGit(options.repoRoot,
      ["rev-parse", "--verify", "--quiet", `refs/tags/v${classification.version}~0`]);
    if (forkTag.exitCode !== 0 && forkTag.exitCode !== 1) {
      throw new Error(safeGitDiagnostic("fetch Fork version history", outputOrError(forkTag), ownedPaths));
    }
    if (forkTag.exitCode === 0) {
      const shallow = runOrThrow(runGit, "fetch Fork version history", options.repoRoot,
        ["rev-parse", "--is-shallow-repository"], ownedPaths).stdout.trim();
      if (shallow === "true") {
        const ancestry = runGit(options.repoRoot, ["merge-base", "--is-ancestor", forkTag.stdout.trim(), head]);
        if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) {
          throw new Error(safeGitDiagnostic("fetch Fork version history", outputOrError(ancestry), ownedPaths));
        }
        if (ancestry.exitCode === 1) {
          runOrThrow(runGit, "fetch Fork version history", options.repoRoot,
            ["fetch", "--unshallow", "--no-tags", "--no-write-fetch-head", "origin", head], ownedPaths);
        }
      }
    }
    const bareTagRef = `refs/tags/${classification.tag}`;
    const advertised = runOrThrow(runGit, "verify official tag", options.repoRoot, [
      `--git-dir=${bareDir}`, "ls-remote", "--tags", options.officialRepositoryUrl, bareTagRef, `${bareTagRef}?{}`,
    ], ownedPaths).stdout.replaceAll("\r\n", "\n").split("\n");
    if (advertised.pop() !== "" || advertised.length < 1 || advertised.length > 2) {
      throw new Error("verify official tag: invalid remote tag advertisement");
    }
    let rawTagOid: string | undefined;
    let advertisedPeeled: string | undefined;
    for (const line of advertised) {
      const match = /^([0-9a-f]{40})\t([^\t\n]+)$/.exec(line);
      if (!match) throw new Error("verify official tag: invalid remote tag advertisement");
      if (match[2] === bareTagRef && rawTagOid === undefined) rawTagOid = match[1];
      else if (match[2] === `${bareTagRef}^{}` && advertisedPeeled === undefined) advertisedPeeled = match[1];
      else throw new Error("verify official tag: invalid remote tag advertisement");
    }
    if (!rawTagOid) throw new Error("verify official tag: invalid remote tag advertisement");
    const peeledCommit = advertisedPeeled ?? rawTagOid;
    const bareType = advertisedPeeled ? "tag" : "commit";
    const refKind = advertisedPeeled ? "annotated" : "lightweight";
    if (!matchesOfficialRelease(options.officialReleaseEvidence, classification.tag, peeledCommit)) {
      throw new Error("invalid official release evidence");
    }
    const hasOfficialCommit = () => {
      const output = runOrThrow(runGit!, "verify official ancestry", options.repoRoot,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"], ownedPaths, `${peeledCommit}\n`).stdout;
      if (output === `${peeledCommit} commit\n` || output === `${peeledCommit} commit\r\n`) return true;
      if (output === `${peeledCommit} missing\n` || output === `${peeledCommit} missing\r\n`) return false;
      throw new Error("verify official ancestry: invalid local object response");
    };
    const localTagRef = `refs/tags/${classification.tag}`;
    const localRef = runGit(options.repoRoot, ["show-ref", "--exists", localTagRef]);
    if (localRef.exitCode !== 0 && localRef.exitCode !== 2) {
      throw new Error(safeGitDiagnostic("verify official tag", outputOrError(localRef), ownedPaths));
    }
    let reuseLocalTag = false;
    if (localRef.exitCode === 0) {
      const localRaw = runOrThrow(runGit, "verify official tag", options.repoRoot,
        ["rev-parse", "--verify", "--quiet", localTagRef], ownedPaths).stdout.trim();
      if (localRaw !== rawTagOid) {
        readExistingTag(runGit, options.repoRoot, localTagRef, ownedPaths);
        throw new Error("existing local official tag does not match verified official tag");
      }
      const rawObject = runOrThrow(runGit, "verify official tag", options.repoRoot,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"], ownedPaths, `${rawTagOid}\n`).stdout;
      if (rawObject !== `${rawTagOid} missing\n` && rawObject !== `${rawTagOid} missing\r\n`) {
        if (rawObject !== `${rawTagOid} ${bareType}\n` && rawObject !== `${rawTagOid} ${bareType}\r\n`) {
          throw new Error("verify official tag: invalid local tag object");
        }
        if (hasOfficialCommit()) {
          const local = readExistingTag(runGit, options.repoRoot, localTagRef, ownedPaths);
          if (!local || local.type !== bareType || local.raw !== rawTagOid || local.peeled !== peeledCommit) {
            throw new Error("existing local official tag does not match verified official tag");
          }
          reuseLocalTag = true;
        }
      }
    }
    if (!reuseLocalTag) {
      runOrThrow(runGit, "fetch official refs", options.repoRoot, [
        `--git-dir=${bareDir}`, "fetch", "--depth=1", "--no-tags", "--no-filter", options.officialRepositoryUrl,
        `+${bareTagRef}:${bareTagRef}`,
      ], ownedPaths);
      const fetchedType = runOrThrow(runGit, "verify official tag", options.repoRoot,
        [`--git-dir=${bareDir}`, "cat-file", "-t", bareTagRef], ownedPaths).stdout.trim();
      if (fetchedType !== "commit" && fetchedType !== "tag") {
        throw new Error("official release ref has unsupported object type");
      }
      const fetchedRaw = runOrThrow(runGit, "verify official tag", options.repoRoot,
        [`--git-dir=${bareDir}`, "rev-parse", bareTagRef], ownedPaths).stdout.trim();
      const fetchedPeeled = runOrThrow(runGit, "verify official tag", options.repoRoot,
        [`--git-dir=${bareDir}`, "rev-parse", `${bareTagRef}^{commit}`], ownedPaths).stdout.trim();
      if (fetchedType !== bareType || fetchedRaw !== rawTagOid || fetchedPeeled !== peeledCommit) {
        throw new Error("verify official tag: fetched tag does not match remote advertisement");
      }
    }
    let ancestry = hasOfficialCommit()
      ? runGit(options.repoRoot, ["merge-base", "--is-ancestor", peeledCommit, head])
      : undefined;
    if (!ancestry || ancestry.exitCode === 1) {
      const shallow = runOrThrow(runGit, "fetch Fork version history", options.repoRoot,
        ["rev-parse", "--is-shallow-repository"], ownedPaths).stdout.trim();
      if (shallow === "true") {
        runOrThrow(runGit, "fetch Fork version history", options.repoRoot,
          ["fetch", "--unshallow", "--no-tags", "--no-write-fetch-head", "origin", head], ownedPaths);
        ancestry = hasOfficialCommit()
          ? runGit(options.repoRoot, ["merge-base", "--is-ancestor", peeledCommit, head])
          : undefined;
      } else if (shallow !== "false") {
        throw new Error("invalid shallow repository status");
      }
    }
    if (!ancestry || ancestry.exitCode !== 0) {
      const error = !ancestry || ancestry.exitCode === 1
        ? new Error("official release tag is not an ancestor of HEAD")
        : outputOrError(ancestry);
      throw new Error(safeGitDiagnostic("verify official ancestry", error, ownedPaths));
    }
    if (!reuseLocalTag) {
      runOrThrow(runGit, "import official tag", options.repoRoot, [
        "fetch", "--no-tags", "--no-write-fetch-head", bareDir, `+${bareTagRef}:${OFFICIAL_TAG_REF}`,
      ], ownedPaths);
      const importedType = runOrThrow(runGit, "verify official tag", options.repoRoot, ["cat-file", "-t", OFFICIAL_TAG_REF], ownedPaths).stdout.trim();
      const importedRaw = runOrThrow(runGit, "verify official tag", options.repoRoot, ["rev-parse", OFFICIAL_TAG_REF], ownedPaths).stdout.trim();
      const importedPeeled = runOrThrow(runGit, "verify official tag", options.repoRoot, ["rev-parse", `${OFFICIAL_TAG_REF}^{commit}`], ownedPaths).stdout.trim();
      if (importedType !== bareType || importedRaw !== rawTagOid || importedPeeled !== peeledCommit) {
        throw new Error("imported official tag does not match verified official tag");
      }
    }
    const currentHead = runOrThrow(runGit, "verify official ancestry", options.repoRoot,
      ["rev-parse", "HEAD"], ownedPaths).stdout.trim();
    if (currentHead !== head) {
      throw new Error("HEAD changed during official base verification");
    }
    const existing = readExistingTag(runGit, options.repoRoot, localTagRef, ownedPaths);
    if (existing) {
      if (existing.type !== bareType || existing.raw !== rawTagOid || existing.peeled !== peeledCommit) {
        throw new Error("existing local official tag does not match verified official tag");
      }
    } else {
      runOrThrow(runGit, "publish local tag", options.repoRoot, ["update-ref", localTagRef, rawTagOid, ZERO_OID], ownedPaths);
    }
    result = {
      kind: "prepared",
      version: classification.version,
      tag: classification.tag,
      refKind,
      rawTagOid,
      peeledCommit,
    };
  } catch (error) {
    primary = new Error(safeGitDiagnostic("prepare official base", error, ownedPaths));
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

export async function prepareForkOfficialBaseCli(): Promise<PrepareForkOfficialBaseResult> {
  const options = {
    repoRoot: CLI_REPO_ROOT,
    officialRepositoryUrl: OFFICIAL_URL,
  };
  try {
    return prepareForkOfficialBase(options);
  } catch (error) {
    if (!(error instanceof OfficialReleaseEvidenceRequiredError)) throw error;
    const officialReleaseEvidence = await fetchOfficialReleaseEvidence(error.tag, fetch, process.env.OCX_OFFICIAL_RELEASE_API_TOKEN);
    return prepareForkOfficialBase({ ...options, officialReleaseEvidence });
  }
}

if (import.meta.main) {
  try {
    await prepareForkOfficialBaseCli();
  } catch (error) {
    console.error(safeGitDiagnostic("prepare official base", error, [CLI_REPO_ROOT]));
    process.exitCode = 1;
  }
}
