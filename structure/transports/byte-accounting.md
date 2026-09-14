# Byte Accounting

Responses body-reader limits and lifetime handling follow the
[core module ownership](responses.md#core-module-ownership). This surface retains its existing behavior.

How opencodex measures request and stream bytes without allocating copies solely to count
them. These contracts are shared by request parsing, SSE rewriting, the provider adapters and
the translator budget, which is why so many documents link here rather than restating them.

## Request-copy accounting

`src/server/request-decompress.ts` observes the UTF-8 sizes of decoded text and reserialized JSON
without allocating encoded byte arrays solely to count them. Parsed-body accounting still uses
`JSON.stringify(parsed)`: numeric normalization can make it larger than the input text. These
observations retain the existing ownership and release lifecycle and do not consume the translator's
hard byte cap. Admission limits, parsing, compression, and error envelopes are unchanged.
`tests/usage/request-decompress.test.ts` covers exact accounting across codecs and Unicode/numeric
normalization, UTF-8 counting without encoded copies, and release after malformed or optional empty input.

## Stream-buffer accounting

`src/server/sse-payload-rewrite.ts` shares an incremental block buffer with native Chat. It scans
only new input, counts consumed blocks rather than remaining suffixes, and preserves LF/CRLF,
partial-event, injection/drop, and EOF behavior. Output admission precedes its single UTF-8 encoding;
failed enqueue and cancellation release the reservation without re-entering a disposed rewrite.
Old/new buffer overlap remains charged against the same translator cap.

`src/adapters/openai-responses.ts` counts new compaction fragments, including surrogate pairs formed
across deltas, while retaining snapshot/done/delta precedence and existing terminal ownership.
Serialized request and buffered-response observations use byte counts without measurement arrays.
The same rule applies to Anthropic, Google, and Chat response accounting; serialization itself is
preserved where the existing metric is the serialized JSON size.

`src/lib/translator-budget.ts` admits an event batch atomically from per-event serialized byte sizes
plus exact separators, without joining a second full JSON array. `src/lib/admission.ts` counts and
truncates diagnostic text at UTF-8 code-point boundaries without allocating arrays per character;
byte sizing retains TextEncoder's coercion behavior for legacy non-string runtime callers.
These optimizations do not add request queues, retry policies, or RSS-based admission gates.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

`src/server/responses-reasoning-summary-rewrite.ts` 使用 `Set<number>` 去重，每个保留的整数序号
按 32 字节计入官方 `translatorBudget`，不另设 256 个序号或 256 KiB 配额。
客户端与 replay projection 共用调用方预算；独立调用在需要时创建默认 32 MiB 预算。
终态、`flush` 和 `dispose` 释放序号记账，只销毁 rewrite 自建的预算，不销毁调用方预算。
