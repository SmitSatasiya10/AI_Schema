# AI Theme Builder — Complete Architecture & Phased Implementation Plan

## Context

The repo (`/home/master/Smit/ai-schema/`) is a real Shopify Online Store 2.0 theme with an AI generation layer nested inside it at `ai-schema/ai-schema/`. Today that layer is a **4-file, stateless Node.js CLI pipeline** — `1-generate-theme.js`, `2-copy-to-theme.js`, `3-interactive-menu.js`, `example-implementation.js` — with no web app, no server, no frontend, no conversation memory, and no editing capability whatsoever. Every invocation does the same thing: load every schema file on disk, dump it all into one \~59.7K-character prompt, ask an LLM for a complete theme JSON in one shot, validate it structurally, and overwrite the live theme files. Re-running with a new prompt just regenerates everything from scratch; there is no way to say "make the hero darker" or "change the heading" against something already generated.

The goal is to evolve this into a real **AI Theme Builder**: something that understands a merchant's brief, asks only the clarifying questions it actually needs, selects and configures existing theme capabilities instead of reinventing them, and — critically — can make small, scoped, non-destructive edits against a theme it already understands, the same way `mergeProductTemplate()` already does for one narrow case today. This plan does **not** implement any of that yet. It is the researched, phased roadmap the user asked for, to be executed one phase at a time after review.

This plan was produced by: three parallel deep-research passes over the pipeline scripts, the schema library, and the real Shopify theme files (cross-checked against a pre-existing, independently-verified `ai-schema/AUDIT.md` already sitting untracked in the repo); followed by two parallel design passes — one on core data structures (WebsiteBrief, capability index, ThemeState, operations vocabulary, validation), one on phase sequencing and MVP scope — synthesized and spot-verified against source below.

---

## 1. Current Architecture — Verified Baseline

```
User (CLI flag or readline menu)
   ↓
3-interactive-menu.js (7 options, all full-regen or raw copy)  — OR —  1-generate-theme.js parseArgs()
   ↓
1-generate-theme.js: runFullPipeline(userPrompt, options)
   ↓
example-implementation.js: loadSchemas()                         [21-73]
   reads global.json + ALL *.json in sections/ (16 files) + ALL *.json in blocks/ (53 files)
   unconditionally, every call — no filtering, no lazy loading
   ↓
example-implementation.js: buildSystemPrompt(schemas)             [78-187]
   12 hardcoded prose rules + JSON.stringify(global + all sections + all blocks)
   MEASURED: 59,704 characters / ~15,000–17,000 tokens, sent on EVERY call
   ↓
example-implementation.js: generateAIColorPalette(userPrompt)     [492-581]   [OpenRouter call #1]
   SEPARATE call just for a 7-key hex palette; falls back to detectNicheAndGetColors()
   (keyword match, no "pet"/"wellness" vocabulary — silently defaults to "modern")
   ↓
example-implementation.js: makeAIRequest(userPrompt, systemPrompt) [192-256]  [OpenRouter call #2]
   model = OPENROUTER_MODEL env, default 'moonshotai/kimi-k2.5', temp 0.8,
   response_format: json_object, exponential-backoff retry (3 attempts, 5xx/network only — solid, keep)
   ↓
example-implementation.js: validateOutput(aiOutput, schemas)      [261-427]
   JSON.parse + type-membership + allowed_blocks + max_blocks + block_order +
   image-hallucination guard (image/image_picker only) — all solid, KEEP.
   Missing: allowed_on-vs-template check, setting range/enum check, product/collection
   hallucination guard, retry/repair loop (failure just throws → process.exit(1))
   ↓
example-implementation.js: generateThemeFiles(config, templateName, {}, colors) [1057-1113]
   writes output/templates/<name>.json — FULL raw overwrite
   writes output/config/settings_data.json — rebuilt fresh from global.json's 8 tokens only,
   NOT merged with whatever settings_data.json already had (real data-loss risk)
   ↓
2-copy-to-theme.js: copyGeneratedFilesToTheme()                   [175-247]
   index.json            → templates/index.json        FULL OVERWRITE
   product.json          → templates/product.json       MERGED via mergeProductTemplate() [107-140]
                            (splices in ONLY the main-product section, preserves everything
                             else in the live template — the one genuinely non-destructive
                             pattern anywhere in the codebase — verified against source)
   settings_data.json     → config/settings_data.json    FULL OVERWRITE
   ↓
Shopify theme files on disk (no deploy/push step in this repo)

```

**Corrected fact vs. the original brief:** the assumed "109 sections / 293 blocks" is wrong. The real counts, verified three independent ways (two Explore agents + AUDIT.md, all matching): **16 section schemas and 53 block schemas** exist in `ai-schema/sections/` and `ai-schema/blocks/`. The *real Shopify theme* has **86 ****`sections/*.liquid`** and **80 ****`blocks/*.liquid`** files — so AI-schema coverage today is \~19% of sections and \~66% of blocks. Zero of the 16 section schemas declare `collection` in `allowed_on`; the pipeline only ever targets `index`/`product` templates regardless.

**What already works and must be reused, not rewritten** (confirmed in source):

- Schema-type enforcement in `validateOutput` (hard-rejects unknown section/block types)
- `allowed_blocks` enforcement, `max_blocks`/`block_order` structural checks
- `mergeProductTemplate()` — the existing "configure, don't replace" pattern (`2-copy-to-theme.js:107-140`), the direct model for everything editing-related in this plan
- `makeAIRequest()`'s network-layer retry/backoff (`example-implementation.js:192-256`)
- The schema file convention itself (`id/label/purpose/allowed_on/settings/allowed_blocks/_notes`) — the problem is coverage (16/53 vs 86/80), not the format
- The image-generation machinery (`generateSectionImages` etc., `example-implementation.js:775-967`) — fully implemented but never called (`--images` flag is dead)

---

## 2. Target Architecture

Evolve the existing pipeline (don't replace it) into two distinct flows sharing common state and building blocks:

**Initial generation:** Request understanding → Clarification loop (`NEEDS_CLARIFICATION` / `READY_TO_GENERATE`) → persisted `WebsiteBrief` → page planning → capability selection via a new lightweight **schema capability index** (deterministic keyword/category retrieval, *not* a vector DB) → full-schema retrieval for only the selected subset → staged section configuration + content generation → `ThemeState` → extended validation → merge-based apply to the real theme files.

**Editing (new — does not exist today):** intent classification → identify affected component against current `ThemeState` → retrieve the relevant `ThemeState` slice + relevant schema (same capability index, scoped) → generate one or more **structured operations** (closed vocabulary) → validate → apply via the same merge machinery.

### Core data structures (full specs verified/designed below, see §4 for file-level anchoring)

**`WebsiteBrief`** — persistent, per-field-provenance representation of the merchant's request (`{value, status: confirmed|inferred|missing, source}` per field). Only `businessType`/core niche identity is realistically blocking; everything else (audience, tone, color, pages) stays defaultable, preserving today's low-friction one-shot UX rather than turning every generation into a form.

**Clarification protocol** — `BriefAssessment = READY_TO_GENERATE | NEEDS_CLARIFICATION(questions[])`. Fires only when a field in a small `blockingFieldKeys` set is missing. Capped at 2 rounds / \~3 questions per round; after the cap, forces `READY_TO_GENERATE` with defaults applied — guarantees the flow can never deadlock.

**Intent classification** — a closed vocabulary calibrated 1:1 to the operations vocabulary below, not invented independently: `CREATE_NEW`, `REDESIGN_PAGE`, `ADD_PAGE`, `EDIT_CONTENT`, `EDIT_DESIGN`, `ADD_SECTION`, `REMOVE_SECTION`, `REORDER_SECTIONS`, `ADD_BLOCK`, `EDIT_BLOCK`, `REMOVE_BLOCK`, `AMBIGUOUS` (routes to clarification). `CREATE_NEW` and `REDESIGN_PAGE` intentionally share one mechanism (`replace_template`) — they differ only in whether a destructive-confirmation step is required, since the audit confirms the system genuinely can't distinguish "fresh build" from "redesign of existing" today, and there's no value inventing two full-generation code paths.

**Schema capability index** — small derived index entries (`id, label, category, tags, allowed_on, hasBlocks/scope, summary`) built by adding a `category`/`tags` field directly into the 69 existing schema JSON files (one-time migration, following the existing convention where `id/label/purpose/allowed_on` already live in the schema itself) and generating `capability-index.json` as a derived build artifact — not a separately hand-maintained map that will drift. A \~12-value closed category taxonomy (`hero, content, social-proof, product-showcase, product-detail, conversion, trust-badges, layout-structural, media, form-input, navigation-utility, misc`). Retrieval is **deterministic**: tokenize prompt+brief → match against a small separate `retrieval-rules.json` (keyword→category) → filter index by category/tag/`allowed_on` → always force-include a baseline hero section first (matches today's "slideshow first" convention) → resolve full schemas for chosen sections, then transitively pull only their `allowed_blocks` blocks (this is what cleanly resolves the previously-undocumented "local vs. standalone block" ambiguity — e.g. `tab` only ever enters context via `content-tabs` pulling it in, never as a dangling candidate) → if the result set is too small, gracefully degrade to sending everything for that template. Do **not** block this on expanding schema coverage — build the index over today's 16/53 first; expand coverage as a parallel workstream (Phase 11 below). Note the concrete evidence for why: `templates/product.json` already contains live sections with **zero** AI schema today (`colors-changer`, `related-products`, `custom-columns-new`, `facebook-testimonials`) — `ThemeState` must treat these as `knownToAI: false` pass-through, never AI-editable, rather than erroring.

**`ThemeState`** — a derived, cached *view* over the live theme files (`templates/<name>.json` + `config/settings_data.json`), hydrated at the start of a session/turn, mutated in memory during multi-turn edits, compiled back to real files only at commit points. Not an independent DB (none exists in this repo and introducing one is a bigger call than this design should force), not re-derived from scratch every single turn (edits need to diff/undo across turns). Each section/block splits settings into `content` vs `design` layers via a fixed, schema-type-derived table (`text/richtext/image_picker/product_picker/collection` → content; `color/range/font_picker/enum-options` → design) — this is the concrete mechanism that makes "change hero heading" ≠ "make hero darker" enforceable in code, not just prompt wording. `hydrate()` generalizes exactly the one thing `mergeProductTemplate()`'s destination-read already does today, but for any template.

**Structured operations** — closed vocabulary: `insert_section, remove_section, reorder_sections, update_section_settings(layer), update_content, insert_block, remove_block, update_block_settings(layer), update_global_settings, replace_template`. `replace_template` is deliberately kept as an explicit escape hatch — it's exactly today's full-overwrite behavior and stays correct for `CREATE_NEW`/`REDESIGN_PAGE`. Every other op carries explicit target ids, so it's scoped/reversible/independently validatable by construction. `mergeProductTemplate()`'s existing splice logic generalizes directly into the apply engine: it's already `update_section_settings` applied to a section discovered *by type* rather than by id (because the AI doesn't know live ids) — that "resolve by type, fall back to insert" step becomes the general resolver for any type-addressed edit.

**Validation extensions** (additive to `validateOutput`, never replacing the working checks): (a) `allowed_on`-vs-`templateName` enforcement — `templateName` is already in scope at the one call site, just not threaded into `validateOutput` today; (b) setting value range/enum checks against schema `min/max/options`, extending the existing per-setting loop that today only checks image fields; (c) product/collection hallucination guard — literally the same pattern as the existing image guard, applied to `product_picker`/`collection` types, closing the exact hole that let a committed artifact contain `"product": "signature-vegan-chicken"` and pass validation untouched; (d) new operation-level validation (`validateOperation`) against `ThemeState` — target existence, `knownToAI` check, content/design layer-matching for scoped edits.

---

## 3. Implementation Phases

Each phase's Definition of Done and dependency reasoning is grounded in the specific file/function anchors below. Phases 1–9 form the **MVP critical path** (§5); 10–16 are post-MVP or optional.

### Phase 1 — Baseline Regression Safety Net & Instrumentation

- **Objective:** Turn `AUDIT.md`'s findings into enforceable regression tests, and add prompt-size/token/call-count logging at every AI call site, before anything downstream touches these functions.
- **Why here:** Every later phase modifies `buildSystemPrompt`, `validateOutput`, or `generateThemeFiles`. Without a captured baseline (59,704 chars, 2 OpenRouter calls/run) and characterization tests, regressions are invisible.
- **Builds on:** `example-implementation.js` (`loadSchemas`, `buildSystemPrompt`, `validateOutput`, `makeAIRequest`), `1-generate-theme.js` (`runFullPipeline`).
- **Files created:** a small `ai-schema/ai-schema/test/` fixture suite; a logging helper (e.g. `ai-schema/ai-schema/instrumentation.js`).
- **Files modified:** call sites of `makeAIRequest`/`generateAIColorPalette` gain a logging wrapper (no behavior change).
- **Validation:** golden-file tests on today's `validateOutput` accept/reject behavior across the current 16/53 schemas.
- **Token/cost impact:** none (measurement only) — this *produces* the baseline every later phase is measured against.
- **Risk:** skipped as "busywork," making every later phase unmeasurable.
- **Rollback:** trivially safe — additive only, no production code path changes.
- **DoD:** regression suite exists and passes against current behavior; every AI call site logs size/cost; baseline numbers committed.

### Phase 2 — Schema Capability Index + Deterministic Retrieval

- **Objective:** Build the lightweight index described in §2 over the existing 69 schema files, plus deterministic keyword/category retrieval — the direct fix for "59.7K chars sent every call."
- **Why here:** Nothing downstream (staged generation, editing) can selectively retrieve schemas until this exists; must land before Phase 5 and before Phase 9.
- **Builds on:** `ai-schema/sections/*.json`, `ai-schema/blocks/*.json` (add `category`/`tags`/`scope` fields, one-time migration, \~69 files), `SCHEMA_CREATION_GUIDE.md` (extend the documented convention).
- **Files created:** `capability-index.js` (build script), `retrieval-rules.json`, generated `capability-index.json`.
- **Files modified:** each of the 69 schema JSON files (add `category`, `tags`, and for the 10 local-block schemas, `scope: "local"` + `localToSectionIds`); `loadSchemas()` gains an index-filtered mode alongside its existing "load everything" mode (back-compat).
- **Data structures:** `SectionIndexEntry`, `BlockIndexEntry` per §2.
- **Validation:** canned-brief test set ("pet wellness store", "luxury fashion", "SaaS landing") must return a bounded, relevant subset and never omit a schema whose keyword literally appears in the brief.
- **Token/cost impact:** this is the primary lever — expect prompt size to drop from the full 59.7K-char baseline to only the retrieved subset's size for a given brief.
- **Risk:** deterministic keyword matching under-retrieves for paraphrased requests ("make it feel expensive" ≠ keyword "luxury"). This is the explicit, evidence-based trigger condition for later semantic retrieval — not a reason to build it now.
- **Rollback:** the "load everything" fallback path keeps working throughout; index-filtered mode is opt-in until proven.
- **DoD:** retrieval is deterministic and testable; a documented fallback to full-load exists for low-confidence cases.

### Phase 3 — Request Understanding, Clarification Loop & WebsiteBrief Persistence

- **Objective:** Add the `NEEDS_CLARIFICATION`/`READY_TO_GENERATE` pass and persist the resolved brief.
- **Why here:** Independent of Phase 2 (can run in parallel), but must land before Phase 5, which needs a resolved brief rather than a raw prompt string.
- **Builds on:** replaces `buildSystemPrompt()` rule 11's "BE CREATIVE, RANDOMIZE" invent-everything behavior and `detectNicheAndGetColors()`'s narrow keyword list (`example-implementation.js:586-613`, no "pet"/"wellness" vocabulary today); supersedes `3-interactive-menu.js`'s canned niche picklist (`showNicheMenu`/`getNichePrompt`) with a real Q&A loop.
- **Files created:** `brief.js` (WebsiteBrief model + persistence), `clarification.js`.
- **Files modified:** `1-generate-theme.js` gains a new `STEP 0` before `loadSchemas()`.
- **AI changes:** new lightweight extraction+question-generation call, same cost tier/shape as the existing color call (single JSON-mode user turn); reuses `makeAIRequest`'s retry/backoff.
- **Validation:** fixtures with deliberately missing fields must route to `NEEDS_CLARIFICATION`; fully-specified prompts must not trigger spurious questions.
- **Token/cost impact:** one extra small call only when the deterministic pre-check is ambiguous; zero added cost for clear prompts.
- **Risk:** over-asking kills the fast one-shot UX that works today; under-asking reproduces the audit's root-cause-B generic-output problem. Needs an empirically-tuned threshold.
- **Rollback:** the clarification pass can be bypassed entirely (flag) to fall back to today's always-generate behavior.
- **DoD:** at least one ambiguous-prompt fixture completes a clarification round-trip end to end; brief persists and round-trips by ID.

### Phase 4 — ThemeState Model Introduction (Read-Back Layer)

- **Objective:** Introduce `ThemeState` and hydrate it from the live `templates/<name>.json` + `config/settings_data.json` before any pipeline run.
- **Why here:** The single most load-bearing phase in the roadmap — every later phase that touches theme files depends on a real, queryable "what's on disk right now" model. Today the only precedent is `mergeProductTemplate()`'s narrow lookup of the existing `main-product` key (`2-copy-to-theme.js:122-124`); this generalizes that pattern, it doesn't invent a new one.
- **Builds on:** reads `templates/index.json`, `templates/product.json`, `config/settings_data.json`, and — for the content/design classification table — `config/settings_schema.json` (2,897 lines, the real design-token surface `global.json`'s 8 tokens only cover \~1% of).
- **Files created:** `theme-state.js` (`hydrate`, `compile`, content/design classification table).
- **Files modified:** none required yet (read-only phase) — `generateThemeFiles`/`loadGlobalSettings` become consumers in Phase 7.
- **Validation:** round-trip test — hydrate, compile back unchanged, diff against original (must be a no-op); test specifically against the messy real files already sitting in `ai-schema/output/` (mismatched multi-run debris) to confirm hydration doesn't choke on real-world mess.
- **Token/cost impact:** none (no AI call in this phase).
- **Risk:** treating this as a lightweight afterthought bolted onto the existing full-overwrite functions rather than the new foundation those functions get rewritten against — this is flagged below (§6) as the single biggest sequencing risk in the whole plan.
- **Rollback:** purely additive; nothing consumes `ThemeState` yet, so it can be reverted with zero blast radius.
- **DoD:** `ThemeState` can be constructed from any current on-disk theme state (including the real live theme) and exposes a working content/design split; sections/blocks with no matching schema are marked `knownToAI: false`, not errored on.

### Phase 5 — Staged Initial-Generation Pipeline

- **Objective:** Replace the single mega-prompt with: page planning → capability selection (Phase 2) → full-schema retrieval for the selected subset → section configuration → content generation.
- **Why here:** Requires Phase 2 (retrieval) and Phase 3 (brief) as direct inputs; should initialize against Phase 4's `ThemeState` (even fresh generations start from an empty/default state) so generation and editing share one code path from the start.
- **Builds on:** rewrites `buildSystemPrompt()`'s all-in-one dump; keeps `makeAIRequest()`'s retry/backoff and `generateAIColorPalette()`/`detectNicheAndGetColors()` unchanged as one sub-stage; output still lands in the `{sections, order}` shape `validateOutput()` already expects.
- **Files modified:** `example-implementation.js` (`buildSystemPrompt` replaced/staged), `1-generate-theme.js` (`runFullPipeline` restructured into stages).
- **Validation:** A/B token-count comparison vs. Phase 1 baseline; content-specificity spot checks against the audit's pet-wellness example (root cause B) to confirm briefs actually change output now.
- **Token/cost impact:** expected large reduction from the 59.7K-char baseline — magnitude depends on Phase 2's retrieved-subset size per brief; measure and report, don't assume a number.
- **Risk:** splitting one call into several stages multiplies failure surface without a repair loop — must ship in close coordination with Phase 6, not far ahead of it.
- **Rollback:** keep the legacy single-call path available behind a flag until the staged path is proven on the fixture set.
- **DoD:** a full run from a resolved brief produces a valid homepage config via the staged flow, with a measurably smaller prompt footprint than the Phase 1 baseline.

### Phase 6 — Validation Extension

- **Objective:** Add `allowed_on`-vs-template enforcement, setting range/enum checks, product/collection hallucination guard, and a bounded retry/repair loop, without touching the checks that already work.
- **Why here:** Can develop in parallel with Phase 5 against the Phase 1 regression suite, but must land before Phase 7's merge-based apply goes live — bad validated payloads are harder to blindly discard once writes stop being full overwrites.
- **Builds on:** `validateOutput()` (`example-implementation.js:261-427`) — explicitly keep the existing type/`allowed_blocks`/`max_blocks`/`block_order`/image checks; extend the signature to accept `templateName`; replace `1-generate-theme.js`'s throw-and-exit (lines 90-92) with a capped repair loop back into Phase 5's generation stage.
- **Files modified:** `example-implementation.js` (`validateOutput`), `1-generate-theme.js` (failure handling).
- **Validation:** Phase 1 regression suite must still pass unchanged; new fixtures for each added check (section on wrong template, hallucinated product handle, out-of-range value) must now fail with actionable errors; repair loop must terminate and fail loudly on cap.
- **Token/cost impact:** small increase from occasional repair-retry calls, bounded by a hard retry cap.
- **Risk:** repair loop silently masking real generation bugs instead of surfacing them — needs retry-count caps and structured error logging tied to Phase 1's instrumentation.
- **Rollback:** each new check can be independently disabled via a flag if it proves too strict against real output.
- **DoD:** all four new checks demonstrably catch the exact failure modes documented in the audit (the committed hallucinated-product/hallucinated-image artifact); at least one automatic repair attempt happens before user-facing failure.

### Phase 7 — Apply-to-Theme Extension (Merge-Based Writes)

- **Objective:** Generalize `mergeProductTemplate()`'s splice-and-preserve pattern to `index.json` and `config/settings_data.json`, driven by `ThemeState`.
- **Why here:** Depends directly on Phase 4 (ThemeState tells the apply step what changed vs. what to preserve) and Phase 6 (only apply validated payloads). This fixes the audit's flagged data-loss risk: `settings_data.json` is rebuilt fresh from `global.json`'s 8 tokens every run today, dropping anything else that was on disk.
- **Builds on:** `2-copy-to-theme.js` (`copyTemplates`, `isProductTemplate`, `copyGeneratedFilesToTheme`) — extend the existing merge/overwrite branch pattern so `index.json`/`settings_data.json` get their own merge functions modeled directly on `mergeProductTemplate()` (lines 107-140); `generateThemeFiles()`'s settings rebuild (`example-implementation.js:1095-1103`) becomes a read-modify-write merge instead of a fresh reconstruction.
- **Files modified:** `2-copy-to-theme.js`, `example-implementation.js` (`generateThemeFiles`, `loadGlobalSettings`).
- **Validation:** regression test proving a merge-based `settings_data.json` write preserves fields outside `global.json`'s 8 tokens; idempotency test (apply twice, no intervening change → identical file).
- **Token/cost impact:** none (no AI call here).
- **Risk:** the phase most likely to be skipped as "full overwrite already works for demos" — but it's a hard blocker for every phase after it. Treat as non-negotiable before Phase 8.
- **Rollback:** merge functions can fall back to the old full-overwrite path per-file if a merge produces an invalid result (schema-validate the merged output before writing).
- **DoD:** repeated generation or a targeted edit never silently drops previously-existing settings or unrelated sections, for both `index.json` and `settings_data.json`.

### Phase 8 — Structured Operations Vocabulary + Apply Engine

- **Objective:** Implement the mechanics of applying a structured operation (§2's closed vocabulary) against `ThemeState` via Phase 7's merge machinery, validated by Phase 6.
- **Why here:** Hard-depends on Phase 4 (state to apply against) and Phase 7 (non-destructive write mechanics) — building this earlier means building against the current full-overwrite functions, guaranteeing rework the moment Phase 7 lands. This phase is the engine only; intent classification and op-generation land in Phase 9.
- **Builds on:** generalizes `mergeProductTemplate()`'s "resolve target by type, splice in place" idea into the general resolver for any type-addressed edit.
- **Files created:** `operations.js` (`applyOperation`, per-op handlers), `validate-operations.js` (`validateOperation` per §2/§4d).
- **Validation:** unit tests per operation type against a fixed `ThemeState` fixture; invalid-operation rejection tests reuse Phase 6's error shape, scoped to the op.
- **Token/cost impact:** none directly (mechanics only, no AI call — the AI call that *produces* an operation is Phase 9).
- **Risk:** vocabulary scope creep — keep it small and generic (settings update, insert/remove/reorder, content update), not one op type per section type.
- **Rollback:** operations are pure functions over `ThemeState`; a bad apply is trivially discarded before compile/write since nothing touches disk until the compile step.
- **DoD:** every operation type in the closed vocabulary applies against a fixture, validates, and compiles into the same merge-based write shape Phase 7 already produces for section replacement.

### Phase 9 — Targeted Editing Flow (Content Edits and Design Edits) — MVP boundary

- **Objective:** Wire the full edit path end to end: intent classification → identify affected component → retrieve the relevant `ThemeState` slice + scoped schema (Phase 2's retrieval, narrowed to one component) → generate a structured operation (Phase 8) → validate (Phase 6) → apply (Phase 7/8).
- **Why here:** The first phase that delivers "editing" as a real, distinct capability — closes the audit's most direct finding (§8: zero editing code exists today). Requires Phases 2, 4, 6, 7, 8 all landed.
- **Builds on:** no existing-code equivalent (confirmed zero editing paths exist); the orchestrator is new, shaped like `runFullPipeline()` but entering at intent classification instead of "load everything and generate."
- **Files created:** `intent-classifier.js`, `edit-pipeline.js`.
- **Validation:** scripted fixtures — "make the hero darker" must produce exactly one `update_section_settings` op touching only the hero and no unrelated sections; "change the hero heading to X" must produce exactly one `update_content` op. This is Scenario 3/4 from the original brief, and the literal MVP exit bar.
- **Token/cost impact:** dramatically smaller than a full generation call — one scoped schema + one `ThemeState` slice, not the whole catalog.
- **Risk:** intent misclassification routing a content request through a design-op generator or vice versa — needs a labeled fixture set covering both intents plus ambiguous phrasing that should route to Phase 3's clarification loop instead of guessing.
- **Rollback:** every edit is a validated, scoped operation with a computed inverse (trivial single-step undo even before Phase 15's full versioning lands).
- **DoD:** both a content-edit and a design-edit request against a previously-generated homepage produce correct, narrowly-scoped operations that apply without touching unrelated sections/settings. **MVP is complete at this phase.**

### Phase 10 — Major Redesign Flow

- **Objective:** Support "redesign the homepage for X" as an intent emitting a multi-operation batch across sections, atomically.
- **Why here:** Strictly depends on Phase 9 being reliable for single-op edits first — batch failures are much harder to debug if the single-op path isn't already trustworthy.
- **Builds on:** Phase 8's apply engine (batched), Phase 9's classifier (new "redesign" bucket), optionally Phase 5's page-planning logic scoped to existing sections instead of a blank page.
- **Validation:** "redesign for a luxury pet wellness brand" against an existing generic homepage must emit multiple individually-valid ops that apply atomically (all-or-nothing).
- **Token/cost impact:** comparable to a full generation call, since redesign genuinely touches many sections — expected, not a regression.
- **Risk:** partial-apply failures leaving `ThemeState` inconsistent — needs transactional semantics (validate the whole batch before applying any of it).
- **Rollback:** the whole batch is one versioned snapshot (ties into Phase 15).
- **DoD:** a redesign request produces a coherent, atomically-applied multi-section operation batch; the old "re-run generation = accidental full regen" behavior is retired as the redesign mechanism.

### Phase 11 — Schema Coverage Expansion Campaign

- **Objective:** Author schema JSON files for the \~70 currently invisible real sections and \~27 currently invisible real blocks, following the existing convention.
- **Why here:** Can start any time after Phase 2's index format stabilizes (so new schemas are authored in the shape retrieval expects); runs largely in parallel with Phases 5–10 as a content-authoring workstream; hard-blocks Phase 12 (multi-page — zero current schemas support `collection`/`blog`/etc.).
- **Builds on:** `SCHEMA_CREATION_GUIDE.md`; real `sections/*.liquid`/`blocks/*.liquid` as ground truth (the existing 16/53 have zero id-mismatches against Liquid — keep that discipline).
- **Validation:** each new schema diffed against its real Liquid file's actual `{% schema %}`; index re-tested to confirm new entries surface correctly.
- **Risk:** treating this as one all-at-once 97-file effort instead of an incremental, priority-ordered backlog (collection-page sections first, to unblock Phase 12).
- **Rollback:** additive-only; a bad schema file is simply not indexed until fixed.
- **DoD:** `collection` at minimum has schema coverage sufficient to plan/generate a real collection page; coverage percentage tracked and visibly increasing per iteration.

### Phase 12 — Multi-Page Support (collection/blog/article/cart/search)

- **Objective:** Generalize page planning, retrieval, generation, and apply-to-theme targeting beyond `index`/`product`.
- **Why here:** Hard-blocked by Phase 11. Benefits from Phase 4/7's foundation already proven on two templates.
- **Builds on:** generalizes the template-name hardcoding in `1-generate-theme.js` (`parseArgs`/`runFullPipeline` default to `'index'`) and `2-copy-to-theme.js`'s `isProductTemplate()` branch to per-template-type dispatch; finally enforces `allowed_on` (documentation-only today) per template.
- **Validation:** end-to-end generation for at least a collection page and one functional page (cart/search), asserting only sections whose `allowed_on` includes that template are ever placed there.
- **Risk:** treating every template as "just another index.json" — cart/search are narrower and more functional than index/collection and shouldn't get freeform generative content.
- **Rollback:** per-template dispatch defaults to "unsupported" (reject cleanly) for any template without landed schema coverage.
- **DoD:** at least collection + one additional non-index/product template generate, validate (with `allowed_on` enforced), and apply via the merge-based layer.

### Phase 13 — Product/Collection Catalog Integration

- **Objective:** Connect real Shopify Admin product/collection data so `product_picker`/`collection` settings resolve to real handles.
- **Why here:** Not a hard MVP blocker (the same "force blank" guard that already protects images can protect catalog fields), but becomes materially more important once Phase 12's collection pages land.
- **Builds on:** closes the exact gap in `validateOutput` where only `image`/`image_picker` types are hallucination-checked today — the committed `"product": "signature-vegan-chicken"` artifact is the direct evidence.
- **Validation:** any AI-emitted product/collection handle is checked against real (or mocked) catalog data and rejected/repaired if it doesn't exist.
- **Risk:** Shopify Admin API auth/rate-limits are a new external dependency with its own failure modes — needs its own error handling, not bolted onto `makeAIRequest`'s existing retry logic.
- **Rollback:** falls back to the existing "leave blank" guard if catalog integration is unavailable.
- **DoD:** a generation/edit involving a product/collection setting resolves to a real, verifiable handle or is explicitly left blank — never a fabricated handle reaching disk.

### Phase 14 — Image/Asset Integration

- **Objective:** Wire the already-built, disconnected image machinery (`generateSectionImages` et al., `example-implementation.js:775-967`, uses OpenRouter model `google/gemini-2.5-flash-image-preview`) into the staged pipeline and the (currently dead) `--images` flag.
- **Why here:** Deliberately late — the system is already safe without it (forces images blank). Must land after Phase 7, so generated images aren't wiped by a subsequent full-overwrite, and after Phase 6, so hallucination guards apply consistently to real image URLs.
- **Builds on:** `runFullPipeline()` currently destructures `generateImages` from options (line 35) and never reads it again — the fix is adding the actual call site plus a merge-safe write path via `2-copy-to-theme.js`.
- **Validation:** enable `--images`, confirm generated assets land correctly and survive a subsequent unrelated content edit (proves integration with merge-based apply, not the old overwrite path).
- **Risk:** tempting to build early ("it already exists, just wire it up") — but wiring it before Phase 7 means generated images are one full-overwrite away from being silently discarded, wasting API spend for nothing.
- **Rollback:** `--images` flag can be turned back off with zero impact on the rest of the pipeline.
- **DoD:** `--images` actually does something; generated images survive a subsequent unrelated edit.

### Phase 15 — Versioning / Undo / Rollback Safety

- **Objective:** Snapshot `ThemeState` before every apply and support rollback.
- **Why here:** Explicitly lower priority per the target architecture, but technically straightforward once Phase 4 + Phase 7 exist — mostly "keep the prior state around and expose a restore op." Sequenced late because it's a safety net around capabilities (editing, redesign) that need to exist first.
- **Builds on:** `ThemeState` snapshots taken immediately before each apply step; no existing-code equivalent.
- **Validation:** apply an edit, then a redesign, then roll back one step — `ThemeState` and on-disk files must match the pre-redesign snapshot exactly.
- **Risk:** unbounded snapshot growth if every micro-edit gets a full snapshot — needs a retention/pruning policy from day one.
- **Rollback:** this phase *is* the rollback mechanism; failure mode is simply "no undo available yet," not destructive.
- **DoD:** any single apply (generation, edit, or redesign batch) rolls back to the immediately prior state, verified byte-identical against theme files.

### Phase 16 — Production Hardening

- **Objective:** Rate limiting, secrets handling, concurrent-request safety, structured error surfaces, security review.
- **Why last:** hardening a moving target is wasted effort; this phase closes gaps that only matter once real users hit the system concurrently, and there's no server/API layer in this repo today to harden until that's built (a separate scope decision, per the audit's §0 finding).
- **Builds on:** everything — `makeAIRequest`'s retry/backoff becomes the baseline to harden further (timeout ceilings, circuit breaking).
- **Validation:** concurrency test (simultaneous edits against shared `ThemeState` must not race); security review of secrets handling and Phase 13/14's new external API integrations.
- **Risk:** compressed or skipped under launch pressure — flag explicitly as gating before any multi-tenant rollout.
- **DoD:** concurrent edits don't corrupt state; security review closed with no open criticals.

---

## 4. Dependency Graph

```
Phase 1 (Baseline/Instrumentation)
   │
   ├─────────────────────────────┐
   ▼                              ▼
Phase 2 (Capability Index)   Phase 3 (Clarification+Brief)     ← parallel, different people
   │                              │
   ▼ (also needs only Phase 1)    │
Phase 4 (ThemeState) ─────────────┤
   │                              │
   └──────────────┬───────────────┘
                   ▼
        Phase 5 (Staged Generation) ── Phase 6 (Validation Ext.)   ← parallel, same file, coordinate via Phase 1 suite
                   │                        │
                   └───────────┬────────────┘
                                ▼
                    Phase 7 (Merge-Based Apply)   ← hard-blocks everything below
                                ▼
                    Phase 8 (Operations Engine)   ← do NOT build before Phase 7 (see §6)
                                ▼
                    Phase 9 (Targeted Editing)   ═══ MVP COMPLETE ═══
                                │
              ┌─────────────────┼─────────────────┐
              ▼                                    ▼
     Phase 10 (Redesign)                  Phase 15 (Versioning/Undo)     ← parallel

Phase 2 ──▶ Phase 11 (Schema Coverage) ──▶ Phase 12 (Multi-Page) ──▶ Phase 13 (Catalog)
                                                                          │
Phase 7 ──▶ Phase 14 (Image/Asset)  ← independent of 10-13, slots in anytime after 7

All phases ──▶ Phase 16 (Production Hardening)   ← last

```

**Strictly sequential critical path (no parallelization possible):** Phase 4 → Phase 7 → Phase 8 → Phase 9.

---

## 5. MVP Scope

**Required (Phases 1–9, in order, no skips):** baseline instrumentation → capability index → clarification/brief → ThemeState → staged generation → validation extension → merge-based apply → operations engine → targeted editing. This is the smallest slice that satisfies: describe a site → clarify → generate homepage → validate → apply → then successfully content-edit and design-edit that homepage without touching unrelated sections.

**Post-MVP, important:** Phase 10 (redesign), Phase 11 (schema coverage), Phase 12 (multi-page — explicitly lower priority per the original brief), Phase 13 (catalog — MVP ships safely today by continuing to force catalog fields blank, same as the existing image guard), Phase 15 (undo — important before real users edit real stores, not required to demonstrate the MVP loop), Phase 16 (irrelevant to a single-operator MVP demo).

**Optional / only if proven necessary:** semantic/vector retrieval — explicitly not a phase; only pursue if Phase 2's deterministic retrieval demonstrably misses on paraphrased briefs in practice. Phase 14 (image integration) — already safe without it; wire up on real demand, no architectural rework needed later regardless of timing.

---

## 6. Biggest Sequencing Risk

**Building the operations engine and editing flow (Phases 8–9) before ThemeState (Phase 4) and merge-based apply (Phase 7) land.** It's tempting to jump straight to "editing" since it's the most visibly-missing capability (confirmed: zero editing code exists today), but the current apply layer full-overwrites `index.json`/`settings_data.json` on every run except for the one narrow `mergeProductTemplate()` case. An operation-based edit engine built against that foundation has nothing stable to diff against and nothing safe to write into — the very next run would silently clobber it, exactly the failure mode already documented for `settings_data.json` today. Prove non-destructive merge works generally (Phase 7) before building the operation engine on top of it.

**Secondary risk:** authoring the \~97-file schema expansion (Phase 11) before the capability-index format (Phase 2) stabilizes — a costly re-authoring pass if the taxonomy shape changes mid-effort. Get Phase 2 stable (even if narrow in scope) before greenlighting the bulk of Phase 11.

---

## 7. Verification Plan

Once a phase is implemented, verify it against the concrete test scenarios already embedded in each phase's Validation section above, plus these end-to-end checks drawn from the original brief:

- **Scenario 1 (specific generation):** "Create a premium pet wellness store for dogs and cats" → confirm pet/wellness-relevant sections are retrieved (Phase 2/5), content is niche-specific not generic (Phase 5), no unrelated schema flood in the logged prompt size (Phase 1 instrumentation).
- **Scenario 2 (ambiguous request):** "Make me a premium store" → must trigger `NEEDS_CLARIFICATION` (Phase 3), never silently generate.
- **Scenarios 3/4 (content vs. design edit):** exact fixtures already specified in Phase 9's DoD.
- **Scenario 5 (structural edit):** "Add testimonials below featured products" → single `insert_section` op, existing sections untouched (Phase 8/9).
- **Scenario 6 (redesign):** Phase 10's DoD fixture.
- **Scenario 7/8 (invalid output / unknown section):** confirm bounded repair loop and hard rejection respectively (Phase 6).
- **Scenario 9 (product/collection reference):** confirm no hallucinated handles once Phase 13 lands, and confirm fields are safely left blank before it does.
- **Scenario 10 (repeated edits):** three sequential edits against the same generated homepage — each sees current state, prior edits are preserved, unrelated sections stay untouched (Phase 4/7/9 working together).

Each phase should be run manually against these fixtures plus its own unit/regression tests before moving to the next phase — no phase should be considered "done" purely because its own isolated tests pass if it changes shared state that a scenario above exercises.

---

**STOP. This is the complete phase plan. No implementation has been started.** Awaiting review — tell me which phase to begin once you've had a chance to look this over.

---

## 8. Technology Stack & Future Architecture Constraint

The future AI Theme Builder application should use the following stack where those capabilities are introduced:

- **Next.js** — application/web layer, server actions/API routes, AI Builder UI, orchestration where appropriate.
- **DaisyUI** — primary UI component/styling layer where suitable.
- **Base UI** — accessible/headless interaction primitives where suitable.
- **PostgreSQL** — persistent application data/state when persistence becomes necessary.

### Important implementation rule

Do **not** introduce Next.js, DaisyUI, Base UI, or PostgreSQL into the current CLI pipeline prematurely just because they are part of the target stack.

The existing repository is currently a Node.js CLI pipeline. Preserve the working CLI architecture while implementing the early foundational phases where possible.

Introduce the target stack only when a phase genuinely requires it:

- Next.js when the actual AI Builder web application / server layer is introduced.
- DaisyUI and Base UI when the AI Builder interface is implemented.
- PostgreSQL when persistent application state, conversations, ThemeState persistence, projects, users, version history, or other database-backed requirements are actually introduced.

Do not create a database schema or database dependency merely for Phase 1 instrumentation.

Do not migrate the existing CLI to Next.js before there is a concrete phase requiring the web application.

The target architecture should therefore support an incremental migration:

```text
CURRENT
Node.js CLI
   ↓
Phase 1–foundational AI architecture
   ↓
Stable domain/state/orchestration layers
   ↓
Next.js application layer
   ├── DaisyUI
   └── Base UI
   ↓
PostgreSQL persistence when required
```

The exact phase at which each technology is introduced should be decided from the actual implementation dependencies rather than forced into earlier phases.

---

## 9. Implementation Governance

The approved roadmap is a **phase-by-phase implementation plan**, not permission to implement all phases at once.

For every implementation request:

1. Implement only the explicitly requested phase.
2. Do not start future phases automatically.
3. Do not introduce future infrastructure prematurely.
4. Preserve backward compatibility where practical.
5. Run the phase's tests and relevant regression tests.
6. Report changed files, behavior changes, tests, and remaining risks.
7. Stop after the requested phase and wait for approval for the next phase.

The current approved implementation order begins with:

```text
Phase 1 — Baseline Regression Safety Net & Instrumentation
        ↓
Phase 2 — Schema Capability Index + Deterministic Retrieval
        ↓
Phase 3 — Request Understanding + Clarification + WebsiteBrief
        ↓
Phase 4 — ThemeState
        ↓
Phase 5 — Staged Initial Generation
        ↓
Phase 6 — Validation Extension
        ↓
Phase 7 — Merge-Based Apply
        ↓
Phase 8 — Structured Operations
        ↓
Phase 9 — Targeted Editing
```

**Do not implement Phase 2 or later while executing Phase 1 unless explicitly instructed.**

