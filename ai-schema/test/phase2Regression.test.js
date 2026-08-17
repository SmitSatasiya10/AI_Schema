/**
 * Confirms Phase 2 didn't regress anything Phase 1 already proved:
 *   - validateOutput() works identically whether it's handed the full
 *     schema set or a retrieval-narrowed one (it only ever looks at
 *     whatever `schemas` object it's given — Phase 2 deliberately left it
 *     untouched, see PHASE2_REPORT.md "AI changes").
 *   - buildSystemPrompt() naturally shrinks when given fewer schemas,
 *     with no code changes to buildSystemPrompt() itself.
 *   - runFullPipeline({ retrievalMode: true }) still produces a valid,
 *     end-to-end result — same happy-path contract as the Phase 1
 *     runFullPipeline test, just with retrieval turned on.
 *   - Phase 1 instrumentation (AI_CALL/VALIDATION/PIPELINE logging) keeps
 *     working when retrieval is active, plus the new RETRIEVAL log line
 *     appears.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase2-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadSchemas, buildSystemPrompt, validateOutput } = require('../example-implementation');
const { runFullPipeline } = require('../1-generate-theme');

test('buildSystemPrompt() — produces a smaller prompt from a retrieval-narrowed schema set than from the full set', async () => {
    const full = await loadSchemas();
    const retrieved = await loadSchemas({ retrieval: { userPrompt: 'Create a premium pet wellness store for dogs and cats.', templateName: 'index' } });
    assert.strictEqual(retrieved.retrievalMeta.mode, 'RETRIEVAL');

    const fullPrompt = buildSystemPrompt(full);
    const retrievedPrompt = buildSystemPrompt(retrieved);

    assert.ok(retrievedPrompt.length < fullPrompt.length, 'retrieval-narrowed prompt should be smaller than the full-catalog prompt');
    // Still a well-formed prompt with the same fixed structure — Phase 2
    // did not redesign buildSystemPrompt() itself.
    assert.ok(retrievedPrompt.includes('CRITICAL RULES'));
    assert.ok(retrievedPrompt.includes('AVAILABLE SECTIONS'));
});

test('validateOutput() — behaves identically against a retrieval-narrowed schema set for schemas it actually contains', async () => {
    const retrieved = await loadSchemas({ retrieval: { userPrompt: 'Create a premium pet wellness store for dogs and cats.', templateName: 'index' } });
    assert.ok(retrieved.sectionSchemas.some(s => s.id === 'slideshow'));
    assert.ok(retrieved.sectionSchemas.some(s => s.id === 'testimonials'));

    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'slide-1': { type: 'slide', settings: { image: '' } } },
                block_order: ['slide-1']
            },
            'testimonials-1': {
                type: 'testimonials',
                settings: {},
                blocks: { 'col-1': { type: 'column', settings: {} } },
                block_order: ['col-1']
            }
        },
        order: ['hero-1', 'testimonials-1']
    };
    const result = validateOutput(JSON.stringify(config), retrieved);
    assert.strictEqual(result.valid, true, result.error);
});

test('validateOutput() — correctly rejects a section type that was excluded by retrieval, same as an unknown type', async () => {
    // "main-product" legitimately exists as a schema, but the index-template
    // retrieval for this prompt excludes it (allowed_on doesn't include
    // "index"). From validateOutput()'s point of view this looks exactly
    // like an unknown type — it only knows about what's IN the schemas
    // object it was given, which is the correct, unchanged behavior.
    const retrieved = await loadSchemas({ retrieval: { userPrompt: 'Create a premium pet wellness store for dogs and cats.', templateName: 'index' } });
    const config = { sections: { 'main-1': { type: 'main-product', settings: {} } }, order: ['main-1'] };
    const result = validateOutput(JSON.stringify(config), retrieved);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /unknown section type/);
});

test('runFullPipeline({ retrievalMode: true }) — happy path still produces a valid result end-to-end', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
        exitCalled = true;
        throw new Error(`process.exit(${code}) called unexpectedly during a happy-path retrieval run`);
    };

    const validConfig = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: { visibility: 'always-display', slide_height: 'medium', slider_visual: 'dots', auto_rotate: 'true', show_text_below: 'false' },
                blocks: { 'slide-1': { type: 'slide', settings: { image: '' } }, 'slide-2': { type: 'slide', settings: { image: '' } } },
                block_order: ['slide-1', 'slide-2']
            },
            'testimonials-1': {
                type: 'testimonials',
                settings: {},
                blocks: { 'col-1': { type: 'column', settings: {} }, 'col-2': { type: 'column', settings: {} }, 'col-3': { type: 'column', settings: {} } },
                block_order: ['col-1', 'col-2', 'col-3']
            }
        },
        order: ['hero-1', 'testimonials-1']
    };
    const validPalette = {
        niche: 'test', description: 'test palette',
        colors_accent_1: '#111111', colors_accent_2: '#222222', colors_text: '#333333',
        colors_background_1: '#ffffff', colors_background_2: '#eeeeee',
        colors_solid_button_labels: '#ffffff', gradient_accent_1: 'linear-gradient(135deg, #111111 0%, #222222 100%)'
    };

    global.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const isColorCall = body.messages.length === 1;
        const content = isColorCall ? JSON.stringify(validPalette) : JSON.stringify(validConfig);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };

    let capturedLogs = [];
    const originalLog = console.log;
    console.log = (msg) => { capturedLogs.push(msg); originalLog(msg); };

    try {
        const result = await runFullPipeline('Create a premium pet wellness store for dogs and cats.', {
            autoCopy: false,
            retrievalMode: true
        });

        assert.strictEqual(exitCalled, false);
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.config.order, validConfig.order);

        const retrievalLog = capturedLogs.find(l => typeof l === 'string' && l.startsWith('[RETRIEVAL]'));
        assert.ok(retrievalLog, 'expected a [RETRIEVAL] instrumentation line when retrievalMode is enabled');
        const pipelineLog = capturedLogs.find(l => typeof l === 'string' && l.startsWith('[PIPELINE]'));
        assert.ok(pipelineLog, 'expected a [PIPELINE] instrumentation line');
        const pipelinePayload = JSON.parse(pipelineLog.replace('[PIPELINE] ', ''));
        assert.strictEqual(pipelinePayload.retrievalMode, 'RETRIEVAL');

        const outputTemplate = path.join(__dirname, '..', 'output', 'templates', 'index.json');
        assert.ok(fs.existsSync(outputTemplate));
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
        console.log = originalLog;
    }
});

test('runFullPipeline() default (no retrievalMode option) — still uses FULL_SCHEMA_MODE, unchanged from Phase 1', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    process.exit = (code) => { throw new Error(`process.exit(${code}) called unexpectedly`); };

    const validConfig = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'slide-1': { type: 'slide', settings: {} } },
                block_order: ['slide-1']
            }
        },
        order: ['hero-1']
    };
    global.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const isColorCall = body.messages.length === 1;
        const content = isColorCall
            ? JSON.stringify({ niche: 'test', description: 'test palette', colors_accent_1: '#111111', colors_accent_2: '#222222' })
            : JSON.stringify(validConfig);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };

    let capturedLogs = [];
    const originalLog = console.log;
    console.log = (msg) => { capturedLogs.push(msg); };

    try {
        const result = await runFullPipeline('Create a homepage.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        const pipelineLog = capturedLogs.find(l => typeof l === 'string' && l.startsWith('[PIPELINE]'));
        const payload = JSON.parse(pipelineLog.replace('[PIPELINE] ', ''));
        assert.strictEqual(payload.retrievalMode, 'FULL_SCHEMA_MODE');
        assert.strictEqual(payload.sectionSchemaCount, 26, 'default behavior should still load all 26 section schemas (Phase 11 added 10)');
        assert.strictEqual(payload.blockSchemaCount, 58, 'default behavior should still load all 58 block schemas (Phase 11 added 5; 57 unique ids after the pre-existing "row" duplicate)');
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
        console.log = originalLog;
    }
});
