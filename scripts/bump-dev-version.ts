#!/usr/bin/env bun
/**
 * Decide the version `dev` should carry after a release publishes.
 *
 * WHY THIS EXISTS
 *
 * `scripts/release.ts` runs only on `main` or `preview` (`allowedBranches`) and does not
 * advance `dev`. For ordinary upstream releases, this helper can prepare a reviewable
 * version bump without writing to `dev` directly. Fork `ben.N` releases are different:
 * `dev` is allowed to continue from the immutable release commit without a version bump.
 *
 * That has been repaired by hand four times: `32529c2b2`, `e4a85d134`, `076ad3036`,
 * `befcac3e1`. The second of those ADDED the detector, and two more repairs followed
 * it, which is the evidence that visibility was never the missing piece.
 *
 * WHAT THIS IS AND IS NOT
 *
 * This decides a version. It does no git and no network work, which is what makes it
 * unit-testable and what keeps the credential surface in the workflow that calls it.
 * It does not merge anything: `.github/workflows/dev-version-bump.yml` uses the
 * output to open a pull request, and a human still merges that. This is a prepared
 * ordinary-release update, not a gate on unrelated `dev` commits.
 *
 * THE RULE
 *
 * Not "increment the minor". That contradicts `befcac3e1`, which moved `dev` from
 * `2.35.0` to `2.36.0` when the published tag was `v2.36.0-preview.20260829`:
 * incrementing the released core's minor would have skipped the stable `2.36.0` that
 * had not shipped yet.
 *
 * Not "lowest unused stable" either, however natural that sounds. "Unused" is a
 * property of the tag set and the npm registry, and a function with no I/O cannot
 * evaluate it. Stating the rule that way would make this file unimplementable as
 * specified.
 *
 * The rule is therefore about the published version's SHAPE, which is the only thing
 * this function can see:
 *
 *   published `X.Y.Z-ben.N`      ->  no version-coupled dev bump
 *   published `X.Y.Z-preview.*`  ->  dev becomes `X.Y.Z`     (befcac3e1)
 *   published `X.Y.Z` (stable)   ->  dev becomes `X.(Y+1).0` (e4a85d134, 076ad3036, 32529c2b2)
 *
 * A Fork revision is an immutable delivery snapshot, not a requirement to rename the
 * ongoing development line. Other prereleases keep the upstream rule: their stable core
 * has not shipped, while an ordinary stable consumes that core and advances the minor.
 */

import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { forkBaseVersion } from "../src/fork/version-policy.mjs";
import { compareReleaseTags } from "./release-notes";

/**
 * `compareReleaseTags` wants a tag. The workflow supplies `github.event.release.tag_name`
 * (`v2.36.0`) while `package.json` holds a bare version (`2.36.0`), so prefixing blindly
 * produces `vv2.36.0` and every comparison against it silently misorders.
 *
 * That is not hypothetical: it made the first version of this script reject a correct
 * candidate with "candidate 2.37.0 does not rank ahead of released v2.36.0" when handed
 * the tag the workflow actually passes.
 */
function asTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * `parseReleaseTag` in `release-notes.ts` is not exported, so parse here rather than
 * widen that module's surface for one caller. Same shape, optional `v` prefix.
 */
function parseVersion(raw: string): { major: number; minor: number; patch: number; prerelease: string | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export interface BumpDecision {
  changed: boolean;
  /** The version dev should carry. Equals `current` when `changed` is false. */
  version: string;
  reason: string;
}

/**
 * Pure decision. `released` is the version just published; `current` is what `dev`
 * carries now.
 *
 * @throws when either input is not a parseable version. A malformed input must not
 * silently produce a plausible-looking bump.
 */
export function decideDevVersion(released: string, current: string): BumpDecision {
  const rel = parseVersion(released);
  if (!rel) throw new Error(`released version is not parseable: ${JSON.stringify(released)}`);
  if (!parseVersion(current)) throw new Error(`current version is not parseable: ${JSON.stringify(current)}`);

  if (rel.prerelease?.startsWith("ben.")) {
    const normalizedReleased = released.trim().replace(/^v/, "");
    if (!forkBaseVersion(normalizedReleased)) {
      throw new Error(`released version is not a canonical Fork version: ${JSON.stringify(released)}`);
    }
    return {
      changed: false,
      version: current,
      reason: `${released} is an immutable Fork revision; dev may continue without a release-coupled version bump`,
    };
  }

  const candidate = rel.prerelease === null
    ? `${rel.major}.${rel.minor + 1}.0`
    : `${rel.major}.${rel.minor}.${rel.patch}`;

  // Nothing to do when dev is already clear of the RELEASED version.
  // Comparing against the candidate instead is wrong, and a test caught it: dev at
  // `2.37.0-preview.1` with `2.36.0` published is genuinely ahead of the release, but it
  // is BEHIND the candidate `2.37.0`, so a candidate-based guard would "fix" a tree that
  // was never broken and downgrade a legitimate prerelease line.
  if (compareReleaseTags(asTag(current), asTag(released)) > 0) {
    return {
      changed: false,
      version: current,
      reason: `dev already carries ${current}, which is ahead of the published ${released}`,
    };
  }

  // The candidate must beat the published version too. With the rule above this holds
  // by construction, so a failure here means the rule and the comparator disagree —
  // refuse rather than emit a version the detector would reject.
  if (compareReleaseTags(asTag(candidate), asTag(released)) <= 0) {
    throw new Error(`candidate ${candidate} does not rank ahead of released ${released}`);
  }

  return {
    changed: true,
    version: candidate,
    reason: rel.prerelease === null
      ? `${released} is a stable release, so dev moves to the next minor ${candidate}`
      : `${released} is a prerelease of an unshipped ${candidate}, so dev carries that core`,
  };
}

if (import.meta.main) {
  const [released, packageJsonPath] = process.argv.slice(2);
  if (!released || !packageJsonPath) {
    console.error("Usage: bun scripts/bump-dev-version.ts <released-version> <path-to-package.json>");
    process.exit(1);
  }

  const file = Bun.file(packageJsonPath);
  const raw = await file.text();
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    console.error(`${packageJsonPath} has no string version`);
    process.exit(1);
  }

  let decision: BumpDecision;
  try {
    decision = decideDevVersion(released, parsed.version);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (decision.changed) {
    // Rewrite only the version line. A full JSON round-trip would reformat the file
    // and turn a one-line bump into an unreviewable diff.
    const rewritten = raw.replace(
      /("version"\s*:\s*")[^"]+(")/,
      (_match, open: string, close: string) => `${open}${decision.version}${close}`,
    );
    if (rewritten === raw) {
      console.error("✗ could not locate the version line to rewrite");
      process.exit(1);
    }
    // Atomic replacement, per scripts/AGENTS.md: package metadata is exactly the class of
    // file whose partial write corrupts a checkout. This script is also the documented
    // manual recovery path, so it can run on a developer machine where an interrupt or a
    // full disk mid-write would leave a truncated package.json and no way to install.
    // Write a sibling temp file, rename it into place (atomic within one filesystem), and
    // remove the temp on any failure so a crash leaves no debris.
    const temp = `${packageJsonPath}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, rewritten, "utf8");
      renameSync(temp, packageJsonPath);
    } catch (err) {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Nothing more to do: the original file is untouched, which is the point.
      }
      console.error(`✗ could not write ${packageJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // A machine contract, not prose: the workflow branches on these values.
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    await Bun.write(output, `changed=${decision.changed}\nversion=${decision.version}\n`);
  }
  console.log(JSON.stringify(decision));
}
