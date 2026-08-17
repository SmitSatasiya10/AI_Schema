/**
 * Phase 5 tests for generation.js. `global.fetch` is mocked throughout — see
 * test/clarification.test.js's file header for why this characterizes
 * orchestration/validation, not live model quality. Fixtures use REAL
 * schemas (via loadSchemas()), matching the existing convention in
 * test/validateOutput.test.js, rather than invented ones.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase5-tests';

const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas } = require('../example-implementation');
const generation = require('../generation');
const {
    lightweightCapabilityListing,
    buildConfigurationSystemPrompt,
    validateGenerationPlan,
    matchesPlan,
    runPlanningStage,
    runConfigurationStage,
    runStagedGeneration
} = generation;

let fullSchemas;
let indexPool; // small, real-schema retrieved-set fixture: slideshow/slide + testimonials/column
let productPool; // small, real-schema fixture: main-product only

test.before(async () => {
    fullSchemas = await loadSchemas();
    const sectionById = new Map(fullSchemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(fullSchemas.blockSchemas.map(b => [b.id, b]));

    indexPool = {
        globalSchema: fullSchemas.globalSchema,
        sectionSchemas: [sectionById.get('slideshow'), sectionById.get('testimonials'), sectionById.get('collage')],
        blockSchemas: [blockById.get('slide'), blockById.get('column'), blockById.get('image'), blockById.get('product')]
    };

    productPool = {
        globalSchema: fullSchemas.globalSchema,
        sectionSchemas: [sectionById.get('main-product')],
        blockSchemas: [blockById.get('product_title'), blockById.get('product_price'), blockById.get('product_buy-buttons')]
    };
});

function jsonFetch(routerFn) {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const content = JSON.stringify(routerFn(body));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
}

const VALID_INDEX_PLAN = {
    templateName: 'index',
    order: ['hero-1', 'testi-1'],
    sections: {
        'hero-1': { type: 'slideshow', blockTypes: ['slide', 'slide'] },
        'testi-1': { type: 'testimonials', blockTypes: ['column', 'column', 'column'] }
    }
};

const VALID_INDEX_CONFIG = {
    sections: {
        'hero-1': {
            type: 'slideshow',
            settings: {},
            blocks: { 's1': { type: 'slide', settings: { image: '' } }, 's2': { type: 'slide', settings: { image: '' } } },
            block_order: ['s1', 's2']
        },
        'testi-1': {
            type: 'testimonials',
            settings: {},
            blocks: { 'c1': { type: 'column', settings: {} }, 'c2': { type: 'column', settings: {} }, 'c3': { type: 'column', settings: {} } },
            block_order: ['c1', 'c2', 'c3']
        }
    },
    order: ['hero-1', 'testi-1']
};

const VALID_PRODUCT_PLAN = {
    templateName: 'product',
    order: ['main'],
    sections: { main: { type: 'main-product', blockTypes: ['product_title', 'product_price'] } }
};

const VALID_PRODUCT_CONFIG = {
    sections: {
        main: {
            type: 'main-product',
            settings: {},
            blocks: { t1: { type: 'product_title', settings: {} }, p1: { type: 'product_price', settings: {} } },
            block_order: ['t1', 'p1']
        }
    },
    order: ['main']
};

const READY_BRIEF = (() => {
    const brief = require('../brief').createEmptyBrief();
    brief.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    brief.niche = { value: 'pet wellness', status: 'confirmed', source: 'user' };
    return brief;
})();

// ---------------------------------------------------------------------------
// lightweightCapabilityListing()
// ---------------------------------------------------------------------------

test('lightweightCapabilityListing() — strips full settings definitions, keeps only the small planning-relevant fields', () => {
    const listing = lightweightCapabilityListing(indexPool);
    const slideshow = listing.sections.find(s => s.id === 'slideshow');
    assert.ok(slideshow);
    assert.deepStrictEqual(Object.keys(slideshow).sort(), ['allowedBlockCount', 'hasBlocks', 'id', 'label', 'maxBlocks', 'summary'].sort());
    assert.strictEqual(listing.sections.length, indexPool.sectionSchemas.length);
    assert.strictEqual(listing.blocks.length, indexPool.blockSchemas.length);
});

// ---------------------------------------------------------------------------
// validateGenerationPlan()
// ---------------------------------------------------------------------------

test('validateGenerationPlan() — accepts a well-formed plan built from real, retrieved schemas', () => {
    const result = validateGenerationPlan(VALID_INDEX_PLAN, indexPool, 'index');
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.valid, true);
});

test('validateGenerationPlan() — rejects a section type not part of the retrieved candidate set (even if it exists in the full catalog)', () => {
    const plan = { templateName: 'index', order: ['x'], sections: { x: { type: 'main-product', blockTypes: [] } } };
    const result = validateGenerationPlan(plan, indexPool, 'index'); // main-product isn't in indexPool
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('not part of the retrieved/relevant capabilities')));
});

test('validateGenerationPlan() — rejects a block type not allowed inside the chosen section', () => {
    const plan = { templateName: 'index', order: ['hero-1'], sections: { 'hero-1': { type: 'slideshow', blockTypes: ['column'] } } };
    const result = validateGenerationPlan(plan, indexPool, 'index'); // "column" isn't in slideshow's allowed_blocks
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('not allowed inside a "slideshow" section')));
});

test('validateGenerationPlan() — rejects exceeding a section\'s max_blocks', () => {
    const plan = { templateName: 'index', order: ['c-1'], sections: { 'c-1': { type: 'collage', blockTypes: ['image', 'image', 'image', 'image'] } } };
    const result = validateGenerationPlan(plan, indexPool, 'index'); // collage max_blocks is 3 (see validateOutput.test.js)
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('allows at most')));
});

test('validateGenerationPlan() — rejects order/sections mismatch (missing id, extra id, duplicates)', () => {
    const missing = validateGenerationPlan({ templateName: 'index', order: ['hero-1'], sections: { 'hero-1': { type: 'slideshow' }, 'ghost': { type: 'slideshow' } } }, indexPool, 'index');
    assert.strictEqual(missing.valid, false);
    assert.ok(missing.errors.some(e => e.includes('"ghost"') && e.includes('not listed in plan.order')));

    const extra = validateGenerationPlan({ templateName: 'index', order: ['hero-1', 'ghost'], sections: { 'hero-1': { type: 'slideshow' } } }, indexPool, 'index');
    assert.strictEqual(extra.valid, false);
    assert.ok(extra.errors.some(e => e.includes('order references unknown section id "ghost"')));

    const dup = validateGenerationPlan({ templateName: 'index', order: ['hero-1', 'hero-1'], sections: { 'hero-1': { type: 'slideshow' } } }, indexPool, 'index');
    assert.strictEqual(dup.valid, false);
    assert.ok(dup.errors.some(e => e.includes('duplicate')));
});

test('validateGenerationPlan() — product template: accepts exactly one main-product section, rejects anything else', () => {
    const ok = validateGenerationPlan(VALID_PRODUCT_PLAN, productPool, 'product');
    assert.strictEqual(ok.valid, true);

    const tooMany = validateGenerationPlan({
        templateName: 'product',
        order: ['main', 'extra'],
        sections: { main: { type: 'main-product' }, extra: { type: 'main-product' } }
    }, productPool, 'product');
    assert.strictEqual(tooMany.valid, false);
    assert.ok(tooMany.errors.some(e => e.includes('must use exactly one section of type "main-product"')));
});

// ---------------------------------------------------------------------------
// matchesPlan()
// ---------------------------------------------------------------------------

test('matchesPlan() — accepts configuration output that matches the approved plan exactly', () => {
    const result = matchesPlan(VALID_INDEX_CONFIG, VALID_INDEX_PLAN);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.valid, true);
});

test('matchesPlan() — rejects a configuration whose section order drifted from the plan', () => {
    const drifted = { ...VALID_INDEX_CONFIG, order: ['testi-1', 'hero-1'] };
    const result = matchesPlan(drifted, VALID_INDEX_PLAN);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('does not match the approved plan order')));
});

test('matchesPlan() — rejects a configuration with the wrong block composition (count and unplanned type)', () => {
    const wrongCount = JSON.parse(JSON.stringify(VALID_INDEX_CONFIG));
    delete wrongCount.sections['testi-1'].blocks.c3;
    wrongCount.sections['testi-1'].block_order = ['c1', 'c2'];
    const result = matchesPlan(wrongCount, VALID_INDEX_PLAN);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('plan required 3')));

    const unplannedType = JSON.parse(JSON.stringify(VALID_INDEX_CONFIG));
    unplannedType.sections['hero-1'].blocks.s1.type = 'mystery-block';
    const result2 = matchesPlan(unplannedType, VALID_INDEX_PLAN);
    assert.strictEqual(result2.valid, false);
    assert.ok(result2.errors.some(e => e.includes('unplanned block type')));
});

// ---------------------------------------------------------------------------
// Prompt scoping (§9 — bounded generation context)
// ---------------------------------------------------------------------------

test('buildConfigurationSystemPrompt() — scopes schemas to ONLY the types used in the approved plan, not the whole retrieved pool', () => {
    const heroOnlyPlan = { templateName: 'index', order: ['hero-1'], sections: { 'hero-1': { type: 'slideshow', blockTypes: ['slide'] } } };
    const prompt = buildConfigurationSystemPrompt(heroOnlyPlan, indexPool);
    assert.ok(prompt.includes('"slideshow"'));
    assert.ok(prompt.includes('"slide"'));
    // testimonials/column/collage/image/product are in indexPool but NOT in this plan — must not appear.
    assert.ok(!prompt.includes('"testimonials"'));
    assert.ok(!prompt.includes('"collage"'));
});

// ---------------------------------------------------------------------------
// runPlanningStage() — mocked AI call, bounded repair
// ---------------------------------------------------------------------------

test('runPlanningStage() — accepts a valid plan on the first attempt', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => { calls++; return VALID_INDEX_PLAN; });
    try {
        const { plan, repaired } = await runPlanningStage({ brief: READY_BRIEF, templateName: 'index', retrievedSchemas: indexPool, themeContext: { templateExists: false, existingSections: [] }, requestId: 'r1' });
        assert.deepStrictEqual(plan, VALID_INDEX_PLAN);
        assert.strictEqual(repaired, false);
        assert.strictEqual(calls, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runPlanningStage() — recovers via one bounded repair when the first plan is invalid', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => {
        calls++;
        return calls === 1 ? { templateName: 'index', order: ['x'], sections: { x: { type: 'not-a-real-type' } } } : VALID_INDEX_PLAN;
    });
    try {
        const { plan, repaired } = await runPlanningStage({ brief: READY_BRIEF, templateName: 'index', retrievedSchemas: indexPool, themeContext: { templateExists: false, existingSections: [] }, requestId: 'r2' });
        assert.deepStrictEqual(plan, VALID_INDEX_PLAN);
        assert.strictEqual(repaired, true);
        assert.strictEqual(calls, 2, 'expected exactly one repair attempt, not an unbounded loop');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runPlanningStage() — throws (Stage 2 never runs) when the repair attempt is also invalid', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => { calls++; return { templateName: 'index', order: ['x'], sections: { x: { type: 'not-a-real-type' } } }; });
    try {
        await assert.rejects(
            () => runPlanningStage({ brief: READY_BRIEF, templateName: 'index', retrievedSchemas: indexPool, themeContext: { templateExists: false, existingSections: [] }, requestId: 'r3' }),
            /invalid GenerationPlan/
        );
        assert.strictEqual(calls, 2, 'exactly plan + one repair attempt, then stop');
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// runConfigurationStage() — mocked AI call, bounded repair, plan conformance
// ---------------------------------------------------------------------------

test('runConfigurationStage() — accepts valid, plan-matching output on the first attempt', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => { calls++; return VALID_INDEX_CONFIG; });
    try {
        const { config, repaired } = await runConfigurationStage({ brief: READY_BRIEF, plan: VALID_INDEX_PLAN, retrievedSchemas: indexPool, themeContext: { globalSettingsCurrent: {} }, requestId: 'r4' });
        assert.deepStrictEqual(config.order, VALID_INDEX_CONFIG.order);
        assert.strictEqual(repaired, false);
        assert.strictEqual(calls, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runConfigurationStage() — repairs output that validates structurally but drifted from the approved plan', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    const drifted = { ...VALID_INDEX_CONFIG, order: ['testi-1', 'hero-1'] };
    global.fetch = jsonFetch(() => { calls++; return calls === 1 ? drifted : VALID_INDEX_CONFIG; });
    try {
        const { config, repaired } = await runConfigurationStage({ brief: READY_BRIEF, plan: VALID_INDEX_PLAN, retrievedSchemas: indexPool, themeContext: { globalSettingsCurrent: {} }, requestId: 'r5' });
        assert.deepStrictEqual(config.order, VALID_INDEX_CONFIG.order);
        assert.strictEqual(repaired, true);
        assert.strictEqual(calls, 2);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runConfigurationStage() — throws when still invalid after the repair attempt', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = jsonFetch(() => { calls++; return { sections: {}, order: [] }; }); // always invalid
    try {
        await assert.rejects(
            () => runConfigurationStage({ brief: READY_BRIEF, plan: VALID_INDEX_PLAN, retrievedSchemas: indexPool, themeContext: { globalSettingsCurrent: {} }, requestId: 'r6' }),
            /Stage 2/
        );
        assert.strictEqual(calls, 2);
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// runStagedGeneration() — full orchestration (deterministic via the product
// template's forced-exclusive-section rule, independent of retrieval-rules
// keyword content)
// ---------------------------------------------------------------------------

function stagedMockFetch() {
    let calls = 0;
    const fn = async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        let payload;
        if (body.messages.length === 1) {
            payload = { niche: 'pet', colors_accent_1: '#111111', colors_accent_2: '#222222' }; // color call
        } else if (body.messages[0].content.includes('STRUCTURE planner')) {
            payload = VALID_PRODUCT_PLAN;
        } else {
            payload = VALID_PRODUCT_CONFIG;
        }
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    };
    fn.callCount = () => calls;
    return fn;
}

test('runStagedGeneration() — end to end against the real schema catalog: retrieval -> plan -> configure, no repairs needed', async () => {
    const originalFetch = global.fetch;
    global.fetch = stagedMockFetch();
    try {
        const result = await runStagedGeneration({ brief: READY_BRIEF, schemas: fullSchemas, templateName: 'product', requestId: 'staged-1' });
        assert.deepStrictEqual(result.plan, VALID_PRODUCT_PLAN);
        assert.deepStrictEqual(result.config.order, ['main']);
        assert.strictEqual(result.config.sections.main.type, 'main-product');
        assert.strictEqual(result.planRepaired, false);
        assert.strictEqual(result.configRepaired, false);
        assert.strictEqual(result.aiCallCount, 2); // plan + configure (color is billed separately by the caller)
        assert.ok(result.retrievalMeta.forcedExclusiveApplied);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runStagedGeneration() — requires a resolved brief and the full schema catalog', async () => {
    await assert.rejects(() => generation.runStagedGeneration({ schemas: fullSchemas }), /WebsiteBrief/);
    await assert.rejects(() => generation.runStagedGeneration({ brief: READY_BRIEF }), /schema catalog/);
});
