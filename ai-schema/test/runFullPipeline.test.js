/**
 * Characterizes runFullPipeline()'s happy path with global.fetch mocked (no real
 * OpenRouter calls, no API key spend). Deliberately runs with { autoCopy: false }
 * so this test never invokes copyGeneratedFilesToTheme() and therefore never
 * overwrites the LIVE theme's templates/*.json or config/settings_data.json —
 * generateThemeFiles() only writes into ai-schema/output/, a disposable scratch
 * directory that already accumulates run debris today (see AUDIT.md §4/§9).
 * Testing the autoCopy:true path against the real theme is intentionally out of
 * scope here — that full-overwrite behavior is exactly what Phase 7 changes.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase1-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runFullPipeline } = require('../1-generate-theme');

const VALID_THEME_CONFIG = {
    sections: {
        'hero-1': {
            type: 'slideshow',
            settings: {
                visibility: 'always-display',
                slide_height: 'medium',
                slider_visual: 'dots',
                auto_rotate: 'true',
                show_text_below: 'false'
            },
            blocks: {
                'slide-1': { type: 'slide', settings: { image: '' } },
                'slide-2': { type: 'slide', settings: { image: '' } }
            },
            block_order: ['slide-1', 'slide-2']
        },
        'testimonials-1': {
            type: 'testimonials',
            settings: {},
            blocks: {
                'col-1': { type: 'column', settings: {} },
                'col-2': { type: 'column', settings: {} },
                'col-3': { type: 'column', settings: {} }
            },
            block_order: ['col-1', 'col-2', 'col-3']
        }
    },
    order: ['hero-1', 'testimonials-1']
};

const VALID_PALETTE = {
    niche: 'test',
    description: 'test palette',
    colors_accent_1: '#111111',
    colors_accent_2: '#222222',
    colors_text: '#333333',
    colors_background_1: '#ffffff',
    colors_background_2: '#eeeeee',
    colors_solid_button_labels: '#ffffff',
    gradient_accent_1: 'linear-gradient(135deg, #111111 0%, #222222 100%)'
};

function mockFetchRouter() {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const isColorCall = body.messages.length === 1; // color call sends one user-role message
        const content = isColorCall ? JSON.stringify(VALID_PALETTE) : JSON.stringify(VALID_THEME_CONFIG);
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] })
        };
    };
}

test('runFullPipeline() — happy path returns a valid config and never touches the live theme (autoCopy:false)', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
        exitCalled = true;
        throw new Error(`process.exit(${code}) called unexpectedly during a happy-path run`);
    };
    global.fetch = mockFetchRouter();

    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });

        assert.strictEqual(exitCalled, false, 'pipeline should not call process.exit on a valid run');
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.config.order, VALID_THEME_CONFIG.order);
        assert.ok(result.colors, 'expected a resolved color palette');
        assert.ok(result.files, 'expected generateThemeFiles() output paths');

        const outputTemplate = path.join(__dirname, '..', 'output', 'templates', 'index.json');
        assert.ok(fs.existsSync(outputTemplate), 'expected output/templates/index.json (scratch dir) to be written');
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
    }
});
