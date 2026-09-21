import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const doctorGuiIfChangedScript = fileURLToPath(new URL("../../scripts/doctor-gui-if-changed.ts", import.meta.url));
const lintGuiIfChangedScript = fileURLToPath(new URL("../../scripts/lint-gui-if-changed.ts", import.meta.url));

describe("doctor-gui-if-changed", () => {
  test("guiPathsChanged is a slash-guarded gui/ prefix predicate", async () => {
    const { guiPathsChanged } = await import("../../scripts/doctor-gui-if-changed");

    expect(guiPathsChanged(["gui/src/App.tsx"])).toBe(true);
    expect(guiPathsChanged(["gui"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts", "gui/package.json"])).toBe(true);
    expect(guiPathsChanged(["scripts/foo.ts"])).toBe(false);
    expect(guiPathsChanged(["guitools/x.ts"])).toBe(false);
    expect(guiPathsChanged([])).toBe(false);
  });

  test("looksLikeDoctorInfraFailure detects registry/network outages", async () => {
    const { looksLikeDoctorInfraFailure } = await import("../../scripts/doctor-gui-if-changed");
    expect(looksLikeDoctorInfraFailure("npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! code ECONNRESET")).toBe(true);
    expect(looksLikeDoctorInfraFailure("npm ERR! network timeout")).toBe(true);
    expect(looksLikeDoctorInfraFailure("All 2 issues\nBugs > 1 errors")).toBe(false);
    // Findings copy can mention "network" without being an infra outage.
    expect(looksLikeDoctorInfraFailure("Network requests > 1 errors")).toBe(false);
  });

  test("DRY_RUN prints the run/skip decision without spawning the doctor", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("doctor:run");

    const skip = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: { ...process.env, DOCTOR_DRY_RUN: "1", DOCTOR_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("doctor:skip");
  });

  test("degrades gracefully when the doctor engine is unavailable (offline prepush)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "definitely-not-a-real-command-xyz",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("soft-skips when doctor exits nonzero due to a registry/network failure", () => {
    // Simulate `bun run doctor` starting, then npx failing offline: numeric status
    // plus registry noise in stderr — must not gate the push.
    // cwd for DOCTOR_CMD is gui/, so reach fixtures via ../scripts/...
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-offline-exit.ts",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toContain("skipping scan");
  });

  test("propagates a non-zero doctor exit so findings gate the push", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-findings-exit.ts",
      },
    });
    expect(run.exitCode).not.toBe(0);
  });

  test("isDoctorBufferOverflow recognizes ENOBUFS / maxBuffer errors", async () => {
    const { isDoctorBufferOverflow } = await import("../../scripts/doctor-gui-if-changed");
    expect(isDoctorBufferOverflow("ENOBUFS")).toBe(true);
    expect(isDoctorBufferOverflow("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")).toBe(true);
    expect(isDoctorBufferOverflow("ENOENT")).toBe(false);
    expect(isDoctorBufferOverflow(undefined)).toBe(false);
  });

  test("hard-fails when doctor output exceeds maxBuffer (does not soft-skip)", () => {
    const run = Bun.spawnSync(["bun", doctorGuiIfChangedScript], {
      env: {
        ...process.env,
        DOCTOR_FILES: "gui/src/App.tsx",
        DOCTOR_CMD: "bun ../scripts/fixtures/doctor-huge-output.ts",
        // Tiny buffer so the fixture's stdout trips the overflow branch.
        OCX_DOCTOR_MAX_BUFFER: "256",
      },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("exceeded buffer");
  });
});

describe("lint-gui-if-changed", () => {
  test("DRY_RUN prints the run/skip decision without spawning lint", () => {
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: { ...process.env, LINT_DRY_RUN: "1", LINT_FILES: "gui/src/App.tsx\nscripts/x.ts" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("lint:run");

    const skip = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: { ...process.env, LINT_DRY_RUN: "1", LINT_FILES: "scripts/x.ts\nREADME.md" },
    });
    expect(skip.exitCode).toBe(0);
    expect(skip.stdout.toString()).toContain("lint:skip");
  });

  test("runs eslint when gui/ changed and fails the push on findings", () => {
    // `bun run lint` in gui/ exits non-zero on findings; a fake command makes
    // the spawn deterministic without depending on the real eslint output.
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: {
        ...process.env,
        LINT_FILES: "gui/src/App.tsx",
        LINT_CMD: "bun ../scripts/fixtures/lint-findings-exit.ts",
      },
    });
    expect(run.exitCode).not.toBe(0);
  });

  test("skips eslint when gui/ did not change", () => {
    const run = Bun.spawnSync(["bun", lintGuiIfChangedScript], {
      env: {
        ...process.env,
        LINT_FILES: "scripts/x.ts\nREADME.md",
        LINT_CMD: "bun ../scripts/fixtures/lint-findings-exit.ts",
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("lint:gui: skip");
  });
});
