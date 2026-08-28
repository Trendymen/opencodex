import { readFileSync, writeFileSync } from "node:fs";

/**
 * Vendored-dependency support for the local installer.
 *
 * The local installer only ever consumes the packed tarball on the machine
 * that packed it, so the resolved dependency subtree can be bundled into the
 * tarball itself: the global install then extracts static files instead of
 * resolving packages from the registry and running the bun postinstall
 * download. Public publishing must keep registry resolution so the
 * platform-specific optional dependencies (@oven/bun-*, @napi-rs/keyring-*)
 * stay per-platform, which is why the bundleDependencies marker is written
 * around a single npm pack run and restored byte-for-byte afterwards.
 */

/** Every runtime dependency becomes a bundled dependency for the local tarball. */
export function bundledDependenciesForLocalPackage(
  dependencies: Record<string, string> | undefined,
): string[] {
  return Object.keys(dependencies ?? {}).sort();
}

/**
 * Run the given step with bundleDependencies temporarily injected into
 * package.json, restoring the original bytes afterwards even on failure.
 */
export function runWithBundledDependencies<T>(packageJsonPath: string, run: () => T): T {
  const original = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(original) as {
    dependencies?: Record<string, string>;
  };
  parsed.bundleDependencies = bundledDependenciesForLocalPackage(parsed.dependencies);
  writeFileSync(packageJsonPath, JSON.stringify(parsed, null, 2) + String.fromCharCode(10));
  try {
    return run();
  } finally {
    writeFileSync(packageJsonPath, original);
  }
}
