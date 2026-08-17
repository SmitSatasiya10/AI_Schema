# AI Theme Builder — Existing System Audit

Read-only audit of the current implementation. No code was modified as part of this audit.

---

## 0. The single most important finding, up front

**There is no web application, frontend, API server, or conversational UI anywhere in this repository.** The only application code that exists is a **4-file Node.js CLI pipeline** inside `ai-schema/`:

```
ai-schema/1-generate-theme.js       (216 lines) — orchestrator
ai-schema/2-copy-to-theme.js        (314 lines) — file copier
ai-schema/3-interactive-menu.js     (358 lines) — terminal menu (readline)
ai-schema/example-implementation.js (1242 lines) — all core AI logic
```

Everything else in the repo (`sections/`, `blocks/`, `templates/`, `config/`, `assets/`, `snippets/`, `layout/`) is the actual Shopify theme (Liquid files), not application code.

This means:
- There is **no "frontend component"** the user prompt enters through. The entry point is either a CLI flag (`node 1-generate-theme.js --prompt "..."`) or a terminal `readline` prompt (`3-interactive-menu.js`).
- There is **no chat session, no conversation memory, no persisted "theme state."** Every invocation of the pipeline is a single, stateless, fire-and-forget script run.
- There is **no editing mode**. The menu (`3-interactive-menu.js:28-45`) offers exactly 7 options: generate homepage, generate product page, generate both, custom description, view docs, copy existing files, exit. Nothing in the codebase accepts "make the hero darker" or "change the heading to X" as input against an existing generated state.
- Also worth flagging: the assumption of "approximately 109 section schemas" and "approximately 293 block schemas" does not match the repo. The actual counts on disk are **16 section schemas and 53 block schemas** (`ls ai-schema/sections/*.json | wc -l` → 16, `ls ai-schema/blocks/*.json | wc -l` → 53). This is a large discrepancy from what was believed to exist — see §3 and §10 for what that gap means in practice.

If a richer chat/editing application exists, **it lives outside this repository** and could not be audited here — every question that assumes its existence is answered against the CLI pipeline that actually exists in this repo.

---

## 1. Trace of the Current User Request Flow

For a prompt like `"Create a premium pet wellness store for dogs and cats."`, run via `node 1-generate-theme.js --prompt "..."` or option 4 in the interactive menu:

```text
User Prompt (CLI arg or readline stdin)
   ↓
3-interactive-menu.js (prompt() via readline) — OR — 1-generate-theme.js parseArgs()
   ↓
1-generate-theme.js: runFullPipeline(userPrompt, options)
   ↓
STEP 1 — example-implementation.js: loadSchemas()
        reads global.json + every *.json in sections/ and blocks/, JSON.parse each
   ↓
STEP 2 — example-implementation.js: buildSystemPrompt(schemas)
        string-concatenates rules + JSON.stringify(globalSchema/sectionSchemas/blockSchemas)
   ↓
STEP 3 — example-implementation.js: generateAIColorPalette(userPrompt)
        a SEPARATE, SECOND OpenRouter call, just for a 5-color palette
        falls back to detectNicheAndGetColors(userPrompt) (keyword match, no AI) on failure
   ↓
STEP 4 — example-implementation.js: makeAIRequest(userPrompt, systemPrompt)
        THIRD-PARTY call via OpenRouter (not a direct Anthropic/OpenAI SDK call)
        model = process.env.OPENROUTER_MODEL, default 'moonshotai/kimi-k2.5'
        single request/response, response_format: json_object, temperature 0.8
   ↓
STEP 5 — example-implementation.js: validateOutput(aiOutput, schemas)
        JSON.parse + schema-conformance checks (see §2/§3)
        on failure: runFullPipeline throws and process.exit(1) — NO retry, NO repair loop
   ↓
STEP 6 — example-implementation.js: generateThemeFiles(config, templateName, {}, colors)
        writes ai-schema/output/templates/<name>.json
        writes ai-schema/output/config/settings_data.json
   ↓
STEP 7 — 2-copy-to-theme.js: copyGeneratedFilesToTheme()
        copies/merges output/ files into the real theme's templates/ and config/
   ↓
Shopify Theme Files: templates/index.json, config/settings_data.json (overwritten in place)
   ↓
Return value: { success, config, colors, files } — printed to console only.
   No frontend receives this. Nothing is "returned to a UI."
```

Direct answers to the 13 sub-questions:

1. **Where does the prompt enter?** `1-generate-theme.js:parseArgs()` (CLI flag `--prompt`) or `3-interactive-menu.js:prompt()` (terminal readline).
2. **Which API/server action receives it?** None — no server exists. `runFullPipeline()` in `1-generate-theme.js:32` is the sole entry function.
3. **Which AI service/model?** OpenRouter (`https://openrouter.ai/api/v1/chat/completions`), model from `OPENROUTER_MODEL` env var, defaulting to `moonshotai/kimi-k2.5` (`example-implementation.js:15`). Note: `.env.example` documents a *different* default (`openai/gpt-4-turbo`) — the example file is stale relative to the actual code default.
4. **System prompt** — see §2, built by `buildSystemPrompt()`.
5. **What context is sent?** `global.json` in full, **all** loaded section schemas in full, **all** loaded block schemas in full — always the entire set, every single call, with no selection/filtering (see §3's "does retrieval exist" answer: **no**).
6. Does the AI receive: entire schemas (**yes, always all of them**); selected schemas (**no**); theme files (**no**); theme state (**no — none is tracked**); section metadata (yes, as part of the schema JSON); block metadata (yes, same); existing content (**no**); previous conversation/history (**no — none exists**).
7. **What the AI returns:** a raw JSON string matching `{ sections: {...}, order: [...] }`, per the OUTPUT FORMAT block in the system prompt.
8. **Parsing:** `JSON.parse(output)` inside `validateOutput()` (`example-implementation.js:267`) — that's the entire "parser." No markdown-fence stripping, no repair of near-valid JSON (mitigated somewhat by requesting `response_format: json_object` from OpenRouter, which is provider-enforced, not app-enforced).
9. **Validation:** `validateOutput()` — structural + schema-membership + `max_blocks` + `block_order` + naive image-hallucination checks. Detailed in §3.
10. **Applying output:** `generateThemeFiles()` writes files to `ai-schema/output/`; `copyGeneratedFilesToTheme()` in `2-copy-to-theme.js` copies/merges those into the real theme folders.
11. **Which theme files change:** `templates/index.json` (full overwrite), `templates/product.json` (merged — see §4/§7), `config/settings_data.json` (full overwrite). Nothing else — no `layout/theme.liquid`, no other templates, no `snippets/`, no other sections/blocks files are ever touched by generation.
12. **Where is final state stored?** Nowhere durable/queryable. It's just whatever is currently sitting in `templates/index.json` / `config/settings_data.json` on disk. There is no database, no versioned "theme state" object, no history of prior generations (confirmed by grepping for `conversation|history|session` across the JS files — zero relevant hits).
13. **What's returned to "the frontend"?** Nothing — there is no frontend. Output is `console.log` lines to the terminal.

---

## 2. The Actual AI Prompt(s)

There are **two separate AI calls** per generation run, each with its own prompt, sent independently (no shared context between them beyond the raw `userPrompt` string):

### A. The main configuration call — `makeAIRequest()` (`example-implementation.js:192-256`)
- **System prompt**: `buildSystemPrompt(schemas)` (`example-implementation.js:78-187`), a single large template-literal string containing:
  - 12 numbered "CRITICAL RULES" (schema-fidelity rules, richtext-wrapping rules, `max_blocks` rules, "leave images empty" rule, homepage-must-be-exactly-10-sections rule, product-page block-order guidance, "be creative/vary content" instructions).
  - `AVAILABLE GLOBAL SETTINGS`: `JSON.stringify(globalSchema, null, 2)` — the full 32-line `global.json`.
  - `AVAILABLE SECTIONS`: `JSON.stringify(sectionSchemas, null, 2)` — all 16 section schemas, verbatim, unfiltered.
  - `AVAILABLE BLOCKS`: `JSON.stringify(blockSchemas, null, 2)` — all 53 block schemas, verbatim, unfiltered.
  - An `OUTPUT FORMAT` spec.
- **User prompt**: the raw `userPrompt` string, unmodified, no wrapping, no additional structure.
- **No developer/tool-role message.** No prior conversation turns. No theme-state context. No product/collection catalog. No "previous generation" reference.

### B. The color-palette call — `generateAIColorPalette()` (`example-implementation.js:492-581`)
- Single user-role message asking for a 7-key hex-color JSON object based on the same raw `userPrompt`.
- Completely independent of the schema/system prompt above — the color model has no idea what sections/blocks exist.

### Measured, not guessed, sizes

Measured directly by running the real `loadSchemas()`/`buildSystemPrompt()` functions:

```
Sections loaded: 16
Blocks loaded: 53
System prompt characters: 59704
Estimated tokens (chars/4): 14926
Estimated tokens (chars/3.5, JSON-dense): 17058
```

---

## 3. The Schema System (`ai-schema/`)

**`global.json`** (`ai-schema/global.json`, 32 lines): a flat `settings` object of 8 keys (button-label color, 2 accent colors, text color, 2 background colors, page width, section spacing, button border thickness). Loaded verbatim by `loadSchemas()` and dropped into the system prompt as `AVAILABLE GLOBAL SETTINGS`. For comparison, the real theme's `config/settings_schema.json` is **2,897 lines** — the AI is only ever shown roughly 1% of the theme's actual design-token surface (nothing about typography, cart, badges, product-card styling, animations, header/footer layout, etc.). It does drive `loadGlobalSettings()` (`example-implementation.js:972`), which builds the `current`/`presets` blocks of the generated `settings_data.json` — but only for those same 8 tokens plus 3 hardcoded fields (`disable_inspect`, `logo_width`, `mobile_logo_width`).

**Section schemas** (`ai-schema/sections/*.json`, 16 files) and **block schemas** (`ai-schema/blocks/*.json`, 53 files): loaded by `loadSchemas()` (`example-implementation.js:21-73`), which just `fs.readdir` + `JSON.parse`s every file in each folder — no indexing, no filtering, no lazy loading. Each schema has: `id` (must match the real Liquid section/block's registered type), `label`, `purpose`, `allowed_on` (array of page templates), `settings` (a flat map of `setting_name → type`, where type is either a bare string like `"color"`, an array of literal option strings, or an object with `type/min/max/default/options`), `allowed_blocks` (array of block `id`s permitted inside that section — always array form in current data; `validateOutput` also has dead code handling an object form with per-block `_notes`, but no schema currently uses it), and optional `_notes` / `_image_generation`.

**How `allowed_on` is used:** it is documentation only. It's shown to the AI inside the schema JSON and referenced generically in the system prompt's rule list, but `validateOutput()` never checks that a section's `allowed_on` includes the template it was placed into — a section schema'd only for `product` could be silently placed in `index.json` and nothing in code would catch it.

**How `allowed_blocks` is used:** this one *is* enforced — `validateOutput()` (`example-implementation.js:363-378`) checks every block's `type` against the owning section's `allowed_blocks` list and errors if not present.

**How settings/types/required are represented:** there is no `required` concept at all — every setting is implicitly optional; nothing in `validateOutput` checks that "essential" settings (as described only in prose inside `_notes` or the system-prompt rules) are actually present.

**`_notes`:** pure prompt text. `validateOutput` only *reads* `_notes` for two things: (a) `DEBUG`-mode console logging, and (b) if a block's `_notes.text` string contains `"p tag"`, it pushes a non-blocking **warning** (not an error) about richtext wrapping. There is no general-purpose `_notes`-constraint enforcement engine — compliance with `_notes` depends entirely on the LLM reading and obeying the giant prompt.

**`_image_generation`:** consumed only by `buildImagePrompt()`/`checkForImageFields()`/`generateSectionImages()` in `example-implementation.js`. Important: **`generateSectionImages()` is never called from the actual pipeline** — `1-generate-theme.js`'s `runFullPipeline()` has no image-generation step despite destructuring a `generateImages` option (`1-generate-theme.js:35`) that is accepted but never read again anywhere in the function. The `--images` CLI flag is dead — it does nothing today.

**Does a schema-retrieval/selection mechanism already exist?** **No.** `loadSchemas()` always loads and sends *everything* in the two folders on every call; there is no relevance filtering, embedding search, or niche-based subset selection anywhere in the codebase. This directly matters for §9/§11 below.

**Coverage gap (critical, and different from what was assumed):** the real theme has **86** `sections/*.liquid` files and **80** `blocks/*.liquid` files. `ai-schema/` only has schemas for **16** sections (≈19% coverage) and **53** blocks (≈66% coverage). The 16/53 that do exist correctly reference real theme `id`s (every schema `id` was diffed against `sections/*.liquid`/`blocks/*.liquid` — no mismatches, and the one filename/id naming discrepancy found, e.g. `ai-schema/blocks/atc_button.json` on disk vs internal `"id": "atc-button"`, is cosmetic — the JSON `id` field, which is what actually gets sent to the AI and validated against, is correct). But 70 real sections and ~27 real blocks are **entirely invisible to the AI** — things like `rich-text`, `multicolumn`, `multirow`, `image-banner`, `pricing-table`, `related-products`, `trustpilot-reviews`, `parallax-hero`, `video`, `featured-blog`, `main-collection-product-grid`, `logo-list`, `product-features`, and dozens more. Also: **zero** of the 16 section schemas list `collection` in `allowed_on`, and the pipeline never targets any template other than `index` and `product` (see §4) — so the real theme's `collection.json`, `blog.json`, `article.json`, `cart.json`, `search.json`, `list-collections.json`, `page.*.json` templates are completely outside the system's reach today, even though they exist in `templates/`.

---

## 4. Theme Generation — configuring vs. inventing

Trace of `generateThemeFiles()` (`example-implementation.js:1057-1113`), called only after validation passes:

- **Section selection/order**: entirely up to the LLM's free-text JSON output. The only mechanical constraints are the "exactly 10 sections, first must be slideshow, ≥8 distinct types" rules stated in prose in the system prompt (`example-implementation.js:112-134`) — nothing in code enforces "exactly 10" (only `> 10` is checked; 1–10 all pass) or "first must be slideshow" or "≥8 distinct types." These are LLM-obeyed conventions, not code-enforced invariants.
- **Section/block IDs**: invented by the LLM as JSON object keys (e.g. `"hero-slideshow"`, `"lifestyle-collage"`). No ID-generation utility exists in code; nothing checks for ID collisions against the real theme's existing keys before overwrite.
- **Settings population**: whatever the LLM emits, filtered only by "does this setting's *type* look wrong for hallucinated images" — actual setting *values* (color hex codes, layout choices, numeric ranges) are never range/enum-checked against the schema's `min`/`max`/`options`.
- **Content**: fully LLM-generated free text (headings, testimonials, taglines, ticker items) — see §6.
- **Images**: schema instructs "always empty string" (`buildSystemPrompt` rule 9); `validateOutput` blocks any non-URL/non-`shopify://` string in an `image`/`image_picker` field. In practice this is **not airtight** — a committed artifact, `ai-schema/output/templates/index.json`, was found containing literal hallucinated filenames (`"image": "vegan-bowl.jpg"`) and a hallucinated product handle (`"product": "signature-vegan-chicken"`) sitting alongside a `settings_data.json` for a completely different niche ("Plant-Based Vegan Foods") and an `image-prompts-manifest.json` for yet another prompt ("Pet food store") with a hardcoded `/Users/debutify/...` path from another machine. This is stale multi-run debris (`ai-schema/output/` isn't gitignored, only `node_modules`/`.env` are — see `ai-schema/.gitignore`), but it's real evidence that: (a) output isn't cleaned between runs so stale/inconsistent artifacts accumulate and get committed, and (b) **`validateOutput` has no check at all for `product_picker`/`collection`-type settings** — only `image`/`image_picker` are checked for hallucination, so a fabricated product handle like `"signature-vegan-chicken"` sails through validation untouched. There is no real product/collection catalog ever given to the AI, so any section using a `"collection"` or `"product_picker"` setting (e.g. `featured-collection.json`, `blocks/product.json`) is structurally guaranteed to either hallucinate a handle or be left blank.
- **`templates/index.json`**: full overwrite, every run (`copyFile` in `2-copy-to-theme.js`, no merge).
- **`templates/product.json`**: **merged**, not overwritten — `mergeProductTemplate()` (`2-copy-to-theme.js:107-140`) locates the existing `main-product`-typed section key in the real template and splices in only that section's `type`/`settings`/`blocks`/`block_order`, preserving every other section (e.g. the real theme's `colors-changer` section, confirmed by diffing `ai-schema/output/templates/product.json` against the live `templates/product.json`). This is the one place in the codebase that behaves like a true "configure the existing theme" operation rather than a wholesale replacement.
- **`config/settings_data.json`**: full overwrite via `loadGlobalSettings()` + `generateThemeFiles()` — rebuilt from `global.json`'s 8 tokens only. Since the real theme almost certainly has richer settings than those 8 (2897-line schema), a full overwrite of `settings_data.json` risks **dropping any other settings that existed in the previous file**, because the new object is built fresh from `global.json` + 3 hardcoded fields, not merged with what was already on disk (see `generateThemeFiles`, `example-implementation.js:1095-1103`).

**Verdict on "configuring the existing theme" vs. "generating a new theme from scratch":** it's a hybrid, closer to "generating from scratch" than the architecture intends. The AI *is* constrained to emit only `id`s that exist in the 16/53 loaded schemas (real enforcement, via `validateOutput`), so within that subset it genuinely is "configuring the existing theme." But because (1) only ~19%/66% of the real theme's sections/blocks are ever offered as options, (2) `index.json` and `settings_data.json` are wholesale-replaced rather than incrementally edited, and (3) there is no persisted "current theme state" the AI is ever shown before generating, each run behaves like **designing a homepage from a small constrained palette**, not **editing/configuring what's already there**.

---

## 5. Clarification / Question Behavior

**No clarification mechanism currently exists.** Verified by:
- Grepping all JS files for `clarif|ambigu|follow-up question|missing information` — zero matches.
- Reading the full control flow of `runFullPipeline()`, `main()` (in both `1-generate-theme.js` and `example-implementation.js`), and `3-interactive-menu.js` — none of them ever inspect the prompt for missing fields, branch on ambiguity, or make a second LLM call to ask a question. The menu's only "structure" is a hardcoded niche picklist (`showNicheMenu()`, `3-interactive-menu.js:50-64`) that maps a number 1–9 to a canned pre-written prompt string (`getNichePrompt()`) — this is not the AI asking questions, it's the developer's own fixed prompt library, used only if the user picks options 1/2/3 instead of "custom" (option 4/9).
- The system prompt itself instructs the opposite behavior: `buildSystemPrompt()` rule 11 says *"BE CREATIVE... RANDOMIZE content... If generating multiple times, MUST create different configurations each time"* — this actively tells the model to fill every gap with invented variety rather than to pause and ask. Combined with `response_format: json_object` and a single non-interactive HTTP call, the model has no channel to ask a question even if it wanted to — its only possible output is the theme-config JSON object itself.

So, for a prompt like *"Create a premium fashion store"* with target audience/style/colors/brand name unspecified: the system **infers/invents everything automatically in one shot**, driven by keyword-based niche detection (`detectNicheAndGetColors`, string-matches words like "luxury"/"premium" against `nicheKeywords`) and/or a second free-form AI color call, with no ambiguity detection, no required-information rules, and no structured clarification step of any kind.

---

## 6. Content Generation

**Where headings/descriptions/CTAs/testimonials/nav/product copy come from:** 100% LLM free-text generation inside the single `makeAIRequest()` call — there is no separate content-generation module, no template-string library, no copied-from-base-theme defaults for text. The only "content" that isn't LLM-authored is: (a) the 6 hardcoded `COLOR_PALETTES` used as a fallback when AI color generation fails (`example-implementation.js:432-487`), and (b) the canned niche *prompts* (not content) in `3-interactive-menu.js`.

**Why "Create a premium pet wellness store for dogs and cats" can still produce generic content:** three compounding causes, all evidenced in code:
1. The system prompt's variety rules (rule 11) are generic guidance applicable to *any* niche — there's no niche-specific content-scaffolding logic beyond a handful of one-line hints (`"Fashion/Jewelry: Use collage, image-with-text..."`) buried inside a 59,704-character prompt dominated (>95% of characters) by raw JSON schema dumps. The actual user brief is a single short sentence competing for the model's attention against ~60KB of schema text.
2. `detectNicheAndGetColors()`'s keyword list has no "pet"/"wellness" keywords at all (`example-implementation.js:589-596`: `luxury, modern, vibrant, nature, tech, feminine`) — a pet-wellness prompt would silently fall through to the `modern` default palette unless the separate AI color call succeeds.
3. No product/collection catalog is ever supplied (§4), so anything requiring real product identity (names, categories, images) is either left blank or invented, disconnected from any actual "dogs and cats" catalog data.

**Does a later "change the store from fashion to pet wellness" actually update content, or only visual settings?** There is no code path for this at all — re-running the pipeline with a new prompt doesn't diff against, or reference, the previous output in any way; it just performs the exact same one-shot generation described in §1 and **overwrites** `index.json` wholesale. So the *practical* effect is closer to "regenerate everything from scratch based on the new prompt" rather than "update the existing content" — but that's a side effect of there being no state/diff mechanism, not a deliberate "settings-only" edit path. There is no "edit content only" or "edit settings only" concept anywhere in the code.

---

## 7. Existing Theme Reuse

- **Sections/blocks reused:** only the 16 sections / 53 blocks that have an `ai-schema/` JSON twin (§3) are reachable at all; the AI cannot accidentally invent new ones because `validateOutput` hard-rejects unknown `type` values (`example-implementation.js:301`, `392`) — this part of the architecture is genuinely sound.
- **Settings reused:** only the 8 `global.json` tokens; the rest of the real theme's settings surface is untouched by generation but also **at risk during full `settings_data.json` overwrite** (§4).
- **Content preserved:** none, by design — index.json is a full overwrite every run.
- **Files copied unchanged:** everything except `templates/index.json`, `templates/product.json` (merged), and `config/settings_data.json` — i.e., `layout/`, `snippets/`, `assets/`, all other `templates/*.json`, and the 70/27 non-schema'd sections/blocks are never touched by generation (they're simply outside its scope, not actively "preserved" via any merge logic).
- **Can AI accidentally create unsupported sections/blocks?** No — `validateOutput` blocks unknown `type`s from ever reaching disk. This safety net works.
- **Does the system know which sections are valid for which templates?** Only via the unenforced `allowed_on` field (§3) — declared but not checked in code, and the pipeline only ever targets `index`/`product` regardless of what `allowed_on` says for other templates.

**How close is the current implementation to "designer/configurator, not code generator"?** Genuinely close *in spirit* for the narrow slice it covers — schema-type enforcement, `allowed_blocks` enforcement, and the product-template merge logic are real configurator behaviors. But it's far from that ideal in *breadth* (81% of sections and part of the settings surface aren't representable at all) and in *statefulness* (no notion of "the theme as it currently is" is ever read back in before writing).

---

## 8. AI Editing (post-generation)

There is **no editing flow**. This is the most direct, verifiable finding in the whole audit: `3-interactive-menu.js`'s `showMenu()` (the only user-facing entry point besides raw CLI flags) has exactly 7 options, none of which accept an instruction against an already-generated theme. `runFullPipeline()` has one code path, always: load schemas → build prompt → color call → main AI call → validate → write → copy. There's no second function, no "patch mode," no section-scoped update, no reading of `templates/index.json`'s *current* contents before writing new ones. Requests like *"Make the hero section darker"* or *"Add testimonials below featured products"* have **no corresponding code path today** — running the pipeline again is the only available action, and it would regenerate the entire homepage from the new prompt text alone, with zero awareness of what the homepage currently contains.

---

## 9. Root Causes

| # | Problem | Root cause | Evidence |
|---|---|---|---|
| A | No clarification questions | No mechanism exists at all — the pipeline is a single non-interactive HTTP call constrained to `response_format: json_object`, so the model has no channel to ask anything even if prompted to. | `makeAIRequest()` (`example-implementation.js:192`); confirmed zero `clarif/ambigu` hits repo-wide |
| B | Generic output instead of the specific brief | (1) The user's brief is a few dozen words drowned inside a ~60K-character prompt that's >95% raw schema JSON; (2) niche-keyword detection (`detectNicheAndGetColors`) has a small, generic keyword set with no domain-specific vocabulary; (3) system prompt explicitly instructs "BE CREATIVE... RANDOMIZE" (rule 11), optimizing for variety over specificity | `buildSystemPrompt()` L118-134; `detectNicheAndGetColors()` L586-613 |
| C | Content doesn't change correctly on request | No diffing/state-read-back exists; every run is a stateless full regeneration from the new prompt text alone, with no memory of, or reference to, the prior content | `runFullPipeline()` full trace, §1/§6 |
| D | Existing components not consistently reused | Only 16/86 sections (19%) and 53/80 blocks (66%) have schemas at all — most of the real theme is structurally invisible to the AI, not merely "underused" | `ls`/`comm` diff, §3 |
| E | Too much or too little context | Both, simultaneously: **too much** low-signal context (all 69 schemas dumped every time regardless of relevance to the prompt — no retrieval/selection exists) and **too little** high-signal context (no real product/collection catalog, no current theme state, no page-type coverage beyond index/product) | `loadSchemas()` always-load-everything, §3; §4 |
| F | AI doesn't understand current theme state before editing | There is no "editing" — see §8. Even generation never reads the current `templates/index.json`/`settings_data.json` before overwriting them (except the narrow `main-product` merge in `2-copy-to-theme.js`) | `generateThemeFiles()`, `mergeProductTemplate()` |
| G | Generation and editing share one flow | Not applicable as stated — there is only a generation flow; an editing flow doesn't exist to be conflated with it | §8 |

---

## 10. What Already Works (should not be rewritten)

- **Schema-type enforcement** — `validateOutput()`'s section/block `type` membership checks (`example-implementation.js:301,392`) reliably prevent the AI from inventing nonexistent section/block types. Real safety net, keep it.
- **`allowed_blocks` enforcement** — `example-implementation.js:363-378` correctly rejects blocks placed in sections that don't permit them.
- **`max_blocks` + `block_order` structural validation** — `example-implementation.js:332-354` catches structurally malformed block output.
- **Schema file format & loader** — `loadSchemas()` and the `id/label/purpose/allowed_on/settings/allowed_blocks/_notes/_image_generation` schema shape (documented in `SCHEMA_CREATION_GUIDE.md`) is a clean, extensible convention; the problem is coverage (16/53 files), not the format itself.
- **Product-template merge logic** — `mergeProductTemplate()` (`2-copy-to-theme.js:107-140`) is a genuinely good "configure, don't replace" pattern — it's the one place the codebase already does targeted, non-destructive updates. Worth studying as a model for what index.json/settings_data.json editing *should* look like.
- **Retry-with-backoff on the AI HTTP call** — `makeAIRequest()`'s exponential-backoff retry on 5xx (`example-implementation.js:201-255`) is sound infrastructure.
- **Image-hallucination guard** (partial) — the `image`/`image_picker` value check in `validateOutput` is a real, working idea; it's just incomplete (doesn't cover `product_picker`/`collection` types).
- **`_image_generation` prompt-building machinery** (`buildImagePrompt`, `checkForImageFields`, `buildDefaultImagePrompt`) — fully implemented and reasonable, just currently disconnected from the pipeline (§3's dead-`--images`-flag finding). Reusable once wired back in.
- **CLI/menu scaffolding** (`3-interactive-menu.js`) — fine as a dev tool for testing generation; not a constraint on whatever the "real" application turns out to be.

---

## 11. Missing Architectural Pieces

| Category | Status | Evidence |
|---|---|---|
| Request understanding / intent classification | **MISSING** | No code path distinguishes "generate" vs "edit" vs "redesign" intents — only one flow exists (§8) |
| Clarification / question phase | **MISSING** | §5 — confirmed via full-repo grep and control-flow trace |
| Brand/store brief (persisted) | **MISSING** | Nothing persists parsed intent beyond the single raw prompt string passed into one function call |
| Page architecture planning | **PARTIALLY EXISTS** | Hardcoded to two shapes only: "exactly 10 sections, slideshow first" for index (prose rule, unenforced in code) and "one main-product section, 12-18 blocks" for product (`buildSystemPrompt` rules 10/12) — not a general planner, and no template beyond index/product is addressable |
| Schema capability retrieval (relevance-based) | **MISSING** | `loadSchemas()` always loads/sends the entire folder contents; no selection logic exists (§3) |
| Theme state (read current theme before acting) | **MISSING** | Only exception is `mergeProductTemplate`'s narrow lookup of the existing `main-product` section key (§4/§10) |
| Structured operations (e.g. "update setting X on section Y") | **MISSING** | The only "operation" is "replace/merge the whole file"; there's no operation vocabulary at all |
| Content-update operations (as distinct from full regen) | **MISSING** | §6 — no diffing exists |
| Contextual retrieval (product/collection catalog, brand assets) | **MISSING** | Confirmed no Shopify Admin API / product data call anywhere in the JS files |
| Generation vs. editing separation | **MISSING** | Only generation exists; there's nothing to separate it from |
| Validation | **PARTIALLY EXISTS** | Strong for section/block/type/`allowed_blocks`/image-string shape; absent for `allowed_on`-vs-template, setting value ranges/enums, product/collection hallucination, and "required settings" |
| Retry / error handling | **PARTIALLY EXISTS** | Network-level retry with backoff exists (`makeAIRequest`); validation-failure handling does not retry or attempt self-repair — it just throws and exits (`1-generate-theme.js:90-92`) |
| Section/template coverage beyond index & product | **MISSING** | 0 of the 16 schemas cover `collection`; pipeline hardcodes `templateName` to `index`/`product` only in every call site (§4/§3) |

---

## 12. Initial Generation vs. Editing — do they use different flows?

They cannot be "the same flow" in a meaningful sense, because **only one of the four scenarios has any implementation at all**:

- **Initial request** ("Create a premium pet wellness store...") → fully implemented, the flow traced in §1.
- **Existing-theme visual edit** ("Make the hero section darker") → **no flow exists**.
- **Existing-theme content edit** ("Change the hero heading to X") → **no flow exists**.
- **Major redesign** ("Redesign the homepage for a luxury pet wellness brand") → in practice this is indistinguishable from "initial request" today: re-running `runFullPipeline()` with new prompt text produces the same kind of full-overwrite regeneration regardless of whether the user intended a from-scratch build or a redesign of something that already exists.

So the honest framing isn't "generation and editing share a flow" — it's that **the codebase only implements generation**, and anything that sounds like an edit currently gets silently treated as a fresh full generation because that's the only capability that exists.

---

## 13. Current Architecture Diagram

```text
User (terminal)
   ↓
3-interactive-menu.js: showMenu() / prompt()          ← OR → CLI flags via 1-generate-theme.js: parseArgs()
   ↓
1-generate-theme.js: runFullPipeline(userPrompt, options)
   ↓
example-implementation.js: loadSchemas()
      reads ai-schema/global.json (8 settings)
      reads ALL 16 files in ai-schema/sections/*.json
      reads ALL 53 files in ai-schema/blocks/*.json
      (no relevance filtering — everything, every time)
   ↓
example-implementation.js: buildSystemPrompt(schemas)
      12 hardcoded rules + full JSON dump of all schemas  (~59.7K chars / ~15-17K tokens)
   ↓
example-implementation.js: generateAIColorPalette(userPrompt)     [OpenRouter call #1 — color only]
      ↳ fallback: detectNicheAndGetColors(userPrompt)              [keyword match, no AI]
   ↓
example-implementation.js: makeAIRequest(userPrompt, systemPrompt) [OpenRouter call #2 — main config]
      model = OPENROUTER_MODEL env (default: moonshotai/kimi-k2.5)
      single-shot, response_format: json_object, no conversation history, no clarification
   ↓
example-implementation.js: validateOutput(aiOutput, schemas)
      JSON.parse + type/allowed_blocks/max_blocks/block_order/image-string checks
      FAIL → runFullPipeline throws → process.exit(1)   (no retry, no repair loop)
   ↓
example-implementation.js: generateThemeFiles(config, templateName, {}, colors)
      writes ai-schema/output/templates/<name>.json   (full overwrite)
      writes ai-schema/output/config/settings_data.json (full overwrite, rebuilt from global.json only)
   ↓
2-copy-to-theme.js: copyGeneratedFilesToTheme()
      index.json            → templates/index.json           (full overwrite)
      product.json           → templates/product.json          (MERGED — main-product section only, rest preserved)
      settings_data.json     → config/settings_data.json        (full overwrite)
      images/*                → assets/generated-images/*        (dead path — image generation not called by pipeline)
   ↓
Shopify Theme Files (on disk — no deploy/push step in this repo)
```

---

## 14. Final Audit Report

**Current Architecture.** A stateless, single-shot Node.js CLI pipeline (`ai-schema/1-generate-theme.js` orchestrating `ai-schema/example-implementation.js`), invoked via CLI flags or a terminal menu (`ai-schema/3-interactive-menu.js`). No web app, API server, frontend, or persisted session exists in this repository.

**Current Generation Flow.** §1/§13 above, verbatim from code.

**Current Editing Flow.** Does not exist (§8). Re-running generation is the only available action, and it fully overwrites `templates/index.json` and `config/settings_data.json` regardless of intent.

**Current Schema Flow.** `loadSchemas()` always loads and sends the entirety of `global.json` (8 settings), all 16 section schemas, and all 53 block schemas on every call — no relevance selection exists. Real theme coverage is only ~19% of sections and ~66% of blocks; the `collection`/`blog`/`article`/`cart`/`search`/`page.*` templates are entirely unaddressed.

**Current Content Flow.** 100% LLM free-text generation in one call, guided only by generic variety rules; no product/collection catalog is ever supplied, so anything requiring real catalog identity is invented or left blank; no diffing exists so "change X to Y" behaves like a full regeneration, not a targeted update.

**Current Clarification Flow.** None. Confirmed by full-repo search and control-flow trace — the model has no channel to ask a question given the single non-interactive `response_format: json_object` call.

**Current AI Context.** Measured directly: ~59,704-character (~15,000–17,000 token) system prompt per generation call, dominated by raw schema JSON; a separate, unrelated second call for color palette; no theme state, no conversation history, no product data, no page-type awareness beyond index/product.

**Current AI Output.** A single JSON object `{ sections: {...}, order: [...] }`, parsed with a bare `JSON.parse`.

**Validation.** Solid for structural/type/`allowed_blocks`/`max_blocks`/image-string-hallucination checks; absent for `allowed_on`-per-template, setting value ranges/enums, `_notes` enforcement (beyond one hardcoded richtext-p-tag warning), and product/collection hallucination — evidenced by a real committed artifact containing an invented product handle that passed validation.

**Theme File Generation.** `index.json` and `settings_data.json`: full overwrite, every run. `product.json`: genuine merge (only `main-product` section replaced, rest preserved) — the one part of the system that already behaves like true "configuration" rather than replacement.

**Working Components.** Schema-type/`allowed_blocks`/`max_blocks` enforcement, the schema file format itself, the product-template merge pattern, retry-with-backoff networking, and the (currently disconnected) image-generation machinery — see §10 for the full list and why each should be kept.

**Problems Found / Root Causes / Missing Pieces.** See §9 and §11 in full detail above.

**Files Involved:**
- `ai-schema/1-generate-theme.js` — pipeline orchestrator, CLI arg parsing.
- `ai-schema/2-copy-to-theme.js` — output→theme file copier/merger; contains the only real "configure, don't replace" logic (`mergeProductTemplate`).
- `ai-schema/3-interactive-menu.js` — terminal UI; canned niche-prompt picklist.
- `ai-schema/example-implementation.js` — all core logic: schema loading, prompt building, AI calls, validation, file generation, color palettes, image-prompt building (unused).
- `ai-schema/global.json` — 8-token global design settings.
- `ai-schema/sections/*.json` (16), `ai-schema/blocks/*.json` (53) — the AI's addressable capability surface (a minority of the real theme).
- `ai-schema/SCHEMA_CREATION_GUIDE.md` — the schema authoring convention.
- `ai-schema/output/` — last-run scratch artifacts (contains stale, informative debris from mismatched prior runs; not gitignored).
- `templates/index.json`, `templates/product.json`, `config/settings_data.json` — the live theme files the pipeline writes to.
- `config/settings_schema.json` (2,897 lines) — the real theme's full design-token surface, of which the AI sees ~1%.

**Current Architecture Diagram.** §13 above.
