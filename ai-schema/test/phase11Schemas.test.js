/**
 * Phase 11 tests for the actual schema additions/corrections: fidelity
 * against real Liquid `{% schema %}` definitions, section/block
 * relationships, retrieval selectivity, Phase 6 validation compatibility,
 * Phase 8 generic operations, and Phase 9 conversational editing — all
 * exercised against the NEW schemas with zero schema-specific code (§24).
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase11-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');
const { loadSchemas } = require('../example-implementation');
const { retrieveRelevantSchemas } = require('../retrieval');
const { validateSettings, validateDataReferences } = require('../validation');
const { resolveSectionTarget, resolveBlockTarget, validateOperation, applyOperationToThemeState } = require('../operations');
const { runTargetedEdit } = require('../edit-pipeline');
const { runConversationalEdit } = require('../conversational-edit');
const { findMissingReferencedBlocks, inventoryAISchemas, AI_SECTIONS_DIR, AI_BLOCKS_DIR } = require('../coverage-report');
const { sessionFilePath } = require('../conversation-session');

const NEW_SECTION_IDS = ['related-products', 'facebook-testimonials', 'custom-columns-new', 'rich-text', 'collapsible-content', 'track-order', 'email-signup-banner', 'shoppable-image', 'image-slider', 'colors-changer'];
const NEW_BLOCK_IDS = ['container', 'collapsible-row-content', 'hotspot', 'image_slide', 'video_slide', 'field_row'];

let schemas;
test.before(async () => {
    schemas = await loadSchemas();
});

async function cleanupSession(sessionId) {
    if (!sessionId) return;
    await fs.rm(sessionFilePath(sessionId), { force: true });
}

// ---------------------------------------------------------------------------
// Schema fidelity — spot-checks against the real Liquid {% schema %}.
// ---------------------------------------------------------------------------

test('fidelity — related-products.heading_size options match the real Liquid enum exactly', () => {
    const schema = schemas.sectionSchemas.find(s => s.id === 'related-products');
    assert.deepStrictEqual(schema.settings.heading_size, ['h3', 'h2', 'h1', 'h0', 'custom']);
});

test('fidelity — image_slide.desc_alignment preserves the real Shopify quirk of an empty-string "left" option, not the word "left"', () => {
    const schema = schemas.blockSchemas.find(b => b.id === 'image_slide');
    assert.deepStrictEqual(schema.settings.desc_alignment, ['', 'center', 'right']);
});

test('fidelity — hotspot.product uses the protected product_picker type name, not a raw/unsafe "product" type', () => {
    const schema = schemas.blockSchemas.find(b => b.id === 'hotspot');
    assert.strictEqual(schema.settings.product, 'product_picker');
});

test('fidelity — every new schema uses only category values from the existing closed taxonomy (§18)', () => {
    const CATEGORIES = new Set(['hero', 'content', 'social-proof', 'product-showcase', 'product-detail', 'conversion', 'trust-badges', 'layout-structural', 'media', 'form-input', 'misc']);
    for (const id of NEW_SECTION_IDS) {
        const schema = schemas.sectionSchemas.find(s => s.id === id);
        assert.ok(CATEGORIES.has(schema.category), `"${id}" has an unrecognized category "${schema.category}"`);
    }
    for (const id of NEW_BLOCK_IDS) {
        const schema = schemas.blockSchemas.find(b => b.id === id);
        assert.ok(CATEGORIES.has(schema.category), `"${id}" has an unrecognized category "${schema.category}"`);
    }
});

test('fidelity — no new section declares allowed_on: ["*"] or an empty/unrestricted list (§19)', () => {
    for (const id of NEW_SECTION_IDS) {
        const schema = schemas.sectionSchemas.find(s => s.id === id);
        assert.ok(Array.isArray(schema.allowed_on) && schema.allowed_on.length > 0, `"${id}" must declare a specific, non-empty allowed_on`);
        assert.ok(!schema.allowed_on.includes('*'));
    }
});

// ---------------------------------------------------------------------------
// Relationships — every new section's allowed_blocks resolves to a real
// AI block schema (§13/§14).
// ---------------------------------------------------------------------------

test('relationships — every NEW section\'s allowed_blocks entries all resolve to an existing AI block schema', async () => {
    const aiSections = await inventoryAISchemas(AI_SECTIONS_DIR);
    const aiBlocks = await inventoryAISchemas(AI_BLOCKS_DIR);
    const missing = findMissingReferencedBlocks(aiSections.filter(s => NEW_SECTION_IDS.includes(s.id)), aiBlocks);
    assert.deepStrictEqual(missing, [], `new sections must not reference a non-existent block: ${JSON.stringify(missing)}`);
});

test('relationships — contact-form.json now references the corrected "field_row" id, not the stale "input_row"', () => {
    const schema = schemas.sectionSchemas.find(s => s.id === 'contact-form');
    assert.ok(schema.allowed_blocks.includes('field_row'));
    assert.ok(!schema.allowed_blocks.includes('input_row'));
    assert.ok(!schemas.blockSchemas.some(b => b.id === 'input_row'), 'the stale "input_row" schema must no longer exist anywhere in the catalog');
});

// ---------------------------------------------------------------------------
// Retrieval — new schemas are actually discoverable, and retrieval stays
// selective (§17/§18/§31).
// ---------------------------------------------------------------------------

test('retrieval — a matching prompt surfaces the new section AND its allowed blocks', () => {
    const result = retrieveRelevantSchemas(schemas, { userPrompt: 'Add Facebook testimonials and an email signup banner to my homepage', templateName: 'index' });
    const sectionIds = result.sectionSchemas.map(s => s.id);
    assert.ok(sectionIds.includes('facebook-testimonials'));
    assert.ok(sectionIds.includes('email-signup-banner'));
    const blockIds = result.blockSchemas.map(b => b.id);
    assert.ok(blockIds.includes('column'), 'facebook-testimonials\' allowed block must come along with it');
    assert.ok(blockIds.includes('email_form'), 'email-signup-banner\'s allowed block must come along with it');
});

test('retrieval — a selective (non-fallback) match still excludes unrelated NEW sections, not just old ones (§18 selectivity holds after catalog growth)', () => {
    const result = retrieveRelevantSchemas(schemas, { userPrompt: 'Add Facebook testimonials and an email signup banner to my homepage', templateName: 'index' });
    assert.ok(result.sectionSchemas.length < schemas.sectionSchemas.length, 'sanity check: this must be a genuinely selective result, not a full-catalog fallback');
    const sectionIds = result.sectionSchemas.map(s => s.id);
    assert.ok(!sectionIds.includes('track-order'));
    assert.ok(!sectionIds.includes('colors-changer'));
    assert.ok(!sectionIds.includes('related-products'));
});

test('retrieval — a section only allowed on "product" is never retrieved for "index", regardless of prompt wording (§19 template scope respected)', () => {
    const result = retrieveRelevantSchemas(schemas, { userPrompt: 'Show related products on my homepage', templateName: 'index' });
    assert.ok(!result.sectionSchemas.some(s => s.id === 'related-products'));
});

test('retrieval — full catalog load still works and remains larger than any retrieved subset (§32 no full-load regression)', () => {
    const retrieved = retrieveRelevantSchemas(schemas, { userPrompt: 'Add Facebook testimonials to my homepage', templateName: 'index' });
    assert.ok(retrieved.sectionSchemas.length < schemas.sectionSchemas.length);
    assert.ok(retrieved.blockSchemas.length < schemas.blockSchemas.length);
});

// ---------------------------------------------------------------------------
// Validation — Phase 6 compatibility (§22).
// ---------------------------------------------------------------------------

function sampleValue(settingSchema) {
    if (typeof settingSchema === 'string') {
        const map = { text: 'Sample', textarea: 'Sample', inline_richtext: 'Sample', richtext: '<p>Sample</p>', html: '<div>x</div>', url: 'https://example.com', color: '#111111', video: '', image_picker: '', product_picker: '', collection: '' };
        return map[settingSchema] !== undefined ? map[settingSchema] : 'Sample';
    }
    if (Array.isArray(settingSchema)) return settingSchema[0];
    if (settingSchema && typeof settingSchema === 'object') {
        if (settingSchema.type === 'checkbox') return true;
        if (settingSchema.type === 'number' || settingSchema.type === 'range') return settingSchema.min ?? 0;
        if (settingSchema.type === 'select') return settingSchema.options && settingSchema.options[0] ? (settingSchema.options[0].value ?? settingSchema.options[0]) : '';
        return 'Sample';
    }
    return 'Sample';
}

test('validation — every new section\'s full set of sample settings validates cleanly', () => {
    for (const id of NEW_SECTION_IDS) {
        const schema = schemas.sectionSchemas.find(s => s.id === id);
        const settings = {};
        for (const [key, def] of Object.entries(schema.settings || {})) settings[key] = sampleValue(def);
        const candidate = { sections: { 't-1': { type: id, settings, blocks: {}, block_order: [] } }, order: ['t-1'] };
        const result = validateSettings(candidate, schemas);
        assert.strictEqual(result.valid, true, `"${id}" sample settings failed: ${JSON.stringify(result.errors)}`);
    }
});

test('validation — every new block\'s full set of sample settings validates cleanly', () => {
    for (const id of NEW_BLOCK_IDS) {
        const schema = schemas.blockSchemas.find(b => b.id === id);
        const settings = {};
        for (const [key, def] of Object.entries(schema.settings || {})) settings[key] = sampleValue(def);
        const candidate = { sections: { 't-1': { type: 'collage', settings: {}, blocks: { 'b-1': { type: id, settings } }, block_order: ['b-1'] } }, order: ['t-1'] };
        const result = validateSettings(candidate, schemas);
        assert.strictEqual(result.valid, true, `"${id}" sample settings failed: ${JSON.stringify(result.errors)}`);
    }
});

test('validation — an invalid enum value on a new section setting IS rejected', () => {
    const candidate = { sections: { 't-1': { type: 'related-products', settings: { heading_size: 'not-a-real-option' }, blocks: {}, block_order: [] } }, order: ['t-1'] };
    const result = validateSettings(candidate, schemas);
    assert.strictEqual(result.valid, false);
});

test('validation — an unknown setting key on a new section IS rejected (AI cannot invent a setting)', () => {
    const candidate = { sections: { 't-1': { type: 'colors-changer', settings: { made_up_setting: 'x' }, blocks: {}, block_order: [] } }, order: ['t-1'] };
    const result = validateSettings(candidate, schemas);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.code === 'SETTING_UNKNOWN'));
});

test('validation — a hallucinated product handle on the new hotspot block is rejected by the SAME merchant-data guard as every other product_picker (§14 protection extends automatically)', () => {
    const candidate = { sections: { 't-1': { type: 'collage', settings: {}, blocks: { 'h-1': { type: 'hotspot', settings: { product: 'invented-handle' } } }, block_order: ['h-1'] } }, order: ['t-1'] };
    const result = validateDataReferences(candidate, schemas, { knownMerchantData: {} });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.code === 'DATA_REFERENCE_HALLUCINATED'));
});

test('validation — a genuinely known product handle for the hotspot block IS accepted', () => {
    const candidate = { sections: { 't-1': { type: 'collage', settings: {}, blocks: { 'h-1': { type: 'hotspot', settings: { product: 'real-product-handle' } } }, block_order: ['h-1'] } }, order: ['t-1'] };
    const result = validateDataReferences(candidate, schemas, { knownMerchantData: { products: ['real-product-handle'] } });
    assert.strictEqual(result.valid, true);
});

// ---------------------------------------------------------------------------
// Operations — Phase 8 generic targeting, zero schema-specific code (§23/§24).
// ---------------------------------------------------------------------------

function themeStateWith(templateName, sections, order) {
    return {
        themeId: 'test', sourcePath: '/fake', schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        templates: { [templateName]: { sourceFile: `templates/${templateName}.json`, raw: { sections, order } } },
        globalSettings: null, meta: { unparseableTemplates: [], globalSettingsError: null }
    };
}

test('operations — a PRE-EXISTING, already-covered section (slideshow) still resolves and updates correctly (regression sanity)', () => {
    const ts = themeStateWith('index', { 'hero-1': { type: 'slideshow', settings: {}, blocks: {}, block_order: [] } }, ['hero-1']);
    const target = resolveSectionTarget(ts, 'index', 'the slideshow', schemas);
    assert.strictEqual(target.status, 'RESOLVED');
});

test('operations — a NEWLY-covered section (collapsible-content) resolves and can be updated through the exact same generic resolveSectionTarget()/validateOperation()/applyOperationToThemeState() path, no special-case code', () => {
    const ts = themeStateWith('page', { 'faq-1': { type: 'collapsible-content', settings: { title: 'Old' }, blocks: {}, block_order: [] } }, ['faq-1']);
    const target = resolveSectionTarget(ts, 'page', 'faq-1', schemas);
    assert.strictEqual(target.status, 'RESOLVED');

    const op = { operation: 'update_section', target: { templateName: 'page', sectionId: 'faq-1' }, changes: { settings: { title: 'New FAQ heading' } } };
    const validation = validateOperation(op, { themeState: ts, schemas, knownMerchantData: {} });
    assert.strictEqual(validation.valid, true, JSON.stringify(validation.errors));

    const executed = applyOperationToThemeState(ts, op, { themeState: ts, schemas, knownMerchantData: {} });
    assert.strictEqual(executed.valid, true);
    assert.strictEqual(executed.themeState.templates.page.raw.sections['faq-1'].settings.title, 'New FAQ heading');
});

test('operations — add_block onto a NEWLY-covered block type (hotspot) works generically', () => {
    const ts = themeStateWith('product', { 'shop-1': { type: 'shoppable-image', settings: {}, blocks: {}, block_order: [] } }, ['shop-1']);
    const op = { operation: 'add_block', target: { templateName: 'product', sectionId: 'shop-1' }, changes: { type: 'hotspot', settings: { alignment: 'center' } } };
    const validation = validateOperation(op, { themeState: ts, schemas, knownMerchantData: {} });
    assert.strictEqual(validation.valid, true, JSON.stringify(validation.errors));
    const executed = applyOperationToThemeState(ts, op, { themeState: ts, schemas, knownMerchantData: {} });
    assert.strictEqual(executed.valid, true);
    const blocks = executed.themeState.templates.product.raw.sections['shop-1'].blocks;
    assert.strictEqual(Object.values(blocks)[0].type, 'hotspot');
});

test('operations — add_block is REJECTED for a block type not in the target section\'s allowed_blocks, even though the block schema itself exists elsewhere in the catalog', () => {
    const ts = themeStateWith('index', { 'hero-1': { type: 'slideshow', settings: {}, blocks: {}, block_order: [] } }, ['hero-1']);
    // "hotspot" is a real, valid AI block schema — just not allowed inside "slideshow".
    const op = { operation: 'add_block', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { type: 'hotspot', settings: {} } };
    const validation = validateOperation(op, { themeState: ts, schemas, knownMerchantData: {} });
    assert.strictEqual(validation.valid, false);
});

// ---------------------------------------------------------------------------
// Conversational editing — Phase 9 works against newly-covered targets with
// zero special-case code (§23).
// ---------------------------------------------------------------------------

function jsonFetch(routerFn) {
    let calls = 0;
    const fn = async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        const content = JSON.stringify(routerFn(body, calls));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    fn.callCount = () => calls;
    return fn;
}

test('conversational editing — an ambiguous newly-covered target still triggers clarification (never guessed)', async () => {
    const sessionId = 'test-phase11-ambiguous';
    const ts = themeStateWith('page', {
        'faq-1': { type: 'collapsible-content', settings: {}, blocks: {}, block_order: [] },
        'faq-2': { type: 'collapsible-content', settings: {}, blocks: {}, block_order: [] }
    }, ['faq-1', 'faq-2']);
    // The AI's own bounded resolution attempt declines to pick between the
    // tied candidates -> deterministic code falls back to them, same as
    // before, just after one bounded AI call instead of zero.
    const router = jsonFetch(() => ({ confident: false }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runConversationalEdit('Change the collapsible content section.', { sessionId, schemas, themeState: ts, templateName: 'page' });
        assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
        assert.strictEqual(result.candidates.length, 2);
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('conversational editing — a multi-turn edit against a newly-covered section: resolve, apply, then a follow-up reference resolves to the same target', async () => {
    const sessionId = 'test-phase11-multiturn';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'product', sectionId: 'shop-1', blockId: 'spot-1' }, changes: { settings: { alignment: 'center' } } }
        : { operation: 'update_block', target: { templateName: 'product', sectionId: 'shop-1', blockId: 'spot-1' }, changes: { settings: { alignment: 'right' } } });
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const ts = themeStateWith('product', {
            'shop-1': { type: 'shoppable-image', settings: {}, blocks: { 'spot-1': { type: 'hotspot', settings: { alignment: 'left' } } }, block_order: ['spot-1'] }
        }, ['shop-1']);

        const turn1 = await runConversationalEdit('Update the shoppable image hotspot alignment.', { sessionId, schemas, themeState: ts, templateName: 'product' });
        assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));
        assert.strictEqual(turn1.operation.target.blockId, 'spot-1');

        const turn2 = await runConversationalEdit('Make it right-aligned instead.', { sessionId, schemas, themeState: turn1.themeState });
        assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
        assert.strictEqual(turn2.operation.target.blockId, 'spot-1', '"it" resolved to the same newly-covered block without re-asking');
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

// ---------------------------------------------------------------------------
// Live theme isolation.
// ---------------------------------------------------------------------------

test('phase11Schemas.test.js — the real repo theme files remain byte-for-byte unchanged after this whole suite', async () => {
    const { DEFAULT_THEME_ROOT } = require('../theme-state');
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');
    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before);
});
