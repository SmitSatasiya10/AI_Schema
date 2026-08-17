/**
 * Phase 1 baseline measurement.
 *
 * This test does not assert "correct" behavior — it MEASURES the current
 * pipeline's footprint (schema counts, prompt size, estimated tokens) and
 * writes the result to BASELINE_MEASUREMENTS.json so BASELINE_REPORT.md can
 * quote real, reproducible numbers instead of guesses. Re-run any time with
 * `npm test` to re-measure after later phases change retrieval/prompting.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadSchemas, buildSystemPrompt } = require('../example-implementation');
const { estimateTokensFromChars } = require('../instrumentation');

test('baseline measurement — schema counts and full system prompt size', async () => {
    const schemas = await loadSchemas();
    const prompt = buildSystemPrompt(schemas);

    const measurement = {
        measuredAt: new Date().toISOString(),
        sectionSchemaCount: schemas.sectionSchemas.length,
        blockSchemaCount: schemas.blockSchemas.length,
        globalSettingsKeyCount: Object.keys(schemas.globalSchema.settings || {}).length,
        systemPromptChars: prompt.length,
        estimatedSystemPromptTokens: estimateTokensFromChars(prompt.length),
        // Measured from the fixed structure of runFullPipeline() in 1-generate-theme.js:
        // one generateAIColorPalette() call (color) + one makeAIRequest() call (main
        // generation) = 2 OpenRouter calls per normal `--prompt` generation run.
        // This is a structural count from source, not a live API measurement.
        openRouterCallsPerGeneration: 2,
        model: process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5'
    };

    assert.ok(measurement.sectionSchemaCount > 0, 'expected at least one section schema on disk');
    assert.ok(measurement.blockSchemaCount > 0, 'expected at least one block schema on disk');
    assert.ok(measurement.systemPromptChars > 0, 'expected a non-empty system prompt');
    assert.ok(measurement.estimatedSystemPromptTokens > 0);

    fs.writeFileSync(
        path.join(__dirname, '..', 'BASELINE_MEASUREMENTS.json'),
        JSON.stringify(measurement, null, 2) + '\n'
    );
});
