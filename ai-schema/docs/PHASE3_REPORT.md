# Phase 3 — Request Understanding + Clarification Loop + WebsiteBrief — Report

Scope executed: **Phase 3 only**, per `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance) and the detailed Phase 3 spec (`AI_THEME_BUILDER_PHASE3_PLAN.md`). No later phase (`ThemeState`, staged generation, structured operations, targeted editing, redesign, Next.js/DaisyUI/Base UI/PostgreSQL, preview) was started. The always-generate path (understanding disabled) remains the default and is unchanged in behavior.

---

## 1. Objective

Stop the pipeline from silently generating a theme when the merchant's request is ambiguous. Add a request-understanding stage that decides `READY` vs. `NEEDS_CLARIFICATION`, asks minimal targeted questions when necessary, and produces a structured `WebsiteBrief` — without generating any homepage/section/block JSON, Liquid, CSS, or JS itself.

## 2. Before flow

```
user prompt --> STEP 1 loadSchemas --> STEP 2 buildSystemPrompt --> STEP 3 color call
             --> STEP 4 main generation call --> STEP 5 validate --> STEP 6 write files --> STEP 7 copy
```

Every invocation generated *something*, however vague the prompt ("Make me a premium store" produced a full random homepage — see `AUDIT.md` root cause B).

## 3. After flow (opt-in)

```
user prompt --> STEP 0 understandRequest() [opt-in via understandingMode/--understanding]
                    |
                    +-- NEEDS_CLARIFICATION --> print questions, return {success:false, ...}, STOP
                    |                            (no schema load, no AI generation call)
                    |
                    +-- READY --> STEP 1 loadSchemas --> ... unchanged through STEP 7
```

Default behavior (`understandingMode` unset) is **byte-for-byte identical** to before — STEP 0 is skipped entirely, confirmed by `test/phase3Regression.test.js` counting exactly 2 AI calls (color + main generation), never 3.

## 4. Files created

- `ai-schema/brief.js` — `WebsiteBrief` model (`createEmptyBrief`, `mergeField`, `mergeBrief`, `isReady`, `missingBlockingFields`, `isValidBriefShape`) + file-based persistence (`saveBrief`/`loadBrief`, keyed by session id, under `output/briefs/<sessionId>.json`).
- `ai-schema/clarification.js` — `buildUnderstandingPrompt`, `requestUnderstanding` (the AI call), `validateUnderstandingResult`, `understandRequest` (the full per-turn orchestrator: load prior state, call AI, bounded repair retry, merge, dedupe questions, apply round caps, persist).
- `ai-schema/test/brief.test.js`, `ai-schema/test/clarification.test.js`, `ai-schema/test/phase3Regression.test.js` — 30 new tests.

## 5. Files modified

- `ai-schema/instrumentation.js` — added `logUnderstanding()` alongside the existing Phase 1/2 loggers (same `[TAG] {json}` pattern, no new logging system).
- `ai-schema/1-generate-theme.js` — `runFullPipeline()` gained an opt-in `understandingMode` option (default `false`, or `UNDERSTANDING_MODE=true` env var) and a `sessionId` option, exactly mirroring the existing `retrievalMode` opt-in pattern from Phase 2. When enabled, STEP 0 runs before STEP 1 (`loadSchemas`); a `NEEDS_CLARIFICATION` result returns early without touching STEP 1–7. `parseArgs()` gained `--understanding` / `--no-understanding` / `--session <id>` CLI flags.
- `ai-schema/3-interactive-menu.js` — added a new menu option ("Custom description with AI clarification") that drives a real Q&A loop via `understandRequest()`/readline. **The original niche-picklist options (1–4) and their canned prompt banks are untouched** — the new option is additive, not a replacement, per the phase's own rollback requirement ("the clarification pass can be bypassed entirely").

## 6. Files deliberately NOT changed

`example-implementation.js`, `2-copy-to-theme.js`, `capability-index.js`, `retrieval.js`, `retrieval-rules.json`, all schema files, and — as with Phases 1–2 — the live theme's top-level `templates/*.json` / `config/*.json` (confirmed via `git status`: no top-level `config/`, `templates/`, `sections/`, `blocks/`, `layout/`, `snippets/`, or `assets/` file changed).

---

## 7. Final `WebsiteBrief` structure

```json
{
  "businessType":         { "value": "...", "status": "confirmed|inferred|missing", "source": "user|ai_inference|null" },
  "niche":                { "value": "...", "status": "...", "source": "..." },
  "brandName":             { ... },
  "targetAudience":        { ... },
  "products":              { ... },
  "brandPersonality":      { ... },
  "visualDirection":       { ... },
  "colorDirection":        { ... },
  "contentTone":           { ... },
  "requiredPages":         { ... },
  "homepageGoals":         { ... },
  "conversionGoals":       { ... },
  "contentRequirements":   { ... },
  "additionalRequirements":{ ... }
}
```

Every field uses the same `{value, status, source}` shape (`brief.js`'s `BRIEF_FIELDS`) so callers can always tell *why* a value is present or absent, never just *whether*. Only `businessType` is in `BLOCKING_FIELD_KEYS` — every other field can receive a reasonable default in a later phase, so its absence never blocks `READY`.

## 8. Clarification rules (required vs. optional)

- **Required (blocking):** `businessType` only. Without it, nothing downstream can be meaningfully configured.
- **Optional (non-blocking):** everything else. `mergeField()` never lets an empty/missing incoming value erase a value already known, and a `confirmed` (merchant-stated) value is never overwritten by a later `inferred` (AI-guessed) one for the same field.
- **Contradiction rejection** (`validateUnderstandingResult`): `READY` with a still-missing `businessType`, or `NEEDS_CLARIFICATION` with zero questions, or a non-minimal question list, are all rejected before anything trusts the AI's output — matching the phase spec's "`READY` with required missing information must be rejected" example.

## 9. Question strategy

- Capped at `MAX_QUESTIONS_PER_ROUND = 3` per round; `validateUnderstandingResult` rejects a response asking materially more than that (non-minimal).
- Deduplicated across turns (`dedupeAgainstAsked`, case/whitespace-insensitive exact match) against every question ever asked in the session — a repeated question from the AI is silently dropped rather than shown twice.
- The prompt instructs the model to extract multiple pieces of information from one message (scenario E: brand + products + audience + style in one sentence) rather than asking one question per field.

## 10. Multi-turn state

Per session (`brief.js`'s persisted shape):

```json
{
  "sessionId": "...",
  "originalRequest": "...",
  "answers": ["...", "..."],
  "brief": { ...WebsiteBrief... },
  "askedQuestions": ["...", "..."],
  "round": 0,
  "status": "READY|NEEDS_CLARIFICATION"
}
```

Stored as plain JSON under `output/briefs/<sessionId>.json` — the smallest mechanism compatible with the current CLI-only architecture (no database), matching the existing `fs`-based read/write convention already used throughout `example-implementation.js`/`2-copy-to-theme.js`. `saveBrief()`/`loadBrief()` are the only functions that know about the filesystem, so swapping in durable storage later doesn't require touching `clarification.js`'s logic. Each turn's conversation text sent to the AI is `originalRequest` + every prior answer + the current answer (`buildConversationText`), so the model always sees the full history, never just the latest message.

Rounds are capped at `MAX_CLARIFICATION_ROUNDS = 2`: if the cap is reached, `understandRequest()` forces `status: READY` with whatever brief it has rather than looping forever (see "Known limitations").

## 11. AI output contract

Single JSON-mode user-turn call (`response_format: {type:'json_object'}`), same shape/cost-tier as the existing `generateAIColorPalette()` call — no system prompt, no schema catalog attached:

```json
{
  "status": "READY" | "NEEDS_CLARIFICATION",
  "brief": { ...WebsiteBrief... },
  "missing": ["<field keys still genuinely material>"],
  "questions": ["<at most 3 targeted questions>"]
}
```

A bounded, single repair retry (`requestUnderstanding` called again with the validation errors appended to the prompt) runs if the first response is invalid; if the repair attempt is *also* invalid, `understandRequest()` throws rather than silently continuing — never an unlimited retry loop.

## 12. Token / cost measurements

| Prompt | Chars | Est. tokens (chars/4) |
|---|---:|---:|
| Main generation system prompt (Phase 1 baseline, full schema mode) | ~64,260 | ~16,065 |
| Understanding prompt (this phase, one sample conversation) | 3,877 | 970 |

The understanding call never attaches the 16 section / 53 block schemas — confirmed by `test/clarification.test.js`'s cost-tier assertion (prompt `< 5000` chars, and explicitly checks for the absence of `AVAILABLE SECTIONS`/`AVAILABLE BLOCKS`). For a clear, fully-specified prompt, **zero** extra generation-call cost is added beyond the one small understanding call — no repair retry fires, no extra clarification round happens.

## 13. Tests

31 new tests across 3 files (95 total in the suite, all passing — verified with a full `npm test` run after these additions):

- **`test/brief.test.js`** (13 tests) — empty-brief shape, blocking-field-only readiness, `mergeField`/`mergeBrief` precedence and non-erasure, `isValidBriefShape` contradiction/shape rejection, `saveBrief`/`loadBrief` round-trip, session-id path-traversal rejection.
- **`test/clarification.test.js`** (15 tests) — prompt cost-tier assertion, `validateUnderstandingResult` for all required scenarios (valid `READY`, valid `NEEDS_CLARIFICATION`, invalid status, malformed brief, both contradiction cases, non-minimal questions), `understandRequest()` for scenario A (vague), scenario B (specific), scenario D (multi-turn merge + no repeated questions, with a persistence-round-trip assertion), round-cap enforcement, bounded-repair success, and repair-still-invalid throwing.
- **`test/phase3Regression.test.js`** (3 tests) — default (`understandingMode` unset) behavior is unchanged (exactly 2 AI calls, no STEP 0), `understandingMode:true` + `READY` proceeds through generation normally (3 AI calls), `understandingMode:true` + `NEEDS_CLARIFICATION` stops after exactly 1 AI call (no color/generation calls fire).

All Phase 1 and Phase 2 tests remain passing unchanged.

Note: because the understanding call's *quality* (whether a given real-world sentence gets classified correctly) depends on the live model, the tests above characterize orchestration — merging, deduplication, round caps, validation, persistence — with `global.fetch` mocked, the same posture already used for `makeAIRequest()`/`generateAIColorPalette()` in `test/instrumentation.test.js` and `test/runFullPipeline.test.js`. Scenarios C (detailed/fully-specified) and E (multiple requirements in one message) are exercised implicitly by the prompt design and the mocked scenario B/D tests, not as separate live-model assertions — see "Known limitations."

## 14. Known limitations

- **Brief not yet consumed by generation.** `understandRequest()`'s resolved `WebsiteBrief` is produced and persisted, but STEP 1–7 of `runFullPipeline()` still receive the raw `userPrompt` string unchanged — the brief is not yet threaded into `buildSystemPrompt()`/`makeAIRequest()`. That wiring is explicitly Phase 5's job ("Staged Initial-Generation Pipeline... Requires Phase 2 (retrieval) and Phase 3 (brief) as direct inputs"), not Phase 3's.
- **Round-cap forces `READY` even with `businessType` still missing.** After `MAX_CLARIFICATION_ROUNDS` (2), the loop stops asking regardless of whether the blocking field was ever resolved, to avoid deadlocking on a merchant who never answers. This intentionally trades "always eventually proceeds" for "always has a fully-resolved blocking field" — a later phase's generation stage must handle a brief where `businessType` is still `missing` (e.g. apply a generic default) rather than assuming Phase 3 guarantees it.
- **No live-model evaluation harness.** All Phase 3 tests mock `global.fetch`, so they verify the code's orchestration logic, not whether the configured model (`moonshotai/kimi-k2.5` via OpenRouter) actually classifies real merchant sentences correctly (e.g. whether it reliably infers "premium" as a `brandPersonality`/`visualDirection` signal). Manual/live verification against the six required scenarios (A–F in the spec) was not run as part of this phase — it needs a real `OPENROUTER_API_KEY` and live spend, which automated tests intentionally avoid.
- **Question dedup is exact-match only.** `dedupeAgainstAsked()` compares normalized (trimmed/lowercased/whitespace-collapsed) strings — a rephrased repeat of an already-asked question ("What's your brand called?" vs. "What is your brand name?") would not be caught. Acceptable for Phase 3 given the single-call, low-temperature (`0.3`) prompt design, but worth revisiting if repeats are observed in practice.
- **`output/briefs/` is unbounded.** Like the pre-existing `output/` scratch debris documented in `AUDIT.md`, session files accumulate with no expiry/cleanup — acceptable for the current CLI-only, single-operator usage this phase targets, but should not carry into a multi-user Phase 4+ architecture unchanged.

## 15. Definition of Done

- [x] Structured request-understanding stage exists (`clarification.js`).
- [x] `NEEDS_CLARIFICATION` is supported.
- [x] `READY` is supported.
- [x] Questions are targeted and minimal (capped at 3, validated as non-minimal beyond that).
- [x] Known information is not unnecessarily requested again (dedup vs. `askedQuestions`; prompt instructs against re-asking answered fields).
- [x] Multi-turn clarification preserves previous information (`mergeBrief`/`mergeField`, tested).
- [x] Structured `WebsiteBrief` exists (`brief.js`).
- [x] Understanding output is validated (`validateUnderstandingResult`, bounded repair retry, throws rather than silently continuing on repeated failure).
- [x] Clarification does not load the full schema catalog (verified by cost-tier test).
- [x] Phase 2 retrieval remains intact (untouched; `retrievalMode` tests still pass).
- [x] Phase 1 tests remain passing.
- [x] Phase 2 tests remain passing.
- [x] Phase 3 tests pass (30 new tests, all green).
- [x] No live theme files are modified.
- [x] No new design/components are generated.
- [x] No Next.js/PostgreSQL/UI migration is introduced.
- [x] No Phase 4+ functionality is implemented.

**STOP.** Per the phase plan's strict stop condition, `ThemeState` (Phase 4) and everything after it is out of scope for this change and was not started.
