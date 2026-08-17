const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas } = require('../example-implementation');
const { retrieveRelevantSchemas, matchRules } = require('../retrieval');

let fullSchemas;

test.before(async () => {
    fullSchemas = await loadSchemas(); // full mode — the raw material retrieval filters
});

// ---------------------------------------------------------------------
// matchRules() — deterministic keyword matching, in isolation
// ---------------------------------------------------------------------

test('matchRules() — the generic default rule fires on common commercial-intent words', () => {
    const { defaultApplied, matchedCategories } = matchRules('Create a premium pet wellness store for dogs and cats.');
    assert.strictEqual(defaultApplied, true);
    assert.ok(matchedCategories.includes('hero'));
});

test('matchRules() — a specific rule fires on an explicit keyword ("testimonials")', () => {
    const { ruleMatches, matchedCategories } = matchRules('Add customer testimonials to my page.');
    // Substring matching against the rule's keyword list correctly matches
    // "testimonial" (it's a substring of "testimonials" and listed first in
    // the rule) rather than the plural form — either is a legitimate hit
    // for this rule, so assert on the category it contributed, not which
    // exact keyword string won.
    const hit = ruleMatches.find(r => r.categories.includes('social-proof') && !r.isDefault);
    assert.ok(hit, 'expected a social-proof rule to match on "testimonials"');
    assert.ok(matchedCategories.includes('social-proof'));
});

test('matchRules() — returns zero matches for text with no recognizable signal', () => {
    const { ruleMatches, defaultApplied } = matchRules('xkzq wvbm plqr');
    assert.strictEqual(ruleMatches.length, 0);
    assert.strictEqual(defaultApplied, false);
});

test('matchRules() — matching is case-insensitive', () => {
    const lower = matchRules('add a NEWSLETTER signup');
    assert.ok(lower.ruleMatches.some(r => r.keyword === 'newsletter'));
});

// ---------------------------------------------------------------------
// Relevance test cases (Phase 2 spec §8) — pet wellness / luxury fashion / SaaS
// ---------------------------------------------------------------------

const RELEVANCE_SCENARIOS = [
    { name: 'pet wellness', prompt: 'Create a premium pet wellness store for dogs and cats.' },
    { name: 'luxury fashion', prompt: 'Create a luxury fashion store.' },
    { name: 'SaaS landing', prompt: 'Create a modern SaaS landing page.' }
];

for (const scenario of RELEVANCE_SCENARIOS) {
    test(`retrieveRelevantSchemas() — "${scenario.name}" surfaces a relevant, bounded subset (not full-fallback)`, () => {
        const result = retrieveRelevantSchemas(fullSchemas, { userPrompt: scenario.prompt, templateName: 'index' });
        assert.strictEqual(result.retrievalMeta.mode, 'RETRIEVAL', `expected retrieval to succeed for "${scenario.name}", got fallback: ${result.retrievalMeta.fallbackReason}`);

        const selectedIds = result.sectionSchemas.map(s => s.id);
        assert.ok(selectedIds.includes('slideshow'), 'expected a hero/slideshow section to be present');
        assert.ok(selectedIds.includes('featured-collection'), 'expected a product-showcase capability to be present');
        assert.ok(result.sectionSchemas.length < fullSchemas.sectionSchemas.length, 'expected fewer sections than the full catalog');
        assert.ok(result.blockSchemas.length < fullSchemas.blockSchemas.length, 'expected fewer blocks than the full catalog');
    });
}

test('retrieveRelevantSchemas() — unrelated capabilities are not unnecessarily selected for a generic prompt', () => {
    // "Create a premium pet wellness store..." only trips the generic default
    // rule (categories: hero, product-showcase, social-proof, conversion,
    // content) — form-input/trust-badges/layout-structural sections should
    // NOT be pulled in just because they exist.
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a premium pet wellness store for dogs and cats.',
        templateName: 'index'
    });
    const selectedIds = result.sectionSchemas.map(s => s.id);
    assert.ok(!selectedIds.includes('newsletter'), 'form-input category should not be pulled in without a matching keyword');
    assert.ok(!selectedIds.includes('section-divider'), 'layout-structural category should not be pulled in without a matching keyword');
    assert.ok(!selectedIds.includes('horizontal-ticker'), 'trust-badges category should not be pulled in without a matching keyword');
});

test('retrieveRelevantSchemas() — an explicit keyword adds its category beyond the generic default set', () => {
    const generic = retrieveRelevantSchemas(fullSchemas, { userPrompt: 'Create a store.', templateName: 'index' });
    const withTrust = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a store with trust badges and a countdown timer for urgency.',
        templateName: 'index'
    });
    assert.ok(!generic.sectionSchemas.map(s => s.id).includes('horizontal-ticker'));
    assert.ok(withTrust.sectionSchemas.map(s => s.id).includes('horizontal-ticker'), 'expected "trust badges" to pull in the trust-badges category');
});

// ---------------------------------------------------------------------
// Relationships — selected blocks must actually be reachable from a
// selected section's allowed_blocks; nothing incompatible is injected.
// ---------------------------------------------------------------------

test('retrieveRelevantSchemas() — every selected block is allowed by at least one selected section', () => {
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a premium pet wellness store for dogs and cats.',
        templateName: 'index'
    });
    assert.strictEqual(result.retrievalMeta.mode, 'RETRIEVAL');

    const allowedBlockIdsUnion = new Set();
    for (const section of result.sectionSchemas) {
        const allowed = Array.isArray(section.allowed_blocks)
            ? section.allowed_blocks
            : (section.allowed_blocks && typeof section.allowed_blocks === 'object' ? Object.keys(section.allowed_blocks) : []);
        allowed.forEach(id => allowedBlockIdsUnion.add(id));
    }

    for (const block of result.blockSchemas) {
        assert.ok(
            allowedBlockIdsUnion.has(block.id),
            `block "${block.id}" was selected but isn't in any selected section's allowed_blocks — retrieval should never inject unrelated blocks`
        );
    }
});

test('retrieveRelevantSchemas() — a block not reachable from any selected section is never present, even if keyword-relevant', () => {
    // "field_row"/"textarea"/"tnc_checkbox" only belong to contact-form,
    // which isn't eligible for the "index" template — so even a prompt
    // mentioning "contact form" should not pull those blocks in for index.
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a store with a contact form section.',
        templateName: 'index'
    });
    const blockIds = result.blockSchemas.map(b => b.id);
    assert.ok(!blockIds.includes('field_row'));
    assert.ok(!blockIds.includes('textarea'));
    assert.ok(!blockIds.includes('tnc_checkbox'));
});

// ---------------------------------------------------------------------
// Template filtering (allowed_on)
// ---------------------------------------------------------------------

test('retrieveRelevantSchemas() — index-template retrieval never selects main-product or contact-form', () => {
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a store with everything: testimonials, trust badges, countdown, newsletter, contact form.',
        templateName: 'index'
    });
    const selectedIds = result.sectionSchemas.map(s => s.id);
    assert.ok(!selectedIds.includes('main-product'), 'main-product is only allowed_on ["product"], never index');
    assert.ok(!selectedIds.includes('contact-form'), 'contact-form is only allowed_on ["page"], never index');
});

test('retrieveRelevantSchemas() — product template always forces exactly main-product (mirrors the existing "ONLY section" rule)', () => {
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a product page for a premium pet supplement.',
        templateName: 'product'
    });
    assert.strictEqual(result.retrievalMeta.mode, 'RETRIEVAL');
    assert.strictEqual(result.retrievalMeta.forcedExclusiveApplied, true);
    assert.deepStrictEqual(result.sectionSchemas.map(s => s.id), ['main-product']);
});

test('retrieveRelevantSchemas() — an unsupported template (no schema declares it) falls back safely instead of returning an empty set', () => {
    const result = retrieveRelevantSchemas(fullSchemas, {
        userPrompt: 'Create a collection page for our best sellers.',
        templateName: 'collection'
    });
    assert.strictEqual(result.retrievalMeta.mode, 'FULL_FALLBACK');
    assert.match(result.retrievalMeta.fallbackReason, /no sections declare "collection"/);
    // Fallback must still return a usable (non-empty) schema set — never an
    // incomplete/invalid generation context.
    assert.strictEqual(result.sectionSchemas.length, fullSchemas.sectionSchemas.length);
    assert.strictEqual(result.blockSchemas.length, fullSchemas.blockSchemas.length);
});

// ---------------------------------------------------------------------
// Fallback safety net
// ---------------------------------------------------------------------

test('retrieveRelevantSchemas() — a prompt with zero keyword signal falls back to the full schema set', () => {
    const result = retrieveRelevantSchemas(fullSchemas, { userPrompt: 'xkzq wvbm plqr', templateName: 'index' });
    assert.strictEqual(result.retrievalMeta.mode, 'FULL_FALLBACK');
    assert.match(result.retrievalMeta.fallbackReason, /zero confidence/);
    assert.deepStrictEqual(result.sectionSchemas, fullSchemas.sectionSchemas);
    assert.deepStrictEqual(result.blockSchemas, fullSchemas.blockSchemas);
});

test('retrieveRelevantSchemas() — fallback output is schema-identical to full-load loadSchemas() output', async () => {
    const fresh = await loadSchemas(); // full-load mode, independent read
    const result = retrieveRelevantSchemas(fullSchemas, { userPrompt: 'xkzq wvbm plqr', templateName: 'index' });
    assert.deepStrictEqual(result.sectionSchemas, fresh.sectionSchemas);
    assert.deepStrictEqual(result.blockSchemas, fresh.blockSchemas);
});

// ---------------------------------------------------------------------
// loadSchemas() integration — both modes reachable through the same entry point
// ---------------------------------------------------------------------

test('loadSchemas({ retrieval }) — returns retrievalMeta; loadSchemas() does not', async () => {
    const full = await loadSchemas();
    assert.strictEqual(full.retrievalMeta, undefined, 'full-load mode should not carry retrieval metadata');

    const retrieved = await loadSchemas({ retrieval: { userPrompt: 'Create a store.', templateName: 'index' } });
    assert.ok(retrieved.retrievalMeta, 'retrieval mode should include retrievalMeta');
});

test('loadSchemas() — full-load mode is completely unaffected by Phase 2 (still every schema on disk)', async () => {
    const full = await loadSchemas();
    assert.strictEqual(full.sectionSchemas.length, fullSchemas.sectionSchemas.length);
    assert.strictEqual(full.blockSchemas.length, fullSchemas.blockSchemas.length);
});
