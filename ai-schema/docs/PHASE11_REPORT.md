# Phase 11 — Schema Coverage Expansion — Report

Scope executed: **Phase 11 only**, per `AI_THEME_BUILDER_PHASE11_PLAN.md` and `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). Phase 10 (Major Redesign Flow) remains intentionally deferred, per the plan's own status table. No Phase 12+ functionality (multi-page generation, product/collection catalog integration, image/asset generation, undo/version history, production persistence/UI, collaboration) was started.

---

## Objective

Expand how much of the **existing** Shopify theme the AI schema catalog actually describes, so Phase 8/9's targeted editing can reach more of what merchants already have — without inventing a new design system, generating Liquid/CSS/JS, or loosening validation to fake coverage. Before this phase, the AI schema catalog (`sections/*.json`, `blocks/*.json`) covered 16 of 86 real section Liquid files (18.6%) and a strict-file-match count of 41 of 80 real block Liquid files (51.25%) — most of the live theme was invisible to retrieval, operations, and conversational editing alike, even though those systems could already handle it generically the moment a schema existed.

## Baseline

Measured directly from the real theme root (`../sections/*.liquid`, `../blocks/*.liquid`) against the AI schema catalog (`sections/*.json`, `blocks/*.json`), via the new `coverage-report.js` tool built for this phase:

```text
Real section Liquid files:  86
AI section schemas:         16
Real block Liquid files:    80
AI block schemas:           53 (52 unique ids — pre-existing "row" duplicate, documented below)
Missing section schemas:    61 (with a real {% schema %} tag)
Missing block schemas:      ~39 (strict file-match; many real "missing" blocks are
                             actually already covered via inline schema.blocks
                             entries — see "Discovery Method")
```

## Discovery Method

`coverage-report.js` (new file) inspects the ACTUAL `{% schema %}` JSON inside every real `.liquid` file — not filenames alone, not the roadmap's historical counts. Two things it had to get right that weren't obvious going in:

1. **Real Shopify section/standalone-block schemas carry no internal `"id"`/`"type"` field.** Shopify identifies them by file basename (`sections/slideshow.liquid` → type `"slideshow"`) — only blocks defined INLINE inside a section's own `blocks` array carry a local `"type"`. `inventoryRealDefinitions()` uses the file basename as the real identity for exactly this reason.
2. **A large fraction of real block "types" have no standalone `.liquid` file at all** — they're declared entirely inline inside one section's own schema (`hotspot` only exists inside `shoppable-image.liquid`; `field_row` only inside `contact-form.liquid`; the pre-existing `row`/`accordion`/`email_form`/`paragraph`/`product`/`tab`/`textarea`/`tnc_checkbox` likewise). A naive "does a standalone file with this basename exist" check misclassifies every one of these as a "stale"/orphaned AI schema. `collectInlineBlockDeclarations()` + `mergeStandaloneAndInlineBlocks()` merge both real sources before comparing, so coverage is measured against every real block IDENTITY, not just real block FILES.

Setting counts used for prioritization exclude Shopify's UI-only `header`/`paragraph` schema entries (those are settings-panel section dividers, not configurable values).

## Prioritization

Per §8's ordered criteria — "sections/blocks actually present in live templates" ranks first — the primary signal was cross-referencing every real section `type` actually used across all 17 `templates/*.json` files against the AI catalog. That produced 27 used-but-uncovered section types, split cleanly into two groups:

- **16 are Shopify's own built-in structural "main-\*" sections** (`main-404`, `main-article`, `main-blog`, `main-cart-items`, `main-cart-footer`, `main-collection-banner`, `main-collection-product-grid`, `main-account`, `main-activate-account`, `main-addresses`, `main-login`, `main-order`, `main-register`, `main-reset-password`, `main-list-collections`, `main-search`) plus `main-page` — one-per-template render targets for cart/search/account/login/etc. with little to no merchant-configurable content (`main-page`, inspected directly, has exactly six padding settings and otherwise just renders `page.content`, Shopify's own dynamic data). **Deliberately deprioritized** — low content value, functional/structural rather than "content a merchant asks the AI to change."
- **The remaining 11 are genuine content sections**, each with real, curatable settings: `related-products`, `facebook-testimonials`, `custom-columns-new`, `rich-text`, `collapsible-content`, `track-order`, `email-signup-banner`, `shoppable-image`, `image-slider`, `colors-changer`, and `main-page` (excluded per above, leaving **10**). These are exactly what Phase 11 implemented.

This is a deterministic, evidence-based cut, not an arbitrary one: every added section has at least one real, current placement in this theme's own templates.

## Added Schemas

### Sections (10)

| id | source Liquid | category | tags | settings | allowed_blocks | allowed_on |
|---|---|---|---|---|---|---|
| `related-products` | `related-products.liquid` | product-showcase | related, recommendations | 10 | — (Shopify's own recommendation engine, no picker) | product |
| `facebook-testimonials` | `facebook-testimonials.liquid` | social-proof | facebook, testimonial, reviews | 8 | column | index, product, page |
| `custom-columns-new` | `custom-columns-new.liquid` | layout-structural | columns, layout | 6 | column | index, product, page |
| `rich-text` | `rich-text.liquid` | content | text | 5 | heading, caption, rating-stars, trustpilot-stars, text, button, atc-button, container | index, product, page |
| `collapsible-content` | `collapsible-content.liquid` | content | expandable, faq | 7 | collapsible-row-content | index, product, page |
| `track-order` | `track-order.liquid` | form-input | order-tracking | 6 | — | page |
| `email-signup-banner` | `email-signup-banner.liquid` | conversion | email, signup, newsletter | 6 | heading, paragraph, email_form | index, password |
| `shoppable-image` | `shoppable-image.liquid` | product-showcase | shoppable, hotspot | 7 | hotspot | product |
| `image-slider` | `image-slider.liquid` | media | slider, gallery | 7 | image_slide, video_slide | index, product, page |
| `colors-changer` | `colors-changer.liquid` | misc | colors, theme-settings | 9 (all `color`) | — | index, product, page |

### Blocks (5 new + 1 corrected)

| id | source | category | settings | notes |
|---|---|---|---|---|
| `container` | `container.liquid` (standalone) | layout-structural | 6 | Nested block-in-block containment (27 real nestable types) not representable — `allowed_blocks` only exists on sections in this catalog's format; documented, not faked |
| `collapsible-row-content` | `collapsible-row-content.liquid` (standalone) | content | 4 | Distinct from the pre-existing `collapsible-row` block (a different real file) |
| `hotspot` | inline, inside `shoppable-image.liquid` | product-showcase | 5 | `product` setting uses the protected `product_picker` type, fully covered by Phase 6's hallucination guard |
| `image_slide` | inline, inside `image-slider.liquid` | media | 5 | `desc_alignment`'s "Left" option is the literal empty string in real Shopify data — preserved verbatim, not renamed to `"left"` |
| `video_slide` | inline, inside `image-slider.liquid` | media | 7 | Real schema has ~15 more decorative play-button/timeline styling settings, curated out |
| `field_row` *(was `input_row`)* | inline, inside `contact-form.liquid` | form-input | 8 | **Correction**, see below |

### Correction: `input_row` → `field_row`

`blocks/input_row.json` predates Phase 11 and was **stale in both id and content** — a coverage-report finding, not a Phase 11 invention: the real block referenced by `contact-form.liquid` is `field_row` (a row of up to two independently-typed inputs), not `input_row`, and the real settings shape (`input_1_enabled`/`input_1_type`/`input_1_required`/`input_1_custom_name`, `input_2_*`) bears no resemblance to the old schema's generic single `label`/`field_type`/`required`/`placeholder`. Per §5 ("correct missing/stale metadata if necessary"), this was fixed as a surgical, documented correction: `blocks/input_row.json` removed, `blocks/field_row.json` added with the real setting shape, `sections/contact-form.json`'s `allowed_blocks` updated to reference the corrected id, and the one test (`test/retrieval.test.js`) that referenced the old id by name updated to match.

## Fidelity Verification

Every setting in every added/corrected schema was checked against the real `{% schema %}` JSON, not assumed from the section's apparent purpose (§4). Concretely:

- Every `select`/enum setting's option VALUES (not just labels) were extracted from the real schema and copied verbatim — an early draft of `collapsible-content` used invented values (`"image-first"`, `"chevron"`) that didn't match Shopify's real ones (`"image_first"`, `"carret"`); caught and corrected during this phase, now covered by a regression test.
- `image_slide`/`video_slide`'s `desc_alignment` preserves Shopify's real (unusual) empty-string `"left"` option rather than "cleaning it up" to the word `"left"`.
- Every genuinely-boolean setting uses the established `["true","false"]` array convention (validated as a real enum by Phase 6) rather than the bare-string `"checkbox"` form that several PRE-EXISTING schemas use — that form is never actually validated as boolean by `validateSettingValue()` (confirmed by reading it directly: an unrecognized bare type-name string returns `[]`, i.e. accepts anything). Using the safer, already-precedented array form for every NEW schema was a deliberate choice, not an oversight.
- `hotspot.product` uses `product_picker` (the catalog's established safe type name for a Shopify `"type": "product"` setting), not a raw, unprotected `"product"` string — confirmed against how the pre-existing `blocks/product.json` already does this.
- `collapsible-row-content`'s real schema also has a `page` (linked-page reference) setting, deliberately omitted: Phase 6's `validateDataReferences()` only guards `product_picker`/`collection` against hallucination, not `page` — representing it now would mean either an unprotected reference field or expanding Phase 6 validation, both explicitly out of Phase 11's scope (§22: "do not expand scope... document it as unsupported and defer").
- `container`'s real schema declares its own nested `blocks` list (27 types) — not representable, since `allowed_blocks` only exists on sections in this catalog's format; documented in the schema's own `_notes`, not silently dropped.

Every added/corrected schema's full sample-settings set (every declared setting, one plausible value each) was run through `validateSettings()`/`validateDataReferences()` directly and validates cleanly (`test/phase11Schemas.test.js`).

## Coverage

| | Before | After |
|---|---|---|
| Section schemas | 16 | 26 |
| Section coverage (of 86 real files) | 18.6% | 30.2% |
| Block schemas (files) | 53 (52 unique ids) | 58 (57 unique ids) |
| Block coverage (standalone + inline real identities) | 41 | 56 |
| Real block identities (standalone + inline) | ~120 | 130 |

`coverage-report.js`'s real-repo integration tests lock in every one of these numbers directly against the live repository (not hardcoded expectations divorced from reality) — a genuine regression (a schema accidentally deleted, an id typo reintroduced) fails the test suite, not just this document.

## Capability Index

No change to `capability-index.js` was needed — confirmed by inspection before writing anything (matching every other phase's own governance discipline). `buildCapabilityIndex(schemas)` derives everything from whatever `sectionSchemas`/`blockSchemas` arrays `loadSchemas()` hands it; adding new `.json` files to `sections/`/`blocks/` is automatically picked up on the next `loadSchemas()` call (itself unchanged — file lists are `readdir()` + sort + parse, with no hardcoded filename list anywhere). Verified directly: `buildCapabilityIndex()` against the full post-Phase-11 catalog reports `sectionCount: 26, blockCount: 58` with zero duplicate-id warnings for sections and the same single, already-documented `"row"` block collision as before — no new collisions introduced.

## Retrieval

No change to `retrieval.js`/`retrieval-rules.json` was needed either — confirmed the same way. Retrieval matches purely on `category`/`tags` (a closed taxonomy) plus `allowed_on`, all read directly off each schema file; there is no hardcoded section/block id list anywhere in the retrieval path (the one exception, `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE = { product: 'main-product' }`, is a narrow, pre-existing, deliberate rule unrelated to catalog growth). Representative example (`test/phase11Schemas.test.js`):

```text
Prompt: "Add Facebook testimonials and an email signup banner to my homepage"
Template: index
→ 16 of 26 sections selected, including BOTH new sections
→ their allowed blocks (column, email_form) came along automatically
→ unrelated new sections (track-order, colors-changer, related-products) correctly excluded
```

`related-products` (allowed_on: `["product"]` only) is confirmed NEVER retrieved for the `index` template, regardless of prompt wording — template-scope restriction holds exactly as declared.

## Token / Cost Measurements

```text
Full catalog (26 sections + 58 blocks):  53,970 chars  (~13,493 tokens)
Full catalog before Phase 11 (16 + 53):  41,525 chars  (~10,382 tokens)
Growth: +30%
```

Representative retrieval scenarios against the GROWN catalog:

| Prompt | Template | Sections | Blocks | Retrieved size | % of full |
|---|---|---|---|---|---|
| "Add Facebook testimonials and an email signup banner to my homepage" | index | 16 | 27 | 23,034 chars (~5,759 tok) | 43% |
| "Create a homepage for a pet wellness store" | index | 15 | 27 | 22,583 chars (~5,646 tok) | 42% |
| "Add a shoppable image to my product page" | product | 1 | 36 | 24,573 chars (~6,144 tok) | 46% |

The full catalog grew 30%, but retrieval for representative requests still selects well under half of it — Phase 2's selectivity architecture continues to do its job at the larger catalog size; growth in coverage did not undo the token-cost improvement Phase 2 established. The full-load fallback (`loadSchemas()` with no `retrieval` option, and `retrieveRelevantSchemas()`'s own below-floor fallback) both remain exercised and passing exactly as before.

## Validation

Every added/corrected schema was run through Phase 6's actual validators, unmodified:

- `validateSettings()` — full sample-settings sets for all 10 sections + 6 blocks validate cleanly; an invalid enum value and an unknown setting key are both correctly rejected.
- `validateDataReferences()` — a hallucinated product handle on the new `hotspot` block's `product_picker` setting is rejected by the exact same guard every other `product_picker` setting already uses (zero new code); a genuinely known handle is accepted.
- No Phase 6 validator source was touched. One genuine representability gap was found (`collapsible-row-content`'s real `page` setting) and deliberately left unrepresented rather than either weakening validation or scope-creeping into extending it (§22).

## Operations

Phase 8's `operations.js`/`edit-pipeline.js` needed and received **zero changes** for new schemas to become editable — confirmed directly, not just by architectural argument:

- `resolveSectionTarget()`/`resolveBlockTarget()` resolve a newly-covered section/block (`collapsible-content`/`hotspot`) exactly the same way they resolve a pre-existing one (`slideshow`) — same function, same code path.
- `validateOperation()` + `applyOperationToThemeState()` correctly propose, validate, and execute an `update_section` against a newly-covered section and an `add_block` against a newly-covered block type.
- `add_block` for a real, valid block schema (`hotspot`) is correctly REJECTED when attempted against a section that doesn't declare it in `allowed_blocks` (tried against `slideshow`) — the `allowed_blocks` relationship enforcement Phase 8 already had works identically for new schemas.
- A full `runTargetedEdit()` end-to-end call (mocked AI) against a newly-covered section+block resolves, proposes, validates, and executes correctly with the exact same code Phase 8 shipped.

## Conversational Editing

Phase 9's `conversational-edit.js` also needed zero changes — it's built entirely on top of the operations/edit-pipeline machinery just verified above. Confirmed directly:

- An ambiguous newly-covered target (two `collapsible-content` sections) still triggers `NEEDS_CLARIFICATION` rather than being guessed.
- A full multi-turn conversation against a newly-covered section+block (`shoppable-image`/`hotspot`) — resolve, propose, apply, then a plain "it" follow-up — resolves to the same target on the second turn without re-asking, exactly like Phase 9's existing scenarios for pre-existing schemas.

## Unsupported Capabilities

Documented explicitly here, per §34 (nothing silently omitted — the full machine-readable version is `coverage-report.js`'s own output, exercised directly by its test suite):

- **16 Shopify built-in structural "main-\*" sections** (`main-404`, `main-article`, `main-blog`, `main-cart-items`, `main-cart-footer`, `main-collection-banner`, `main-collection-product-grid`, `main-account`, `main-activate-account`, `main-addresses`, `main-login`, `main-order`, `main-register`, `main-reset-password`, `main-list-collections`, `main-search`) plus `main-page` — real, safely representable (some have genuine settings), but deliberately deprioritized: functional/structural, one-per-template, minimal merchant content value. Future phase if ever needed: same mechanism as this phase, just lower priority.
- **7 real section Liquid files have no `{% schema %}` tag at all** (`cart-icon-bubble.liquid`, `cart-live-region-text.liquid`, `cart-notification-button.liquid`, `cart-notification-product.liquid`, `main-404.liquid`, `pickup-availability.liquid`, `predictive-search.liquid`) — cart/search helper snippets rendered via `{% section %}` with no configurable settings surface. Not applicable, not a gap.
- **`main-product`'s own `allowed_blocks` list references 8 block ids with no AI schema** (`reviews`, `product_complementary`, `product_emoji-benefits`, `product_popup`, `product_scroll-buttons`, `product_sku`, `product_upsell-block--product-info`, `product_view-details`) — a pre-existing gap on an ALREADY-covered section, surfaced by this phase's `findMissingReferencedBlocks()` but not fixed here: secondary-priority (the section itself remains fully editable via its already-supported blocks), deferred to a future coverage pass.
- **`container`'s real nested-block containment** (27 types it can host) is not representable — `allowed_blocks` only exists on sections in this catalog's format today. The container's own settings are fully covered; what can be nested inside it is not.
- **`collapsible-row-content`'s real `page` (linked-page) setting** is not representable without either an unprotected reference field or extending Phase 6's hallucination guard beyond `product_picker`/`collection` — deferred, not faked.
- **35 further real sections (of the 51 total unsupported — the other 16 are the already-discussed used-but-deprioritized "main-\*" ones) and the bulk of the remaining 71 unsupported blocks have no live-template usage at all** — lowest priority by this phase's own evidence-based ranking (§8), not present in any real `templates/*.json` today.

## Determinism

`coverage-report.js` sorts every directory listing before use (`inventoryRealDefinitions()`/`inventoryAISchemas()`, both via `listFiles()`) — the same discipline `example-implementation.js`'s `loadAllSchemasFromDisk()` already established for exactly the same reason (a duplicate id's resolution must not depend on OS filesystem order). A dedicated test runs `buildCoverageReport()` twice against the same repo state and asserts byte-identical summary/supported/blocks output.

## Tests

**373 tests total, all passing** — every prior phase's suite (326, unchanged — see the 2 test fixes below) plus 47 new:

- **`test/coverageReport.test.js`** (23 tests) — `extractSchemaBlock()` (well-formed, missing tag, malformed JSON, Shopify's `{%- -%}` whitespace-control variant); `inventoryRealDefinitions()`/`inventoryAISchemas()` (fixture-based, id-from-basename, no-schema-tag reporting, sorted/deterministic ordering, missing-directory handling); `findDuplicateIds()`/`compareCoverage()`/`findMissingReferencedBlocks()` (pure unit tests); then real-repo integration: the actual coverage numbers, every Phase 11 addition present and supported, zero orphaned AI schemas after the inline-block merge, the pre-existing `"row"` duplicate still detected (not hidden), the `input_row`→`field_row` correction leaves no stray reference, the pre-existing `main-product` gap remains visible, and a determinism check (two runs, identical output).
- **`test/phase11Schemas.test.js`** (24 tests) — fidelity (exact enum values, the empty-string quirk, protected `product_picker` typing, closed-taxonomy category compliance, no `allowed_on: ["*"]`); relationships (every new section's `allowed_blocks` resolves, `contact-form.json` references the corrected id); retrieval (matching prompt surfaces the section+blocks, selectivity holds for new sections too, template-scope respected, full-load fallback still works); validation (sample settings clean, invalid enum rejected, unknown setting rejected, hallucination guard extends automatically to the new block, known reference accepted); operations (pre-existing section regression sanity, newly-covered section generically targetable, `add_block` onto a new block type works generically, `allowed_blocks` enforcement still rejects an out-of-scope block type); conversational editing (ambiguity still clarifies, a full multi-turn edit against a newly-covered target); live-repo isolation.
- **2 pre-existing tests fixed**, both because they used a section/block id as a synthetic "unknown to the AI catalog" example that Phase 11 made real: `test/phase7PipelineRegression.test.js` (`colors-changer` → a genuinely fictional type name) and `test/themeState.test.js` (`colors-changer`/`facebook-testimonials` on `product.json`, which now has ZERO unknown section types at all → switched to `collection.json`'s `main-collection-banner`, a still-genuinely-unknown, deliberately-deprioritized structural section). A third file, `test/merge.test.js`, uses `colors-changer` purely as a fixture LABEL with a hand-constructed `knownToAI: false` flag (never derived from the real catalog) — confirmed unaffected, left as-is.
- **2 hardcoded counts updated**: `test/phase2Regression.test.js`'s `sectionSchemaCount`/`blockSchemaCount` assertions (16/53 → 26/58) and a stale comment in `test/capabilityIndex.test.js`.

## Live Theme Safety

No `.liquid` file, `templates/*.json`, or `config/*.json` file was modified — confirmed both by design (every write in this phase targeted only `ai-schema/sections/*.json`/`ai-schema/blocks/*.json`/`ai-schema/test/*.js`/`ai-schema/coverage-report.js`/`ai-schema/docs/*.md`) and by a direct before/after byte-comparison test of the real theme's `templates/index.json`, run at the end of both new test files.

## Known Limitations

- **Coverage remains partial by design, not by omission.** 30.2% section / ~43% block-identity coverage after this phase, up from 18.6%/~34% — a deliberate, evidence-based subset (§8's "actual usage" criterion), not an attempt at exhaustive coverage in one migration (§6: "do not blindly create schemas for every missing file").
- **`main-product`'s 8 missing block references remain unresolved** — a pre-existing gap, now visible in `coverage-report.js`'s own output, deferred rather than expanded into scope.
- **`container`'s nested-block containment is unrepresentable** in the current schema format (`allowed_blocks` is section-only) — documented, not worked around with a format change (§10: "do not introduce a new schema format").
- **The `page` (linked-page) Shopify setting type has no representable, safe form yet** anywhere in the catalog — Phase 6's hallucination guard only covers `product_picker`/`collection`. The one place this phase encountered it (`collapsible-row-content`) omits it rather than under-protecting it.
- **The pre-existing `"row"` block id duplicate (`row.json`/`result_row.json`) was left exactly as-is** — already documented (PHASE2_REPORT.md), already deterministically resolved (sorted-filename, last-wins, tested), and out of this phase's "expand coverage" scope; fixing it would be a different, unrelated cleanup.

## Definition of Done

- [x] Actual section Liquid files have been inventoried (86, `coverage-report.js`).
- [x] Actual block Liquid files have been inventoried (80 standalone + inline identities, 130 total).
- [x] Current AI schema coverage has been measured (16/53 before, 26/58 after).
- [x] Coverage gaps are explicitly identified (`coverage-report.js`'s `unsupported`/`noSchemaTag`/`staleAISchemas`/`missingReferencedBlocks` fields).
- [x] Missing capabilities are prioritized deterministically (§8's live-template-usage criterion, documented above).
- [x] High-priority supported sections have compatible AI schemas (10 added).
- [x] High-priority supported blocks have compatible AI schemas (5 added + 1 corrected).
- [x] Existing schemas were not unnecessarily rewritten (one surgical, documented correction — `input_row`→`field_row` — nothing else touched).
- [x] Real Liquid `{% schema %}` definitions are the source of truth (every setting traced back to real JSON, not inferred).
- [x] Settings match actual Shopify schema semantics (enum values verified verbatim, including the empty-string quirk).
- [x] Defaults/options/ranges are preserved where applicable.
- [x] Section/block relationships are represented correctly (`allowed_blocks` cross-checked, zero missing references among new schemas).
- [x] Duplicate IDs are detected and handled deterministically (pre-existing `"row"` case confirmed still correctly resolved; zero new duplicates).
- [x] Capability Index automatically includes new schemas (zero code changes needed, verified).
- [x] Retrieval can discover newly covered capabilities (verified with representative prompts).
- [x] Retrieval remains selective (42-46% of the grown catalog for representative prompts).
- [x] Full-load fallback remains available (unchanged, exercised by tests).
- [x] `allowed_on` remains correct (evidence-based per section, verified never over-permissioned).
- [x] Phase 6 validation remains compatible (zero validator changes; sample data + adversarial cases both verified).
- [x] Phase 8 operations can use newly covered capabilities generically (verified end to end, zero special-case code).
- [x] Phase 9 conversational editing can use newly covered capabilities where present (verified end to end).
- [x] No schema-specific special-case AI logic was introduced (confirmed by direct inspection of every touched file).
- [x] Real theme remains untouched (verified by direct file comparison).
- [x] Coverage improvement is measured (table above).
- [x] Token/cost impact is measured (table above).
- [x] Unsupported capabilities are explicitly documented (section above).
- [x] Deterministic repeated runs produce the same inventory/index/report (tested directly).
- [x] Phase 1 tests pass.
- [x] Phase 2 tests pass.
- [x] Phase 3 tests pass.
- [x] Phase 4 tests pass.
- [x] Phase 5 tests pass.
- [x] Phase 6 tests pass.
- [x] Phase 7 tests pass.
- [x] Phase 8 tests pass.
- [x] Phase 9 tests pass.
- [x] Phase 11 tests pass (47 new).
- [x] No PostgreSQL/UI/preview functionality is introduced.
- [x] No redesign functionality is introduced.
- [x] No Phase 12–16 functionality is introduced.
