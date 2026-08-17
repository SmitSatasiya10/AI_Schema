# Phase 9 — Conversational Editing / Multi-Turn Change Workflow — Report

Scope executed: **Phase 9 only**, per `AI_THEME_BUILDER_PHASE9_PLAN.md` and `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). No later phase (undo/version history, collaborative editing, preview, visual editor, new schemas/Liquid/CSS/JS, production persistence/UI) was started.

---

## Objective

Let a merchant make a change, answer a clarification question, refine that change, and make follow-up edits — "change the hero heading" → "which hero?" → "the homepage one" → "done" → "make the button blue too" — without the system losing the current theme context or regenerating unrelated parts of the theme. Phase 8 gave the system the ability to make ONE targeted change per function call; Phase 9 gives it the ability to remember that call across multiple turns of a real conversation.

## Existing Gap

Confirmed by inspection before writing anything (§4 of the plan): `edit-pipeline.js`'s `runTargetedEdit(userPrompt, options)` is a single, stateless async function. `grep -n "session" edit-pipeline.js operations.js theme-state.js apply.js merge.js` returned nothing before this phase. Concretely:

- **Nothing survived between two separate `runTargetedEdit()` calls.** No `sessionId`, no persisted file, no in-memory cache. A `NEEDS_CLARIFICATION` result handed the caller `{candidates, questions}` with no built-in way to resume "the same edit" other than re-running the whole function with a differently-worded prompt.
- **No CLI wiring existed at all.** `3-interactive-menu.js`/`1-generate-theme.js` never `require('./edit-pipeline')` — `runTargetedEdit()` was reachable only from `test/editPipeline.test.js`.
- **Phase 3's `clarification.js`/`brief.js` already proved the right persistence PATTERN** for this repo (a `sessionId` + a small JSON file under `output/`, loaded/merged/saved every turn — no database) but only for building a `WebsiteBrief` (business type, audience, tone, ...) ahead of INITIAL generation. Its field shape has nothing for "which target," "which operation," or "which ThemeState version."
- **`theme-state.js`'s `saveThemeState()`/`loadThemeState()` existed but were called nowhere** outside `theme-state.js`'s own test file — every real pipeline rebuilt `ThemeState` fresh from disk each run. Nothing hashed `ThemeState` content, so nothing could detect "this session's target might no longer be valid."
- **`edit-pipeline.js`'s AI proposal stage was hardcoded to one operation.** PHASE8_REPORT.md's own "Known Limitations" named this exact gap: no path from one request to several bounded operations.

Phase 9 closes these gaps by adding two new files on top of the unmodified Phase 8 machinery, plus two small, additive fields on `edit-pipeline.js`'s existing `NEEDS_CLARIFICATION` result shape (below).

## Conversation State Contract

`conversation-session.js` — file-based, mirrors `brief.js`'s exact persistence pattern (`output/edit-sessions/<sessionId>.json`, `sessionFilePath()`/`saveSession()`/`loadSession()` matching `briefFilePath()`/`saveBrief()`/`loadBrief()` one-for-one):

```js
{
  sessionId, themeId,
  status,                 // one of SESSION_STATES
  currentIntent,          // the original request text while clarification is pending
  pendingQuestion,        // the single most recent question asked
  pendingClarification,   // { kind: 'section'|'block'|'value'|'intent', candidates?, templateName?, sectionId?, target?, questions? }
  resolvedTarget,         // { templateName, sectionId, type, blockId?, blockType? } — the active edit target
  lastOperation,          // the last executed operation + generateOperationId() id
  lastChangeSummary,
  lastMessage, lastResultStatus,  // §31 idempotency
  themeStateVersion,      // sha256 of serializeThemeState() — §22 freshness
  turnCount,
  createdAt, updatedAt
}
```

Nothing more. No full prompt history, no merchant-content logging (§34's own constraint) — only what's needed to resume the CURRENT edit.

## State Machine

`SESSION_STATES = { IDLE, UNDERSTANDING, NEEDS_CLARIFICATION, READY_FOR_OPERATION, APPLYING, COMPLETED, FAILED }`, exactly the set the plan names (§6). In practice, `runConversationalEdit()`'s single-pass design only ever writes `IDLE` (fresh/reset), `NEEDS_CLARIFICATION`, `FAILED`, or `COMPLETED` — `UNDERSTANDING`/`READY_FOR_OPERATION`/`APPLYING` are transient sub-steps inside one function call, not states a session is ever persisted in, since there's no async boundary mid-turn worth exposing to a re-entrant caller.

A subtlety worth naming precisely: the **returned** `status` a caller sees (`PROPOSED`/`APPLIED`/`DRY_RUN`/`FAILED`/`NEEDS_CLARIFICATION`/`IDLE`/`TOO_MANY_OPERATIONS`/`INITIAL_GENERATION`) is deliberately a **finer-grained** value than the **persisted** `session.status` (a `SESSION_STATES` value). A successful turn always persists `session.status = COMPLETED`, but the caller still needs to know whether that meant "proposed only," "applied to disk," or "dry-run" — exactly Phase 8's own three outcomes, preserved unchanged. `finish()`'s `extra.turnStatus` carries this distinction without polluting the state machine with three near-duplicate "done" states.

## Clarification Workflow

Real multi-turn trace (this is `test/conversationalEdit.test.js`'s Scenario 1, executed against a fixture theme with two `slideshow` sections both containing "banner" in their id):

```
User: Change the banner.
  -> resolveSectionTarget() ties between announcement-banner / homepage-hero-banner
  -> NEEDS_CLARIFICATION, pendingClarification = { kind: 'section', candidates, templateName }
  -> ZERO AI calls (target resolution runs entirely before any AI call, per Phase 8's own discipline)

User: Announcement banner.
  -> mergeClarificationAnswer() token-matches the answer against candidates deterministically
     (numeric "1"/"2", or id/type keyword overlap; a TIE stays unresolved, never guessed)
  -> resolves to announcement-banner
  -> hasChangeDetails("Change the banner.", target) strips edit verbs + the target's own
     id/type tokens from the intent; nothing is left over
  -> NEEDS_CLARIFICATION again, pendingClarification = { kind: 'value', target, questions: ["What would you like to change?"] }
  -> ZERO AI calls (still fully deterministic)

User: Make the text blue.
  -> pending.kind === 'value': merges "Change the banner. Make the text blue." against the
     ALREADY-known target (never re-resolved — re-resolving from scratch here would hit the
     exact same tie again, since "make the text blue" shares no section-identifying keyword)
  -> proposeAndExecuteForTarget() — ONE bounded AI call -> PROPOSED
```

**Exactly one AI call across the whole 3-turn conversation** (asserted directly in the test). This is the concrete mechanism behind §9/§10/§11: minimal clarification, one question at a time, original intent surviving both rounds, and no AI call spent on anything a deterministic string match can resolve.

`hasChangeDetails()` is the one new heuristic this phase adds beyond Phase 8: strip `EDIT_VERBS` (reused from `edit-pipeline.js`, not redefined), a small generic-word set (`the`, `a`, `to`, `it`, ...), and the resolved target's own id/type tokens from the intent text; if anything real remains, there's enough to propose from (Scenario 2's fully-specified request skips this question entirely — verified by test).

## Follow-Up Resolution

`resolveFollowUpReference()` implements the plan's exact vocabulary — `it`, `that`, `this`, `the button`, `the heading`, `the hero`, `the section`, `the same one` — as a small ordered pattern list (`conversational-edit.js`'s `REFERENCE_PATTERNS`), resolved against `session.resolvedTarget` only (§14: "not broad semantic memory"):

- Generic references (`it`/`that`/`this`/`the same one`, or no reference word at all) resolve to the single most recent target — no ambiguity check needed, there's only one "most recent."
- `the section` steps back up to section level even if the last target was a block.
- Type-hinted references (`the button`/`the heading`/`the hero`) first check whether the last target's own type matches; if not, they search SIBLING blocks within the same section for a type match. Exactly one match resolves silently; more than one returns `AMBIGUOUS` with every tied candidate (never guessed, tested directly).

One vocabulary extension beyond the plan's literal list, added after tracing the plan's own Scenario 3 through the classifier: a small **continuation-marker** set (`too`, `also`, `as well` — `containsContinuationMarker()`) that signals "apply to the same target" even with no pronoun present ("Make the text white too" names no section/block keyword at all). Documented here because it's new vocabulary, not because it changes the underlying mechanism — it routes through the exact same "resolve to the single most recent target" path as `it`/`that`.

## New Request Detection

`classifyTurn()` — deterministic, in this priority order:

1. A cancel phrase (§30) always wins, regardless of context.
2. A pending clarification always routes the next message to `CLARIFICATION_ANSWER` (§7 — never treated as an unrelated new request).
3. `classifyRequest()` (Phase 8, unmodified) returning `INITIAL_GENERATION` always routes there, even with active edit context (§17).
4. No active target yet → always `NEW_REQUEST`.
5. A reference word or continuation marker → `FOLLOW_UP`.
6. Otherwise: **default to `NEW_REQUEST`**, UNLESS the message explicitly names the SAME section the session is already on (via `resolveSectionTarget()`, reused, not re-implemented) — that's still unambiguously a continuation.

Step 6's default direction is the one deliberate correction made mid-implementation. An earlier draft treated "names no section at all" as a follow-up signal (reasoning: an unrelated request also often shares no keyword with the old target, so the absence of a match seemed uninformative either way) — but that's backwards: it would silently overload an unrelated new request onto the active target far more often than it would correctly catch a real continuation. Scenario 4 ("Change the product page layout." right after a hero edit) is the concrete test that catches this: it names no keyword the hero section has, and correctly falls through to `NEW_REQUEST` only because the default was flipped. The continuation-marker vocabulary above is what still lets Scenario 3's true continuation succeed without that risky default.

Initial generation stays completely separate in practice, not just in classification: when `classifyTurn()` returns `INITIAL_GENERATION`, `runConversationalEdit()` returns `{status: 'INITIAL_GENERATION'}` without touching `operations.js`, `apply.js`, or the session's edit state at all — the caller is expected to route to `1-generate-theme.js`'s existing pipeline, exactly as `runTargetedEdit()` already did in Phase 8.

## AI Usage

Every deterministic step proven, by test, to make **zero** network calls (via the same `throwingFetch()` convention `editPipeline.test.js` established): cancel, target-ambiguity detection, the clarification answer that still needs a follow-up "what would you like to change?" question, and an idempotent repeat of the last message. The one bounded-repair ceiling from Phase 8 (`runOperationProposalStage()`, entirely unmodified) is reused everywhere a proposal happens — one call, and on failure exactly one repair call, never a third attempt (tested directly, matching `editPipeline.test.js`'s own assertions).

No new AI call sites were added. Every AI call in Phase 9 flows through `edit-pipeline.js`'s existing `runOperationProposalStage()` — either indirectly (via `runTargetedEdit()` for a fresh `NEW_REQUEST`) or directly (via `proposeAndExecuteForTarget()`, a thin wrapper that mirrors `runTargetedEdit()`'s steps 5-8 for an ALREADY-known target, added because Phase 8 had no entry point that skips resolution — the one piece of new orchestration glue this phase needed, per the gap confirmed above). `runOperationProposalStage()` itself was not touched.

## Operation Integration

`operations.js` is used entirely as-is. `resolveSectionTarget()`/`resolveBlockTarget()` back both `classifyTurn()`'s same-section check and the bounded multi-operation path's per-clause resolution. `applyOperationToThemeState()`/`applyOperationsToThemeState()`/`validateOperationOrder()` execute every operation this phase produces, single or batched — Phase 9 adds no new mutation logic anywhere; every branch in `conversational-edit.js` ends by handing an already-proposed operation to one of these functions.

**Bounded multi-operation batches** (§24/§25): `splitBoundedClauses()` splits on `and`/`;` only when EVERY resulting part independently contains its own edit verb (a single "and" inside one descriptive clause, e.g. "black and white," is never split). A `NEW_REQUEST` that splits into more than `MAX_OPERATIONS_PER_TURN` (3) clauses is rejected before any resolution or AI call, with `{status: 'TOO_MANY_OPERATIONS'}` and the plan's own suggested message. Within the bound, `runMultiOperationTurn()` resolves and proposes ONE operation per clause (one bounded AI call each), and only once every clause has produced a validated operation does it call `validateOperationOrder()` + `applyOperationsToThemeState()` — atomic, tested: one invalid clause fails the whole batch and leaves the original `ThemeState` untouched (no partial application, verified by comparing the pre-call object).

## ThemeState Freshness

No content hash exists anywhere in `theme-state.js` (`schemaVersion` is a fixed contract-shape constant, confirmed by inspection) — `computeThemeStateVersion()` adds one, scoped to `conversation-session.js` rather than `theme-state.js` itself (lower regression risk to an already-tested file): `sha256(JSON.stringify(serializeThemeState(themeState)))`. `serializeThemeState()` already projects out exactly the content that matters (`templates` + `globalSettings`, no `createdAt`/`updatedAt` noise), so two `ThemeState` objects with identical content hash identically regardless of when they were built (tested directly).

Every turn recomputes this version against the incoming `themeState` and compares it to `session.themeStateVersion`. A mismatch means the ThemeState changed out from under this session since its last successful turn — the session's `resolvedTarget`/`lastOperation`/`pendingClarification` are cleared and `status` resets to `IDLE` before classification runs, forcing a fresh resolution rather than trusting a target that might no longer exist (tested: an out-of-band content change is detected and the target re-resolves correctly against the NEW content; a staleness reset with no salvageable target correctly asks for clarification instead of guessing).

## Failure Recovery

`applyOperationToThemeState()`/`applyOperationsToThemeState()` already guarantee (Phase 8, unmodified, re-verified here) that a failed validation never mutates the input `ThemeState` — Phase 9's `FAILED` branches simply pass that guarantee through untouched (tested: the original object reference is asserted unchanged after a failed repair). A `FAILED` result does **not** reset or clear the session — `currentIntent`/`resolvedTarget` survive exactly as Phase 3's `clarification.js` already established the precedent for ("the session remains active until: operation succeeds, user cancels, context expires, or user starts over," §29) — so a corrected follow-up message in the same session can still succeed (tested directly).

## Cancellation / Reset

`isCancelMessage()` — a small deterministic phrase set (`cancel`, `never mind`, `start over`, ...), case/punctuation-insensitive, that does **not** misfire on "Cancel the discount badge text" (the whole message must normalize to exactly one cancel phrase, not merely contain the word). `resetSession()` clears every pending-edit field (`currentIntent`, `pendingClarification`, `resolvedTarget`, `lastOperation`, ...) back to `IDLE` while keeping `sessionId`/`themeId`/`turnCount` — the same session continuing idle, not a new one. Cancelling mid-clarification never touches `ThemeState` (tested).

## Apply Integration

Unchanged from Phase 7/8: every successful turn that sets `autoApply` calls `apply.js`'s `applyThemeState()` directly on the operation-mutated `ThemeState` — `merge.js`'s template-replacement policies are never invoked by any Phase 9 code path (confirmed by inspection: `conversational-edit.js` never `require('./merge')`). Dry run writes nothing (tested); a real apply writes only the targeted template file, with a sibling section byte-for-byte preserved on disk (tested, same assertion style as `editPipeline.test.js`).

One genuinely new piece of cross-turn plumbing: after ANY successful turn (not only when `autoApply` is set), `runConversationalEdit()` calls `theme-state.js`'s previously-unused `saveThemeState()` — keyed explicitly by the SESSION's `themeId`, not whatever `.themeId` the input `ThemeState` object happened to carry (a mismatch there would silently save to one file and load from a different one on the next turn; caught and fixed during testing). The next turn, if no `themeState` is passed explicitly, calls the equally previously-unused `loadThemeState()` to pick up exactly where the last turn left off (tested end to end: a second turn with no `themeState` option at all correctly resolves against the first turn's edited content). This closes §21's "the next user message must use the updated state" using infrastructure Phase 4 already built but nothing had wired in yet.

## Instrumentation

`instrumentation.js` gains one new logger, `logConversationTurn()`, following the exact shape/discipline of every other logger in the file (structured fields only, no full conversation history, no full `ThemeState`, no merchant content — §34): `sessionId`, `turnCount`, `turnType`, `status`, `clarificationCount`, `targetResolution`, `aiCallCount`, `repaired`, `operationCount`, `operationTypes`, `themeStateVersion`, `durationMs`. Called exactly once per turn, from the single `finish()` closure every branch of `runConversationalEdit()` routes through — one log line per turn, not per internal step.

## Tests

**326 tests total, all passing** — every prior phase's suite (274, unchanged) plus 52 new:

- **`test/conversationSession.test.js`** (15 tests) — `createSession()` shape/defaults; `saveSession()`/`loadSession()` round-trip (file-based persistence, mirrors `brief.js`'s own test convention); `resetSession()` (clears pending state, keeps identity/turn count); `isCancelMessage()` (recognizes the vocabulary, doesn't misfire mid-sentence); `computeThemeStateVersion()` (identical content → identical hash regardless of timestamps; a content change → a different hash); `matchCandidateFromAnswer()`/`mergeClarificationAnswer()` (numeric selection, keyword-overlap resolution, a genuine tie or a match-nothing answer stays unresolved rather than guessing).
- **`test/conversationalEdit.test.js`** (37 tests) — `classifyTurn()` unit tests for every turn type including the cancel-always-wins and initial-generation-even-with-context priority rules; `resolveFollowUpReference()` unit tests for generic/type-hinted/ambiguous/no-context cases; `splitBoundedClauses()`; all five §36 realistic scenarios end to end (below); AI-usage bounds (four dedicated zero-AI-call tests plus the one-bounded-repair and still-invalid-after-repair cases); bounded multi-operation batches (a valid 2-clause batch, an atomic rollback on one invalid clause, the operation-count limit rejected before any AI call); ThemeState staleness detection and recovery (two tests) and cross-turn auto-persistence (one test, no explicit `themeState` on the second call); cancel mid-clarification; resumability after a failed turn; the Phase 7 apply boundary (dry run, real apply with sibling-section preservation); live-repo isolation.

## Realistic Conversations

All five scenarios from §36 are implemented as literal end-to-end tests against `runConversationalEdit()` with a mocked, bounded `global.fetch` (no real AI spend):

1. **Ambiguous target** — "Change the banner." → "Which banner?" → "Announcement banner." → "What would you like to change?" → "Make the text blue." → one `update_block` operation on `announcement-banner`, **one AI call total** across all three turns.
2. **Follow-up ("it")** — a fully-specified heading change applies directly (no unnecessary clarification), then "Make it shorter." resolves to the SAME block via the generic reference path, no re-asking.
3. **Follow-up (no reference word)** — a hero-button style change, then "Make the text white too." resolves to the SAME button block via the continuation-marker path, with no pronoun or named target at all.
4. **New request** — a hero heading change, then "Change the testimonials section." is classified `NEW_REQUEST` and correctly targets `testi-1`, never applied against the still-active hero target.
5. **Unsupported capability** — "Add a floating AI chatbot widget." resolves no target, the AI's invented `add_section` type fails schema-catalog validation, one bounded repair still fails, and the turn ends `FAILED` — no new section/block type is ever invented or applied.

## Known Limitations

- **`hasChangeDetails()` gates only the clarification-answer path, not a plain single-shot `NEW_REQUEST`.** A brand-new, non-ambiguous request like "Change the hero." (unique target, zero specifics) still delegates entirely to `runTargetedEdit()` and lets the AI propose its best guess, exactly as Phase 8 already does (`buildProposalSystemPrompt()`'s own rule 6: "still propose your best single guess — validation will catch anything unsafe"). Extending the "ask before guessing" gate to that path would require intercepting inside `runTargetedEdit()` itself, which this phase deliberately avoided touching beyond the two additive `NEEDS_CLARIFICATION` fields — Scenario 1's exact two-question flow is the only place the plan requires this gate, and that flow always starts from a target-level ambiguity, which is where the gate lives.
- **Multi-operation batching is `NEW_REQUEST`-only.** A follow-up turn ("and also change X") is not split into multiple operations — each `FOLLOW_UP`/`CLARIFICATION_ANSWER` turn produces at most one operation. This matches the plan's own bounded-and-conservative posture (§25/§26) and was a deliberate scope line to keep the surface area the realistic scenarios actually require, not a discovered gap.
- **Type-hinted follow-up references only search ONE level: sibling blocks of the currently active section.** "The button" cannot resolve to a button block in a DIFFERENT section than the one currently active — consistent with §14's "not broad semantic memory," but worth naming since a merchant editing section A who then says "the button" meaning a button in section B (never mentioned this conversation) will get `NOT_FOUND` → a generic clarification question, not a guess and not a crash.
- **`session.themeId` is authoritative for save/load, not the `ThemeState` object's own `.themeId` field.** `runConversationalEdit()` always saves keyed by the session's `themeId` (fixed during testing — see "Apply Integration"); a caller that passes a `ThemeState` whose own `.themeId` differs from `options.themeId` will still have it saved/loaded correctly by session, but should not rely on the returned `themeState.themeId` field matching what was persisted.
- **Natural-language target/reference matching remains keyword-overlap, not semantic** — the same class of limitation Phase 8's own report already names for `resolveSectionTarget()`/`resolveBlockTarget()`, inherited unchanged since Phase 9 reuses those functions directly rather than replacing them.

## Definition of Done

- [x] Multi-turn edit session state exists (`conversation-session.js`).
- [x] Pending clarification survives between turns (file-persisted, tested across separate `loadSession()` calls).
- [x] Original intent survives clarification (`session.currentIntent`, tested through both clarification rounds of Scenario 1).
- [x] Clarification answers are merged into the pending edit context (`mergeClarificationAnswer()`, deterministic).
- [x] Ambiguous answers trigger clarification instead of guessing (tied/no-match answers tested to stay unresolved).
- [x] Follow-up references resolve against active edit context (`resolveFollowUpReference()`, full reference vocabulary tested).
- [x] New requests are distinguishable from follow-ups (`classifyTurn()`, tested including the Scenario 4 different-section case).
- [x] Initial generation remains separate (routes back to the caller untouched, tested even with active edit context).
- [x] Updated ThemeState is used after successful operations (`saveThemeState()`/`loadThemeState()` wired in, tested with no explicit `themeState` on the second turn).
- [x] Theme state freshness/version is checked (`computeThemeStateVersion()`, tested).
- [x] Stale targets are re-resolved safely (tested: out-of-band change detected, target re-resolved against new content).
- [x] AI usage remains bounded (zero AI calls proven for every deterministic step, tested with `throwingFetch()`).
- [x] Deterministic tasks do not trigger unnecessary AI calls (same tests as above).
- [x] One bounded repair remains the maximum (reused from `edit-pipeline.js`, unmodified, re-tested).
- [x] Multi-operation proposals are bounded (`MAX_OPERATIONS_PER_TURN = 3`, rejected before any AI call when exceeded).
- [x] Multi-operation execution remains atomic (`applyOperationsToThemeState()`, reused; rollback tested).
- [x] Failed operations do not mutate ThemeState (tested: original object reference unchanged).
- [x] Failed conversations remain resumable (tested: a corrected follow-up succeeds after a FAILED turn).
- [x] Cancel/reset clears pending edit state safely (tested, theme untouched).
- [x] Operation IDs/idempotency are handled safely (`generateOperationId()` reused; an exact message repeat against an unchanged ThemeState short-circuits with zero AI calls, tested).
- [x] Phase 6 validation remains active (`validateOperation()`/`validateSettingValue()` reused unchanged throughout).
- [x] Phase 7 apply remains the persistence boundary (`applyThemeState()` reused directly; `merge.js`'s template-replacement policies never invoked).
- [x] Targeted edits never unnecessarily trigger full-template replacement (tested: sibling section byte-for-byte preserved on disk).
- [x] Change summaries remain available (`changeSummary`/`changeSummaries` on every successful result).
- [x] Instrumentation exists (`logConversationTurn()`).
- [x] Realistic multi-turn conversations are tested (all five §36 scenarios, literal end-to-end tests).
- [x] Live theme files remain untouched during tests (verified via direct before/after file read, matching `editPipeline.test.js`'s own convention).
- [x] Phase 1–8 tests pass (274, unchanged).
- [x] Phase 9 tests pass (52 new: 15 + 37).
- [x] No PostgreSQL/UI/preview functionality is introduced.
- [x] No undo/version-history system is introduced.
- [x] No new schemas/Liquid/CSS/JS are introduced.
- [x] No Phase 10+ functionality is implemented (no production persistence layer, no UI integration).
