# Phase 5 — Staged Initial-Generation Pipeline — Report

Scope executed: **Phase 5 only**, per `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance) and the detailed Phase 5 spec (`AI_THEME_BUILDER_PHASE5_PLAN.md`). No later phase (merge-based apply, structured operations, targeted editing, redesign, undo/redo, PostgreSQL, Next.js/DaisyUI/Base UI, preview) was started. The legacy single-mega-prompt path remains the default and is unchanged in behavior.

---

## Objective

Connect Phases 2–4 into the first real initial-generation pipeline: a merchant's `WebsiteBrief` (Phase 3) plus the live theme's `ThemeState` (Phase 4) plus Phase 2's deterministic retrieval, feeding a **staged** generation — decide the structure first, configure it second — instead of one mega-prompt that decides everything at once. This directly targets the audit's root-cause-B problem (generic output for ambiguous prompts) and the Phase 1 baseline's 64K-char, ~16K-token single system prompt.

## Before flow

```
userPrompt --> loadSchemas (full or Phase 2 retrieval) --> buildSystemPrompt (all retrieved schemas)
            --> ONE makeAIRequest call (decides structure AND content together)
            --> validateOutput --> theme JSON candidate
```

## After flow (opt-in, `--staged`/`STAGED_MODE=true`)

```
userPrompt --> STEP 0 understandRequest() [implied on]  -->  WebsiteBrief (READY)
            --> STEP 1 loadSchemas() [full catalog — retrieval runs internally in Stage 1/2]
            --> STEP 3 colors [unchanged, shared with the legacy path]
            --> STEP 4a buildThemeState() [Phase 4, read-only, no AI call]
            --> STEP 4b runStagedGeneration():
                   briefToSummaryText(brief) --> retrieveRelevantSchemas() [Phase 2, reused, unmodified]
                        --> Stage 1 PLANNING call --> GenerationPlan --> validateGenerationPlan()
                                (bounded 1-retry repair; invalid after repair => throw, Stage 2 never runs)
                        --> Stage 2 CONFIGURATION call --> validateOutput() [Phase 1, reused, unmodified]
                                + matchesPlan() (plan-conformance check)
                                (bounded 1-retry repair; invalid after repair => throw)
            --> validated theme JSON candidate (same {sections, order} shape as the legacy path)
```

`--staged` implies `--understanding` (Stage 1/2 requires a resolved `WebsiteBrief` as its authoritative input, per spec §6) — a caller doesn't need to separately remember both flags.

## Files created

- `ai-schema/generation.js` — `lightweightCapabilityListing`, `buildPlanningSystemPrompt`/`buildPlanningUserPrompt`, `validateGenerationPlan`, `runPlanningStage`, `buildConfigurationSystemPrompt`/`buildConfigurationUserPrompt`, `matchesPlan`, `runConfigurationStage`, `runStagedGeneration`.
- `ai-schema/test/generation.test.js` (19 tests), `ai-schema/test/phase5Regression.test.js` (4 tests).

## Files modified (additive only — no existing behavior changed)

- `ai-schema/retrieval.js` — exported the existing `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE` constant (was previously module-private) so `generation.js` can enforce the same product-template rule instead of re-deriving it. Zero logic change; `phase2Regression.test.js`/`retrieval.test.js` still pass unchanged.
- `ai-schema/brief.js` — added `briefToSummaryText(brief)`, a pure formatter with no effect on any existing exported function.
- `ai-schema/theme-state.js` — added `selectGenerationContext(themeState, templateName)`, a pure read-only selector with no effect on `buildThemeState`/`validateThemeState`/`serializeThemeState`/persistence.
- `ai-schema/1-generate-theme.js` — `runFullPipeline()` gained an opt-in `stagedMode` option (default `false`, or `STAGED_MODE=true`), following the exact opt-in pattern already established by `retrievalMode`/`understandingMode`. The non-staged branch of STEP 2/4/5 is the pre-Phase-5 code, unmoved except for being wrapped in an `else`. `parseArgs()` gained `--staged`/`--no-staged` CLI flags.

## Files deliberately NOT changed

`example-implementation.js` (`buildSystemPrompt`, `makeAIRequest`, `validateOutput`, `generateAIColorPalette`, `detectNicheAndGetColors`, `generateThemeFiles` — all reused verbatim, not one line touched), `capability-index.js`, `retrieval-rules.json`, `clarification.js`, `2-copy-to-theme.js`, all schema files, and — as with every prior phase — the live theme's top-level `templates/*.json` / `config/*.json` (confirmed via `git status` and an explicit isolation test, see "Tests" below).

---

## WebsiteBrief integration

`briefToSummaryText(brief)` (new, in `brief.js`) flattens only the *present* fields (`isFieldPresent`) of a resolved `WebsiteBrief` into one string, e.g. `"businessType: pet wellness store; niche: pet wellness; targetAudience: dog and cat owners"`. This string is the single input both `retrieveRelevantSchemas()` and the Stage 1/2 prompts consume — raw conversational text is never sent to generation once a brief exists. `runStagedGeneration()` throws immediately if no brief is supplied (§6 — the brief is the authoritative input, not an optional add-on).

## ThemeState integration

`selectGenerationContext(themeState, templateName)` (new, in `theme-state.js`) extracts, deterministically and without any AI call:
- whether the target template currently exists, and if so its existing section `order` and a lightweight `{id, type, knownToAI, blockCount}` per section (no full settings)
- the theme's current global `settings_data.json` → `current` values

This is embedded in both stage prompts as *context, not directives* — Stage 1's prompt lists existing section types under "CURRENT THEME AWARENESS" (informational, not a hard constraint — see "Known limitations"); Stage 2's prompt surfaces only the `colors_*`/`gradient_*` keys from current global settings, so generated content can stay tonally consistent with the live theme's palette without ever being told to output global settings itself. **The full ~333K-char `ThemeState` (measured in `PHASE4_REPORT.md`) is never sent anywhere** — only this bounded slice.

## Retrieval integration

Unchanged Phase 2 code (`retrieveRelevantSchemas`, `matchRules`, the fallback/floor logic, `retrieval-rules.json`) is called exactly as before, just with `briefToSummaryText(brief)` as its `userPrompt` argument instead of the raw user prompt string (§24). No LLM call decides which schemas to retrieve — that invariant, already true before Phase 5, is untouched.

**Real finding, not simulated:** `retrieval-rules.json` is deliberately generic e-commerce vocabulary (documented in its own file header — "no niche-specific words... deliberately"), not niche-aware. Testing all three required scenarios below showed each brief's `businessType` phrase (all containing "store" or "page") triggers only the `defaultRule`, so **all three scenarios retrieved the identical candidate set** (11 sections / 23 blocks for the `index` template) — retrieval differentiates by generic commercial intent, not by niche. This is a property of Phase 2's existing rule set, unchanged and out of this phase's scope to modify; it's called out here because it directly shapes the token measurements below and is worth knowing for a future phase that might want niche-aware retrieval rules.

## Staged generation

**Stage 1 — Planning** (`runPlanningStage`): one AI call (JSON mode, single system+user turn, reusing `makeAIRequest()`). Its prompt (`buildPlanningSystemPrompt`) lists only a **lightweight capability index** of the retrieved candidates (`lightweightCapabilityListing` — id/label/summary/hasBlocks/allowedBlockCount/maxBlocks; no settings definitions at all) — never the full schema catalog. Output is a `GenerationPlan` (see below), validated by `validateGenerationPlan()` against the *retrieved* candidate set specifically (not the full catalog — §12), including the product-template forced-exclusivity rule reused from `retrieval.js`. One bounded repair retry (validation errors appended to the prompt) if invalid; throws — **Stage 2 never runs** — if the repair attempt is also invalid (§21).

**Stage 2 — Configuration** (`runConfigurationStage`): one AI call, reusing `makeAIRequest()` again. Its prompt (`buildConfigurationSystemPrompt`) is scoped to **only** the section/block schema types the approved plan actually uses (verified by test: a type present in the retrieved pool but absent from the plan never appears in this prompt). Output is validated by the **existing, unmodified** `validateOutput()` — same section/block/allowed_blocks/max_blocks/image-hallucination checks as the legacy path, zero new Shopify-JSON validation logic — plus a new `matchesPlan()` check confirming the output didn't structurally drift from what Stage 1 approved (order, section types, block-type multiset per section). One bounded repair retry; throws if still invalid after repair.

Both stages carry the same content-generation rules as the legacy prompt (richtext HTML wrapping, empty-string image fields, no hallucinated product/collection handles) — necessarily re-stated rather than imported, since `buildSystemPrompt()` in `example-implementation.js` was intentionally left untouched (zero regression risk to the already-accepted legacy path) and its prose also includes rules Stage 1/2 don't need (10-section homepage cap details, "use at least 8 different section types" variety mandate — Stage 1 already owns composition decisions).

## GenerationPlan (actual structure)

```json
{
  "templateName": "index",
  "order": ["hero-1", "trust-1", "showcase-1"],
  "sections": {
    "hero-1": { "type": "slideshow", "blockTypes": ["slide", "slide"] },
    "trust-1": { "type": "icon-bar", "blockTypes": ["column", "column", "column"] },
    "showcase-1": { "type": "featured-collection", "blockTypes": [] }
  }
}
```
Section id keys are the AI's own slugs; `type` must be copied verbatim from the lightweight listing; `blockTypes` is a flat list (count + type, no settings). This intermediate structure is validated (never treated as free-form text) before Stage 2 is allowed to consume it — matching §22's "do not use free-form AI text as an internal contract."

## Validation & recovery

| Layer | What it checks | Reused or new |
|---|---|---|
| `validateGenerationPlan` | plan shape, order↔sections consistency, section/block types within the *retrieved* set, `allowed_blocks`/`max_blocks` respected, product-template exclusivity | new (no prior equivalent — Stage 1's output shape didn't exist before) |
| `validateOutput` | section/block type validity, `allowed_blocks`, `max_blocks`, `block_order` consistency, image-hallucination guard, ≤10 sections | **reused verbatim from Phase 1**, zero changes |
| `matchesPlan` | Stage 2's output didn't silently retype/reorder/recompose relative to the approved plan | new (this specific cross-check has no prior equivalent — `validateOutput` alone would accept a *different but still schema-valid* structure) |

Recovery is identically bounded at both stages: one AI call → validate → if invalid, exactly one repair call (errors appended to the prompt) → validate again → if still invalid, **throw** (caught by `runFullPipeline`'s existing try/catch → `process.exit(1)`, same as any other pipeline error). No infinite loops, no silent continuation on invalid output — verified by test (`runPlanningStage`/`runConfigurationStage` "throws... exactly plan + one repair attempt, then stop").

## Existing theme protection

- Only section/block **types already present in the retrieved candidate set** can appear in a plan — `validateGenerationPlan` rejects anything else, even if it's a real type elsewhere in the full catalog (test: `main-product` rejected when not in the `index`-template retrieved pool).
- Stage 2 can only use types the plan already approved — enforced twice: once by `buildConfigurationSystemPrompt`'s scoped-down schema listing (the AI is never even shown other types), once by `validateOutput` + `matchesPlan` after the fact.
- `ThemeState`'s unknown-to-AI sections/blocks (39/47 in the real theme, per `PHASE4_REPORT.md`) are never modified — Phase 5 doesn't write anywhere near them; `selectGenerationContext` only *reads* them for informational context (id/type/knownToAI), same non-destructive posture `ThemeState` itself established.
- No product handles, collection handles, or other merchant data are invented — Stage 2's prompt rule 9 explicitly instructs leaving such fields empty, and this is the same posture (never weakened) as `validateOutput`'s existing image-hallucination guard, which is reused unchanged.
- **No live apply**: `runStagedGeneration()` returns a candidate object only — it never calls `generateThemeFiles`/`copyGeneratedFilesToTheme` itself; those remain `1-generate-theme.js`'s STEP 6/7, gated by the pre-existing `autoCopy` flag exactly as before Phase 5.

---

## Token / cost measurements (real, not estimated)

**Before (Phase 1 baseline, full-schema mode):** 1 call, system prompt 64,260 chars (~16,065 tokens).

All three required scenarios' briefs triggered the same retrieval outcome (see "Retrieval integration" above — a real finding about the current rule set, not a testing artifact):

| Scenario | Brief | Retrieval | Sections / Blocks |
|---|---|---|---|
| 1 | "premium pet wellness store for dogs and cats" | RETRIEVAL (defaultRule via "store") | 11 / 23 |
| 2 | "luxury fashion store" | RETRIEVAL (defaultRule via "store") | 11 / 23 |
| 3 | "modern SaaS landing page" | RETRIEVAL (defaultRule via "page") | 11 / 23 |

Measured for a realistic 5-section plan (hero + trust + showcase + social-proof + newsletter, built from Scenario 1's actual retrieved candidates, respecting real `allowed_blocks`/`max_blocks`):

| | Stage 1 (planning) | Stage 2 (configuration) | **Total (both calls)** |
|---|---:|---:|---:|
| System prompt chars | 6,726 | 8,132 | |
| User prompt chars | 200 | 201 | |
| **Total chars** | 6,926 | 8,333 | **15,259** |
| Est. tokens (chars/4) | 1,732 | 2,083 | **3,815** |

**Staged total input (both calls) is ~15.3K chars / ~3.8K tokens, a 76% reduction versus the legacy single call's 64.3K chars / ~16.1K tokens** — at the cost of one additional AI call (2 calls instead of 1 for the generation step itself; 3 total per run including the unchanged color call, versus 2 today; 4 total when `--understanding`'s own call is also counted, versus 2 today).

## Call count

| Path | Calls | Breakdown |
|---|---:|---|
| Legacy (default) | 2 | color + main generation |
| `--understanding` only | 3 | understanding + color + main generation |
| `--staged` (implies understanding) | 4 (+0–2 on repair) | understanding + color + plan + configure |

No call was added without a concrete purpose (§11): planning and configuration each answer a genuinely different question (what to build vs. how to fill it in), and both are bounded (max 1 repair each) rather than open-ended.

---

## Tests

**135 tests total, all passing** — every prior phase's suite plus:

- **`test/generation.test.js`** (19 tests) — `lightweightCapabilityListing` strips settings; `validateGenerationPlan` accepts a valid real-schema plan and rejects (separately) an out-of-pool type, a disallowed block-in-section, an exceeded `max_blocks`, order/sections mismatches, and validates the product-template forced-exclusivity rule both ways; `matchesPlan` accepts an exact match and rejects order drift / block-count drift / unplanned block types; `buildConfigurationSystemPrompt` proves prompt scoping (an unused real schema never appears); `runPlanningStage`/`runConfigurationStage` each cover first-try success, one bounded repair success, and repair-still-invalid → throw (with exact call-count assertions proving no extra retries); `runStagedGeneration` end-to-end against the **real schema catalog** via the deterministic product-template path, plus input-guard tests (missing brief/schemas).
- **`test/phase5Regression.test.js`** (4 tests) — default behavior is byte-identical to pre-Phase-5 (exactly 2 AI calls), `stagedMode:true` + READY brief runs all 4 calls and returns a validated candidate, `stagedMode:true` + `NEEDS_CLARIFICATION` stops after exactly 1 call (no ThemeState build, no color/plan/configure calls), and an isolation test that reads the real `templates/index.json` byte-for-byte before/after a full staged run and asserts it's unchanged.

All Phase 1–4 tests (baseline, buildSystemPrompt, instrumentation, loadSchemas, runFullPipeline, validateOutput, capabilityIndex, retrieval, phase2Regression, brief, clarification, phase3Regression, themeState) remain passing unchanged.

## Real theme test

`runStagedGeneration()`'s retrieval and `buildThemeState()`'s ThemeState construction both run against the **actual** `ai-schema/sections`/`ai-schema/blocks` catalog and the actual top-level theme (24 templates, 85 sections, 258 blocks — same numbers as `PHASE4_REPORT.md`) in `test/generation.test.js`/`test/phase5Regression.test.js` — only the two AI calls themselves are mocked (no API spend). The isolation test in `phase5Regression.test.js` empirically confirms (byte-for-byte file comparison, not just code inspection) that a full staged run — including building live `ThemeState` — never modifies `templates/index.json`.

## Known limitations

- **"Prefer existing structure" is prompt guidance only, not a hard validator rule.** Spec §14/§15 use "prefer"/"wherever possible" language; `buildPlanningSystemPrompt`'s "CURRENT THEME AWARENESS" section surfaces existing section types as context and asks the model to reuse a similar composition when it fits, but nothing in `validateGenerationPlan` enforces this — making it a hard rule risked brittle repair loops (a plan can't be definitively judged "insufficiently similar to what already exists" the way "this block type isn't in `allowed_blocks`" can). This is a conscious choice, not an oversight.
- **Hero-first placement for `index` is also guidance, not enforced.** Same reasoning — Stage 1's prompt suggests a hero-category section first when one is available, but `validateGenerationPlan` doesn't reject a plan that omits or reorders it, to avoid an over-eager repair loop on a stylistic (not correctness) preference. The legacy path's hardcoded "index must start with slideshow" rule is *not* carried forward as a hard constraint in the staged path for this reason.
- **Stage 2's rules text is necessarily duplicated (not imported) from `buildSystemPrompt()`.** Documented above under "Staged generation" — a deliberate scope boundary to keep the legacy path's already-accepted code untouched, not a reuse failure.
- **Retrieval doesn't yet differentiate by niche** (see "Retrieval integration" above) — all three required scenarios retrieved the same candidate pool. This is inherited, unmodified Phase 2 behavior; a future phase could add niche-aware keywords to `retrieval-rules.json` without touching anything Phase 5 built.
- **No merge with existing content.** Per the strict phase boundary (§40), the staged output is a fresh candidate, not merged against `ThemeState`'s existing configuration for the target template — `selectGenerationContext`'s existing-section info is informational only in this phase. Actual merge-based apply is Phase 7's job.
- **Collection/blog/article/cart/search templates remain unsupported** for staged generation, same as the legacy path — `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE` only knows about `product`; any other non-`index` template runs through the general floor/fallback retrieval logic already established in Phase 2, untested here beyond `index`/`product` per §26.

## Definition of Done

- [x] `WebsiteBrief` is used as the structured generation input.
- [x] Relevant existing `ThemeState` context is selected deterministically (no AI call).
- [x] Phase 2 deterministic retrieval is integrated (reused, unmodified).
- [x] Full schema catalog is not unnecessarily sent (bounded, plan-scoped prompts; measured).
- [x] Full `ThemeState` is not unnecessarily sent (bounded selector; measured against the 333K-char baseline).
- [x] Staged generation exists with meaningful stage boundaries (structure vs. configuration).
- [x] Stage 1 produces a validated `GenerationPlan`.
- [x] Stage 2 produces a validated existing-theme JSON candidate.
- [x] Only existing section/block types are used (validated against the retrieved set, not just the full catalog).
- [x] Existing Shopify JSON structure is preserved (`{sections, order}`, same shape `validateOutput` already expects).
- [x] Existing validation remains active (`validateOutput` reused verbatim).
- [x] Invalid intermediate/final output receives bounded recovery (exactly one repair attempt per stage, tested).
- [x] Unknown live theme components are preserved (never touched by this phase).
- [x] Merchant-specific content can configure existing supported fields (Stage 2 content generation, grounded in the brief).
- [x] Product/data references are not hallucinated (Stage 2 rule 9; `validateOutput`'s image guard unweakened).
- [x] Real token/call measurements are recorded (above).
- [x] Phase 1 tests pass.
- [x] Phase 2 tests pass.
- [x] Phase 3 tests pass.
- [x] Phase 4 tests pass.
- [x] Phase 5 tests pass (23 new tests).
- [x] Live theme files remain untouched (empirically tested).
- [x] PostgreSQL is not introduced.
- [x] Next.js/DaisyUI/Base UI are not introduced.
- [x] No Phase 6+ functionality is implemented (no merge/apply, no operations, no editing).

**STOP.** Per the phase plan's strict stop condition, Phase 6 (Validation Extension) and everything after it is out of scope for this change and was not started.
