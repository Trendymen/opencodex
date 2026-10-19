import { expect, test } from "bun:test";
import { createCodexPassthroughFixture } from "../helpers/codex-passthrough-fixture";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { recordCodexUpstreamOutcome, getCodexQuotaHealthSnapshot, clearCodexUpstreamHealth, resolveCodexAccountForThread, resolveCodexAccountForThreadDetailed, previewCodexAccountForRequest, codexQuotaScopeForModel } from "../../src/codex/routing";
import { setAccountHealth, getAccountHealth } from "../../src/codex/routing/health-store";
import { bindThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { loadConfig } from "../../src/config";
import { updateAccountQuota, setAccountQuotaFromParsed, parseUsageQuota } from "../../src/codex/quota";
import { captureMainQuotaWriter } from "../../src/codex/main-account-cache";
import { ACCOUNT, ACCESS } from "../helpers/reserve-ingress-fixture";
import { resolveCodexAuthContext, codexPoolAffinityKey, CodexRecoveryWithheldError } from "../../src/codex/auth-context";
import { sharedPoolBackpressure } from "../../src/routing/probe-lease";

const input = { model: "gpt-5.6-sol", input: "synthetic", stream: false };
const accountId = "pool-soft-fixture";
const token = fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "soft-fixture-account" } });

async function cooledPool(precheck: boolean, configure?: (config: OcxConfig) => void, expectedBearer = token) {
  let config!: OcxConfig;
  const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(value) {
    config = value; value.activeCodexAccountId = undefined; value.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
    value.codexAccounts = [{ id: accountId, isMain: false, chatgptAccountId: "soft-fixture-account" }];
    value.providers.openai!.codexPassthrough = { localErrorPolicies: { accountSoftPrecheck: precheck } };
    saveCodexAccountCredential(accountId, { accessToken: token, refreshToken: "synthetic-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId: "soft-fixture-account" });
    configure?.(value);
  }, upstream: async request => { expect(request.headers.get("authorization")).toBe(`Bearer ${expectedBearer}`);
    return Response.json({ error: { code: "invalid_prompt", message: "upstream retained" } }, { status: 400 }); } });
  recordCodexUpstreamOutcome(config, accountId, 429, { retryAfter: "60", now: Date.now() });
  return { ...fixture, config };
}

test("pool_without_active_can_send_when_only_cached_cooldown_blocks_candidates", async () => {
  for (const precheck of [true, false]) {
    const fixture = await cooledPool(precheck);
    const before = getCodexQuotaHealthSnapshot(accountId);
    expect(before).not.toBeNull();
    try { const response = await fixture.request(input); const text = await response.text();
      if (precheck) { expect(response.status).not.toBe(400); expect(fixture.seen.length).toBe(0); }
      else { expect(response.status).toBe(400); expect(text).toContain("upstream retained"); expect(fixture.seen.length).toBe(1); }
      expect(getCodexQuotaHealthSnapshot(accountId)).toEqual(before);
      expect(loadConfig().activeCodexAccountId).toBeUndefined();
    } finally { await fixture.close(); }
  }
});

test("restoring the default permission leaves cached cooldown intact for the next request", async () => {
  const clientFetch = globalThis.fetch;
  const fixture = await cooledPool(false); const before = getCodexQuotaHealthSnapshot(accountId);
  try {
    const allowed = await fixture.request(input); expect(allowed.status).toBe(400); await allowed.text(); expect(fixture.seen.length).toBe(1);
    const update = await clientFetch(`${fixture.publicBase}/api/providers?name=openai`, { method: "PATCH",
      headers: { authorization: `Bearer ${process.env.OPENCODEX_ADMIN_AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ codexPassthrough: { localErrorPolicies: { accountSoftPrecheck: null } } }) });
    expect(update.status).toBe(200); await update.text();
    expect(getCodexQuotaHealthSnapshot(accountId)).toEqual(before);
    const blocked = await fixture.request(input); expect(blocked.status).not.toBe(400); await blocked.text(); expect(fixture.seen.length).toBe(1);
    expect(loadConfig().providers.openai!.codexPassthrough?.localErrorPolicies?.accountSoftPrecheck).toBeUndefined();
  } finally { await fixture.close(); }
});

test("an available alternate keeps legacy routing while the off permission can serve the cooled active account", async () => {
  const alternateToken = fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "soft-alternate-account" } });
  for (const precheck of [true, false]) {
    const fixture = await cooledPool(precheck, config => {
      config.activeCodexAccountId = accountId;
      config.codexAccounts!.push({ id: "pool-soft-alternate", isMain: false, chatgptAccountId: "soft-alternate-account" });
      saveCodexAccountCredential("pool-soft-alternate", { accessToken: alternateToken, refreshToken: "synthetic-alt-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId: "soft-alternate-account" });
      updateAccountQuota(accountId, 10); updateAccountQuota("pool-soft-alternate", 20);
    }, precheck ? alternateToken : token);
    try { const response = await fixture.request(input); expect(response.status).toBe(400); await response.text(); expect(fixture.seen.length).toBe(1); }
    finally { await fixture.close(); }
  }
});

test("main_and_exact_bound_pool_share_soft_precheck_permission", async () => {
  for (const bound of [false, true]) for (const precheck of [true, false]) {
    let config!: OcxConfig;
    const fixture = await createCodexPassthroughFixture({ mode: "pool", configure(value) { config = value;
      value.providers.openai!.codexPassthrough = { localErrorPolicies: { accountSoftPrecheck: precheck } };
    }, upstream: async () => Response.json({ error: { code: "invalid_prompt", message: "upstream main retained" } }, { status: 400 }) });
    recordCodexUpstreamOutcome(config, MAIN_CODEX_ACCOUNT_ID, 429, { retryAfter: "60", now: Date.now() });
    const before = getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID);
    try { const response = await fixture.request({ ...input, ...(bound ? { model: `main/${input.model}` } : {}) }); await response.text();
      expect(response.status).toBe(precheck ? 429 : 400); expect(fixture.seen.length).toBe(precheck ? 0 : 1);
      expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID)).toEqual(before);
    } finally { await fixture.close(); }
  }
});

test("exact-bound pool shares the soft precheck permission", async () => {
  for (const precheck of [true, false]) {
    const fixture = await cooledPool(precheck, config => { config.codexAccountNamespaces = { ...config.codexAccountNamespaces, soft: accountId }; });
    try { const response = await fixture.request({ ...input, model: "soft/gpt-5.6-sol" }); await response.text();
      expect(response.status).toBe(precheck ? 429 : 400); expect(fixture.seen.length).toBe(precheck ? 0 : 1);
    } finally { await fixture.close(); }
  }
});

test("soft precheck cannot override an explicit account pause", async () => {
  const fixture = await cooledPool(false, config => { config.pausedCodexAccountIds!.push(accountId); });
  try { const response = await fixture.request(input); expect(response.ok).toBe(false); await response.text(); expect(fixture.seen.length).toBe(0); }
  finally { await fixture.close(); }
});

test("soft_precheck_does_not_disable_credits_or_withheld", async () => {
  const fixture = await cooledPool(false, config => {
    config.codexAccountNamespaces = { ...config.codexAccountNamespaces, soft: accountId };
    config.codexAccounts![0]!.plan = "pro"; config.creditCodexAccountIds = [];
  });
  updateAccountQuota(accountId, 100, Date.now() + 3_600_000);
  setAccountQuotaFromParsed(accountId, { credits: { hasCredits: true, balance: 42.5, observedAt: Date.now() } });
  try { const response = await fixture.request({ ...input, model: `soft/${input.model}` }); expect(response.status).toBe(429);
    expect(await response.text()).toContain("credits"); expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

for (const hardLock of [false, true]) test(`main credits and hard lock remain authoritative (${hardLock})`, async () => {
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(config) {
    config.codexMainAccountHardLock = hardLock; config.creditCodexAccountIds = [];
    config.providers.openai!.codexPassthrough = { localErrorPolicies: { accountSoftPrecheck: false, transportErrorMapping: false } };
  }, upstream: async () => Response.json({ status: "completed", output: [] }) });
  const quota = parseUsageQuota({ plan_type: "pro", rate_limit: { allowed: false, primary_window: {
    used_percent: 100, limit_window_seconds: 604_800, reset_at: Date.now() + 3_600_000,
  } }, credits: { has_credits: true, balance: "42.5", overage_limit_reached: false } });
  setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, quota, undefined, captureMainQuotaWriter(ACCOUNT)!);
  try { const response = await fixture.request(input); expect(response.status).toBe(429); expect(await response.text()).not.toBe("Bad Gateway");
    expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

test("the real recovery-window refusal is preserved when the ordinary quota precheck is off", async () => {
  const ids = [accountId, "pool-soft-two", "pool-soft-three"];
  const fixture = await cooledPool(false, config => {
    config.activeCodexAccountId = accountId; config.upstreamFailoverThreshold = 3;
    for (const id of ids.slice(1)) { config.codexAccounts!.push({ id, isMain: false, chatgptAccountId: "soft-fixture-account" });
      saveCodexAccountCredential(id, { accessToken: token, refreshToken: "synthetic-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId: "soft-fixture-account" }); }
  });
  try {
    clearCodexUpstreamHealth();
    const headers = new Headers({ "session-id": "soft-withheld-fixture", "thread-id": "soft-withheld-thread" });
    const affinity = codexPoolAffinityKey(headers); expect(affinity).toBeString();
    const now = Date.now(); const quotaScope = codexQuotaScopeForModel(input.model);
    expect(ids).toContain(resolveCodexAccountForThread(affinity, fixture.config, now, quotaScope));
    for (const id of ids) for (let i = 0; i < 3; i++) recordCodexUpstreamOutcome(fixture.config, id, 503, { now, quotaScope });
    const limiter = sharedPoolBackpressure(); let spent = 0;
    while (spent < 16 && limiter.tryPermitProbeDispatch(now)) spent++;
    expect(spent).toBe(3);
    await expect(resolveCodexAuthContext(headers, fixture.config, "pool", { modelId: input.model, skipOrdinaryCachedQuotaPrecheck: true,
      primeCodexPoolQuotas: async () => {}, isMainAccountTokenLive: () => false })).rejects.toBeInstanceOf(CodexRecoveryWithheldError);
    const response = await fixture.request(input, headers); expect(response.status).toBe(429); expect(await response.text()).not.toBe("Bad Gateway");
    expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

test("mixed cached quota and transient failure cannot use an ordinary active fallback", async () => {
  const fixture = await cooledPool(false, config => { config.activeCodexAccountId = accountId; config.upstreamFailoverThreshold = 3; });
  const now = Date.now();
  for (let i = 0; i < 3; i++) recordCodexUpstreamOutcome(fixture.config, accountId, 503, { now });
  try {
    expect(getCodexQuotaHealthSnapshot(accountId)).not.toBeNull();
    const response = await fixture.request(input); await response.text();
    expect(response.ok).toBe(false); expect(response.status).not.toBe(400); expect(fixture.seen.length).toBe(0);
  } finally { await fixture.close(); }
});

test("mixed quota and transient affinity keeps the recovery limiter and binding", async () => {
  const fixture = await cooledPool(false, config => { config.activeCodexAccountId = accountId; config.upstreamFailoverThreshold = 3; });
  const headers = new Headers({ "session-id": "mixed-health-session", "thread-id": "mixed-health-thread" });
  const affinity = codexPoolAffinityKey(headers)!; const now = Date.now(); const scope = codexQuotaScopeForModel(input.model);
  bindThreadAffinity(affinity, accountId, now, scope);
  for (let i = 0; i < 3; i++) recordCodexUpstreamOutcome(fixture.config, accountId, 503, { now, quotaScope: scope });
  let permits = 0; const limiter = sharedPoolBackpressure();
  while (permits < 16 && limiter.tryPermitProbeDispatch(now)) permits++;
  try {
    expect(permits).toBe(3); expect(getCodexQuotaHealthSnapshot(accountId, scope)).not.toBeNull();
    await expect(resolveCodexAuthContext(headers, fixture.config, "pool", { modelId: input.model, skipOrdinaryCachedQuotaPrecheck: true,
      primeCodexPoolQuotas: async () => {}, isMainAccountTokenLive: () => false })).rejects.toBeInstanceOf(CodexRecoveryWithheldError);
    const response = await fixture.request(input, headers); expect(response.status).toBe(429); await response.text();
    expect(fixture.seen.length).toBe(0); expect(getThreadAffinity(affinity, scope)?.accountId).toBe(accountId);
  } finally { await fixture.close(); }
});

test("quota-refused affinity has the same preview and final account with a legal alternate", async () => {
  const alternate = "preview-soft-alternate";
  const fixture = await cooledPool(false, config => {
    config.activeCodexAccountId = alternate;
    config.codexAccounts!.push({ id: alternate, isMain: false, chatgptAccountId: "preview-soft-account" });
    saveCodexAccountCredential(alternate, { accessToken: token, refreshToken: "synthetic-alternate-refresh", expiresAt: 4_000_000_000_000, chatgptAccountId: "preview-soft-account" });
    updateAccountQuota(accountId, 10); updateAccountQuota(alternate, 20);
  });
  const now = Date.now(); const scope = codexQuotaScopeForModel(input.model); const key = "quota-preview-fixture";
  const options = { skipOrdinaryCachedQuotaPrecheck: true, isMainAccountTokenLive: () => false };
  bindThreadAffinity(key, accountId, now, scope);
  try {
    const preview = previewCodexAccountForRequest(key, fixture.config, now, scope, options, input.model);
    const final = resolveCodexAccountForThreadDetailed(key, fixture.config, now, scope, options, input.model);
    expect(final.status).toBe("selected"); expect(final.status === "selected" && final.accountId).toBe(accountId);
    expect(preview).toBe(accountId); expect(getThreadAffinity(key, scope)?.accountId).toBe(accountId);
  } finally { await fixture.close(); }
});

test("Direct caller skips the Pool-only main health check when the ordinary quota policy is off", async () => {
  let config!: OcxConfig;
  const fixture = await createCodexPassthroughFixture({ mode: "direct", configure(value) { config = value; },
    upstream: async () => Response.json({ status: "completed", output: [] }) });
  const health = { consecutiveFailures: 1, lastFailureAt: Date.now(), credentialFailureGeneration: 123 };
  setAccountHealth(MAIN_CODEX_ACCOUNT_ID, health);
  try {
    await resolveCodexAuthContext(new Headers({ authorization: `Bearer ${ACCESS}` }), config, "direct", {
      modelId: input.model, skipOrdinaryCachedQuotaPrecheck: true,
    });
    expect(getAccountHealth(MAIN_CODEX_ACCOUNT_ID)).toEqual(health);
  } finally { await fixture.close(); }
});
