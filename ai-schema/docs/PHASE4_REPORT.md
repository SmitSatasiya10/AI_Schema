# Phase 4 — ThemeState — Report

Scope executed: **Phase 4 only**, per `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance) and the detailed Phase 4 spec (`AI_THEME_BUILDER_PHASE4_PLAN.md`). No later phase (WebsiteBrief↔generation wiring, staged generation, structured operations, targeted editing, merge-based apply, PostgreSQL, Next.js/DaisyUI/Base UI, preview, undo/redo) was started.

---

## Objective

Give the AI Theme Builder a reliable, application-level representation of the **existing** Shopify theme's current JSON configuration — so future phases can safely customize what's already there instead of regenerating or inventing a new theme. Before Phase 4, the pipeline could understand a request (Phase 3) but had no read-back model of the live theme at all; `2-copy-to-theme.js` only ever wrote forward (AI output → theme), never read the theme's current state back into a structured form.

## Current theme sources (inspected before writing any code)

Per the plan's instruction to verify from the actual repository rather than assume:

- `templates/*.json` (19 files) + `templates/customers/*.json` (7 files) — **24 total** OS 2.0 JSON templates, all sharing the same `{sections, order}` top-level shape (one exception: `password.json` also carries a top-level `layout` key, preserved automatically since `raw` is stored verbatim).
- `templates/gift_card.liquid` — the one non-JSON template file; documented as unsupported (§10), not silently treated as a JSON template.
- `config/settings_data.json` — the authoritative **current values** (`current`, `presets`, `platform_customizations`).
- `config/settings_schema.json` (2,897 lines, 29 setting groups) — the setting **definitions**; deliberately *not* copied into `ThemeState` (§9: "distinguish setting definition from setting value... do not copy unnecessary metadata").
- `config/markets.json` — Shopify markets/region configuration; unrelated to section/block/settings customization, out of scope, not touched.
- `ai-schema/sections/` (16 files) + `ai-schema/blocks/` (53 files) — the AI schema catalog `loadSchemas()` already exposes; used only to classify known-vs-unknown, never as the source of truth for what the live theme contains.

Real-theme discovery that shaped the design: `templates/product.json` contains real, currently-shipping section types with **no** matching `ai-schema/sections` schema — `colors-changer`, `related-products`, `custom-columns-new` (note: `custom-columns` *is* known, `custom-columns-new` is a different, unknown type), and `facebook-testimonials`. This is exactly the "AI schema coverage is a subset of the real theme" gap the plan warns about (§5), and it's used directly as a live fixture in `test/themeState.test.js` rather than a synthetic example.

## ThemeState model (as implemented)

```
ThemeState
├── themeId            "default" (see "Theme ID" below)
├── sourcePath          absolute path to the theme root
├── schemaVersion        1  (ThemeState's own format version)
├── createdAt / updatedAt  ISO timestamps
├── templates
│   └── "<name>"        e.g. "index", "product", "customers/account"
│        ├── sourceFile   e.g. "templates/product.json"
│        ├── raw          the parsed JSON, stored verbatim — untouched
│        └── classification
│             └── sections["<id>"] = { type, knownToAI, blockCount, blocks: { "<id>": { type, knownToAI } } }
├── globalSettings
│    ├── sourceFile      "config/settings_data.json"
│    └── raw             the parsed settings_data.json, verbatim
├── meta
│    ├── templateCount, sectionCount, blockCount
│    ├── unknownSectionCount, unknownBlockCount
│    ├── unparseableTemplates: [{name, sourceFile, error}]
│    ├── unsupportedTemplateFiles: ["templates/gift_card.liquid"]
│    └── globalSettingsError
└── validation            { valid, errors, warnings } — see "Validation" below
```

**Deliberate divergence from the plan's own sketch:** the plan's illustrative tree (§2) shows `sections`/`blocks` as siblings of `templates`; the real repository's JSON templates *embed* their sections inline (as shown above in `templates/index.json`), there's no separate top-level sections/blocks JSON to read independently. `ThemeState` follows the real structure rather than the sketch, per the plan's own instruction (§2: "do not blindly use this exact structure... design the actual model based on the real Shopify JSON format").

**Why `raw` + `classification` are kept as two separate things, never merged:** this is the core design choice, and it's what makes several of the plan's hardest requirements automatic rather than something to carefully get right by hand:
- **Preserving unknown data (§5)** is structural, not a rule to follow — `raw` is never selectively filtered, so there's nothing that *could* drop an unrecognized section.
- **Round-trip safety (§6)** is exact (not just "semantically equivalent") — `serializeThemeState()` returns `raw` straight back out.
- **Schema-aware validation without destructive rejection (§12)** — `classification` is purely additive/informational; `validateThemeState()` never consults it to decide whether something is *allowed* to exist, only whether the JSON's own internal structure (order↔sections, block_order↔blocks) is self-consistent.

This mirrors the same pattern already established by `capability-index.js` in Phase 2: compute metadata over real data, never rewrite the data to fit the metadata.

## Parsing (`buildThemeState()`)

```
themeRoot
    │
    ├── walk templates/ recursively (*.json only; *.liquid recorded as unsupported)
    │        │
    │        └── for each file: parse JSON
    │                 ├── success → templates[name] = { sourceFile, raw, classification }
    │                 └── failure → meta.unparseableTemplates.push(...), skip (does not abort the build)
    │
    ├── parse config/settings_data.json → globalSettings (or null + meta.globalSettingsError)
    │
    ├── classify every section/block's type against the full AI schema catalog
    │        (loadSchemas() with no retrieval filter — classification is always against
    │        everything the catalog knows, independent of any later retrieval-mode subset)
    │
    ├── validateThemeState(state) → state.validation
    │
    └── instrumentation.logThemeState(...)
```

No AI call anywhere in this path (§13) — confirmed by the test suite mocking nothing for `theme-state.js` and still passing against the real theme.

## Unknown data

Handled uniformly, not per-template special-casing: any section/block `type` string not present in `ai-schema/sections`/`ai-schema/blocks` gets `knownToAI: false` in `classification`, and is counted in `meta.unknownSectionCount`/`unknownBlockCount` — but its entry in `raw` (including every custom setting) is completely untouched. Verified against real data: `templates/product.json`'s `colors-changer` section round-trips byte-identically through `serializeThemeState()` while being correctly flagged `knownToAI: false`.

## Serialization

`serializeThemeState(themeState)` returns `{ templates: {name: rawObject}, globalSettings: rawObjectOrNull }` — a pure passthrough of the stored `raw` values. It does **not** write anything to disk (§14/§15) — applying a state back to the live theme is explicitly out of scope until a later merge/apply phase. Verified for every one of the real theme's 24 templates plus `settings_data.json`: `serializeThemeState(realState).templates[name]` is `assert.deepStrictEqual` to a fresh `JSON.parse(fs.readFileSync(...))` of the same file.

## Validation

`validateThemeState()` checks structural self-consistency, independent of AI-schema awareness:

| Check | Severity | Rationale |
|---|---|---|
| Template JSON failed to parse | error | can't do anything with it |
| `settings_data.json` failed to parse | error | same |
| Template root isn't an object / missing `sections` or `order` | error | breaks the OS 2.0 template contract |
| `order` references a section id absent from `sections` | error | would fail to render at all in Shopify |
| A `sections` entry not referenced in `order` | **warning** | Shopify allows unplaced sections (e.g. app-embed-only); not necessarily broken |
| `block_order` references a block id absent from `blocks` | error | same rendering-break reasoning as order/sections |
| A block present but missing from `block_order` | **warning** | same leniency reasoning |
| Section/block `type` not in the AI schema catalog | **never flagged** | §12 — this is exactly the "known but different from allowed" distinction the plan draws; unknown is informational (`meta.unknown*Count`), not a validation failure |

Deliberately **not** duplicated here: `validateOutput()`'s AI-generation-specific rules (max 10 sections, `allowed_blocks` membership, `max_blocks` limits, image-hallucination guard). Those exist to catch a *model* inventing something it shouldn't; `ThemeState` represents content that's already live and presumably already valid Shopify JSON — reusing `validateOutput()` directly would have meant either loosening its error semantics (risking a regression to Phase 1's already-accepted behavior) or accepting that every unknown-but-real section in the live theme would register as a hard error, which contradicts §12 outright. This is called out explicitly as a conscious scope boundary, not an oversight — see "Known limitations."

Run against the real theme: **`valid: true`, 0 errors** — the live theme's 24 templates are internally self-consistent.

## Persistence

File-based, matching the existing convention (`brief.js`'s `output/briefs/<sessionId>.json` from Phase 3): `output/theme-state/<themeId>.json`, via `saveThemeState()`/`loadThemeState()`. These two functions are the only code that knows about the filesystem, so later PostgreSQL persistence can replace them without touching `buildThemeState()`/`validateThemeState()`/`serializeThemeState()`. `themeStateFilePath()` rejects any `themeId` containing characters outside `[a-zA-Z0-9_-]` (same guard as Phase 3's `briefFilePath()`), so a malicious/malformed id cannot escape `output/theme-state/`.

### Theme ID

The plan explicitly warns against blindly reusing Phase 3's clarification session id (a conversation identifier) for a theme identifier (a configuration identifier) — they're different concepts. Since the current CLI architecture operates against exactly one theme root (this repository), a single static `themeId: 'default'` is the smallest mechanism that satisfies the requirement without inventing multi-project management that doesn't exist yet. `buildThemeState({ themeId })` accepts an override for tests/future multi-theme use, but nothing in this phase assumes more than one theme exists.

## Measurements (real theme, `npm run` via `theme-state.js`)

| Metric | Value |
|---|---:|
| Templates detected | 24 (+ 1 unsupported `.liquid`) |
| Sections represented | 85 |
| Blocks represented | 258 |
| Unknown section types | 39 |
| Unknown block types | 47 |
| Unparseable templates | 0 |
| `ThemeState` size (`JSON.stringify` chars) | 333,098 |
| Estimated tokens (chars/4) | ~83,275 |
| Build duration | 34ms |
| Serialization duration | <1ms |
| Validation result | valid, 0 errors, 0 warnings |

`ThemeState` is intentionally not designed to be sent to an AI call as-is (83K tokens would dwarf even the Phase 1 baseline's 60K-char full-schema prompt) — it's an in-process/persisted structure for later phases to query and target selectively, not a prompt payload.

## Tests

**112 tests total, all passing** (Phase 1: baseline/buildSystemPrompt/instrumentation/loadSchemas/runFullPipeline/validateOutput; Phase 2: capabilityIndex/retrieval/phase2Regression; Phase 3: brief/clarification/phase3Regression; Phase 4: `test/themeState.test.js`, 17 new tests):

- **Real-theme (read-only)**: every `.json` template detected including nested `customers/`, `gift_card.liquid` correctly recorded as unsupported, known-vs-unknown classification verified against the real `colors-changer`/`main-product` sections, unknown sections confirmed present in `raw`, exact round-trip against a fresh disk read for all 24 templates + settings, structural validation passes clean, and an **isolation test** that reads `templates/index.json` + `config/settings_data.json` byte-for-byte before and after two separate `buildThemeState()` calls and asserts they're unchanged — empirical proof of "never writes to the live theme," not just code inspection.
- **`classifyTemplate()`** — pure unit tests for known/unknown detection, confirms the input object is never mutated.
- **`validateThemeState()`** — pure unit tests for every error/warning case in the table above, plus the explicit "unrecognized type never produces an error by itself" non-destructive-rejection test.
- **Fixture-based** (disposable `os.tmpdir()` theme root, cleaned up after each test) — malformed JSON template doesn't abort the build and is flagged; unknown section with custom settings survives a full build→serialize round-trip.
- **Persistence** — save/load round-trip, `null` on missing, path-traversal-unsafe `themeId` rejected.

## Known limitations

- **No AI-schema settings-level validation.** As explained above, `validateThemeState()` deliberately checks structural self-consistency only, not per-setting correctness (enum ranges, image hallucination, `allowed_blocks` membership) for *known* sections — that logic lives in `validateOutput()` and is scoped to AI-generated output, not existing live content. A later phase that wants "warn me if a known section's live settings look wrong" would need to build that check explicitly; it wasn't duplicated here to avoid the destructive-rejection risk described in "Validation."
- **`config/settings_schema.json` is not modeled.** Only setting *values* (`settings_data.json`) are represented, per §9's explicit instruction. A future phase that needs to validate a value against its definition (e.g. "is this within the range this setting allows") will need to read `settings_schema.json` separately — `ThemeState` doesn't carry it.
- **Duplicate JSON keys are undetectable.** If a template file's raw JSON text has a duplicate section id, `JSON.parse()` already silently resolves it (last one wins) before `ThemeState` ever sees the data — there is no way to detect or flag this after the fact. Not observed in the real theme, but noted as a structural limit of working from parsed JSON rather than a token stream.
- **`output/theme-state/` is unbounded**, same posture as Phase 3's `output/briefs/` — acceptable for the current single-operator CLI usage, not something that should carry unchanged into a multi-user architecture.
- **Read-only by design.** `ThemeState` has no update/mutation API yet (§20 explicitly defers "safe updates" and §21 explicitly excludes targeted editing/operations from this phase) — this is intentional, not an oversight; Phase 8/9 own that.

## Definition of Done

- [x] `ThemeState` model exists.
- [x] Current theme JSON can be converted into `ThemeState`.
- [x] `ThemeState` preserves existing section order (`raw.order` untouched).
- [x] `ThemeState` preserves existing block order (`raw.*.block_order` untouched).
- [x] `ThemeState` preserves existing settings (`raw.*.settings` untouched).
- [x] Unknown sections are preserved (verified against the real theme's `colors-changer`, `facebook-testimonials`, etc.).
- [x] Unknown blocks are preserved.
- [x] Unknown properties/settings are preserved (e.g. `password.json`'s extra `layout` key survives via verbatim `raw`).
- [x] `ThemeState` can be serialized back to theme JSON (`serializeThemeState()`).
- [x] Round-trip semantic (in fact exact) preservation is tested, against both the real theme and fixtures.
- [x] `ThemeState` validation exists (`validateThemeState()`).
- [x] Existing schema-aware validation reused where appropriate (AI schema catalog reused for classification; `validateOutput()`'s AI-generation-specific rules deliberately not duplicated — see "Known limitations").
- [x] Unknown schema components are not destructively rejected (explicit test).
- [x] File-based persistence abstraction exists (`saveThemeState`/`loadThemeState`).
- [x] PostgreSQL is not introduced.
- [x] No live theme files are modified (empirically tested, not just asserted).
- [x] Phase 1 tests pass.
- [x] Phase 2 tests pass.
- [x] Phase 3 tests pass.
- [x] Phase 4 tests pass (17 new tests).
- [x] No Phase 5+ functionality is implemented (no WebsiteBrief↔generation wiring, no operations, no editing, no apply).

**STOP.** Per the phase plan's strict stop condition, Phase 5 (Staged Initial Generation Pipeline) and everything after it is out of scope for this change and was not started.
