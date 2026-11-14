---
title: Trendymen Fork extensions
description: Compatibility and maintenance differences from the rebased upstream release.
---

This appendix describes the Trendymen Fork's additions to upstream. The other reference pages retain upstream wording; the Fork configuration differences are in [Fork configuration](/reference/configuration/fork-extensions/).

## Compatibility changes

- Log details distinguish the client's initial Responses top-level effort from the last recognizable `configuration_update` in its initial input; the list's effort column follows upstream display. A continuation without a visible update or an unrecognized later update shows an unknown session value; hidden history is not inferred. This observation does not prove forwarding or upstream adoption. Later WebSocket frames may change settings and are outside the initial observation.
- Pool account identity rewriting escapes turn metadata characters above U+00FF before writing HTTP headers, preserving valid Latin-1 characters and JSON values. This avoids local header errors for metadata containing Chinese characters or emoji; account identity isolation still applies when compatibility processing is disabled.
- Native GPT subscription Responses requests have 23 provider-level processing permissions, all enabled by default. They cover request/response compatibility, generated headers and optional local errors, including Direct and Pool accounts. Existing feature conditions still apply; other destinations and translated ingress keep their behavior. See [GPT subscription processing](/reference/configuration/fork-extensions/#gpt-subscription-processing) for individual controls and retained recovery, budget and credential protections.
- Ark GLM/Kimi and BigModel GLM Responses routes lower unsupported tool schemas and handle assistant-prefill restrictions. Ordinary third-party tools drop ChatGPT-only `encrypted` annotations while preserving properties and literal values with that name. OpenAI-operated destinations and explicitly trusted direct relays retain the annotations; combo members do not inherit that direct-route exception.
- The OpenAI Chat, Google, Command Code, Anthropic, Kiro and Cursor adapters add progress guidance when their tool conditions are met. Some also add tool-discovery and patch-order guidance. The model catalog and native Responses do not add it automatically, and the model may not produce visible progress. Code-mode result-display and host guidance follow upstream behavior; the proxy does not synthesize progress or execute or retry patches.
- Declared nested `functions.exec` / `web__run` calls and supported `spawn_agent.fork_turns` completions receive bounded repair. Upstream routed custom-tool support remains in place; the Fork converts custom tool outputs to strings and merges safely matchable repeated `call_id` outputs for the strict Console Go destination. Current tool declarations remain the authority.
- Model-scoped native Responses phase inference includes ordinary JSON delivery alongside upstream's provider-scoped SSE option. Reasoning summary projection applies only to translated adapter responses when the client requests it. Native Responses preserve content-channel reasoning in SSE, JSON and stored replay.
- Annotation instructions use bare chip directives. Output repair preserves code blocks, but it is not gated by this turn's annotation count and does not handle multiline code spans; native forwarding receives the input rewrite only when its permission allows it.
- With the corresponding processing permissions enabled, SSE flush and terminal handling preserve usable upstream errors and one final `[DONE]`. Canonical forwarding bridges the Lite header only when building an upstream WebSocket frame, with an explicit HTTP value taking precedence over same-name metadata. HTTP request metadata stays unchanged.
- Ark quota errors retain the provider's message and reset time while preventing automatic retry. BigModel Codex discovery accepts `models[].slug`.

## Recovery and maintenance

The optional model API listener keeps a loopback management service separate from a LAN data endpoint on port `10100`. It reuses native model routes and credentials, rejects management and pairing on the auxiliary endpoint, and reports actual listener state through a verified local management read. It defaults to off and topology changes require a restart. See [Model API listener](/reference/configuration/fork-extensions/#model-api-listener) for both supported topologies and the native primary-mode boundary.

Encrypted task recovery adds strict backend-envelope handling, one bounded native replay after exhausted transient-5xx retries, and a ciphertext-free notice when an admitted parent `MESSAGE` times out. Unreadable ciphertext is terminal; it is not forwarded to ordinary third-party routes or stored in continuation state. Recovery remains opt-in.

The Fork provides disk diagnostics, independent text-sample controls, and `install:local` package/service/Volta rollback. `ben.N` versions compare the upstream core first and the Fork revision second; a stable release of the same core does not overwrite the Fork. Published tags remain immutable.

Development and release candidates use `dev`. A published build is identified by its immutable Fork tag and formal GitHub Release. Release validation uses the upstream workflow's complete `workflow_dispatch` run on the exact `dev` commit; it does not depend on a `main` push run.

Standalone web search's provider flag, real backend-ciphertext recovery, and Windows global replacement/service recovery still need implementation-bound end-to-end acceptance. The official tests do not establish those results.
