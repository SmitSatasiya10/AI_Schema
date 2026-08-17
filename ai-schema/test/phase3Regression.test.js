/**
 * Confirms Phase 3 (request understanding + clarification) is fully opt-in
 * and does not change default runFullPipeline() behavior — mirrors the
 * regression posture of test/phase2Regression.test.js for retrievalMode.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase3-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const brief = require('../brief');
const { runFullPipeline } = require('../1-generate-theme');

const VALID_THEME_CONFIG = {
    sections: {
        'hero-1': {
            type: 'slideshow',
            settings: {},
            blocks: { 'slide-1': { type: 'slide', settings: { image: '' } } },
            block_order: ['slide-1']
        }
    },
    order: ['hero-1']
};

const VALID_PALETTE = {
    niche: 'test',
    description: 'test palette',
    colors_accent_1: '#111111',
    colors_accent_2: '#222222'
};

function readyUnderstanding() {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    return { status: 'READY', brief: b, missing: [], questions: [] };
}

function clarifyUnderstanding() {
    const b = brief.createEmptyBrief();
    return { status: 'NEEDS_CLARIFICATION', brief: b, missing: ['businessType'], questions: ['What type of store is this?'] };
}

function mockFetchRouter(understandingResponse) {
    let calls = 0;
    const router = async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        const content = body.messages[0].content;
        let payload;
        if (content.includes('requirements analyst')) {
            payload = understandingResponse;
        } else if (body.messages.length === 1) {
            payload = VALID_PALETTE; // color call
        } else {
            payload = VALID_THEME_CONFIG; // main generation call
        }
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    };
    router.callCount = () => calls;
    return router;
}

test('runFullPipeline() — without understandingMode, never calls the understanding stage (Phase 1/2 behavior unchanged)', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(readyUnderstanding());
    global.fetch = router;
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        // Exactly 2 AI calls: color palette + main generation. A 3rd call
        // would mean STEP 0 ran even though understandingMode was never set.
        assert.strictEqual(router.callCount(), 2);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runFullPipeline() — with understandingMode + a READY result, proceeds to generation as normal', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(readyUnderstanding());
    global.fetch = router;
    const sessionId = 'test-phase3-regression-ready-session';
    try {
        const result = await runFullPipeline('Create a premium pet wellness store for dogs and cats.', { autoCopy: false, understandingMode: true, sessionId });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.config.order, VALID_THEME_CONFIG.order);
        assert.strictEqual(router.callCount(), 3); // understanding + color + main generation
    } finally {
        global.fetch = originalFetch;
        await fs.rm(brief.briefFilePath(sessionId), { force: true });
    }
});

test('runFullPipeline() — with understandingMode + NEEDS_CLARIFICATION, stops before generating anything', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(clarifyUnderstanding());
    global.fetch = router;
    let sessionId;
    try {
        const result = await runFullPipeline('Make me a premium store.', { autoCopy: false, understandingMode: true });
        sessionId = result.sessionId;
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
        assert.ok(result.questions.length > 0);
        assert.strictEqual(router.callCount(), 1, 'only the understanding call should have fired — no color/generation calls');
    } finally {
        global.fetch = originalFetch;
        if (sessionId) await fs.rm(brief.briefFilePath(sessionId), { force: true });
    }
});
