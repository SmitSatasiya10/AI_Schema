# Phase 8 — Structured Theme Operations / Targeted Editing — Report

Scope executed: **Phase 8 only**, per `AI_THEME_BUILDER_PHASE8_PLAN.md` and `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). No later phase (undo/version history, collaborative editing, preview, visual editor, new schemas/Liquid/CSS/JS, full redesign workflow) was started.

---

## Objective

Let the AI make a **targeted** change to the existing theme — "change the hero heading" — without regenerating or replacing unrelated configuration, the way every prior phase's initial-generation pipeline necessarily does. The core product problem: today, any request, however small, has no path except "regenerate (and, pre-Phase-7, overwrite) the whole homepage."

## Current Targeted-Editing Gap

Confirmed by inspection before writing anything (§4): **nothing in the repository before Phase 8 can target an existing section/block for a scoped change.**

- `clarification.js`/`brief.js` only understand INITIAL generation requirements (`WebsiteBrief` fields: business type, audience, tone, pages, ...) — never "which existing section."
- `generation.js` only ever produces a brand-new candidate structure for a whole template (Stage 1 plan + Stage 2 configure), confirmed again in `PHASE5_REPORT.md`'s own "No merge with existing content" limitation.
- The only non-destructive splice anywhere is `merge.js`'s forced-exclusive-section policy (Phase 7, generalizing `mergeProductTemplate()`) — but that's driven by a hardcoded per-template rule (`product` → exactly one `main-product` section), not a user's specific request about a specific component.

"Change the hero heading" had zero code path before this phase. Phase 8 is the missing path, not an extension of an existing one.

## Operation Contract

Real shape, from `operations.js` (camelCase, matching this codebase's existing convention — `templateName`, `sectionId` — rather than the illustrative `snake_case` in the plan document, which explicitly allows this: "the actual property names may differ based on the repository"):

```js
{
  operation: "update_section",      // one of OPERATION_TYPES
  target: {
    templateName: "index",
    sectionId: "hero-1",            // required for update/remove section, update/add/remove block
    blockId: "slide-1"              // required for update/remove block
  },
  changes: {
    settings: { heading: "New heading" },  // update_section/update_block/update_global_settings
    type: "collage",                        // add_section/add_block only — schema type to instantiate
    position: "start" | "end"               // add_section/add_block only — default "end"
  }
}
```

`generateOperationId(operation)` produces a deterministic (not random) id: `${operation}:${templateName}:${sectionId}:${blockId}` (§7) — stable for one execution, human-readable in logs/repair prompts.

## Supported Operations

All seven from the plan's own candidate list (§6) — each maps onto a real, already-existing JSON shape (`{type, settings, blocks, block_order}` for sections/blocks, `{current}` for global settings), so none required inventing a new theme concept:

`update_section`, `update_block`, `add_section`, `remove_section`, `add_block`, `remove_block`, `update_global_settings`.

## Target Resolution

`resolveSectionTarget(themeState, templateName, query, schemas)` / `resolveBlockTarget(section, query, schemas)` (§8/§9):

1. **Exact id match** — if `query` is literally an existing section/block id, resolves immediately, unambiguously.
2. **Deterministic keyword matching** otherwise — tokenizes `query` and scores overlap against each candidate's id + its schema's `type`/`label`/`category`/`tags` (via `capability-index.js`'s `buildCapabilityIndex()`, reused unmodified — e.g. `slideshow.json`'s `category: "hero"` is what lets the word "hero" resolve to the slideshow section, since "hero" doesn't literally appear in the real type id).
3. **Ties are never silently broken.** If two or more candidates share the top score, the result is `AMBIGUOUS` with every tied candidate listed — never an arbitrary pick (§23, "the critical safety rule" — tested directly: two `slideshow`-type sections both scoring equally on the query "slideshow" correctly return both, not one).

No AI call anywhere in this resolution — it's plain tokenization and set-overlap scoring, deterministic and independently testable.

## Clarification Integration

`edit-pipeline.js`'s `runTargetedEdit()` checks target resolution **before** ever calling the AI proposal step (verified by test: an ambiguous target never reaches `global.fetch`, using a fetch mock that throws if called). On `AMBIGUOUS`, it returns `{status: 'NEEDS_CLARIFICATION', candidates, questions}` — `questions` follows the same plain-string-array shape `clarification.js` (Phase 3) already established, so a caller doesn't need a second question-rendering code path, without pulling in `WebsiteBrief`'s machinery itself (§28 — edit requests don't need business-type/audience/tone fields, only the target).

## Validation

`validateOperation(operation, {themeState, schemas, knownMerchantData})` (§13) is fully deterministic (no AI call) and, critically, **reuses Phase 6 rather than duplicating it**:

- Per-setting type/enum/range/checkbox correctness: `validation.js`'s `validateSettingValue()`/`getSettingKind()`, called directly, not re-implemented.
- Product/collection hallucination guard: the exact same "empty is safe, otherwise must be in `knownMerchantData`" rule Phase 6 established for whole-candidate validation, applied here to just the changed keys.
- `allowed_on` (for `add_section`): `retrieval.js`'s `isEligibleForTemplate()`, the same function Phase 6/7 already reuse.
- `allowed_blocks`/`max_blocks` (for `add_block`): read directly from the real section schema, same semantics `validateOutput()` already established.

Ten stable error codes (§22, kept to exactly what's reachable given the actual architecture — see "Known Limitations" for the two spec-suggested codes deliberately not added): `OPERATION_INVALID`, `OPERATION_TARGET_NOT_FOUND`, `OPERATION_TARGET_AMBIGUOUS`, `OPERATION_SECTION_NOT_ALLOWED`, `OPERATION_BLOCK_NOT_ALLOWED`, `OPERATION_MAX_BLOCKS_EXCEEDED`, `OPERATION_SETTING_INVALID`, `OPERATION_DATA_REFERENCE_INVALID`, `OPERATION_CONFLICT`, `OPERATION_ORDER_INVALID`.

## Execution

`executeOperation(themeState, operation)` is pure (§18/§19): deep-clones the whole `ThemeState` once, mutates only the one targeted template/section/block/global-settings entry, and — for every update — **spreads the existing object first**, so any unknown property on that exact section/block survives untouched (the same discipline `merge.js`'s forced-exclusive splice already established in Phase 7, generalized here to arbitrary sections/blocks rather than just the one hardcoded `product` case). `update_global_settings` doesn't reimplement a settings merge at all — it calls `merge.js`'s `mergeGlobalSettingsChanges()` directly, a clean, direct cross-phase reuse.

`applyOperationToThemeState()` wraps this with the full validate → execute → **post-operation `validateThemeState()`** sequence (§25) — tested directly: a themeState with a pre-existing, unrelated structural break (a different template's `order` referencing a phantom section) correctly fails the operation even though the operation itself was perfectly valid, proving post-validation isn't skipped just because the proposal passed.

## Multi-Operation Atomicity

`applyOperationsToThemeState(themeState, operations[])` (§20/§21):

1. **Ordering is validated up front**, against the whole batch, before any execution: `validateOperationOrder()` rejects a later operation that targets a section/block an earlier operation in the same batch already removed — the exact case the spec calls out by name (`remove_section → update_section` on the removed target).
2. Operations are then applied **sequentially against one evolving clone**; any single failure discards that whole in-progress clone and returns the **original, untouched** `ThemeState` — never a partial result (tested: a 2-operation batch where the 2nd operation is invalid leaves the original `deepStrictEqual` to its pre-batch state).
3. A valid dependent sequence (`add_section` → `update_section` on the just-added, deterministically-named section) succeeds — proving "add-then-update" works where the id is genuinely predictable (§39's explicit test requirement).

`dryRunOperations()` is the same path, reporting `{wouldApply, errors, changeSummaries}` with zero I/O (operations.js never does I/O to begin with — see "Phase 7 Integration" for where the dry-run/write boundary actually lives).

## Preservation

Directly tested (`test/operations.test.js`), not just asserted in prose: an `update_section` changes only the targeted setting keys, leaving that section's `blocks`/`block_order` and every sibling section/template `deepStrictEqual` to the input; an `update_block` preserves an unknown property (`decorative_prop`) on the exact block being updated; `remove_section`/`remove_block` only ever touch the one targeted id, leaving everything else in that same collection untouched.

## Phase 7 Integration

`runTargetedEdit()`'s optional `autoApply` step calls `apply.js`'s `applyThemeState()` **directly** on the operation-mutated `ThemeState` — it never goes through `merge.js`. This is deliberate, not an oversight (§27's own explicit warning against accidentally re-entering full-structure replacement): `merge.js`'s two policies (splice-by-type / full-structure-replace, from Phase 7) exist specifically to reconcile a *whole-template initial-generation candidate* against existing state; an operation's result is neither of those shapes — `executeOperation()` already knows precisely what changed and what to preserve, so there is nothing left for `merge.js`'s policy logic to decide. `apply.js`'s generic machinery (path safety, staging, verification, backup, atomic commit) is reused as-is with zero changes. Verified by test: an `update_section` operation applied via `autoApply` writes `templates/index.json` with the sibling section byte-for-byte identical on disk — never a full-template rewrite.

## Dry Run

`runTargetedEdit(..., {autoApply: true, dryRunApply: true})` → `status: 'DRY_RUN'`, `applyResult: {applied: false, dryRun: true, targets: [...]}`, and — tested directly — the target file on disk is untouched.

## Change Summary

Real shape, from `operations.js`:

```js
{
  operationId: "update_section:index:hero-1",
  operation: "update_section",
  target: "index.hero-1",
  changed: ["settings.heading"],
  preserved: true
}
```

For a batch, `applyOperationsToThemeState()` returns `changeSummaries: [...]` (one per operation, same shape) rather than a single flattened structure — each operation's own summary stays independently attributable, useful for a future per-operation confirmation UI (not built here — §45).

## Instrumentation

`instrumentation.js` gained three Phase 8 loggers, none logging full merchant content:

- `logOperation` — one per `applyOperationToThemeState()` call: operation id/type, valid/invalid, changed-key count, duration.
- `logOperationBatch` — one per `applyOperationsToThemeState()` call: operation count, whether the batch committed atomically, duration.
- `logEditPipeline` — one per `runTargetedEdit()` run: classification, target-resolution status, repair/AI-call count, final status, duration.

## Tests

**274 tests total, all passing** — every prior phase's suite (258, unchanged) plus:

- **`test/operations.test.js`** (40 tests) — `generateOperationId()`; `resolveSectionTarget()`/`resolveBlockTarget()` (exact match, natural-language match via schema category, not-found, missing template, and the critical tied-ambiguity case); `validateOperation()` across all 7 operation types (valid/invalid target, invalid settings, `allowed_on`/`allowed_blocks`/`max_blocks` enforcement, the data-reference hallucination guard, unsupported operation type, missing `templateName`); `applyOperationToThemeState()` (no-mutation-of-input, preservation of unrelated sections/templates/unknown properties, deterministic id generation for `add_section`/`add_block`, `position` handling, post-operation `validateThemeState()` catching a pre-existing unrelated structural break); `validateOperationOrder()`/`applyOperationsToThemeState()` (valid dependent sequence, whole-batch rollback on failure, ordering-violation rejected before execution, empty-batch rejection); `dryRunOperations()`.
- **`test/editPipeline.test.js`** (16 tests) — `classifyRequest()` against the plan's own example phrases for all three classes; `buildAmbiguityQuestion()`; `runTargetedEdit()` end to end with a mocked, bounded AI proposal (first-try success, one bounded repair, still-invalid-after-repair `FAILED` with exact call counts, the hallucination guard rejecting a proposed handle, `remove_section`/`add_block` requests executing real changes) plus the classification/ambiguity short-circuits proven to make **zero** AI calls; the Phase 7 apply boundary (dry run writes nothing, a real apply touches only the targeted template file with the sibling section byte-for-byte preserved on disk, `update_global_settings` writes only `config/settings_data.json`); live-repo isolation.

## Real Theme Tests

`test/operations.test.js`/`test/editPipeline.test.js` use hand-built `ThemeState`-shaped fixtures (deliberately — `ThemeState` is plain JSON per Phase 4's own design, and `theme-state.js`'s own tests already cover `buildThemeState()` against the real theme; Phase 6/7's test suites established this exact convention). Every fixture's section/block **types** are real, validated against the actual 16/53-schema catalog via `loadSchemas()` — `validateOperation()` runs for real against real `allowed_on`/`allowed_blocks`/`max_blocks`/setting-shape data, not invented schemas. Realistic requests from the plan's §40 list were exercised end to end with mocked AI: "Change the hero settings" (`update_section`), "Remove the testimonials section" (`remove_section`), "Add another slide to the hero" (`add_block`), plus a global-settings edit — each resolves its target deterministically, executes in memory, and (in the apply-boundary tests) dry-runs/writes against a temp `themeRoot`, never the real repo. `git status -- templates/ config/` (theme root) confirms zero changes after the full suite.

## Known Limitations

- **Block-level ambiguity is a softer signal than section-level.** `runTargetedEdit()` hard-stops with `NEEDS_CLARIFICATION` on section-level ambiguity (the higher-stakes case — which section/template is even being edited) but, once a section resolves unambiguously, an ambiguous BLOCK match within it currently also triggers clarification (implemented, tested) — this was implemented, not deferred; noted here because it adds one more AI-call-avoiding short-circuit beyond what §10's examples show, which is a conservative choice (more clarification, not less) rather than a gap.
- **One operation per targeted-edit request.** `runTargetedEdit()`'s AI proposal stage produces exactly one operation, matching the plan's own single-change examples ("change the heading", "remove the section"). Multi-operation batches are fully supported and tested at the `operations.js` layer (`applyOperationsToThemeState()`), but `edit-pipeline.js` doesn't yet have a path that asks the AI to propose several operations from one request — deliberate, per §30 ("do not automatically generate dozens of operations") and §44 (full redesign is explicitly out of scope). A future phase could add a bounded multi-operation proposal on top of the same validated, atomic executor without changing `operations.js` at all.
- **`OPERATION_TARGET_AMBIGUOUS` is defined but not directly returned by `validateOperation()`.** Ambiguity is a *target-resolution*-time concept (`resolveSectionTarget()`/`resolveBlockTarget()`'s own `AMBIGUOUS` status, surfaced by `edit-pipeline.js` as `NEEDS_CLARIFICATION`), not a property of an already-concrete operation object — by the time an operation reaches `validateOperation()`, its `target.sectionId`/`blockId` is a single concrete id or it isn't (`OPERATION_TARGET_NOT_FOUND`). The code is defined in `OPERATION_ERROR_CODES` for API completeness/documentation and future use (e.g. a caller that wants to re-validate a stale proposal against a changed `ThemeState`), but no current code path emits it — documented here rather than silently unused.
- **`add_section`/`add_block` position support is `"start"`/`"end"` only** — no "insert after section X" addressing. This matches the smallest-useful-set instruction (§6: "do not implement all of these blindly") — arbitrary positional insertion wasn't needed by any of the plan's example requests and can be added later without changing the operation contract's shape (just widening what `changes.position` accepts).
- **Natural-language target matching is keyword-overlap, not semantic.** "the banner" won't match a section whose schema/id/category shares no token with "banner" even if a human would consider it the right target — the same class of limitation Phase 2's `retrieval-rules.json` already has and documents (§9's own "if paraphrased requests are missed in practice, that's the trigger for semantic retrieval — not a reason to build it now" reasoning applies identically here).

## Definition of Done

- [x] Structured operation contract exists.
- [x] Operation generation/proposal is separated from execution (`edit-pipeline.js` proposes; `operations.js` validates and mutates — the AI never touches `ThemeState` directly).
- [x] Operation validation is deterministic (`validateOperation()`, no AI call).
- [x] Target resolution uses existing ThemeState (`resolveSectionTarget`/`resolveBlockTarget`).
- [x] Ambiguous targets trigger clarification instead of guessing (tested, and proven to happen BEFORE any AI call).
- [x] Existing sections can be targeted safely (`update_section`/`remove_section`).
- [x] Existing blocks can be targeted safely (`update_block`/`remove_block`).
- [x] Supported sections/blocks can be added safely where applicable (`add_section`/`add_block`, `allowed_on`/`allowed_blocks`/`max_blocks` enforced).
- [x] Sections/blocks can be removed explicitly (never inferred from omission — every removal requires an explicit `remove_section`/`remove_block` operation).
- [x] Global settings can be updated explicitly (`update_global_settings`, reusing `merge.js`).
- [x] Only supported existing capabilities can be added (schema-catalog membership checked, unknown types rejected).
- [x] Operation changes are minimal and targeted (empty/no-op `changes.settings` rejected; only the changed keys appear in `changed`).
- [x] Untouched data is preserved (tested, byte-for-byte).
- [x] Unknown existing properties are preserved (tested).
- [x] Merchant-data hallucination protection remains active (reuses Phase 6's exact posture).
- [x] Multiple operations execute atomically in memory (tested: full rollback on any failure).
- [x] Operation ordering is validated (`validateOperationOrder()`, tested).
- [x] Stable operation error codes exist (10, small and meaningful).
- [x] Post-operation ThemeState validation runs (`validateThemeState()`, tested to actually catch a problem).
- [x] Phase 6 validation remains active (`validateSettingValue`/`getSettingKind`/`isEligibleForTemplate` reused directly).
- [x] Phase 7 merge/apply is reused (`apply.js` called directly; `merge.js`'s policy functions correctly NOT invoked — see "Phase 7 Integration").
- [x] Targeted edits do not trigger unnecessary full-template replacement (tested — sibling section byte-for-byte preserved on disk).
- [x] Dry-run operation support exists (`dryRunOperations()` + `runTargetedEdit(...,{dryRunApply:true})`).
- [x] Change summaries exist (shape shown above).
- [x] Instrumentation exists (`logOperation`/`logOperationBatch`/`logEditPipeline`).
- [x] Real-theme read-only tests pass (real schema catalog, real `allowed_on`/`allowed_blocks`/`max_blocks` data).
- [x] Live theme files remain untouched during tests (verified via `git status`).
- [x] Phase 1–7 tests pass (258, unchanged).
- [x] Phase 8 tests pass (56 new: 40 + 16).
- [x] No PostgreSQL/UI/preview functionality is introduced.
- [x] No undo/version-history system is introduced.
- [x] No Phase 9+ functionality is implemented (no conversational multi-turn workflow, no multi-operation AI proposals).

**STOP.** Per the phase plan's strict stop condition, Phase 9 (Conversational Editing / Multi-Turn Change Workflow) and everything after it is out of scope for this change and was not started.
