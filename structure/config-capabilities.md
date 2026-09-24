# Config Capabilities

`src/types.ts` owns the shared provider and model capability types used by this contract.

## Explicit per-model capability declarations

`modelCapabilities` on `src/types/provider.ts` stores exact model-ID entries with optional inputModalities, contextTier and video.processing axes. `src/config/provider-validation.ts` strictly validates writes and merges PATCH axes without sharing live objects; null map/model/axis/processing tombstones delete, while empty PATCH objects do nothing. Complete POST/PUT replacements reject tombstones. File reads retain valid axes; malformed explicit modalities restrict to text with a diagnostic. The two catalog writers receive explicit config and gather fingerprints include the map. This storage contract alone does not activate a context tier, advertise a larger window or enable video processing.

The text-only consumer reads exact inputModalities declarations before legacy hints. CLI add/edit `--text-only` targets one model and preserves sibling declarations; `src/vision/eligibility.ts` routes declared text-only models into existing image-description or explicit-omission handling. Positive routed image declarations override stale candidate metadata, while native catalog authority retains its existing legacy policy.

An explicit custom row is the operator's own definition of one routed model, so its
`customModels[].inputModalities` outranks the provider-level vision hints
(`noVisionModels`, `modelInputModalities`) for that exact `provider`/`modelId` identity.
`modelCapabilities` keeps the top slot as the dedicated capability axis, including for the
`ocx provider edit --text-only` write. The catalog overlay in
`src/codex/catalog/routed-gather.ts` copies that declaration onto the advertised row directly,
and the request-path predicates in `src/vision/eligibility.ts` and `src/vision/plan.ts` read the
same field through `customRowInputModalities`, so an advertised row and the dispatch decision can
no longer disagree about one model. A custom row that declares no modalities stays silent rather
than becoming a text-only claim.

Every consumer that answers "can this model take an image" applies one rule to the declaration:
image is absent from the list. A row declaring only `audio` or `video` therefore counts as
image-incapable in both `requiresVisionPreprocessing` and `modelAcceptsImageInput`, rather than
being treated as a text model by one and an image target by the other.
