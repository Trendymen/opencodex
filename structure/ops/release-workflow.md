# Release Workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build. `scripts/release.ts` accepts either an explicit version or
`--bump patch|minor|major`; the stable and preview channels use separate resolvers in
`scripts/version-line.ts`. It runs local typecheck, `bun test --isolate tests`, and
`bun run privacy:scan` before the version bump, commit/push, Cross-platform CI wait, and GitHub
Release workflow dispatch. Docs publishing is separate from npm release publishing.

The version lives in four files, and every path that moves it moves all four:
`package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the
`opencodex-desktop` entry of `desktop/src-tauri/Cargo.lock`. The desktop build reads its version
from the Tauri and Cargo files (the widget plist inherits it) while the updater manifest is derived
from the dispatch input, so a `package.json`-only move ships an app that reports the previous
version under a manifest naming the new one, and the updater re-offers that release forever.
`scripts/release-version-sources.ts` owns the list and the one-line rewrite of each file.
`scripts/release.ts` and `scripts/bump-dev-version.ts` rewrite through it, `release.yml` runs its
`check` in `preflight` and `package-desktop` before anything is built and again in `publish`, and
`dev-version-bump.yml` stages exactly those four paths and refuses a reused bump branch that
touches anything else. `tests/ci-workflows/release-version-sources.test.ts` fails on drift in the
working tree and pins that wiring.

The `package-standalone` job in `.github/workflows/release.yml` also builds Bun compiled
`ocx` archives for Linux, macOS, and Windows, bundles `gui/dist`, smoke-tests `/healthz`, and
publishes SHA-256 sidecars for the attach job. Each archive also carries the target-matching
`@napi-rs/keyring` native addon under `keyring/`; the macOS release installs both optional Darwin
packages so its separate arm64 and x64 builds cannot silently reuse the hosted runner's
architecture. Desktop preparation copies those same pinned assets into Tauri resources. The loader
and packaged-app proof are owned by the [desktop keyring contract](../desktop-shell.md#packaged-native-keyring-binding).

Opening a release starts with the `dev` pre-move. Dispatch
`.github/workflows/dev-version-bump.yml` with the intended version, merge the pull request it opens,
then promote and release. A no-op is valid when `dev` already outranks the target. `release.yml`
independently enforces that readiness condition and refuses publication if the pre-move is missing.
The design and repair history live in `devlog/_fin/260904_release_version_line/`.

Opening a preview for the next core ends the current patch line. After
`vX.Y.0-preview.*` is tagged, a fix ships as part of `X.Y.0`, not as
`X.(Y-1).(Z+1)`. `nextStableRelease` refuses such a patch bump, and the release workflow's global
ordering gate prevents an explicit lower version from bypassing the resolver. This is a deliberate
policy restriction, not preservation of an unused capability: at the design audit, 103 of 143 stable
tags had `patch > 0`, and history includes `v2.6.24-preview.20260705` followed by `v2.6.23` and
`v2.7.39-preview.20260724` followed by `v2.7.37`. Reopening parallel patch lines would require a
separate channel-aware invariant and release-note baseline design.

### Release notes

The release workflow invokes `scripts/build-release-changelog.ts`, which builds notes from
the actual Git range and uses generated PR notes as enrichment. Its categorized summaries
contain one bullet per PR or direct commit, followed by `## Changelog` entries retaining PR
titles and authors or sanitized direct-commit text. A comparison baseline adds a compare link.
Preview notes are incremental; stable notes cover the range since the previous stable tag.
The standalone `scripts/release-notes.ts render` command retains its separate scope-grouped
summary and carried-preview rendering behavior.

Both renderers strip the exact leading `[WRONG BRANCH]` marker followed by one ASCII space
from PR summary bullets and full-changelog titles. Other bracketed text is preserved.
Summary bullets remove conventional commit prefixes; PR changelog entries keep those prefixes,
PR numbers, and author attribution. This normalization does not change category selection,
direct-commit coverage, or PR-target enforcement.

The deterministic renderer produces the structure but not curated prose. Maintainers who want
the OpenAI-style grouped summaries can run the optional local polish step against the rendered
body (needs an OpenAI-compatible API key):

```bash
bun scripts/release-notes.ts render ... --out notes.md
bun scripts/release-notes.ts polish --in notes.md --out notes.md
```

`polish` rewrites only the category sections, keeps the machine-rendered Changelog verbatim,
and fails closed when the rewrite drops, invents, or re-heads any PR reference. It is never
called from CI — there is no LLM credential on the runner — so the workflow ships the
deterministic body whenever the maintainer skips it.

## Release metadata invariants

Every npm release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` and the desktop version sources | `version` in `package.json`, `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the `opencodex-desktop` entry of `desktop/src-tauri/Cargo.lock` equals the release workflow `version` input. |
| npm registry | `@bitkyc08/opencodex@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

Fresh publication refuses an existing npm version, Git tag or GitHub Release. An explicit
resume skips npm publication only after the official registry returns a scalar, full-length
`gitHead` exactly matching the audited `GITHUB_SHA`. `scripts/verify-release-resume.ts` validates
that metadata; the publication step also requires the preflight's matching output before it
acknowledges publication. Missing, malformed, unavailable or mismatched identity refuses resume.
This checks registry source metadata, not cryptographic provenance. Fresh publication retains
the existing OIDC trusted-publishing path.

Two ordering checks run before publication. The version on `origin/dev` must strictly outrank the
release target, proving the pre-move has landed. After a fresh tag fetch, the release target must also
outrank the global release-tag set. The only equality exception is a dry run whose existing tag points
at the exact `GITHUB_SHA`; a real publish never receives that exception.

Do not force-move public version tags by default. If release metadata is already inconsistent, treat
the version as consumed and publish the next unused patch version instead. Only rewrite a public tag
after an explicit human decision that the public history rewrite is acceptable.

Manual preflight checks when debugging a release:

```bash
npm view @bitkyc08/opencodex@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

If any of these commands reports an existing artifact for the requested version, stop fresh
publication. A previously acknowledged npm publication may use the explicit same-commit resume
path above; it never republishes npm. Otherwise choose the next unused version that outranks the
global tag set and release it through `scripts/release.ts`. A patch is not available once a higher-core
preview has closed that stable patch line.

Cross-platform CI test lanes and release proof live in [Cross-platform CI](cross-platform-ci.md).

## Remote Hub locale and release gate

The Remote Hub guide describes the
[status credential binding](../runtime.md#remote-hub-status-credential-binding)
and its matching-cache or `unavailable` result.

The Remote Hub guide and affected CLI, server-config, management-API, and dashboard references have eight sources: root English plus `fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, and `tr`. English is canonical; commands, defaults, endpoint auth, and warnings remain exact in translations. A release requires the remote-only focused/full gates, privacy scan, GUI/docs builds, protocol compatibility receipts, and the MAINTAINERS security review for the exact head.

Codex display-cache expiry, retained blocking main-policy evidence, and reset history follow the
[quota cache contract](../providers/openai-tiers.md#quota-cache-and-short-window-history).

The account CLI and translated Codex integration guides follow the [automatic plan exclusion contract](../providers/openai-accounts.md#automatic-pool-plan-exclusions), including all-excluded pools and explicit routes.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

The shared atomic replacement publisher also identifies explicit Remote Workspace file writes as `remote-workspace`; its isolated owner and support limits are documented in [Remote Workspace](../remote-workspace.md).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
The Combo guides describe the distinction between display quota and single-credential inference evidence used by routing. See [scoped provider quota](../runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Provider configuration documents distinguish actual summaries from raw reasoning content. The test layout registers the summary-default contract cases and removes the obsolete content-rewrite test with its implementation.

Paginated and migration-capable history follows the [authoritative writer contract](../codex-home.md#paginated-history-writer-boundary); this document adds no independent writer guarantee.

Private pool credential metadata follows the [quota-history publication identity contract](../providers/openai-accounts.md#quota-history-publication-identity); credential-only and account DTO projections omit it.

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback, preserved affinity, strategy-specific threshold summaries, and shared short-observation freshness for switch warnings.

Hub/browser pairing instructions distinguish machine enrollment, session authentication, permission denial and network failure. The hosted dashboard preview is the render artifact used to review these states.
The integrations guide documents Cline CLI as a two-file, loopback-only integration. Hosted CI validates its source-backed fixtures; the packaged dashboard exposes it through the existing client list.
The lightweight top-level CLI help counts Cline CLI among the fifteen registered export clients; registry parity remains covered by the client help and integration tests.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

The account history response can include a [low-confidence effective capacity estimate](../providers/openai-accounts.md#observed-effective-token-capacity); usage normalization retains local-answer provenance so local responses cannot supply samples.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached, rejects inputs above the safe decoded-pixel ceiling, caps native decode work process-wide, and stops queued work when the request is cancelled.

OpenCode launcher verification distinguishes the local management catalog request from the inference child. Its transport regressions cover proxy environment, redirects, endpoint validation, credential precedence and child-env separation on hosted CI.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Exact [model input declarations](../config.md#explicit-per-model-capability-declarations) now feed text-only eligibility and catalog hints; existing image-description/omission handling consumes them before the main upstream send.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](../catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

The public server configuration reference documents the optional
[compaction routing override](../transports/responses-failover.md#compaction-routing-overrides). Its regression file is registered in both test-layout inventories.

Catalog synchronization follows the [reasoning metadata refresh contract](../catalog.md#reasoning-metadata-refresh).

Bun updater ownership and recovery follow the [service transaction contract](service-and-sidecars.md#bun-updater-ownership-transaction).

Linux release bundling enables Tauri verbosity on the primary attempt so linuxdeploy diagnostics remain visible. macOS signing verbosity and publication/signature gates are unchanged.

Universal macOS release builds install both aarch64-apple-darwin and x86_64-apple-darwin Rust targets. Windows builds consume the private JSON override generated by `desktop/scripts/windows-installer-config.ts`: only WiX ProductVersion uses the validated numeric public version core. Public package/application versions, tags, asset names and updater manifests retain full SemVer. The pinned Tauri MSI template permits equal-core replacement; manual MSI installation does not enforce same-core preview/stable downgrade prevention.
The existing `codex-routing`, `codex-auth-context` and `codex-quota-prime` tests cover [priority failback](../providers/openai-accounts.md#ongoing-priority-failback), including cache-default retention, stale evidence, main fencing and failed-attempt cadence.
