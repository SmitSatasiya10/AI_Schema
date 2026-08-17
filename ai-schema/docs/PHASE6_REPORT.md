# Phase 6 — Validation Extension — Report

Scope executed: **Phase 6 only**, per `AI_THEME_BUILDER_PHASE6_PLAN.md` and `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). No later phase (merge-based apply, structured operations, targeted editing, redesign, undo/redo, PostgreSQL, Next.js/DaisyUI/Base UI, preview) was started.

---

## Objective

Close the concrete, previously-documented validation gaps from Phases 1–5 (`AUDIT.md`, `test/validateOutput.test.js`'s "KNOWN GAP" tests) without redesigning generation, without touching schemas, and without weakening any existing check:

- `allowed_on`-vs-target-template was never enforced against actual candidates.
- Setting *values* (enums, numeric ranges, checkboxes) were never checked — only structural shape (type membership, `allowed_blocks`, `max_blocks`, `block_order`, image-hallucination).
- `product_picker`/`collection` settings had no hallucination guard, unlike `image`/`image_picker` — the exact gap that let a real committed artifact contain `"product": "signature-vegan-chicken"`.
- Neither generation path had a bounded repair loop for these checks; the legacy (non-staged) path had **no repair loop for anything** — any invalid output threw straight to `process.exit(1)`.
- A `GenerationPlan` validated against a `FULL_FALLBACK` retrieval pool (unfiltered by `allowed_on`) could approve a section incompatible with the target template.

## Existing Validation (Phases 1–5, preserved unchanged)

- `validateOutput()` (`example-implementation.js`) — section/block type membership, `allowed_blocks`, `max_blocks`, `block_order` consistency, image/image_picker hallucination guard. **Zero lines changed.** All 15 of its existing tests (`test/validateOutput.test.js`), including both "KNOWN GAP" tests, still pass with their original assertions — the gaps they document are closed by a *new* layer, not by rewriting the function they characterize.
- `validateGenerationPlan()` / `matchesPlan()` (`generation.js`) — retrieved-candidate-set enforcement, block-in-section/`max_blocks` checks, plan-conformance drift detection, product-template forced exclusivity. Preserved; `validateGenerationPlan()` gained one additive check (below).
- `buildThemeState()` / `validateThemeState()` (`theme-state.js`) — structural ThemeState validation, unknown-component preservation. Unchanged.

## New Validation Layers

All new logic lives in **`validation.js`**, a pure, deterministic module (§27 — no AI call anywhere in it) that assumes its input already passed `validateOutput()`. It never re-implements a check `validateOutput()` already owns.

```
Configuration Generation
     │
     ▼
validateOutput()            Phase 1, unchanged — structural baseline
     │ (only reached if valid)
     ▼
validateCandidate()         Phase 6 — validation.js:
     │                        validateAllowedOn()      allowed_on vs. template
     │                        validateSettings()       enum/range/checkbox/unknown-key
     │                        validateDataReferences()  product/collection hallucination
     │                        validateThemeCompatibility()  informational ThemeState boundary
     ▼
Final Candidate
```

- **`validateAllowedOn(config, schemas, templateName)`** — for every section actually used, checks `sectionSchema.allowed_on` includes `templateName`, reusing `retrieval.js`'s own `isEligibleForTemplate()` (newly exported, zero logic change) so "missing/empty `allowed_on` == unrestricted" has exactly one definition in the codebase, not two interpretations.
- **`validateSettings(config, schemas)`** — walks every section's and block's `settings` object (via a shared `walkSettings()` helper, so the section/block iteration itself isn't duplicated across validators) and, for each key actually present:
  - rejects it outright if the schema doesn't define that key at all (`SETTING_UNKNOWN` — "AI-generated setting not supported by schema → reject", §13);
  - otherwise validates the value against the schema's own shape (see "Settings Validation" below).
- **`validateDataReferences(config, schemas, { knownMerchantData })`** — the same walk, filtered to `product_picker`/`collection` settings: empty is always safe (mirrors the existing image guard's "blank is fine" rule); a non-empty value must appear in `knownMerchantData.products`/`.collections` or it's rejected as hallucinated.
- **`validateThemeCompatibility(themeState, templateName)`** — a read-only boundary check (§20/§21): confirms the `ThemeState` being generated against is itself structurally valid and surfaces how many of the target template's current sections are unknown to the AI schema catalog — **as warnings only, never errors**. It does not merge, diff, or enforce "preserve everything," since Phase 5's own generation contract legitimately allows a fresh homepage structure (§21 explicitly warns against inventing a stricter rule than that).
- **`validateCandidate(config, schemas, context)`** — the orchestrator: runs all of the above and merges their findings into one structured result. This is the single function both generation paths call.

## `allowed_on`

Actual schema semantics (confirmed against all 16 section schemas, `retrieval.js`'s existing `isEligibleForTemplate()`, and `SCHEMA_CREATION_GUIDE.md`): `allowed_on` is a flat array of template-name strings (e.g. `["index", "product", "page"]`); a missing or empty array means *unrestricted* (no current schema is actually missing it, so this is a defensive default, not an observed case). `validateAllowedOn()` enforces exactly this, on the **final candidate** — the first place `allowed_on` is checked against real generated output rather than only used to narrow retrieval *before* generation.

**Concrete gap this closes (found by inspection, confirmed by test):** `retrieval.js`'s `FULL_FALLBACK` mode returns the *entire unfiltered* schema catalog (its own comment: "FULL_SCHEMA_MODE, identical to pre-Phase-2 behavior") — so a `GenerationPlan` validated against a fallback pool could previously select `main-product` (`allowed_on: ["product"]` only) for an `index` template and `validateGenerationPlan()` would accept it, because "is this type in the retrieved pool" was the only check. `validateGenerationPlan()` now additionally requires `isEligibleForTemplate(sectionSchema, templateName)` for every plan section — reusing, not reinterpreting, the eligibility rule (`test/phase6Regression.test.js`: "GAP CLOSED: a FULL_FALLBACK-style retrieved pool ... no longer lets a template-incompatible section through"). The legacy (non-staged) path has no plan step at all, so `validateCandidate()`'s `validateAllowedOn()` is the only enforcement point there — verified directly (`test/validation.test.js`).

## Settings Validation

The schema convention (confirmed across all 69 real schema files, documented in `SCHEMA_CREATION_GUIDE.md`) has exactly three setting-definition shapes, and `validateSettingValue()` dispatches on all three:

| Shape | Example (real schema) | What's validated |
|---|---|---|
| string type name | `"title": "inline_richtext"` | Free-form text/richtext/color/url/etc. types (§16 — no content-pattern policing, only a JS `typeof === 'string'` check, so ordinary merchant copy is never rejected). `image`/`image_picker` are intentionally skipped here (already fully covered by `validateOutput()`); `product_picker`/`collection` are handled by `validateDataReferences()`, not here. |
| array | `"auto_rotate": ["true", "false"]` | Value must be one of the listed literal option strings (`SETTING_INVALID_OPTION` otherwise). |
| object | `"columns_desktop": {"type":"range","min":1,"max":10,"default":4}` | `checkbox` requires a real JS boolean (a `"true"` string is rejected — `SETTING_INVALID_TYPE`); `number`/`range` require a JS number within `min`/`max` when declared (`SETTING_OUT_OF_RANGE`); `select` (documented by the schema guide, not yet used by any real schema) validates against `options[].value`; other object types (`text`, `richtext`) fall back to the same free-form string check. |

**What can't be validated today, and why:** no schema file declares a `required: true` flag at the setting-definition level (the string `"required"` only ever appears as a setting *name*, e.g. `blocks/textarea.json`'s own `required` boolean-enum field, confirmed by grep across all 69 files) — so "required setting missing" has no real schema data to validate against and isn't implemented (§12: "do not invent validation rules"). No current schema uses the `select` object type, so that path is implemented per the documented convention but has no real-schema test coverage (see "Known limitations").

## Merchant Data References

`validateDataReferences()` mirrors the existing, accepted `image`/`image_picker` guard exactly: empty string is always safe; a non-empty `product_picker`/`collection` value must be present in an explicit `knownMerchantData.{products,collections}` list passed by the caller. **No product/collection catalog integration exists in this repository** (that's Phase 13 in `AI_THEME_BUILDER_PHASE_PLAN.md`) — until one does, `knownMerchantData` defaults to `{}`, so **any** non-empty value is rejected, same safe-by-default posture the image guard already established. This directly closes the exact gap `AUDIT.md` documents (a real committed artifact containing `"product": "signature-vegan-chicken"`) — reproduced as a test fixture and confirmed rejected (`test/validation.test.js`), while `test/validateOutput.test.js`'s original "KNOWN GAP" test is left completely untouched (it correctly still documents that `validateOutput()` itself, unchanged, doesn't catch this — the new layer does).

## Template / Section / Block Compatibility

- **Template compatibility** — `validateAllowedOn()` above.
- **Section compatibility** — already correctly separated before Phase 6 and unchanged: `validateOutput()` rejects an AI-generated section type unknown to the schema catalog; `theme-state.js`'s `classifyTemplate()` marks an *existing* live-theme section unknown to the catalog as `knownToAI: false` and preserves it untouched. No new code was needed for this distinction — it already existed correctly.
- **Block compatibility** — `allowed_blocks`/`max_blocks`/`block_order` are `validateOutput()`'s job, unchanged. No section schema declares a machine-readable `block_order` *sequence* constraint (confirmed by inspection — "typical order" only ever appears as prose in `_notes`, e.g. `main-product.json`), so there is no schema data to validate a specific block ordering against beyond what `validateOutput()` already checks (block_order/blocks consistency).

## Validation Result Contract

```js
{
  valid: false,
  errors: [
    { code: "SECTION_NOT_ALLOWED_ON_TEMPLATE", path: "sections.main-1", message: "..." },
    { code: "SETTING_UNKNOWN", path: "sections.main-1.settings.totally_bogus", message: "..." }
  ],
  warnings: [
    { code: "THEME_STATE_UNKNOWN_COMPONENTS", path: "themeState.templates.index", message: "..." }
  ]
}
```

Six stable codes total (`ERROR_CODES` in `validation.js`): `SECTION_NOT_ALLOWED_ON_TEMPLATE`, `SETTING_UNKNOWN`, `SETTING_INVALID_TYPE`, `SETTING_INVALID_OPTION`, `SETTING_OUT_OF_RANGE`, `DATA_REFERENCE_HALLUCINATED` — deliberately small (§22), each carrying a `path` into the candidate and a human-readable `message` usable directly in a repair prompt.

## Repair Behavior

Both generation paths fold `validateCandidate()`'s result into the **same single bounded-repair loop** Phase 5 already established for the staged path (§24 — "preserve this architecture"), rather than adding a second, separate repair round:

- **Staged path** (`generation.js` `runConfigurationStage`) — its existing `validate()` closure now also runs `validateCandidate()` after `validateOutput()`/`matchesPlan()` succeed; a failure at any of the three layers feeds the same one bounded repair call.
- **Legacy path** (`1-generate-theme.js`) — previously had **zero** repair attempts (any `validateOutput()` failure threw immediately). It now mirrors the staged path's exact pattern: one AI call → `validateOutput()` + `validateCandidate()` → if invalid, one repair call with errors appended to the prompt → validate again → throw if still invalid. This is the minimal, tested compatibility change `AI_THEME_BUILDER_PHASE_PLAN.md`'s own Phase 6 description calls for ("replace 1-generate-theme.js's throw-and-exit ... with a capped repair loop").

Verified by test (`test/phase6Regression.test.js`): exactly one repair attempt on failure, never a third; a first-try-valid candidate is completely unaffected (identical AI-call count to pre-Phase-6 behavior); a candidate still invalid after repair throws with the structured error codes in the message, never silently passes.

## Measurements

Real, from the test run (`node --test`, all 171 tests, 478ms total):

| | |
|---|---:|
| New error codes | 6 |
| New validator functions (`validation.js`) | 8 exported |
| `validateCandidate()` typical duration (measured via `instrumentation.logCandidateValidation`) | <1ms (deterministic, no I/O beyond in-memory schema maps) |
| Repair attempts observed in tests | exactly 0 or 1, never 2 (bounded, as designed) |
| Repair success rate in tests | 100% when the repaired output is actually valid; failure path correctly throws when it isn't |
| Candidate chars logged alongside each validation event | via `instrumentation.logCandidateValidation`'s `candidateChars` field |

## Tests

**171 tests total, all passing** — every prior phase's suite (135, byte-identical, zero files touched) plus:

- **`test/validation.test.js`** (27 tests) — `getSettingKind()`'s three-shape normalization; `validateAllowedOn()` accept/reject/reject-unknown-type-is-skipped, both directions (main-product on index vs. product); `validateSettingValue()` per shape (enum, range/number with min/max, checkbox boolean-strictness, free-form string type-only checks, image/product_picker/collection intentionally skipped, undefined-is-always-fine); `validateSettings()` accept/reject-unknown-key/reject-invalid-enum/block-level validation/unknown-type-no-findings; `validateDataReferences()` accept-blank/reject-hallucinated (the exact AUDIT.md artifact shape)/accept-known/reject-wrong-list; `validateThemeCompatibility()` against both `null` and the **real** live ThemeState (never blocks); `validateCandidate()` end-to-end accept, both "GAP CLOSED" demonstrations (hallucinated product, `allowed_on`), multi-layer aggregation (not fail-fast), default templateName.
- **`test/phase6Regression.test.js`** (9 tests) — the `FULL_FALLBACK` `allowed_on` gap fix (both a rejection and a non-regression case), `runConfigurationStage()` folding Phase 6 checks into the existing bounded repair loop (repair success and repair-still-invalid-throws, both with exact call-count assertions), the legacy path's brand-new repair loop (repair success, repair-still-invalid-throws, first-try-valid unaffected, live-theme isolation).

## Real theme test

`validateThemeCompatibility()` is tested directly against the **real** `buildThemeState()` output (24 templates, 85 sections, 258 blocks, 39 unknown sections — same numbers as `PHASE4_REPORT.md`), confirming it never returns `valid: false` for the live theme's actual unknown-component mix. `git status -- templates/ config/` (the live theme root, one level above `ai-schema/`) shows **zero changes** after the full test run — only the pre-existing disposable `ai-schema/output/` scratch directory was touched (same as every prior phase's test suite).

## Known Limitations

- **`select` object-type settings have code but no real-schema test coverage.** No current section/block schema uses `{"type": "select", "options": [...]}` (confirmed by grep across all 69 files) — `validateSettingValue()` implements it per `SCHEMA_CREATION_GUIDE.md`'s documented convention (zero cost, no schema invented to test it — §30/§32), but it's unexercised by real data today.
- **No "required setting" validation.** No schema declares a required-setting flag at the definition level; `required` only ever appears as a setting *name* (form-input blocks). Nothing to validate against, so nothing was invented.
- **No machine-readable `block_order` *sequence* constraint exists in any schema** — "typical order" is prose in `_notes` only. `validateOutput()`'s existing `block_order` consistency check (every listed block exists, every block is listed) is the full extent of what's checkable today.
- **`validateDataReferences()` rejects ALL non-empty product/collection handles until Phase 13 lands a real catalog** — this is the same safe-by-default posture as the pre-existing image guard, not a new gap; it means legitimate handles can never be accepted yet, only correctly deferred/left blank.
- **`validateThemeCompatibility()` is intentionally non-blocking/informational only** — per §20/§21, this phase does not implement merge/apply or a "preserve everything" rule, since Phase 5's generation contract legitimately allows a fresh homepage structure. A stricter compatibility contract, if ever wanted, belongs to Phase 7 (merge-based apply), which needs to know exactly what "preserve" means for a real merge — this phase deliberately does not pre-empt that decision.
- **Repair prompts reference structured error codes/messages but the underlying AI call is still a single JSON-mode turn** — no per-error-code specialized repair strategy exists; all errors are appended to one prompt, matching the existing bounded-repair architecture.

## Definition of Done

- [x] Validation architecture is layered and deterministic (`validation.js`: 5 focused functions + 1 orchestrator, no AI call).
- [x] Existing `validateOutput()` behavior remains safe — unmodified, all 15 original tests pass with original assertions.
- [x] `allowed_on` is enforced according to real schema semantics (both the `GenerationPlan` layer and the final-candidate layer).
- [x] Template compatibility is validated.
- [x] Section compatibility is validated (pre-existing correct behavior confirmed, not re-implemented).
- [x] Block compatibility is validated (pre-existing, `validateOutput()`, unchanged).
- [x] `allowed_blocks` remains enforced.
- [x] `max_blocks` remains enforced.
- [x] `block_order` is validated where applicable (no schema-declared sequence exists beyond consistency, documented).
- [x] Settings are validated where actual schema metadata supports it (enum/range/checkbox).
- [x] Unsupported AI-generated settings are rejected (`SETTING_UNKNOWN`).
- [x] Unknown existing theme settings remain preserved (this layer never reads/writes `settings_data.json`; `ThemeState`'s existing passthrough already guarantees this).
- [x] Product/collection hallucinated references are prevented where deterministically possible.
- [x] Existing image safety remains intact (untouched, `validateOutput()`).
- [x] `GenerationPlan` is validated against the retrieved candidate boundary, now including `allowed_on`.
- [x] Stage 2 remains conformant to `GenerationPlan` (`matchesPlan()` untouched).
- [x] `ThemeState` compatibility checks exist where justified (informational boundary, §20/§21).
- [x] Structured validation results with stable error codes exist.
- [x] Errors and warnings are distinguished correctly.
- [x] Repair uses bounded retries only (exactly one, both paths, tested).
- [x] No silent invalid-output correction occurs (repair re-asks the AI; nothing is auto-mutated by this code).
- [x] Validation itself requires no AI call.
- [x] Real measurements/instrumentation are added (`instrumentation.logCandidateValidation`).
- [x] Phase 1–5 tests pass (135, unchanged).
- [x] Phase 6 tests pass (36 new).
- [x] Live theme files remain untouched (verified via `git status`).
- [x] No schema expansion is introduced.
- [x] No merge/apply functionality is introduced.
- [x] No PostgreSQL/UI functionality is introduced.
- [x] No Phase 7+ functionality is implemented.

**STOP.** Per the phase plan's strict stop condition, Phase 7 (Merge/Apply Safety) and everything after it is out of scope for this change and was not started.
