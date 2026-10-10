import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadBundledCodexCatalog, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { deriveEntry } from "../../src/codex/catalog/sync";
import { resetCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";

export function installIsolatedCodexRuntime(root: string): () => void {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexCliPath = process.env.CODEX_CLI_PATH;
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');

  const catalog = JSON.stringify({ models: [deriveEntry(null, "gpt-5.6-sol", "Runtime fixture", 9)] });
  let command: string;
  if (process.platform === "win32") {
    const script = join(root, "fixture-codex.js");
    writeFileSync(script, [
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("codex-cli 0.145.0\\n");',
      '} else if (process.argv.includes("--bundled")) {',
      `  process.stdout.write(${JSON.stringify(catalog)});`,
      '} else {',
      '  process.exitCode = 2;',
      '}',
    ].join("\n"));
    command = join(root, "fixture-codex.cmd");
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    command = join(root, "fixture-codex");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const catalogPath = join(root, "fixture-catalog.json");
    writeFileSync(catalogPath, catalog);
    writeFileSync(command, [
      "#!/bin/sh",
      'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
      "  printf '%s\\n' 'codex-cli 0.145.0'",
      'elif [ "$#" -eq 3 ] && [ "$1" = "debug" ] && [ "$2" = "models" ] && [ "$3" = "--bundled" ]; then',
      `  exec /bin/cat ${quote(catalogPath)}`,
      "else",
      "  exit 2",
      "fi",
      "",
    ].join("\n"));
    chmodSync(command, 0o755);
  }

  const restore = () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCodexCliPath;
    resetCatalogRuntimeStateForTests();
    resetCodexRuntimeResolveCacheForTests();
  };
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CLI_PATH = command;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  try {
    if (loadBundledCodexCatalog()?.models?.[0]?.slug !== "gpt-5.6-sol") {
      throw new Error("isolated Codex runtime fixture catalog was not selected");
    }
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}
