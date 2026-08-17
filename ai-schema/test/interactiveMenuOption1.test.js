/**
 * Option 1 ("Generate Homepage from niche templates") previously never asked
 * for a custom requirement — it always sent the randomly-picked niche
 * template text to the AI, silently dropping anything the user typed
 * elsewhere in the terminal. This file covers the fix: an optional prompt
 * added after niche selection whose typed input (when present) becomes the
 * primary generation request, with the niche template surviving only as the
 * contextual default used when the user presses Enter with nothing typed —
 * all still flowing through the unchanged runFullPipeline() call (no new
 * generation path, no bypass of Phases 2-9).
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-interactive-menu-tests';

const test = require('node:test');
const assert = require('node:assert');
const { runFullPipeline } = require('../1-generate-theme');
const { getNichePrompt, resolveNicheTemplatePrompt, rl } = require('../3-interactive-menu');

// 3-interactive-menu.js creates a readline interface on process.stdin at
// module load time (for the real CLI's prompt() calls). Close it once this
// file is done requiring the module so the test process can exit cleanly.
test.after(() => rl.close());

test('resolveNicheTemplatePrompt() — non-empty custom input overrides the niche template exactly, trimmed', () => {
    const template = 'Create a fitness equipment store homepage with workout inspiration, training guides, and transformation stories';
    const result = resolveNicheTemplatePrompt(template, '  Build a hardcore CrossFit box homepage with barbell drops and chalk dust.  ');
    assert.strictEqual(result, 'Build a hardcore CrossFit box homepage with barbell drops and chalk dust.');
});

test('resolveNicheTemplatePrompt() — empty, whitespace-only, or missing input falls back to the niche template unchanged', () => {
    const template = 'Create a fitness equipment store homepage with workout inspiration, training guides, and transformation stories';
    assert.strictEqual(resolveNicheTemplatePrompt(template, ''), template);
    assert.strictEqual(resolveNicheTemplatePrompt(template, '   '), template);
    assert.strictEqual(resolveNicheTemplatePrompt(template, undefined), template);
});

test('option 1 flow — a typed custom requirement reaches the actual AI request unmodified and drives the generated candidate', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    process.exit = (code) => { throw new Error(`process.exit(${code}) called unexpectedly`); };

    const nicheTemplate = getNichePrompt('7'); // Fitness & Sports
    assert.ok(nicheTemplate);

    const customRequirement = 'Build a hardcore CrossFit box homepage themed around barbell drops, chalk dust, and a leaderboard wall — nothing calm or minimalist.';

    // Exactly what the case '1' handler now does: show the niche template,
    // then let the user's own typed input take over as the real request.
    const finalPrompt = resolveNicheTemplatePrompt(nicheTemplate, customRequirement);
    assert.strictEqual(finalPrompt, customRequirement, 'the typed requirement must become the primary generation request, not merged with or overridden by the niche template');

    const seenUserPrompts = [];
    const distinctiveConfig = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: { visibility: 'always-display' },
                blocks: { 'slide-1': { type: 'slide', settings: { heading: 'Barbell Drops & Chalk Dust' } } },
                block_order: ['slide-1']
            }
        },
        order: ['hero-1']
    };

    global.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const isColorCall = body.messages.length === 1;
        if (isColorCall) {
            const content = JSON.stringify({ niche: 'test', description: 'test palette', colors_accent_1: '#111111', colors_accent_2: '#222222' });
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
        }
        // main_generation — record exactly what the pipeline actually sent.
        seenUserPrompts.push(body.messages[1].content);
        // Only return the distinctive candidate when the request really
        // carries the custom text — anything else (e.g. the niche template
        // leaking through) gets an empty, validation-failing config instead,
        // so a wiring regression here fails loudly rather than silently.
        const content = body.messages[1].content === customRequirement
            ? JSON.stringify(distinctiveConfig)
            : JSON.stringify({ sections: {}, order: [] });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };

    try {
        const result = await runFullPipeline(finalPrompt.trim(), { templateName: 'index', autoCopy: false });

        assert.ok(seenUserPrompts.includes(customRequirement), 'the actual AI request must contain the typed custom requirement');
        assert.ok(!seenUserPrompts.includes(nicheTemplate), 'the niche template text must not be sent once the user typed a custom requirement');

        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(result.config, distinctiveConfig, 'the generated candidate must be the one produced from the custom-requirement request — proof it drove real generation through the unchanged Phases 2-9 pipeline, not a separate path');
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
    }
});

test('option 1 flow — pressing Enter with no custom input keeps sending the niche template, unchanged from before this fix', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    process.exit = (code) => { throw new Error(`process.exit(${code}) called unexpectedly`); };

    const nicheTemplate = getNichePrompt('2'); // Jewelry & Accessories
    assert.ok(nicheTemplate);
    const finalPrompt = resolveNicheTemplatePrompt(nicheTemplate, '   ');
    assert.strictEqual(finalPrompt, nicheTemplate, 'pressing Enter with nothing typed must fall back to the predefined niche description');

    const seenUserPrompts = [];
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
        if (isColorCall) {
            const content = JSON.stringify({ niche: 'test', description: 'test palette', colors_accent_1: '#111111', colors_accent_2: '#222222' });
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
        }
        seenUserPrompts.push(body.messages[1].content);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(validConfig) } }] }) };
    };

    try {
        const result = await runFullPipeline(finalPrompt.trim(), { templateName: 'index', autoCopy: false });
        assert.ok(seenUserPrompts.includes(nicheTemplate));
        assert.strictEqual(result.success, true, result.error);
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
    }
});
