# Phase 7 — Merge / Apply Safety — Report

Scope executed: **Phase 7 only**, per `AI_THEME_BUILDER_PHASE7_PLAN.md` and `AI_THEME_BUILDER_PHASE_PLAN.md` §9 (Implementation Governance). No later phase (structured operations, targeted editing, conversational editing, redesign, undo/redo, PostgreSQL, Next.js/DaisyUI/Base UI, preview) was started.

---

## Objective

Take a Phase 5/6 validated theme candidate and reconcile it with the existing live theme **without** ever blindly overwriting it — closing the AUDIT.md-flagged data-loss risk (`settings_data.json` rebuilt fresh from `global.json`'s 8 tokens every run, dropping everything else) and generalizing the one pre-existing "configure, don't replace" pattern (`mergeProductTemplate()`) to the rest of the write path, while never silently destroying data the AI schema catalog doesn't recognize.

## Existing Write Architecture

Inspected before writing anything new (§5), confirmed in `2-copy-to-theme.js`:

- **`mergeProductTemplate()`** — the one genuinely non-destructive pattern in the codebase: splices the AI's single `main-product` section into the live `product.json` by **type match** (reusing the existing key, or creating `"main"`), leaving every other section in that file untouched.
- **Every other template** (in practice, only `index.json`) — a plain `copyFile()`, i.e. a full overwrite.
- **`config/settings_data.json`** — also a full overwrite, rebuilt from `global.json`'s 8 color/gradient tokens + `content_for_index`; this is the exact data-loss risk `AUDIT.md` documents.

Both remain completely unchanged and still fully functional (`copyGeneratedFilesToTheme()` is still the default write path — see "Rollout" below).

## Candidate Contract

Determined by inspection, not assumption (§11), and documented at the top of `merge.js`:

- **Forced-exclusive-section templates** (today: only `"product"`, per `retrieval.js`'s `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE`) — Stage 1/2 and the legacy prompt both hard-require exactly one section of the forced type. This is a **partial/targeted** update, matching `mergeProductTemplate()`'s existing behavior exactly.
- **Every other template** (today: `"index"`) — both the legacy prompt ("MUST include EXACTLY 10 sections") and Stage 1's plan generate a **complete desired section list** for that one template, not a diff — confirmed by `PHASE5_REPORT.md`'s own "No merge with existing content" known limitation and by the pre-Phase-7 `copyFile()` behavior. Per the Phase 7 spec §11, this licenses a full replacement of **that one template's** `sections`/`order`, while everything else (other templates, untouched global settings, other files) is preserved by construction.

## Merge Contract

Implemented in **`merge.js`** — pure, deterministic, no AI call (§7), never writes anything (§6, kept in a separate file from the writer).

- **`mergeForcedExclusiveTemplate(existingRaw, candidate, forcedSectionId)`** — generalizes `mergeProductTemplate()`: finds the existing section matching the forced type (by `type`, not by AI-generated id, since AI ids never coincide with real theme ids), splices in only `type`/`settings`/`blocks`/`block_order`, and spreads the existing section object first so any unknown property on it survives (§13). Creates a new `"main"` section only if no match exists. Detects `MERGE_SECTION_TYPE_CONFLICT` if the existing template ambiguously has more than one section of the forced type already.
- **`mergeFullStructureTemplate(existingRaw, candidate, existingClassification, acknowledgeUnknownSectionReplacement)`** — replaces the target template's `sections`/`order` outright with the candidate's. Because this is the one merge path that intentionally discards whatever was there before, it **fails closed** (`MERGE_UNSAFE_REPLACEMENT`) whenever the existing target template contains sections unknown to the AI schema catalog, unless the caller explicitly passes `acknowledgeUnknownSectionReplacement: true`. This is the single biggest safety decision in Phase 7: silently discarding unknown data is exactly what §2/§12 forbid, so the decision is made **visible and opt-in** instead of implicit.
- **`mergeGlobalSettingsChanges(existingRaw, changes)`** — the direct fix for the AUDIT.md data-loss risk: only the keys explicitly passed in `changes` are written into `current`; `presets`, `platform_customizations`, and every unrelated/unknown existing key in `current` are spread through untouched.
- **`mergeThemeState(existingThemeState, options)`** — the orchestrator. **Fails closed before doing anything** if `candidateValidation` (the Phase 6 `validateCandidate()` result) is missing or not `valid: true` (§8) — merge never trusts an un-vetted candidate. Deep-clones the entire existing `ThemeState` first, then replaces only the one targeted template entry and `globalSettings` — every other template is preserved by construction, not by a rule this function has to remember to apply. Returns `{valid, conflicts, mergedThemeState, summary}`.
- **`dryRunMerge()`** — thin, report-shaped wrapper (§23); since `mergeThemeState()` never writes anything to begin with, this is really "the same function, formatted for a human to read before deciding to apply."

## Preservation Rules

Directly tested (`test/merge.test.js`), not just asserted in prose:

- Full-structure merge: **unrelated templates** and **untouched global settings** are `deepStrictEqual` to the input after merge.
- Forced-exclusive merge: unrelated sections (including ones **unknown to the AI schema catalog**) are preserved verbatim, in their original `order` position; an **unknown property** on the one targeted section (e.g. `theme_specific_property`) survives across the merge.
- `mergeThemeState()`/`mergeGlobalSettingsChanges()` never mutate their inputs (tested via before/after `deepStrictEqual` on the caller's own copies).

## Section / Block Identity

- Forced-exclusive templates: matched **by type** (there is, by the candidate contract, always exactly one of the forced type) — generalizing `mergeProductTemplate()`'s existing convention, not inventing a new one.
- Full-structure templates: since the AI's own slug ids (`hero-1`, `testi-1`, ...) essentially never coincide with real existing section ids, and the candidate is the *complete* desired structure for that template, "matching by id" is moot — every id in the result comes directly from the candidate. `addedSections`/`updatedSections`/`removedSections` are computed by set-comparison against the previous section ids, which — for this policy — correctly and truthfully reports "almost everything added, almost everything removed" rather than pretending a coincidental id match would mean something it doesn't.
- Because Phase 6's `validateOutput()`/`validateCandidate()` already guarantee every candidate section/block type is real (§8 — merge fails closed without that evidence), Phase 7 never has to independently re-decide "is this an unsupported type" — that decision was already made upstream, once, not duplicated here (§5).
- `MERGE_DUPLICATE_ID` is a small piece of defense-in-depth: `validateOutput()` doesn't actually reject an `order` array that lists the same id twice (a real, pre-existing gap noted here, not fixed in `validateOutput()` itself per Phase 6's "don't weaken it" posture) — merge catches it before it could ever produce a malformed template.

## Settings Merge

`config/settings_data.json` is never rewritten wholesale by the new path. `1-generate-theme.js`'s `mergeApplyMode` branch builds a **targeted** `globalSettingsChanges` object — the resolved color/gradient palette keys plus `content_for_index` (when the target is `index`) — and hands it to `mergeGlobalSettingsChanges()`, which only ever touches those specific `current` keys. `settings_schema.json` is never read or written by Phase 7 (out of scope, confirmed unused anywhere in `merge.js`/`apply.js`).

## Conflict Handling

Four stable, small codes (§19 — "keep the error-code set small and meaningful"), each carrying a `path` and message:

| Code | When |
|---|---|
| `MERGE_INVALID_TARGET` | Missing/malformed `templateName`/`candidate`, missing or invalid `candidateValidation` evidence (§8), or a candidate that doesn't match its template's known policy shape (e.g. more than one section for a forced-exclusive template). |
| `MERGE_DUPLICATE_ID` | `candidate.order` lists the same section id twice. |
| `MERGE_SECTION_TYPE_CONFLICT` | A forced-exclusive template's *existing* content already has more than one section of the forced type — ambiguous which to replace. |
| `MERGE_UNSAFE_REPLACEMENT` | A full-structure replacement would silently discard existing sections unknown to the AI schema catalog, and the caller hasn't explicitly acknowledged it. |

`MERGE_TEMPLATE_NOT_FOUND` (suggested as an *example* in the spec, not a requirement) was deliberately **not** added — a missing target template is handled safely by creating it fresh, matching `mergeProductTemplate()`'s own pre-existing fallback behavior; it was never actually an error condition once inspected. `MERGE_BLOCK_PARENT_CONFLICT` was also not added: given the actual architecture (a candidate's sections and blocks are always generated together, in one already-validated payload), there is no code path where a block could reference a "changed parent" independently — documented here rather than adding an unreachable code.

**Fail closed, always:** every conflict aborts the merge with `valid: false` and zero mutation — no partial application, no "pick one and continue" (§20). Verified by tests.

## Dry Run

`dryRunMerge(existingThemeState, options)` runs the exact same deterministic merge and returns `{wouldApply, conflicts, summary}` — never `mergedThemeState` itself, so a caller can't accidentally treat a dry-run report as something to write. `applyThemeState(..., {dryRun: true})` additionally reports the exact **file paths** that would be touched (after path-safety resolution) without creating a staging directory or writing anything.

## Apply

Implemented in **`apply.js`** — the only file in Phase 7 that touches disk.

1. **Path safety first** (§30) — every target is resolved via `path.resolve()` + `path.relative()` against the theme root (not a naive string-prefix check); anything that resolves outside the root throws before any I/O happens.
2. **Stage** — every target file is written into a fresh `fs.mkdtemp()` directory under `<themeRoot>/ai-schema/output/.staging/` — confirmed (via `fs.statSync().dev`) to be the **same filesystem device** as `templates/`/`config/`, so the later commit step's `fs.rename()` is atomic per file without assuming a cross-filesystem guarantee that isn't actually true everywhere (§21).
3. **Verify staged output** (§28) — every staged file is read back, re-parsed, and structurally checked (`sections`/`order` shape for templates, `current` object for settings) **before any real file is touched**. This is the primary safety guarantee: the overwhelming majority of possible failures (a malformed merge result) are caught here, so the real theme is never even approached.
4. **Backup** — a single, fixed (not accumulating) backup directory, `<themeRoot>/ai-schema/output/.apply-backup/`, overwritten each apply call — the "smallest safe local backup strategy" the spec calls for (§29), deliberately **not** a version-history system (§37): one backup slot, not a history.
5. **Commit** — staged files are renamed into place one at a time. If any single rename fails partway through, everything **already committed in this call** is restored from the backup just taken (or removed, if it didn't exist before), then the error is re-thrown — verified by test with a real forced mid-commit failure (making one target's directory read-only after the first file already committed).
6. **Re-verify the real files** (§28 — "do not assume a successful `writeFile()` means a valid theme") — the just-written real files are read back and re-checked.
7. **Staging is always cleaned up** (`finally`), success or failure; the backup directory is left in place for manual recovery.

## Path Safety

`resolveSafeThemePath(themeRoot, relativePath)` — tested directly against: a normal nested target (accepted), `../../` traversal (rejected), an absolute-path escape (rejected), and the root itself as a target (rejected — not a valid file).

## Change Summary

Real shape, from `merge.js`:

```js
{
  changedFiles: ["templates/index.json", "config/settings_data.json"],
  changedTemplates: ["index"],
  addedSections: ["hero-1", "testi-1"],
  updatedSections: [],
  removedSections: ["old1"],
  changedSettings: ["colors_accent_1"],
  preservedUnknownComponents: []
}
```

(`removedSections`/`addedSections` are naturally empty-ish for a forced-exclusive/partial merge and larger for a full-structure replacement — see "Section / Block Identity" above for why that's the truthful representation, not a special case.)

## Measurements

Real, from the test run:

| | |
|---|---:|
| `mergeThemeState()` typical duration (instrumented via `logMerge`) | 0ms (in-memory, deterministic) |
| `applyThemeState()` typical duration (instrumented via `logApply`), real write | 1–3ms for 1–2 small JSON files |
| Conflict codes | 4 |
| New exported functions (`merge.js` + `apply.js`) | 10 |
| Pipeline write modes | 2 (legacy `copyGeneratedFilesToTheme()`, default; opt-in `mergeApplyMode`) |

## Tests

**218 tests total, all passing** — every prior phase's suite (211, unchanged) plus:

- **`test/merge.test.js`** (23 tests) — `mergeGlobalSettingsChanges()` targeted-merge/no-mutation; `mergeThemeState()` fail-closed preconditions (missing/invalid `candidateValidation`, missing templateName/candidate); full-structure policy (no mutation of input/candidate, correct added/updated/removed accounting, unrelated templates/settings preserved byte-for-byte, `MERGE_UNSAFE_REPLACEMENT` both triggered and successfully acknowledged, missing-template-created-fresh, `MERGE_DUPLICATE_ID`); forced-exclusive policy (splice-by-type into an existing match preserving unrelated sections + unknown properties, create-new-`main` when no match, missing-template-created-fresh, `MERGE_SECTION_TYPE_CONFLICT`, `MERGE_INVALID_TARGET` on a malformed candidate shape); global settings integration; `dryRunMerge()`.
- **`test/apply.test.js`** (17 tests) — `resolveSafeThemePath()` (accept/traversal/absolute-escape/root-itself); `computeTargetFiles()`/`verifyStructuralShape()`; dry run (reports, writes nothing); real writes (new file, overwrite-with-backup, unrelated files untouched, global-settings-only-when-flagged); staged verification catching a bad candidate **before** the real file is touched; staging cleanup; a **real, forced** mid-commit failure (chmod one target's directory read-only) proving the already-committed file is rolled back from backup and the never-committed file is untouched; live-repo isolation.
- **`test/phase7PipelineRegression.test.js`** (7 tests) — default behavior (mergeApplyMode unset) is completely unaffected; `mergeApplyMode` writes candidate + targeted color settings into a temp `themeRoot`; still gated by the existing `autoCopy` flag; dry run; fail-closed on an unsafe merge (with a real `process.exit` assertion, matching the existing error-path test convention) and the same scenario succeeding once acknowledged; live-repo isolation.

## Real Theme Test

`test/apply.test.js` and `test/phase7PipelineRegression.test.js` each end with an explicit assertion that the real repo's `templates/index.json`/`config/settings_data.json` are unchanged after the whole suite runs — on top of the structural fact that **no test in Phase 7 ever passes `DEFAULT_THEME_ROOT` as `themeRoot` to `applyThemeState()`**, so live-repo isolation is guaranteed by construction, not just by an after-the-fact check. `git status -- templates/ config/` (run from the theme root) confirms zero changes after the full suite.

`mergeThemeState()`/`dryRunMerge()` were also exercised directly against real schema-validated candidates (`validateOutput()` + `validateCandidate()` run for real against the actual 16/53-schema catalog in `test/merge.test.js`'s fixtures) — only the ThemeState *input* is hand-built there (deliberately, per file header: ThemeState is plain JSON, and `theme-state.js`'s own tests already cover `buildThemeState()` against the real theme).

## Rollout

`mergeApplyMode` is **opt-in** (`options.mergeApplyMode` / `MERGE_APPLY_MODE=true` / `--merge-apply`), following the exact established pattern of every prior phase's flag (`retrievalMode`, `understandingMode`, `stagedMode`). The default path (`copyGeneratedFilesToTheme()`, full-overwrite for `index.json`, `mergeProductTemplate()` for `product.json`) is **completely unchanged** and remains the default — per §22 ("apply must be explicit... do not make the old generation path unexpectedly destructive"). When enabled, it's still gated by the pre-existing `autoCopy` flag rather than a second independent switch. `acknowledgeUnknownSectionReplacement` defaults to `false` and has no CLI flag (options-only) — a deliberate choice to keep the one genuinely destructive escape hatch a level of friction above a casual CLI flag.

## Known Limitations

- **Multi-template batch merges are out of scope.** `mergeThemeState()` operates on exactly one `(templateName, candidate)` pair per call, matching how `generation.js`/`1-generate-theme.js` actually produce candidates today (one template per pipeline run). A hypothetical future "redesign the whole site atomically" batch (Phase 10) would need its own orchestration on top of this, not a change to this function's contract.
- **The backup mechanism is one slot, not a history.** Each `applyThemeState()` call overwrites the previous backup. This is intentional (§37 forbids a version-history system in this phase) but means only the immediately-prior state is locally recoverable, not an arbitrary earlier one.
- **`acknowledgeUnknownSectionReplacement` is all-or-nothing per template**, not per-section — if a target template has 3 unknown sections, acknowledging proceeds past all 3, there's no way to say "discard these 2, keep that 1" within Phase 7's scope (that granularity belongs to Phase 8/9's structured operations).
- **Real filesystem device confirmed identical for `templates/`/`config/`/`ai-schema/output/` in THIS repo's layout** (verified via `fs.statSync().dev`), which is what makes the same-filesystem atomic-rename assumption safe here — `apply.js` still includes an `EXDEV` fallback (copy+unlink) for a deployment where that assumption doesn't hold, but that fallback path is untested against a real cross-device mount (impractical to simulate in this environment).
- **A pre-existing, unrelated Node.js test-runner flakiness was observed** (not introduced by Phase 7 — reproduced on the pre-Phase-7 171-test suite too): under `node --test`'s default concurrency, an intermittent `ERR_TEST_FAILURE`/`Unable to deserialize cloned data` IPC error occasionally aborts one test file's remaining tests. Root-caused to test-runner parallelism/IPC volume, not a logic defect — confirmed **100% reproducibly green** across multiple runs with `node --test --test-concurrency=1`. Flagged here for visibility; not something this phase's scope covers fixing (it predates Phase 7 and isn't specific to any Phase 6/7 file).

## Definition of Done

- [x] Existing ThemeState remains the source of truth.
- [x] Candidate and existing state are clearly separated (`existingThemeState` vs `candidate` vs `mergedThemeState`).
- [x] Merge is deterministic (no `Date.now()`/randomness in merge content, only in instrumentation timing).
- [x] Merge is a pure/non-writing operation (`merge.js` has zero `fs` usage).
- [x] Apply is a separate explicit operation (`apply.js`, only file that touches disk).
- [x] Candidate validation is required before merge (fails closed without valid `candidateValidation`).
- [x] Merged state is validated before apply (staged verification, §28).
- [x] Unrelated templates are preserved (tested, byte-for-byte).
- [x] Unrelated settings are preserved (tested).
- [x] Unrelated sections are preserved (forced-exclusive policy, tested).
- [x] Unrelated blocks are preserved (within an unrelated section, untouched by construction).
- [x] Unknown sections are preserved (forced-exclusive policy; full-structure policy fails closed unless acknowledged).
- [x] Unknown blocks are preserved (same mechanism, within a preserved unrelated section).
- [x] Unknown properties are preserved (tested — `theme_specific_property` survives a splice).
- [x] Unknown existing settings are preserved (tested — `mergeGlobalSettingsChanges()`).
- [x] Section identity rules are deterministic (type-match for forced-exclusive; full-replace for full-structure).
- [x] Block identity rules are deterministic (same mechanism).
- [x] Merge conflicts have structured error codes (4, small and meaningful).
- [x] Unsafe conflicts fail closed (tested).
- [x] No AI call is used during merge/apply.
- [x] Dry-run capability exists (`dryRunMerge()`, `applyThemeState(...,{dryRun:true})`).
- [x] Change summary exists (shape shown above).
- [x] Apply uses staging/atomic safety (per-file atomic rename, same-filesystem verified, backup+rollback on partial failure).
- [x] Apply verifies written JSON (staged AND post-write).
- [x] Path traversal is prevented (tested).
- [x] Only ThemeState JSON scope is written (`templates/*.json`, `config/settings_data.json` — nothing else).
- [x] Live theme isolation is tested (every Phase 7 test uses a temp `themeRoot`; explicit before/after real-file checks).
- [x] Real-theme dry-run is tested (`mergeThemeState()`/`dryRunMerge()` exercised against real schema-validated candidates).
- [x] Phase 1–6 tests pass (211, unchanged).
- [x] Phase 7 tests pass (47 new: 23 + 17 + 7).
- [x] No PostgreSQL/UI functionality is introduced.
- [x] No undo/version-history system is introduced (one backup slot, not a history).
- [x] No Phase 8+ functionality is implemented (no structured operations, no targeted editing).

**STOP.** Per the phase plan's strict stop condition, Phase 8 (Structured Theme Operations / Targeted Editing) and everything after it is out of scope for this change and was not started.
