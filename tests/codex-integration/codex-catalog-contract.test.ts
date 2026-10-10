import { describe, expect, test } from "bun:test";
import {
  ensureStrictCatalogFields,
} from "../../src/codex/catalog/parsing";

describe("Codex 0.151 catalog contract fields", () => {
  test("legacy shell types canonicalize while disabled remains disabled", () => {
    const normalizedLegacy = ["default", "local", "shell_command"].map(shell_type =>
      ensureStrictCatalogFields({ slug: "test", shell_type }).shell_type);

    expect(normalizedLegacy).toEqual(["unified_exec", "unified_exec", "unified_exec"]);
    expect(ensureStrictCatalogFields({ slug: "test", shell_type: "disabled" }).shell_type)
      .toBe("disabled");
  });

  test("missing booleans receive serde defaults", () => {
    expect(ensureStrictCatalogFields({ slug: "test" })).toMatchObject({
      node_repl_disabled: false,
      node_repl_auto_review_required: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: true,
    });
  });

  test("explicit per-model booleans are never overwritten by defaults", () => {
    expect(ensureStrictCatalogFields({
      slug: "test",
      node_repl_disabled: true,
      node_repl_auto_review_required: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: false,
    })).toMatchObject({
      node_repl_disabled: true,
      node_repl_auto_review_required: true,
      include_plugin_usage_instructions: true,
      include_apps_usage_instructions: false,
    });
  });
});
