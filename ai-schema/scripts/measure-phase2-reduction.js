#!/usr/bin/env node
/**
 * Phase 2 measurement script — run once to produce PHASE2_MEASUREMENTS.json.
 * Not part of the test suite (tests assert behavior; this just records real
 * numbers for the report), but written the same way as Phase 1's
 * BASELINE_MEASUREMENTS.json: measured from the actual implementation, not
 * assumed. Re-run any time with `node scripts/measure-phase2-reduction.js`.
 */
const fs = require('fs');
const path = require('path');
const { loadSchemas, buildSystemPrompt } = require('../example-implementation');
const { estimateTokensFromChars } = require('../instrumentation');

const SCENARIOS = [
    { name: 'pet wellness', prompt: 'Create a premium pet wellness store for dogs and cats.', templateName: 'index' },
    { name: 'luxury fashion', prompt: 'Create a luxury fashion store.', templateName: 'index' },
    { name: 'SaaS landing', prompt: 'Create a modern SaaS landing page.', templateName: 'index' },
    { name: 'descriptive (testimonials + trust + countdown)', prompt: 'Build a store with customer testimonials, trust badges, and a countdown timer for urgency.', templateName: 'index' },
    { name: 'product page', prompt: 'Create a product page for a premium pet supplement.', templateName: 'product' },
    { name: 'vague / no signal', prompt: 'asdf qwerty', templateName: 'index' }
];

async function main() {
    const full = await loadSchemas();
    const fullPrompt = buildSystemPrompt(full);
    const baseline = {
        sectionSchemaCount: full.sectionSchemas.length,
        blockSchemaCount: full.blockSchemas.length,
        systemPromptChars: fullPrompt.length,
        estimatedSystemPromptTokens: estimateTokensFromChars(fullPrompt.length)
    };

    const results = [];
    for (const scenario of SCENARIOS) {
        const retrieved = await loadSchemas({ retrieval: { userPrompt: scenario.prompt, templateName: scenario.templateName } });
        const retrievedPrompt = buildSystemPrompt(retrieved);
        const afterChars = retrievedPrompt.length;
        const afterTokens = estimateTokensFromChars(afterChars);
        const reductionPct = Math.round((1 - afterChars / baseline.systemPromptChars) * 1000) / 10;

        results.push({
            scenario: scenario.name,
            prompt: scenario.prompt,
            templateName: scenario.templateName,
            mode: retrieved.retrievalMeta.mode,
            fallbackReason: retrieved.retrievalMeta.fallbackReason,
            selectedSectionIds: retrieved.sectionSchemas.map(s => s.id),
            selectedSectionCount: retrieved.sectionSchemas.length,
            selectedBlockCount: retrieved.blockSchemas.length,
            before: { chars: baseline.systemPromptChars, estimatedTokens: baseline.estimatedSystemPromptTokens },
            after: { chars: afterChars, estimatedTokens: afterTokens },
            reductionPct
        });
    }

    const output = { measuredAt: new Date().toISOString(), baseline, scenarios: results };
    fs.writeFileSync(
        path.join(__dirname, '..', 'PHASE2_MEASUREMENTS.json'),
        JSON.stringify(output, null, 2) + '\n'
    );

    console.log(`Baseline: ${baseline.systemPromptChars} chars / ~${baseline.estimatedSystemPromptTokens} tokens (${baseline.sectionSchemaCount} sections, ${baseline.blockSchemaCount} blocks)\n`);
    for (const r of results) {
        console.log(`${r.scenario} [${r.mode}]`);
        console.log(`  before: ${r.before.chars} chars / ~${r.before.estimatedTokens} tokens`);
        console.log(`  after:  ${r.after.chars} chars / ~${r.after.estimatedTokens} tokens`);
        console.log(`  reduction: ${r.reductionPct}%${r.fallbackReason ? ` (fallback: ${r.fallbackReason})` : ''}`);
        console.log('');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
