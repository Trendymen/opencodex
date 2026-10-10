---
title: Trendymen Fork extensions
description: Compatibility and maintenance differences from the rebased upstream release.
---

This appendix describes the Trendymen Fork relative to upstream `v2.81.0`. The other reference pages retain upstream wording; the Fork configuration differences are in [Fork configuration](/reference/configuration/fork-extensions/).

## Compatibility changes

- Ark GLM/Kimi and BigModel GLM Responses routes lower unsupported tool schemas and handle assistant-prefill restrictions. Ordinary third-party tools drop ChatGPT-only `encrypted` annotations while preserving properties and literal values with that name. OpenAI-operated destinations and explicitly trusted direct relays retain the annotations; combo members do not inherit that direct-route exception.
- Third-party tool tasks receive progress, code-mode result-display and patch-order guidance. The proxy does not synthesize progress or execute or retry patches.
- Declared nested `functions.exec` / `web__run` calls and supported `spawn_agent.fork_turns` completions receive bounded repair. Custom tool outputs become strings; Console Go's strict destination deduplicates repeated call outputs. Current tool declarations remain the authority.
- Native Responses phase inference and content-channel reasoning summary projection cover paths outside the upstream bridge. Summary projection requires an explicit client summary request, preserves raw fields, and keeps passthrough continuation aligned with the delivered response.
- Annotation instructions use bare chip directives. Output repair preserves code blocks, but it is not gated by this turn's annotation count and does not handle multiline code spans; native forwarding only receives the input rewrite.
- SSE flush and terminal handling preserve usable upstream errors and one final `[DONE]`. Canonical forwarding copies a true Lite header into missing WebSocket metadata without replacing explicit values.
- Ark quota errors retain the provider's message and reset time while preventing automatic retry. BigModel Codex discovery accepts `models[].slug`; the legacy `deepseek-v4-flash` alias can receive images directly unless operator configuration still excludes it.

## Recovery and maintenance

Encrypted task recovery adds strict backend-envelope handling, one bounded native replay after exhausted transient-5xx retries, and a ciphertext-free notice when an admitted parent `MESSAGE` times out. Unreadable ciphertext is terminal; it is not forwarded to ordinary third-party routes or stored in continuation state. Recovery remains opt-in.

The Fork provides disk diagnostics, independent text-sample controls, and `install:local` package/service/Volta rollback. `ben.N` versions compare the upstream core first and the Fork revision second; a stable release of the same core does not overwrite the Fork. Published tags remain immutable.

Standalone web search's provider flag, real backend-ciphertext recovery, and Windows global replacement/service recovery still need implementation-bound end-to-end acceptance. Synthetic tests do not establish those results.
