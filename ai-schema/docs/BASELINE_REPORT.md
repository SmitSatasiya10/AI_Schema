# Phase 1 — Baseline Regression Safety Net & Instrumentation — Report

Scope executed: **Phase 1 only**, per `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). No later phase was started. No generation behavior was changed — this phase added measurement and regression tests only.

---

## Baseline

Measured directly by running the real `loadSchemas()` / `buildSystemPrompt()` functions against the schemas currently on disk (see `test/baseline.test.js`, which regenerates `BASELINE_MEASUREMENTS.json` on every `npm test` run):

```json
{
  "measuredAt": "2026-08-17T04:06:46.351Z",
  "sectionSchemaCount": 16,
  "blockSchemaCount": 53,
  "globalSettingsKeyCount": 9,
  "systemPromptChars": 59702,
  "estimatedSystemPromptTokens": 14926,
  "openRouterCallsPerGeneration": 2,
  "model": "moonshotai/kimi-k2.5"
}
```

- **Schema count:** 16 section schemas (`ai-schema/sections/*.json`) + 53 block schemas (`ai-schema/blocks/*.json`) = 69 total, all loaded unconditionally on every `loadSchemas()` call. (This confirms — and doesn't yet fix — the number already documented in `AUDIT.md`; the originally-assumed "109 sections / 293 blocks" does not match what's on disk.)
- **Prompt character count:** 59,702 characters for the full system prompt (`buildSystemPrompt()`), dominated by `JSON.stringify()` of all 69 schemas.
- **Estimated input tokens:** 14,926 (chars/4 heuristic, via `instrumentation.estimateTokensFromChars()`).
- **OpenRouter calls per generation:** 2 — one `generateAIColorPalette()` call (color palette) and one `makeAIRequest()` call (main theme JSON) per `runFullPipeline()` invocation. This is a structural count read from `1-generate-theme.js`'s fixed call sequence, not a live-API measurement (no API key was used; the test suite mocks `global.fetch` throughout).
- **Model:** `moonshotai/kimi-k2.5` (the actual code default in `example-implementation.js`; `.env.example` documents a stale `openai/gpt-4-turbo` comment that does not match the real default — a pre-existing inconsistency, not something Phase 1 touched).
- **Validation coverage tested:** section type membership, block type membership, `allowed_blocks` enforcement, `max_blocks` enforcement, `block_order` completeness/consistency, image/`image_picker` hallucination guard, structural checks (empty order, >10 sections, malformed JSON, order-references-unknown-section). See `test/validateOutput.test.js` (17 tests).

Re-run `npm test` inside `ai-schema/ai-schema/` at any time to re-measure; `BASELINE_MEASUREMENTS.json` is overwritten with fresh numbers each run so this document never goes stale silently — compare its `measuredAt` against a later phase's numbers to see the actual effect of that phase.

---

## Files changed

| File | Change | Why |
|---|---|---|
| `ai-schema/instrumentation.js` (new) | Pure logging/measurement helper: `nextRequestId`, `estimateTokensFromChars`, `logAICall`, `logValidation`, `logPipeline`. No control-flow logic — only computes numbers and calls `console.log`. | Central place for the structured instrumentation the phase requires, reusable by later phases without duplicating logging code at every call site. |
| `ai-schema/example-implementation.js` | `makeAIRequest()`, `generateAIColorPalette()`, `validateOutput()` each gained one new **optional, defaulted** parameter (`context = {}`) and now call `instrumentation.logAICall()` / `instrumentation.logValidation()` at their existing return/throw points. No existing logic, retry behavior, or return values were changed — only additive logging calls were inserted around them. | Exposes request ID, call type, model, prompt/output size, estimated tokens, duration, retry count, and validation result for every AI call and every validation run, per the phase's goal #3, without touching what these functions actually do. |
| `ai-schema/1-generate-theme.js` | `runFullPipeline()` now generates one `requestId` per run, passes `{requestId, callType}` context into `makeAIRequest`/`generateAIColorPalette`/`validateOutput`, tracks `aiCallCount`, and logs one `instrumentation.logPipeline()` summary at the end (success or failure path). | Ties the per-call instrumentation together into one pipeline-level summary (schema counts, prompt size, AI call count, duration, template, success/failure) — goal #3's "selected/retrieved schema count when that capability exists later" is left as `null`/absent today since no retrieval exists yet (Phase 2's job). |
| `ai-schema/package.json` | Added `"test": "node --test"` script. No dependency added. | Node 22 (confirmed via `node --version`) ships a built-in test runner (`node:test`), so this satisfies "choose the smallest appropriate approach rather than introducing a large testing framework" without adding a new dependency to a project that currently has exactly one (`dotenv`). |
| `ai-schema/test/*.test.js` (new, 6 files) | New regression/characterization test suite — see below. | Phase 1's core deliverable. |
| `ai-schema/BASELINE_MEASUREMENTS.json` (new, generated) | Written by `test/baseline.test.js` on every test run. | Machine-readable baseline for later phases to diff against. |

**Files intentionally NOT changed:** `2-copy-to-theme.js`, `3-interactive-menu.js`, every schema JSON file in `sections/`/`blocks/`, `global.json`, `SCHEMA_CREATION_GUIDE.md`, and — critically — the real theme's top-level `templates/*.json` / `config/*.json`. Confirmed via `git status` after the full test run: only files under `ai-schema/` changed (plus `ai-schema/output/`'s two scratch files, which the new `runFullPipeline()` characterization test regenerates — that directory already held stale, non-gitignored multi-run debris before this phase, per `AUDIT.md` §4/§9).

---

## Tests

31 tests across 6 files, run via `npm test` (`node --test`), all passing:

- **`test/loadSchemas.test.js`** (4 tests) — global schema shape, section/block counts match the actual file count on disk (measured dynamically via `fs.readdir`, not hardcoded), every schema has an `id`, idempotency across repeated calls.
- **`test/buildSystemPrompt.test.js`** (3 tests) — required prompt section headers present, every loaded section/block `id` appears verbatim in the prompt, determinism for identical input.
- **`test/baseline.test.js`** (1 test) — the measurement described above; writes `BASELINE_MEASUREMENTS.json`.
- **`test/validateOutput.test.js`** (17 tests) — the core characterization suite:
  - valid config accepted (built from real `slideshow`/`testimonials` schemas)
  - unknown section type rejected
  - unknown block type rejected
  - block not in section's `allowed_blocks` rejected
  - `max_blocks` violation rejected (using `collage.json`'s real `max_blocks: 3`)
  - missing `block_order` rejected
  - `block_order` referencing an unknown block rejected
  - block missing from `block_order` rejected
  - image hallucination guard rejects an invented filename (mirrors the real `"vegan-bowl.jpg"` artifact found in `AUDIT.md` §4)
  - image hallucination guard accepts `""`, `shopify://...`, `https://...`
  - order referencing an unknown section rejected
  - empty `order` array rejected
  - >10 sections rejected
  - malformed JSON rejected
  - **two "known gap" tests that intentionally assert today's behavior**, not the desired future behavior: a hallucinated `product_picker` value (mirrors the real `"signature-vegan-chicken"` artifact) currently passes validation, and `validateOutput` has no `templateName` parameter yet. These exist so that when Phase 6 closes these gaps, it has to consciously update or delete these tests rather than the gap silently reopening later without anyone noticing.
- **`test/instrumentation.test.js`** (6 tests) — proves the instrumentation wiring didn't change behavior: `makeAIRequest()` returns identical content with/without a `context` argument, still throws after exhausting retries on 5xx, still returns null on `generateAIColorPalette()` failure, still returns the parsed palette on success — plus one test that captures `console.log` output and asserts a well-formed `[AI_CALL]` JSON line is emitted alongside the unchanged return value.
- **`test/runFullPipeline.test.js`** (1 test) — end-to-end happy path with `global.fetch` mocked and `{ autoCopy: false }`, asserting the full `loadSchemas → buildSystemPrompt → color call → main call → validate → generateThemeFiles` sequence still produces a valid result and **never calls `process.exit`**. Deliberately run with `autoCopy: false` so it never invokes `copyGeneratedFilesToTheme()` — `generateThemeFiles()` only writes to the disposable `ai-schema/output/` scratch directory, never to the live theme's `templates/`/`config/` at the repo root. Testing the `autoCopy: true` full-overwrite path against the real theme was intentionally left out of scope for this phase (that's the exact behavior Phase 7 changes).

All tests run offline against mocked `global.fetch` where an OpenRouter call is involved — no real API key or network access was used, and no cost was incurred.

---

## Behavior

**Confirmed unchanged.** Every existing check in `validateOutput()` (type membership, `allowed_blocks`, `max_blocks`, `block_order`, image hallucination guard) behaves identically to before, verified by the characterization suite. `makeAIRequest()`'s retry/backoff and `generateAIColorPalette()`'s null-on-failure fallback are verified identical with and without the new `context` parameter. `runFullPipeline()`'s step sequence, return shape (`{success, config, colors, files}`), and file-write targets are unchanged. The system prompt's contents were not modified — only wrapped with pre/post logging calls at existing call sites. No schema files, no validation logic, no retry logic, and no theme files were altered by this phase.

---

## Known limitations (explicitly deferred — not fixed in this phase)

Per the plan's critical rule, each of these is documented here and left to its designated later phase, not addressed now:

- **All 69 schemas are still loaded and sent on every call, unconditionally** (`loadSchemas()`, `buildSystemPrompt()`) — 59,702 characters / ~14,926 estimated tokens every generation. → **Phase 2** (schema capability index + deterministic retrieval).
- **No clarification step** — the system still infers/invents everything from one prompt in one shot. → **Phase 3**.
- **No `ThemeState`** — nothing reads back the current live theme before writing. → **Phase 4**.
- **`templates/index.json` and `config/settings_data.json` are still full overwrites** on every generation run (only `templates/product.json` is genuinely merged, via the existing `mergeProductTemplate()`). → **Phase 7**.
- **No editing flow exists** — every invocation is a fresh full generation. → **Phase 9**.
- **`validateOutput()` has no `allowed_on`-vs-template enforcement, no setting range/enum checks, and no product/collection hallucination guard** — confirmed and explicitly characterized by the two "KNOWN GAP" tests in `test/validateOutput.test.js` rather than silently left unverified. → **Phase 6**.
- **No retry/repair loop on validation failure** — `1-generate-theme.js` still throws and calls `process.exit(1)` immediately. → **Phase 6**.
- **`ai-schema/output/` remains non-gitignored, disposable scratch space** that accumulates run debris across invocations (confirmed still true — the new `runFullPipeline` test overwrote its two files as an expected side effect of running). Not addressed here since it was already flagged as a known issue in `AUDIT.md`, and fixing it isn't part of Phase 1's scope.

---

## Definition of Done — checked against the phase's stated bar

- ✅ Regression suite exists and passes against current behavior (31/31 tests passing).
- ✅ Every AI call site (`makeAIRequest`, `generateAIColorPalette`) logs size/cost via `instrumentation.logAICall`; `validateOutput` logs via `instrumentation.logValidation`; `runFullPipeline` logs a pipeline-level summary via `instrumentation.logPipeline`.
- ✅ Baseline numbers captured and committed to `BASELINE_MEASUREMENTS.json` (schema counts, prompt chars, estimated tokens, OpenRouter calls/generation, model) — measured from the real implementation, not hardcoded.
- ✅ Existing validation behavior (type membership, `allowed_blocks`, `max_blocks`, `block_order`, image hallucination guard) is preserved and covered by regression tests.
- ✅ Instrumentation proven not to change generation behavior (dedicated tests comparing with/without `context`, plus retry/fallback behavior tests).

**Phase 1 Definition of Done is satisfied.**

Stopping here per governance rules — awaiting explicit approval before starting Phase 2 (Schema Capability Index + Deterministic Retrieval).
