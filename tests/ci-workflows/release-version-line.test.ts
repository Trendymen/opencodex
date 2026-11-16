import { describe, expect, test } from "bun:test";
import { readVersionSources } from "../../scripts/release-version-sources";
import { compareVersions, devReleaseVersion } from "../../scripts/version-line";
import { forkBaseVersion, forkVersionTagError } from "../../src/fork/version-policy.mjs";
import { repoRoot } from "../helpers/repo-root";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.toString().trim();
}

describe("release version line", () => {
  test("the committed base is consistent across all four sources", () => {
    const sources = readVersionSources(repoRoot());
    expect(sources).toHaveLength(4);
    const base = sources[0]!.version;
    expect(sources.map(source => source.version)).toEqual([base, base, base, base]);
    if (!forkBaseVersion(base)) {
      expect(base).toMatch(/^\d+\.\d+\.\d+$/);
      return;
    }
    const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
    expect(forkVersionTagError(base, tags, tag => Bun.spawnSync(
      ["git", "merge-base", "--is-ancestor", `${tag}^{commit}`, "HEAD"],
      { cwd: repoRoot(), stdout: "pipe", stderr: "pipe" },
    ).exitCode === 0)).toBeNull();
  });

  test("a published stable can equal or exceed the committed base without a dev bump", () => {
    const base = "2.100.0";
    const stable = devReleaseVersion({ base, stableTags: ["v2.100.0"], previewTags: [], channel: "latest" });
    const preview = devReleaseVersion({ base, stableTags: ["v2.100.1"], previewTags: [], channel: "preview", stamp: "20261108" });
    expect(stable).toBe("2.100.1");
    expect(preview).toBe("2.100.2-preview.20261108.1");
    expect(compareVersions(preview, "2.100.1")).toBeGreaterThan(0);
  });
});
