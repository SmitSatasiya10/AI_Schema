#!/usr/bin/env node

/**
 * Complete AI Theme Generation Pipeline
 * 
 * This script:
 * 1. Generates theme configuration using AI
 * 2. Optionally generates images
 * 3. Automatically copies files to the theme folder
 * 4. Outputs a summary of changes
 */

const path = require('path');
const { 
    loadSchemas, 
    buildSystemPrompt, 
    makeAIRequest, 
    validateOutput, 
    generateThemeFiles, 
    loadGlobalSettings,
    detectNicheAndGetColors,
    generateAIColorPalette 
} = require('./example-implementation');

const { copyGeneratedFilesToTheme, checkOutputFiles } = require('./2-copy-to-theme');
const instrumentation = require('./instrumentation');
const { understandRequest } = require('./clarification');
const { buildThemeState, DEFAULT_THEME_ROOT } = require('./theme-state');
const { runStagedGeneration } = require('./generation');
const { validateCandidate, validateThemeCompatibility } = require('./validation');
const { mergeThemeState } = require('./merge');
const { applyThemeState } = require('./apply');
const { generateAndApplyFooter } = require('./footer-generation');

const DEBUG = process.env.DEBUG === 'true';

/**
 * Full pipeline: Generate → Validate → Copy
 */
async function runFullPipeline(userPrompt, options = {}) {
    const {
        templateName = 'index',
        generateImages = false,
        autoCopy = true,
        cleanup = false,
        // Phase 2: opt-in only. Default (false/omitted) preserves the exact
        // pre-Phase-2 behavior — loadSchemas() with no args, every schema,
        // every call — per the plan's "old path must remain recoverable"
        // requirement. RETRIEVAL_MODE env var offers the same opt-in
        // without touching call sites that don't pass options explicitly.
        retrievalMode = process.env.RETRIEVAL_MODE === 'true',
        // Phase 3: opt-in only, same reasoning as retrievalMode above — the
        // clarification pass can be bypassed entirely to fall back to
        // today's always-generate behavior (Phase 3 spec's rollback
        // requirement). sessionId lets a caller resume a multi-turn
        // clarification across separate runFullPipeline() invocations
        // (there is no long-running process to hold state in memory across
        // CLI runs — see brief.js for the file-based persistence this uses).
        understandingMode = process.env.UNDERSTANDING_MODE === 'true',
        sessionId = null,
        // Phase 5: opt-in, same rollback posture as Phases 2/3 — the old
        // single-mega-prompt path remains fully available/default. Staged
        // generation is architecturally dependent on a resolved WebsiteBrief
        // (spec §6), so enabling it also enables understanding — a caller
        // that only asked for --staged shouldn't have to separately remember
        // --understanding too.
        stagedMode = process.env.STAGED_MODE === 'true',
        // Phase 7: opt-in, same rollback posture as Phases 2/3/5 — the old
        // full-overwrite/mergeProductTemplate() copy step (2-copy-to-theme.js)
        // remains the default. When enabled, STEP 7 uses merge.js/apply.js
        // instead: a deterministic merge against the current ThemeState,
        // fail-closed on conflicts, then a staged/verified/backed-up write
        // (§22 "apply must be explicit" — still gated by the existing
        // autoCopy flag, not a second independent gate).
        mergeApplyMode = process.env.MERGE_APPLY_MODE === 'true',
        // Required, non-default acknowledgement before a full-structure
        // merge (e.g. "index") is allowed to discard existing sections the
        // AI schema catalog doesn't recognize — see merge.js's file header.
        acknowledgeUnknownSectionReplacement = false,
        // Reports what apply.js WOULD write without writing it (§23).
        dryRunApply = false,
        // Only meaningful with mergeApplyMode; overridable so tests never
        // point apply.js at the real repo (§26).
        themeRoot = DEFAULT_THEME_ROOT
    } = options;

    const effectiveUnderstandingMode = understandingMode || stagedMode;

    const requestId = instrumentation.nextRequestId('pipeline');
    const pipelineStartTime = Date.now();
    let aiCallCount = 0;

    try {
        console.log('\n' + '='.repeat(70));
        console.log('🚀 ECOMSKALE AI THEME GENERATOR - FULL PIPELINE');
        console.log('='.repeat(70) + '\n');

        // STEP 0: Request understanding + clarification (Phase 3, opt-in).
        // Runs BEFORE any schema is loaded or any generation call is made —
        // per the phase plan, Phase 3 must never generate theme JSON itself,
        // it only decides whether there's enough information to proceed.
        let resolvedBrief = null;
        if (effectiveUnderstandingMode) {
            console.log('🧭 STEP 0: Understanding request...');
            const understanding = await understandRequest(userPrompt, { sessionId, context: { requestId } });
            aiCallCount++;

            if (understanding.status === 'NEEDS_CLARIFICATION') {
                console.log(`❓ Need more information before generating (session: ${understanding.sessionId}):`);
                understanding.questions.forEach((q, i) => console.log(`   ${i + 1}. ${q}`));
                console.log(`\n   Re-run with the same session to answer: --session ${understanding.sessionId} --prompt "<your answer>"\n`);

                instrumentation.logPipeline({
                    requestId,
                    success: false,
                    status: 'NEEDS_CLARIFICATION',
                    sessionId: understanding.sessionId,
                    aiCallCount,
                    templateName,
                    durationMs: Date.now() - pipelineStartTime
                });

                return {
                    success: false,
                    status: 'NEEDS_CLARIFICATION',
                    sessionId: understanding.sessionId,
                    questions: understanding.questions,
                    brief: understanding.brief
                };
            }

            resolvedBrief = understanding.brief;
            console.log(`✅ Request understood (session: ${understanding.sessionId})\n`);
        }

        // STEP 1: Load schemas. Staged mode always loads the full catalog —
        // Phase 5's own retrieval (inside runStagedGeneration) narrows it
        // internally from the brief, so the legacy retrievalMode flag (which
        // narrows what buildSystemPrompt() sees) doesn't apply here.
        console.log('📚 STEP 1: Loading AI schemas...');
        const schemas = stagedMode
            ? await loadSchemas()
            : (retrievalMode
                ? await loadSchemas({ retrieval: { userPrompt, templateName, requestId } })
                : await loadSchemas());
        if (schemas.retrievalMeta) {
            console.log(`✅ Retrieval: ${schemas.retrievalMeta.mode} — ${schemas.sectionSchemas.length} sections, ${schemas.blockSchemas.length} blocks (of ${schemas.retrievalMeta.candidateSectionCount} eligible / ${schemas.retrievalMeta.candidateBlockCount} total blocks)${schemas.retrievalMeta.fallbackReason ? ` — fallback: ${schemas.retrievalMeta.fallbackReason}` : ''}\n`);
        } else {
            console.log(`✅ Loaded: ${schemas.sectionSchemas.length} sections, ${schemas.blockSchemas.length} blocks\n`);
        }

        // STEP 2: Build system prompt (legacy path only — staged generation
        // builds its own bounded, plan-scoped prompts inside generation.js).
        let systemPrompt = null;
        if (!stagedMode) {
            console.log('📝 STEP 2: Building system prompt...');
            systemPrompt = buildSystemPrompt(schemas);
            console.log(`✅ System prompt ready (${systemPrompt.length} characters)\n`);
        }

        // STEP 3: Handle colors (shared by both paths — unchanged)
        console.log('🎨 STEP 3: Generating color palette...');
        let colors = null;
        const aiColors = await generateAIColorPalette(userPrompt, 2, { requestId, callType: 'color_palette' });
        aiCallCount++;

        if (aiColors) {
            colors = aiColors;
            console.log(`✅ AI Color Palette: ${aiColors.niche.toUpperCase()}`);
            console.log(`   Primary: ${aiColors.colors_accent_1}`);
            console.log(`   Secondary: ${aiColors.colors_accent_2}`);
            console.log(`   Reason: ${aiColors.description}\n`);
        } else {
            const result = detectNicheAndGetColors(userPrompt);
            colors = result.colors;
            console.log(`✅ Using predefined palette: ${result.niche.toUpperCase()}`);
            console.log(`   Primary color: ${colors.colors_accent_1}\n`);
        }

        // Optional interactive gate (§ "user approves/overrides AI colors"):
        // the caller (the CLI) decides HOW to ask — this function only
        // guarantees the AI's chosen palette is never used without giving
        // the caller a chance to confirm or replace it first, when it wants
        // one. Omitted entirely (e.g. non-interactive/test callers), colors
        // pass through unchanged — same behavior as before this hook existed.
        if (typeof options.onColorsReady === 'function') {
            colors = await options.onColorsReady(colors);
        }

        let validation;
        let themeState = null; // built here (stagedMode) or lazily in STEP 7 (mergeApplyMode) — never rebuilt twice
        if (stagedMode) {
            // STEP 4: Phase 4 ThemeState (read-only, no AI call) + Phase 5
            // staged generation (plan → configure, each independently
            // validated — see generation.js).
            console.log('🏗️  STEP 4a: Building current ThemeState (read-only)...');
            themeState = await buildThemeState({ themeRoot, context: { requestId } });
            console.log(`✅ ThemeState: ${themeState.meta.templateCount} templates, ${themeState.meta.sectionCount} sections (${themeState.meta.unknownSectionCount} unknown to AI schema)\n`);

            // Phase 6 (§20/§21): informational compatibility boundary only —
            // never blocks generation, never merges/applies (that's Phase 7).
            const themeCompat = validateThemeCompatibility(themeState, templateName);
            if (themeCompat.warnings.length > 0) {
                console.log(`ℹ️  ThemeState compatibility notes (${themeCompat.warnings.length}):`);
                themeCompat.warnings.forEach(w => console.log(`   - [${w.code}] ${w.message}`));
                console.log();
            }

            console.log('🧩 STEP 4b: Staged AI generation (plan → configure)...');
            const staged = await runStagedGeneration({ brief: resolvedBrief, schemas, themeState, templateName, requestId });
            aiCallCount += staged.aiCallCount;
            console.log(`✅ Staged generation complete — ${staged.retrievalMeta.mode}, ${staged.plan.order.length} sections (plan repaired: ${staged.planRepaired}, config repaired: ${staged.configRepaired})\n`);

            validation = { valid: true, config: staged.config, warnings: staged.warnings || [] };

            // Footer bundling: every homepage generation also regenerates
            // the footer's block content (link headings, newsletter copy)
            // to match, reusing the SAME resolved brief and ThemeState —
            // no second clarification call. Writes directly via merge/apply
            // regardless of this run's own mergeApplyMode choice (the only
            // viable write path for a sections/*.json file — see
            // footer-generation.js). A failure here must not undo the
            // homepage generation that already succeeded above.
            if (templateName === 'index' && autoCopy) {
                console.log('🦶 STEP 4c: Regenerating footer content...');
                try {
                    const footerResult = await generateAndApplyFooter({ brief: resolvedBrief, schemas, themeState, themeRoot, requestId });
                    aiCallCount += footerResult.aiCallCount;
                    if (footerResult.applied) {
                        console.log(`✅ Footer updated (${footerResult.linkListCount} link list(s), existing menu assignments preserved)\n`);
                    } else {
                        console.log(`ℹ️  Footer not updated: ${footerResult.reason}\n`);
                    }
                } catch (footerError) {
                    console.warn(`⚠️  Footer generation failed, homepage generation is unaffected: ${footerError.message}\n`);
                }
            }
        } else {
            // STEP 4: AI Configuration (legacy single-call path)
            console.log('🤖 STEP 4: Requesting AI-generated configuration...');
            console.log(`   Prompt: "${userPrompt}"\n`);

            // Phase 6 (§5/§24): layers the new candidate validator
            // (allowed_on, deep setting validation, product/collection
            // hallucination guard — validation.js) on top of the existing,
            // unmodified validateOutput() — same pipeline shape Phase 5's
            // staged path already uses, generalized here to the legacy
            // single-call path, which previously had NO repair loop at all
            // (AUDIT.md: "failure just throws -> process.exit(1)").
            function validateLegacyCandidate(output) {
                const outputValidation = validateOutput(output, schemas, { requestId });
                if (!outputValidation.valid) {
                    return { valid: false, config: null, warnings: [], errors: [outputValidation.error] };
                }
                const candidateValidation = validateCandidate(outputValidation.config, schemas, { templateName });
                return {
                    valid: candidateValidation.valid,
                    config: candidateValidation.valid ? outputValidation.config : null,
                    warnings: outputValidation.warnings || [],
                    errors: candidateValidation.errors.map(e => `[${e.code}] ${e.path}: ${e.message}`)
                };
            }

            const firstOutput = await makeAIRequest(userPrompt, systemPrompt, 3, { requestId, callType: 'main_generation' });
            aiCallCount++;
            console.log('✅ AI response received\n');

            // STEP 5: Validate (+ one bounded repair attempt — §24/§29)
            console.log('✅ STEP 5: Validating configuration...');
            let legacyResult = validateLegacyCandidate(firstOutput);

            if (!legacyResult.valid) {
                console.warn('⚠️  Validation failed, attempting one bounded repair...');
                legacyResult.errors.forEach(e => console.log(`   - ${e}`));
                const repairPrompt = `${userPrompt}\n\nYour previous response was invalid for these reasons: ${legacyResult.errors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
                const repairOutput = await makeAIRequest(repairPrompt, systemPrompt, 3, { requestId, callType: 'main_generation_repair' });
                aiCallCount++;
                legacyResult = validateLegacyCandidate(repairOutput);
            }

            if (legacyResult.warnings && legacyResult.warnings.length > 0) {
                console.log('⚠️  Warnings:');
                legacyResult.warnings.forEach(w => console.log(`   - ${w}`));
                console.log();
            }

            if (!legacyResult.valid) {
                throw new Error(`Validation failed even after repair: ${legacyResult.errors.join('; ')}`);
            }
            console.log('✅ Configuration is valid!\n');
            validation = { valid: true, config: legacyResult.config, warnings: legacyResult.warnings };
        }

        // STEP 6: Generate theme files
        console.log('📁 STEP 6: Generating theme files...');
        const outputDir = path.join(__dirname, 'output');
        const files = await generateThemeFiles(
            validation.config,
            templateName,
            {},
            colors
        );
        console.log('✅ Theme files generated\n');

        // STEP 7: Apply to theme (if auto-copy enabled) — same explicit
        // gate (`autoCopy`) as the legacy path, not a second independent
        // flag (§22): mergeApplyMode only changes HOW the write happens,
        // not whether writing was requested at all.
        let mergeSummary = null;
        let applyResult = null;
        if (autoCopy) {
            if (mergeApplyMode) {
                console.log('🔀 STEP 7: Merging + applying to theme (Phase 7)...');
                if (!themeState) themeState = await buildThemeState({ themeRoot, context: { requestId } });

                const candidateValidation = validateCandidate(validation.config, schemas, { templateName, themeState });

                const globalSettingsChanges = {};
                if (colors) {
                    for (const key of ['colors_accent_1', 'colors_accent_2', 'colors_text', 'colors_background_1', 'colors_background_2', 'colors_solid_button_labels', 'gradient_accent_1', 'gradient_accent_2']) {
                        if (colors[key] !== undefined) globalSettingsChanges[key] = colors[key];
                    }
                }
                if (templateName === 'index') globalSettingsChanges.content_for_index = validation.config.order;

                const mergeResult = mergeThemeState(themeState, {
                    templateName,
                    candidate: validation.config,
                    candidateValidation,
                    globalSettingsChanges,
                    acknowledgeUnknownSectionReplacement,
                    requestId
                });

                if (!mergeResult.valid) {
                    throw new Error(`Merge failed: ${mergeResult.conflicts.map(c => `[${c.code}] ${c.message}`).join('; ')}`);
                }
                mergeSummary = mergeResult.summary;

                applyResult = await applyThemeState(mergeResult.mergedThemeState, {
                    themeRoot,
                    changedTemplates: mergeResult.summary.changedTemplates,
                    writeGlobalSettings: mergeResult.summary.changedFiles.includes('config/settings_data.json'),
                    dryRun: dryRunApply,
                    requestId
                });
                console.log(`✅ ${dryRunApply ? 'Dry run — would change' : 'Applied'}: ${mergeResult.summary.changedFiles.join(', ')}\n`);
            } else {
                console.log('📋 STEP 7: Copying files to theme folder...');
                const copied = await copyGeneratedFilesToTheme();
                if (!copied) {
                    console.warn('⚠️  Some files could not be copied. Please check the output folder.\n');
                }
            }
        }

        // Final summary
        console.log('='.repeat(70));
        console.log('✨ GENERATION COMPLETE!\n');
        
        console.log('📊 Summary:');
        console.log(`   Sections: ${validation.config.order.length}`);
        console.log(`   Template: ${templateName}.json`);
        console.log(`   Colors: ${colors.niche || 'custom'} palette`);
        
        const outputFiles = await checkOutputFiles();
        if (outputFiles.template) console.log('   ✓ templates/index.json');
        if (outputFiles.settings) console.log('   ✓ config/settings_data.json');
        if (outputFiles.images) console.log('   ✓ images/ (generated)');
        
        console.log('\n🎯 Generated sections:');
        validation.config.order.forEach((sectionId, index) => {
            const section = validation.config.sections[sectionId];
            console.log(`   ${index + 1}. ${sectionId} (${section.type})`);
        });

        console.log('\n' + '='.repeat(70) + '\n');

        instrumentation.logPipeline({
            requestId,
            success: true,
            stagedMode,
            mergeApplyMode,
            retrievalMode: schemas.retrievalMeta ? schemas.retrievalMeta.mode : 'FULL_SCHEMA_MODE',
            sectionSchemaCount: schemas.sectionSchemas.length,
            blockSchemaCount: schemas.blockSchemas.length,
            systemPromptChars: systemPrompt ? systemPrompt.length : 0,
            estimatedSystemPromptTokens: instrumentation.estimateTokensFromChars(systemPrompt ? systemPrompt.length : 0),
            aiCallCount,
            templateName,
            durationMs: Date.now() - pipelineStartTime
        });

        return {
            success: true,
            config: validation.config,
            colors,
            files,
            mergeSummary,
            applyResult
        };

    } catch (error) {
        instrumentation.logPipeline({
            requestId,
            success: false,
            aiCallCount,
            templateName,
            durationMs: Date.now() - pipelineStartTime,
            error: error.message
        });
        console.error('\n❌ ERROR:', error.message);
        if (DEBUG) console.error(error.stack);
        process.exit(1);
    }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        templateName: 'index',
        generateImages: false,
        autoCopy: true,
        cleanup: false,
        retrievalMode: process.env.RETRIEVAL_MODE === 'true',
        understandingMode: process.env.UNDERSTANDING_MODE === 'true',
        sessionId: null,
        // CLI default flipped: staged generation (AI chooses sections/blocks
        // from the full template-eligible name list, see generation.js) is
        // now on unless explicitly disabled via --no-staged or
        // STAGED_MODE=false. runFullPipeline()'s OWN internal default
        // (line ~66 above) is intentionally left untouched — that's what
        // test/phase5Regression.test.js's "byte-identical to before Phase 5"
        // case pins for direct/programmatic callers that pass no options.
        stagedMode: process.env.STAGED_MODE !== 'false',
        mergeApplyMode: process.env.MERGE_APPLY_MODE === 'true',
        dryRunApply: false
    };

    let userPrompt = 'Create a beautiful homepage for a modern e-commerce store.';

    // Parse named arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--prompt' && args[i + 1]) {
            userPrompt = args[i + 1];
            i++;
        } else if (arg === '--template' && args[i + 1]) {
            options.templateName = args[i + 1];
            i++;
        } else if (arg === '--images') {
            options.generateImages = true;
        } else if (arg === '--no-copy') {
            options.autoCopy = false;
        } else if (arg === '--cleanup') {
            options.cleanup = true;
        } else if (arg === '--retrieval') {
            options.retrievalMode = true;
        } else if (arg === '--full-schema') {
            options.retrievalMode = false;
        } else if (arg === '--understanding') {
            options.understandingMode = true;
        } else if (arg === '--no-understanding') {
            options.understandingMode = false;
        } else if (arg === '--session' && args[i + 1]) {
            options.sessionId = args[i + 1];
            i++;
        } else if (arg === '--staged') {
            options.stagedMode = true;
        } else if (arg === '--no-staged') {
            options.stagedMode = false;
        } else if (arg === '--merge-apply') {
            options.mergeApplyMode = true;
        } else if (arg === '--no-merge-apply') {
            options.mergeApplyMode = false;
        } else if (arg === '--dry-run-apply') {
            options.dryRunApply = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node generate-and-copy.js [options]

Options:
  --prompt TEXT           User prompt for theme generation
  --template NAME         Template name (default: index)
  --images                Generate images for sections
  --no-copy               Don't copy files to theme folder
  --cleanup               Remove output files after copying
  --retrieval             Use Phase 2 deterministic schema retrieval instead
                          of loading every schema (opt-in; same effect as
                          RETRIEVAL_MODE=true). Falls back to the full
                          schema set automatically if retrieval can't find
                          enough relevant candidates.
  --full-schema           Force the pre-Phase-2 full-load behavior even if
                          RETRIEVAL_MODE=true is set in the environment.
  --understanding         Use Phase 3 request understanding/clarification
                          before generating (opt-in; same effect as
                          UNDERSTANDING_MODE=true). If the request is
                          ambiguous, prints targeted questions and exits
                          without generating instead of guessing.
  --no-understanding      Force the pre-Phase-3 always-generate behavior
                          even if UNDERSTANDING_MODE=true is set.
  --session ID            Resume a previous clarification session (the
                          session ID is printed when clarification pauses).
                          Only meaningful together with --understanding.
  --staged                Use Phase 5 staged generation (AI plans structure
                          from the full template-eligible section/block name
                          list, then configures only what it picked) instead
                          of the single-mega-prompt path. DEFAULT as of this
                          CLI unless disabled below. Implies --understanding
                          — staged generation requires a resolved
                          WebsiteBrief. Reads the current ThemeState
                          read-only for context; never writes to the live
                          theme itself (that's still gated by --no-copy).
  --no-staged             Force the legacy single-call, full-schema-dump
                          generation path (same effect as STAGED_MODE=false).
  --merge-apply           Use Phase 7 deterministic merge/apply (merge.js/
                          apply.js) instead of the legacy full-overwrite/
                          mergeProductTemplate() copy step (opt-in; same
                          effect as MERGE_APPLY_MODE=true). Still gated by
                          --no-copy like the legacy copy step. Fails closed
                          (throws, writes nothing) on an unsafe merge —
                          e.g. a full-structure template replacement that
                          would discard sections unknown to the AI schema
                          catalog.
  --no-merge-apply        Force the pre-Phase-7 copy step even if
                          MERGE_APPLY_MODE=true is set in the environment.
  --dry-run-apply         With --merge-apply, report what would change
                          without writing anything.
  --help                  Show this help message

Examples:
  node generate-and-copy.js
  node generate-and-copy.js --prompt "Pet food store homepage"
  node generate-and-copy.js --prompt "Luxury fashion" --images
  node generate-and-copy.js --template home --no-copy
  node generate-and-copy.js --prompt "Pet wellness store" --retrieval
  node generate-and-copy.js --prompt "Make me a premium store" --understanding
  node generate-and-copy.js --prompt "PawWell, dog supplements" --understanding --session understand_123_1
  node generate-and-copy.js --prompt "Create a premium pet wellness store for dogs and cats" --staged
`);
            process.exit(0);
        }
    }

    return { userPrompt, options };
}

// Main execution
async function main() {
    const { userPrompt, options } = parseArgs();
    await runFullPipeline(userPrompt, options);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { runFullPipeline };
