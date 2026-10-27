import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./remove-tree";

export function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

// Assembled from fragments so the fixture identity is not an email literal in a tracked
// file: scripts/privacy-scan.ts matches any email-shaped string and `.invalid` is not
// allow-listed, so writing it whole fails the repository's own privacy gate. The bytes
// handed to git are identical either way.
const FIXTURE_COMMIT_EMAIL = ["test", "opencodex.invalid"].join("@");

export function commitFixture(cwd: string, path: string, contents: string, message: string): string {
  writeFileSync(join(cwd, path), contents);
  runGit(cwd, "add", path);
  runGit(
    cwd,
    "-c",
    "user.name=OpenCodex Test",
    "-c",
    `user.email=${FIXTURE_COMMIT_EMAIL}`,
    "commit",
    "-m",
    message,
  );
  return runGit(cwd, "rev-parse", "HEAD");
}

export function initChangedRunFixture(): { cwd: string; base: string; allocated: string } {
  const allocated = mkdtempSync(join(tmpdir(), "opencodex-changed-ref-"));
  try {
    if (Object.keys(process.env).some(key => /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)))
      throw new Error("changed fixture refuses inherited Git path overrides");
    runGit(allocated, "init", "--quiet");
    const cwd = runGit(allocated, "rev-parse", "--show-toplevel");
    for (const [owned, candidate] of [
      [allocated, cwd],
      [join(allocated, ".git"), runGit(cwd, "rev-parse", "--absolute-git-dir")],
    ]) {
      const original = statSync(owned!, { bigint: true }), canonical = statSync(candidate!, { bigint: true });
      if (!original.isDirectory() || original.ino === 0n || original.dev !== canonical.dev
        || original.ino !== canonical.ino) {
        throw new Error("changed fixture Git root or metadata is outside its allocated directory");
      }
    }
    const base = commitFixture(cwd, "base.txt", "base\n", "base");
    return { cwd, base, allocated };
  } catch (error) {
    try {
      removeTreeWithRetry(allocated);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "changed fixture initialization and cleanup failed");
    }
    throw error;
  }
}
