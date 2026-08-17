/**
 * Phase 6 wiring/regression tests — confirms the new validation.js layer is
 * actually REACHABLE from both generation paths (not just unit-tested in
 * isolation, see test/validation.test.js), and that the bounded-repair
 * architecture Phase 5 established (§24: "AI output -> validate -> repair
 * once -> validate -> throw if still invalid") is preserved rather than
 * reinterpreted when Phase 6's checks are folded in.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase6-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');
const { loadSchemas } = require('../example-implementation');
const { validateGenerationPlan, runConfigurationStage } = require('../generation');
const { runFullPipeline } = require('../1-generate-theme');
const brief = require('../brief');
const { DEFAULT_THEME_ROOT } = require('../theme-state');

let fullSchemas;

test.before(async () => {
    fullSchemas = await loadSchemas();
});

function jsonFetch(routerFn) {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const content = JSON.stringify(routerFn(body));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
}

// ---------------------------------------------------------------------------
// validateGenerationPlan() — allowed_on gap fix (§7/§18)
// ---------------------------------------------------------------------------

test('validateGenerationPlan() — GAP CLOSED: a FULL_FALLBACK-style retrieved pool (unfiltered by allowed_on) no longer lets a template-incompatible section through', () => {
    // fullSchemas mirrors exactly what retrieval.js's FULL_FALLBACK mode
    // hands back (schemas.sectionSchemas unfiltered — see retrieval.js
    // retrieveRelevantSchemas()'s fallback branch). main-product declares
    // allowed_on: ["product"] only, yet was previously accepted for ANY
    // template as long as it existed somewhere in the pool.
    const plan = { templateName: 'index', order: ['main-1'], sections: { 'main-1': { type: 'main-product', blockTypes: [] } } };
    const result = validateGenerationPlan(plan, fullSchemas, 'index');
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('does not include template "index"')));
});

test('validateGenerationPlan() — a template-compatible section from the same unfiltered pool still passes (no over-rejection)', () => {
    const plan = { templateName: 'index', order: ['hero-1'], sections: { 'hero-1': { type: 'slideshow', blockTypes: [] } } };
    const result = validateGenerationPlan(plan, fullSchemas, 'index');
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateGenerationPlan() — the same main-product section is accepted for its real allowed template', () => {
    const plan = { templateName: 'product', order: ['main-1'], sections: { 'main-1': { type: 'main-product', blockTypes: [] } } };
    const result = validateGenerationPlan(plan, fullSchemas, 'product');
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

// ---------------------------------------------------------------------------
// runConfigurationStage() — Phase 6 checks folded into the SAME bounded
// repair loop Phase 5 already established (one repair attempt total, not
// one per validation layer).
// ---------------------------------------------------------------------------

function buildCollagePool() {
    const sectionById = new Map(fullSchemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(fullSchemas.blockSchemas.map(b => [b.id, b]));
    return {
        globalSchema: fullSchemas.globalSchema,
        sectionSchemas: [sectionById.get('collage')],
        blockSchemas: [blockById.get('product')]
    };
}

const PLAN_WITH_PRODUCT_BLOCK = {
    templateName: 'index',
    order: ['collage-1'],
    sections: { 'collage-1': { type: 'collage', blockTypes: ['product'] } }
};

function configWithProductHandle(handle) {
    return {
        sections: {
            'collage-1': {
                type: 'collage',
                settings: {},
                blocks: { p1: { type: 'product', settings: { product: handle } } },
                block_order: ['p1']
            }
        },
        order: ['collage-1']
    };
}

const READY_BRIEF = (() => {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    return b;
})();

test('runConfigurationStage() — Phase 6 candidate validation triggers the SAME single bounded repair as structural/plan validation (hallucinated product handle -> repaired to blank)', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => {
        calls++;
        return calls === 1 ? configWithProductHandle('invented-handle') : configWithProductHandle('');
    });
    try {
        const { config, repaired } = await runConfigurationStage({
            brief: READY_BRIEF, plan: PLAN_WITH_PRODUCT_BLOCK, retrievedSchemas: buildCollagePool(),
            themeContext: { globalSettingsCurrent: {} }, requestId: 'p6-r1'
        });
        assert.strictEqual(repaired, true);
        assert.strictEqual(config.sections['collage-1'].blocks.p1.settings.product, '');
        assert.strictEqual(calls, 2, 'exactly one repair attempt, not an unbounded loop');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runConfigurationStage() — throws (does not silently pass) when the hallucinated reference survives the repair attempt too', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => { calls++; return configWithProductHandle('still-invented'); });
    try {
        await assert.rejects(
            () => runConfigurationStage({
                brief: READY_BRIEF, plan: PLAN_WITH_PRODUCT_BLOCK, retrievedSchemas: buildCollagePool(),
                themeContext: { globalSettingsCurrent: {} }, requestId: 'p6-r2'
            }),
            /DATA_REFERENCE_HALLUCINATED/
        );
        assert.strictEqual(calls, 2, 'exactly plan-configure + one repair attempt, then stop');
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// Legacy (non-staged) pipeline — previously had NO repair loop at all
// (AUDIT.md: "failure just throws -> process.exit(1)"). Phase 6 adds one,
// generalized from the same pattern.
// ---------------------------------------------------------------------------

const VALID_PALETTE = { niche: 'test', description: 'x', colors_accent_1: '#111111', colors_accent_2: '#222222' };

function legacyMockRouter({ first, second }) {
    let calls = 0;
    const router = async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        let payload;
        if (body.messages.length === 1) {
            payload = VALID_PALETTE; // color call
        } else {
            payload = calls <= 2 ? first : second; // first non-color call = attempt 1, next = repair
        }
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    };
    router.callCount = () => calls;
    return router;
}

test('runFullPipeline() legacy path — recovers via one bounded repair when Phase 6 candidate validation fails on the first attempt', async () => {
    const originalFetch = global.fetch;
    const router = legacyMockRouter({ first: configWithProductHandle('invented-handle'), second: configWithProductHandle('') });
    global.fetch = router;
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.config.sections['collage-1'].blocks.p1.settings.product, '');
        assert.strictEqual(router.callCount(), 3, 'color + first attempt + one repair attempt');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runFullPipeline() legacy path — throws after exactly one repair attempt if still invalid (no unbounded retry, no silent pass)', async () => {
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    process.exit = (code) => { throw new Error(`process.exit(${code})`); };
    const router = legacyMockRouter({ first: configWithProductHandle('still-invented'), second: configWithProductHandle('still-invented') });
    global.fetch = router;
    try {
        await assert.rejects(() => runFullPipeline('Create a homepage for a test store.', { autoCopy: false }), /process\.exit/);
        assert.strictEqual(router.callCount(), 3, 'color + first attempt + exactly one repair attempt, no third');
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
    }
});

test('runFullPipeline() legacy path — a first-try-valid candidate is unaffected (call count unchanged from pre-Phase-6 behavior)', async () => {
    const originalFetch = global.fetch;
    const VALID = {
        sections: { 'hero-1': { type: 'slideshow', settings: {}, blocks: { s1: { type: 'slide', settings: { image: '' } } }, block_order: ['s1'] } },
        order: ['hero-1']
    };
    const router = legacyMockRouter({ first: VALID, second: VALID });
    global.fetch = router;
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        assert.strictEqual(router.callCount(), 2, 'no repair call should fire when the first attempt is already valid');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runFullPipeline() legacy path — repair attempts never touch the live theme (autoCopy:false isolation)', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');

    const originalFetch = global.fetch;
    const router = legacyMockRouter({ first: configWithProductHandle('invented-handle'), second: configWithProductHandle('') });
    global.fetch = router;
    try {
        await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
    } finally {
        global.fetch = originalFetch;
    }

    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before);
});
