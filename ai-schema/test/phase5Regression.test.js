/**
 * Confirms Phase 5 (staged generation) is fully opt-in and wired correctly
 * into runFullPipeline() — mirrors test/phase3Regression.test.js's posture
 * for understandingMode.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase5-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');
const brief = require('../brief');
const { runFullPipeline } = require('../1-generate-theme');
const { DEFAULT_THEME_ROOT } = require('../theme-state');

const VALID_LEGACY_CONFIG = {
    sections: { 'hero-1': { type: 'slideshow', settings: {}, blocks: { s1: { type: 'slide', settings: { image: '' } } }, block_order: ['s1'] } },
    order: ['hero-1']
};

const VALID_PALETTE = { niche: 'test', description: 'x', colors_accent_1: '#111111', colors_accent_2: '#222222' };

const VALID_PRODUCT_PLAN = {
    templateName: 'product',
    order: ['main'],
    sections: { main: { type: 'main-product', blockTypes: ['product_title'] } }
};

const VALID_PRODUCT_CONFIG = {
    sections: { main: { type: 'main-product', settings: {}, blocks: { t1: { type: 'product_title', settings: {} } }, block_order: ['t1'] } },
    order: ['main']
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
        const messages = body.messages;
        let payload;
        if (messages[0].content.includes('requirements analyst')) {
            payload = understandingResponse; // Phase 3 understanding call (single user turn)
        } else if (messages[0].content.includes('STRUCTURE planner')) {
            payload = VALID_PRODUCT_PLAN; // Phase 5 Stage 1 (system+user)
        } else if (messages[0].content.includes('structure plan has ALREADY been approved')) {
            payload = VALID_PRODUCT_CONFIG; // Phase 5 Stage 2 (system+user)
        } else if (messages.length === 1) {
            payload = VALID_PALETTE; // color call (single user turn)
        } else {
            payload = VALID_LEGACY_CONFIG; // legacy single-call generation (system+user)
        }
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    };
    router.callCount = () => calls;
    return router;
}

test('runFullPipeline() — without stagedMode, behavior is byte-identical to before Phase 5 (2 AI calls, legacy config path)', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(readyUnderstanding());
    global.fetch = router;
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.config.order, VALID_LEGACY_CONFIG.order);
        assert.strictEqual(router.callCount(), 2, 'staged mode must add zero calls when not enabled');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runFullPipeline() — stagedMode + READY brief runs understanding -> color -> plan -> configure (4 calls) and returns a validated candidate', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(readyUnderstanding());
    global.fetch = router;
    const sessionId = 'test-phase5-regression-staged-session';
    try {
        const result = await runFullPipeline('Create a premium pet wellness store for dogs and cats.', {
            autoCopy: false, stagedMode: true, templateName: 'product', sessionId
        });
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.config.order, VALID_PRODUCT_CONFIG.order);
        assert.strictEqual(router.callCount(), 4);
    } finally {
        global.fetch = originalFetch;
        await fs.rm(brief.briefFilePath(sessionId), { force: true });
    }
});

test('runFullPipeline() — stagedMode implies understandingMode: NEEDS_CLARIFICATION stops before ThemeState/generation (only 1 call)', async () => {
    const originalFetch = global.fetch;
    const router = mockFetchRouter(clarifyUnderstanding());
    global.fetch = router;
    let sessionId;
    try {
        const result = await runFullPipeline('Make me a premium store.', { autoCopy: false, stagedMode: true });
        sessionId = result.sessionId;
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
        assert.strictEqual(router.callCount(), 1, 'no color/plan/configure calls should fire before clarification resolves');
    } finally {
        global.fetch = originalFetch;
        if (sessionId) await fs.rm(brief.briefFilePath(sessionId), { force: true });
    }
});

test('runFullPipeline() — stagedMode never writes to the live theme (isolation, real ThemeState build included)', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');

    const originalFetch = global.fetch;
    const router = mockFetchRouter(readyUnderstanding());
    global.fetch = router;
    const sessionId = 'test-phase5-regression-isolation-session';
    try {
        await runFullPipeline('Create a premium pet wellness store for dogs and cats.', {
            autoCopy: false, stagedMode: true, templateName: 'product', sessionId
        });
    } finally {
        global.fetch = originalFetch;
        await fs.rm(brief.briefFilePath(sessionId), { force: true });
    }

    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before, 'staged generation (autoCopy:false) must never modify the live theme');
});
