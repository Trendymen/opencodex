---
title: Fork configuration
description: Provider, recovery, custom-model and diagnostic controls added by the Trendymen Fork.
---

These settings supplement upstream `v2.84.0`. Compatibility behavior is described in [Fork extensions](/reference/fork-extensions/).

## Provider settings

| Field | Fork behavior |
| --- | --- |
| `agentMessageFormat` | `preserve` retains native messages; `user_message` converts complete readable text/media at third-party Responses destinations, including third-party GPT models. OpenAI-operated destinations always preserve native format. Unset keeps destination-specific defaults; ciphertext, unknown parts and empty content are not partially converted. |
| `inferResponsesMessagePhaseModels` | Exact model IDs opted into native Responses phase inference. Official destinations and GPT/OpenAI model families are excluded. Opening announcements that claim `final_answer` are demoted to `commentary`; final item/terminal evidence determines the final phase. Failed or incomplete turns do not gain a synthetic final phase. |
| `defaultMaxOutputTokens`, `modelMaxOutputTokens` | Existing output defaults also fill omitted `max_output_tokens` on key-auth Responses. Model settings win over provider defaults; caller values win over both. Forward authentication receives no injected value. |

With a valid window and more than 512 estimated tokens remaining, the injected budget is `max(512, min(configured, remaining - headroom))`, with 256–4,096 tokens of headroom. Without that window or with no more than 512 remaining tokens, the configured value is retained so the upstream can reject overflow explicitly.

`agentMessageFormat` and `inferResponsesMessagePhaseModels` use config or the management API. An omitted POST field retains the latest value; PATCH `null` clears it. `agentMessageFormat` POST `null` is rejected. Explicit format conversion preserves identities and the original request/replay objects.

The `opencode-go` preset defaults `preserveResponsesReasoningContent` to `true` only when absent; explicit `false` wins. The refusal sample motivating it came from DeepSeek. Other Responses models on that provider have not all been validated with retained replay.

## GPT subscription processing

`providers.<name>.codexPassthrough` controls 21 compatibility operations. Every permission defaults to `true`, including `normalizeEncryptedContent`. An omitted object, `{}`, and all 21 values set to `true` retain the previous behavior. A permission does not enable an otherwise disabled feature: request pacing, task recovery, reset retries, upstream WebSocket transport and skills still require their existing settings and conditions.

The permissions apply only when the final destination uses `openai-responses`, `authMode: "forward"`, and the normalized base URL `https://chatgpt.com/backend-api/codex`, with native Responses ingress over HTTP, SSE or WebSocket. This includes Direct main login and Pool main/added accounts. Provider renaming and model-level adapter selection do not change that test. Key authentication, third-party GPT providers, other models on other destinations, and Chat Completions or Anthropic ingress retain their existing behavior. Each fallback destination is checked separately.

In the dashboard, open the provider's settings and expand **Official GPT subscription processing**. The four groups below support enabling or disabling individual permissions and disabling all permissions. Saving affects the next request or WebSocket turn; an in-progress turn and its fallback attempts retain their captured permissions. Account credential revocation keeps its existing behavior.

The paths in these tables are relative to `codexPassthrough`. All defaults are `true`.

### Request

| Field | Operation permitted when enabled |
| --- | --- |
| `normalizeRequestParameters` | Existing official-backend parameter cleanup, defaults and forced streaming where previously required. |
| `expandRequestHistory` | Expand saved continuation history for `previous_response_id`. |
| `normalizeEncryptedContent` | Existing encrypted-content normalization; task-recovery failure handling remains separate. |
| `snapshotSkillsCatalog` | Apply the skills-catalog snapshot when the existing skills settings require it. |
| `rewriteAnnotationInstructions` | Rewrite recognized Codex annotation instructions to request bare directives. |
| `bridgeLiteMetadata` | Copy the recognized Lite header into missing request metadata without replacing explicit values. |

### Response

| Field | Operation permitted when enabled |
| --- | --- |
| `backfillResponseFields` | Fill missing response item IDs, message status and text annotations. |
| `repairResponseToolCalls` | Apply existing authorized tool-call repairs, with the original tool-map conditions. |
| `redactUpstreamErrors` | Apply general upstream-error redaction and normalization. Injected private credentials remain protected when this is off. |
| `privateSseReadDeadline` | Keep the fixed 5-second deadline for the first protected SSE output and incomplete blocks. When disabled, use `stallTimeoutSec` for stream inactivity and preserve cancellation, memory budgets and private-credential masking. |
| `synthesizeTerminalFailure` | Apply existing synthetic terminal-failure handling when no usable terminal event arrives. |
| `normalizeHostedImages` | Convert supported hosted-image results for the client and clean their display paths from subsequent input. |

### Headers

| Field | Operation permitted when enabled |
| --- | --- |
| `synthesizeRoutingHint` | Generate a missing `x-codex-routing-hint`. |
| `synthesizeSessionId` | Generate a missing `session_id`. |
| `addResponseRequestId` | Add OCX's `x-opencodex-request-id` response header. |
| `addResponseBrowserHeaders` | Add OCX's browser CORS/exposed-header fields. Disabling this can prevent cross-origin browser clients from reading responses. |

Disabling header synthesis does not delete explicit caller or provider headers. Authentication, selected-account identity, required HTTP/WebSocket framing and existing transport/security checks still apply.

### Local error policies

| Field | Behavior when disabled |
| --- | --- |
| `localErrorPolicies.resetReplayRefusal` | Do not emit the optional Codex replay-refusal explanation or its `x-should-retry: false` header. An ambiguous send still cannot be replayed; a required gateway failure remains 502 or 504. |
| `localErrorPolicies.requestPacingAdmission` | Bypass optional local request-pacing admission for this attempt. |
| `localErrorPolicies.inputAdmissionPrecheck` | Bypass the optional local input-size estimate precheck. Hard limits still apply. |
| `localErrorPolicies.accountSoftPrecheck` | Bypass ordinary cached quota/cooldown prechecks. Explicit pause, account locks, reauthentication, credit/reserve policies and other protected account decisions remain active. |
| `localErrorPolicies.transportErrorMapping` | Use a plain 502 `Bad Gateway` or 504 `Gateway Timeout` for local transport failures instead of the optional Codex error explanation. |

These settings do not suppress real upstream errors, including OpenAI 429 responses, or task-recovery conversion/decryption failures. Shared send budgets, authentication and identity checks remain enforced. Disabling a refusal or error mapping does not add proxy retries. Without the replay-refusal hint, the Codex client may retry under its own budget; if the upstream already processed the request, that can repeat work or consume more quota.

### Saving and clearing overrides

The configuration file and full JSON configuration accept boolean leaves. To restore a default there, remove the field. For example, this provider fragment disables annotation rewriting and the local soft quota precheck while leaving the other permissions at their defaults:

```json
{
  "codexPassthrough": {
    "rewriteAnnotationInstructions": false,
    "localErrorPolicies": {
      "accountSoftPrecheck": false
    }
  }
}
```

`PATCH /api/providers?name=<name>` merges only the supplied leaves under `codexPassthrough`. PATCH `null` removes an override: a leaf restores that leaf's default, `localErrorPolicies: null` clears that group, and `codexPassthrough: null` clears the whole object. GET returns stored overrides without materializing defaults. Do not use `null` in the configuration file or treat clearing as disabling.

To disable all permissions, use the dashboard action or set all 21 leaves to `false`:

```json
{
  "codexPassthrough": {
    "normalizeRequestParameters": false,
    "expandRequestHistory": false,
    "normalizeEncryptedContent": false,
    "snapshotSkillsCatalog": false,
    "rewriteAnnotationInstructions": false,
    "bridgeLiteMetadata": false,
    "backfillResponseFields": false,
    "repairResponseToolCalls": false,
    "redactUpstreamErrors": false,
    "privateSseReadDeadline": false,
    "synthesizeTerminalFailure": false,
    "normalizeHostedImages": false,
    "synthesizeRoutingHint": false,
    "synthesizeSessionId": false,
    "addResponseRequestId": false,
    "addResponseBrowserHeaders": false,
    "localErrorPolicies": {
      "resetReplayRefusal": false,
      "requestPacingAdmission": false,
      "inputAdmissionPrecheck": false,
      "accountSoftPrecheck": false,
      "transportErrorMapping": false
    }
  }
}
```

With all permissions off, request JSON values, field presence, unknown fields and array order are preserved, subject to explicit model/Fast routing, selected-account authentication and required transport rules. JSON can be serialized again. Responses are not guaranteed to be byte-identical when framing or private-credential protection is required. Client WebSocket error frames retain the complete upstream error body in `response` when error rewriting is disabled.

Private credentials actually injected by OCX remain protected before delivery, including Pool/stored-main credentials and sensitive configured header values. If safe delivery cannot be established, the proxy returns `upstream_error_protection_failed` before committing the response, or aborts an already committed stream. It does not invent a successful terminal event.

To remove only the fixed 5-second SSE deadline, set `codexPassthrough.privateSseReadDeadline` to `false` or clear **Private SSE fixed 5-second deadline** in the provider's response settings. This does not change the bounded HTTP error-body deadline or allow unsafe output. A longer wait can delay a failure; `stallTimeoutSec` and request cancellation still limit inactive streams.

Logs record private-protection failures with a `private-*` local error code and retain the original response-header status in `upstreamHttpStatus`, including per-attempt rows and persisted usage. The dashboard shows that status separately and labels the protection message as a local reason. For example, upstream HTTP 200 followed by a local deadline failure is recorded separately from the final 502. Historical rows without this field cannot recover the original status.

## Custom models and context caps

Custom-model types, CRUD and catalog rows already exist upstream. The Fork adds strict writes, per-row salvage, stable-ID concurrent merging and a known-field public projection. Unknown opaque fields remain internal. A custom row replacing a discovered row retains its discovered `pricingStatus`.

`customModels[].codexToolMode` supports `code_mode_only`, `shell`, or inheritance. Create omission inherits; update omission retains the stored value; update `null` clears it. The CLI uses `--tool-mode code_mode_only|shell|inherit`; this supplements the existing catalog consumer of the field.

Failed saves to `PUT /api/provider-context-caps` restore that route's live context-cap fields and pending deletions without refreshing the catalog. This guarantee does not extend to every configuration field. Provider registration publishes its draft only after saving; a `ConfigWritePublishedError` retains the already-published disk-consistent value.

## Encrypted task recovery

Recovery remains disabled by default and uses an additional authenticated ChatGPT request when enabled. This example enables recovery with the Fork's backend defaults:

```json
{
  "agentTaskRecovery": {
    "enabled": true,
    "model": "gpt-5.6-luna",
    "reasoningEffort": "medium",
    "timeoutMs": 120000,
    "maxRetries": 2,
    "retries": 0
  }
}
```

`timeoutMs` bounds each attempt; response first-byte/inactivity stalls remain capped at 45 seconds. `maxRetries` permits at most two further timeout attempts. The existing `retries` allowance handles transient HTTP/transport failures, is shared across timeout attempts, and stays within the attempt deadline. Cancellation and `invalid_encrypted_content` stop both paths.

Native transient-5xx recovery only admits a strict `NEW_TASK`, then replays the same selected target once using the shared send budget. Admitted encrypted parent `MESSAGE` timeouts can produce a ciphertext-free resend notice; it does not claim that the message was read. Strict ciphertext and recovered bodies are excluded from continuation storage.

## Diagnostics and local installation

Provider diagnostics are structural by default. Text artifacts require both provider debug and `provider-text`, available through CLI, API and dashboard:

```bash
ocx debug provider on
ocx debug provider-text on
ocx debug provider-text off
```

Journals and referenced artifacts share 4 MiB groups under UTC date/hour directories. The two roots retain at most seven days and 20 GiB of managed data; cleanup removes the oldest journal before its artifacts. Unsafe or unreadable unrelated entries remain outside that managed bound. Samples are redacted and limited per string/turn. Stop the proxy before manually removing both `provider-debug` and `provider-debug-artifacts`; removing artifacts alone breaks retained references.

`bun run install:local` is an explicitly requested local maintenance action. It stages and validates the dependency closure offline, synchronizes Volta and checks service readiness before committing replacement. On macOS it enables `OCX_DEBUG=1` and `OCX_PROVIDER_TEXT_DEBUG=1`; `--no-restart` writes service configuration to the on-disk plist without reloading the service. The font-stack patch remains, and the old scrolling CSS patch is retired.
