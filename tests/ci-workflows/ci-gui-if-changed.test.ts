import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("doctor-gui-if-changed", () => {
  test("a Fork candidate uses its ancestor official tag and refuses missing or unrelated tags", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-doctor-fork-base-"));
    const git = (...args: string[]): string => {
      const result = Bun.spawnSync(["git", "-C", root, ...args]);
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      git("init", "-q");
      writeFileSync(join(root, "package.json"), '{"version":"2.67.0-ben.1"}\n');
      git("add", "package.json");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", "official");
      const base = git("rev-parse", "HEAD");
      const mainBranch = git("branch", "--show-current");
      git("tag", "v2.67.0");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "--allow-empty", "-qm", "fork");

      const module = await import("../../scripts/doctor-gui-if-changed") as unknown as {
        resolveForkDoctorBase?: (repoRoot: string) => string | null;
      };
      expect(typeof module.resolveForkDoctorBase).toBe("function");
      expect(module.resolveForkDoctorBase!(root)).toBe("v2.67.0");
      git("tag", "-d", "v2.67.0");
      expect(module.resolveForkDoctorBase!(root)).toBeNull();

      git("checkout", "-qb", "sibling", base);
      git("-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "--allow-empty", "-qm", "sibling");
      git("tag", "v2.67.0");
      git("checkout", "-q", mainBranch);
      expect(module.resolveForkDoctorBase!(root)).toBeNull();
      writeFileSync(join(root, "package.json"), '{"version":"2.67.0"}\n');
      expect(module.resolveForkDoctorBase!(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
