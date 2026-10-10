---
title: Fork configuration
description: Provider, recovery, custom-model and diagnostic controls added by the Trendymen Fork.
---

These settings supplement upstream `v2.81.0`. Compatibility behavior is described in [Fork extensions](/reference/fork-extensions/).

## Provider settings

| Field | Fork behavior |
| --- | --- |
| `agentMessageFormat` | `preserve` retains native messages; `user_message` converts complete readable text/media at third-party Responses destinations, including third-party GPT models. OpenAI-operated destinations always preserve native format. Unset keeps destination-specific defaults; ciphertext, unknown parts and empty content are not partially converted. |
| `inferResponsesMessagePhaseModels` | Exact model IDs opted into native Responses phase inference. Official destinations and GPT/OpenAI model families are excluded. Opening announcements that claim `final_answer` are demoted to `commentary`; final item/terminal evidence determines the final phase. Failed or incomplete turns do not gain a synthetic final phase. |
| `defaultMaxOutputTokens`, `modelMaxOutputTokens` | Existing output defaults also fill omitted `max_output_tokens` on key-auth Responses. Model settings win over provider defaults; caller values win over both. Forward authentication receives no injected value. |

With a valid window and more than 512 estimated tokens remaining, the injected budget is `max(512, min(configured, remaining - headroom))`, with 256–4,096 tokens of headroom. Without that window or with no more than 512 remaining tokens, the configured value is retained so the upstream can reject overflow explicitly.

`agentMessageFormat` and `inferResponsesMessagePhaseModels` use config or the management API. An omitted POST field retains the latest value; PATCH `null` clears it. `agentMessageFormat` POST `null` is rejected. Explicit format conversion preserves identities and the original request/replay objects.

The `opencode-go` preset defaults `preserveResponsesReasoningContent` to `true` only when absent; explicit `false` wins. The refusal sample motivating it came from DeepSeek. Other Responses models on that provider have not all been validated with retained replay.

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
