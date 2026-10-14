import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, armDetachedConfigBaseline, saveConfigPreservingClaudeCode } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  CODEX_PASSTHROUGH_CATALOG, CODEX_PASSTHROUGH_DEFAULTS, resolveCodexPassthroughPermissions, readCodexPassthroughConfig,
  codexPassthroughCandidateError, mergeCodexPassthroughPatch,
} from "../../src/fork/codex-passthrough-contract";
import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";

describe("official Codex compatibility permissions", () => {
  test("configuration exposes exactly the approved 16 plus 5 keys", () => {
    const compat = ["normalizeRequestParameters", "expandRequestHistory", "normalizeEncryptedContent", "snapshotSkillsCatalog",
      "rewriteAnnotationInstructions", "bridgeLiteMetadata", "backfillResponseFields", "repairResponseToolCalls", "redactUpstreamErrors",
      "privateSseReadDeadline", "synthesizeTerminalFailure", "normalizeHostedImages", "synthesizeRoutingHint", "synthesizeSessionId", "addResponseRequestId", "addResponseBrowserHeaders"];
    const local = ["resetReplayRefusal", "requestPacingAdmission", "inputAdmissionPrecheck", "accountSoftPrecheck", "transportErrorMapping"];
    const resolved = resolveCodexPassthroughPermissions(undefined);
    expect(Object.keys(resolved).filter(key => key !== "localErrorPolicies").sort()).toEqual(compat.sort());
    expect(Object.keys(resolved.localErrorPolicies).sort()).toEqual(local.sort());
    expect(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group !== "localErrors").map(row => row.key).sort()).toEqual(compat);
    expect(CODEX_PASSTHROUGH_CATALOG.filter(row => row.group === "localErrors").map(row => row.key).sort()).toEqual(local);
  });
  test("unset_and_empty_allow_all_21_permissions", () => {
    const p = resolveCodexPassthroughPermissions(undefined);
    expect([...Object.entries(p).filter(([key]) => key !== "localErrorPolicies").map(([, value]) => value),
      ...Object.values(p.localErrorPolicies)]).toEqual(Array(21).fill(true));
    expect(resolveCodexPassthroughPermissions({})).toEqual(p);
    expect(resolveCodexPassthroughPermissions(CODEX_PASSTHROUGH_DEFAULTS)).toEqual(p);
    expect(resolveCodexPassthroughPermissions({ bridgeLiteMetadata: undefined,
      localErrorPolicies: { resetReplayRefusal: undefined } })).toEqual(p);
    expect(resolveCodexPassthroughPermissions({ bridgeLiteMetadata: false }).normalizeEncryptedContent).toBe(true);
    expect(resolveCodexPassthroughPermissions({ bridgeLiteMetadata: false }).bridgeLiteMetadata).toBe(false);
  });

  test("patch_null_restores_permission_without_enabling_legacy_features", () => {
    expect(mergeCodexPassthroughPatch({ normalizeEncryptedContent: false }, null)).toEqual({ ok: true, value: undefined });
    expect(mergeCodexPassthroughPatch({ bridgeLiteMetadata: false, localErrorPolicies: { resetReplayRefusal: false } },
      { bridgeLiteMetadata: null, localErrorPolicies: { requestPacingAdmission: false } })).toEqual({ ok: true,
        value: { localErrorPolicies: { resetReplayRefusal: false, requestPacingAdmission: false } } });
    expect(mergeCodexPassthroughPatch({ localErrorPolicies: { accountSoftPrecheck: false } },
      { localErrorPolicies: null })).toEqual({ ok: true, value: undefined });
    expect(mergeCodexPassthroughPatch(undefined, {})).toEqual({ ok: true, value: undefined });
  });

  test("strict writes reject malformed or unsupported fields", () => {
    for (const value of [null, [], false, "yes", { unsupported: true }, { bridgeLiteMetadata: "true" },
      { localErrorPolicies: { resetReplayRefusal: 0 } }, { localErrorPolicies: { unexpected: false } }]) {
      expect(codexPassthroughCandidateError(value)).not.toBeNull();
      expect(mergeCodexPassthroughPatch(undefined, value === null ? { bridgeLiteMetadata: 0 } : value).ok).toBe(false);
    }
    expect(codexPassthroughCandidateError({ localErrorPolicies: {} })).toBeNull();
  });

  test("read degradation disables invalid leaves and preserves unrelated providers", () => {
    const result = readCodexPassthroughConfig({ bridgeLiteMetadata: "sensitive-input", normalizeEncryptedContent: true,
      unsupported: "do not echo this", localErrorPolicies: { accountSoftPrecheck: 0 } });
    expect(result.value).toEqual({ bridgeLiteMetadata: false, normalizeEncryptedContent: true,
      localErrorPolicies: { accountSoftPrecheck: false } });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).not.toContain("sensitive-input");
    const off = resolveCodexPassthroughPermissions(readCodexPassthroughConfig(null).value);
    expect([...Object.entries(off).filter(([key]) => key !== "localErrorPolicies").map(([, value]) => value),
      ...Object.values(off.localErrorPolicies)]).toEqual(Array(21).fill(false));
    const raw = { port: 10100, defaultProvider: "relay", providers: {
      relay: { adapter: "openai-responses", baseUrl: "https://relay.example.test/v1", authMode: "key", models: ["fixture"],
        codexPassthrough: { bridgeLiteMetadata: "bad" } },
      other: { adapter: "openai-chat", baseUrl: "https://other.example.test/v1" },
    } };
    expect(validateConfigCandidate(raw).ok).toBe(false);
    const diagnostic = configDiagnosticsFromRaw(JSON.stringify(raw));
    expect(diagnostic.source).toBe("file");
    expect(diagnostic.config.providers.relay!.codexPassthrough).toEqual({ bridgeLiteMetadata: false });
    expect(diagnostic.config.providers.relay!.models).toEqual(["fixture"]);
    expect(diagnostic.config.providers.other!.baseUrl).toBe("https://other.example.test/v1");
    expect(diagnostic.warnings?.some(warning => warning.includes("codexPassthrough"))).toBe(true);
  });

  test("hand edited file degrades only bad permissions without rewriting disk", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-codex-compat-load-"));
    const oldHome = process.env.OPENCODEX_HOME;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENCODEX_HOME = home;
    const raw = JSON.stringify({ port: 10100, defaultProvider: "relay", providers: {
      relay: { adapter: "openai-responses", baseUrl: "https://relay.example.test/v1", codexPassthrough: {
        normalizeEncryptedContent: true, bridgeLiteMetadata: "do-not-echo", localErrorPolicies: null } },
      other: { adapter: "openai-chat", baseUrl: "https://other.example.test/v1" },
    } });
    writeFileSync(join(home, "config.json"), raw);
    try {
      const config = loadConfig();
      expect(config.providers.relay!.codexPassthrough?.bridgeLiteMetadata).toBe(false);
      expect(config.providers.relay!.codexPassthrough?.normalizeEncryptedContent).toBe(true);
      expect(Object.values(config.providers.relay!.codexPassthrough!.localErrorPolicies!)).toEqual(Array(5).fill(false));
      expect(config.providers.other!.baseUrl).toBe("https://other.example.test/v1");
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(raw);
      expect(warning.mock.calls.flat().join(" ")).not.toContain("do-not-echo");
    } finally {
      warning.mockRestore();
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
      removeTreeWithRetry(home);
    }
  });

  test("malformed top level degrades to mutable config and allows an unrelated save", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-codex-compat-resave-"));
    const oldHome = process.env.OPENCODEX_HOME;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    process.env.OPENCODEX_HOME = home;
    try {
      for (const reader of ["load", "diagnostics"]) for (const malformed of [null, [], "bad"]) {
        writeFileSync(join(home, "config.json"), JSON.stringify({ port: 10100, defaultProvider: "relay", providers: {
          relay: { adapter: "openai-responses", baseUrl: "https://relay.example.test/v1", codexPassthrough: malformed },
          other: { adapter: "openai-chat", baseUrl: "https://other.example.test/v1", models: ["other-model"] },
        } }));
        const live = reader === "load" ? loadConfig() : configDiagnosticsFromRaw(readFileSync(join(home, "config.json"), "utf8")).config;
        armDetachedConfigBaseline(live);
        live.fastRows = false;
        expect(() => saveConfigPreservingClaudeCode(live)).not.toThrow();
        const saved = loadConfig();
        const flags = saved.providers.relay!.codexPassthrough!;
        expect([...Object.entries(flags).filter(([key]) => key !== "localErrorPolicies").map(([, value]) => value),
          ...Object.values(flags.localErrorPolicies!)]).toEqual(Array(21).fill(false));
        expect(saved.fastRows).toBe(false);
        expect(saved.providers.other!.models).toEqual(["other-model"]);
      }
    } finally {
      warning.mockRestore();
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
      removeTreeWithRetry(home);
    }
  });
});
