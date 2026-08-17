/**
 * Tests for footer-generation.js — the footer coverage work's menu-handle
 * preservation (preserveFooterMenuHandles) and the generateAndApplyFooter()
 * orchestrator's graceful "no footer-group in this theme" path (the AI-call
 * path is covered indirectly by the mocked end-to-end run described in the
 * footer coverage plan; these tests are the deterministic, no-fetch pieces).
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-footer-generation-tests';

const test = require('node:test');
const assert = require('node:assert');
const {
    FOOTER_TEMPLATE_NAME,
    FALLBACK_MENU_HANDLE,
    existingLinkListMenus,
    preserveFooterMenuHandles,
    preserveUnknownFooterBlocks,
    generateAndApplyFooter
} = require('../footer-generation');

// ---------------------------------------------------------------------
// existingLinkListMenus()
// ---------------------------------------------------------------------

test('existingLinkListMenus() — extracts menu handles from link_list blocks in block_order sequence, ignoring other block types', () => {
    const existing = {
        block_order: ['img-1', 'ln-1', 'ln-2', 'es-1'],
        blocks: {
            'img-1': { type: 'image', settings: {} },
            'ln-1': { type: 'link_list', settings: { heading: 'Pet Care Hub', menu: 'main-menu' } },
            'ln-2': { type: 'link_list', settings: { heading: 'FAQs & Policies', menu: 'footer' } },
            'es-1': { type: 'email_signup', settings: {} }
        }
    };
    assert.deepStrictEqual(existingLinkListMenus(existing), ['main-menu', 'footer']);
});

test('existingLinkListMenus() — a link_list block with no menu set falls back to FALLBACK_MENU_HANDLE, not undefined', () => {
    const existing = {
        block_order: ['ln-1'],
        blocks: { 'ln-1': { type: 'link_list', settings: { heading: 'No menu here' } } }
    };
    assert.deepStrictEqual(existingLinkListMenus(existing), [FALLBACK_MENU_HANDLE]);
});

test('existingLinkListMenus() — returns [] for a missing or malformed existing section', () => {
    assert.deepStrictEqual(existingLinkListMenus(null), []);
    assert.deepStrictEqual(existingLinkListMenus({ blocks: {} }), []); // no block_order array
});

// ---------------------------------------------------------------------
// preserveFooterMenuHandles()
// ---------------------------------------------------------------------

const EXISTING_FOOTER_SECTION = {
    block_order: ['img-1', 'ln-1', 'ln-2', 'es-1'],
    blocks: {
        'img-1': { type: 'image', settings: {} },
        'ln-1': { type: 'link_list', settings: { heading: 'Pet Care Hub', menu: 'main-menu' } },
        'ln-2': { type: 'link_list', settings: { heading: 'FAQs & Policies', menu: 'footer' } },
        'es-1': { type: 'email_signup', settings: {} }
    }
};

test('preserveFooterMenuHandles() — splices existing menu handles onto candidate link_list blocks, matched by link_list-only position', () => {
    const candidate = {
        type: 'footer',
        settings: {},
        blocks: {
            'c-ln-1': { type: 'link_list', settings: { heading: 'Style Guide' } },
            'c-es-1': { type: 'email_signup', settings: { heading: 'Join us' } },
            'c-ln-2': { type: 'link_list', settings: { heading: 'Returns & Shipping' } }
        },
        block_order: ['c-ln-1', 'c-es-1', 'c-ln-2']
    };

    const result = preserveFooterMenuHandles(candidate, EXISTING_FOOTER_SECTION);

    // Positional match is among link_list blocks specifically — the
    // interleaved email_signup block must not shift the pairing.
    assert.strictEqual(result.blocks['c-ln-1'].settings.menu, 'main-menu');
    assert.strictEqual(result.blocks['c-ln-2'].settings.menu, 'footer');
    // AI-generated heading text is preserved untouched.
    assert.strictEqual(result.blocks['c-ln-1'].settings.heading, 'Style Guide');
    assert.strictEqual(result.blocks['c-ln-2'].settings.heading, 'Returns & Shipping');
    // Non-link_list blocks pass through unchanged.
    assert.deepStrictEqual(result.blocks['c-es-1'], candidate.blocks['c-es-1']);
    // Input is not mutated.
    assert.strictEqual(candidate.blocks['c-ln-1'].settings.menu, undefined);
});

test('preserveFooterMenuHandles() — more candidate link_lists than existing falls back to the first existing menu handle', () => {
    const candidate = {
        blocks: {
            'c-ln-1': { type: 'link_list', settings: { heading: 'A' } },
            'c-ln-2': { type: 'link_list', settings: { heading: 'B' } },
            'c-ln-3': { type: 'link_list', settings: { heading: 'C' } } // beyond the 2 existing
        },
        block_order: ['c-ln-1', 'c-ln-2', 'c-ln-3']
    };
    const result = preserveFooterMenuHandles(candidate, EXISTING_FOOTER_SECTION);
    assert.strictEqual(result.blocks['c-ln-1'].settings.menu, 'main-menu');
    assert.strictEqual(result.blocks['c-ln-2'].settings.menu, 'footer');
    assert.strictEqual(result.blocks['c-ln-3'].settings.menu, 'main-menu', 'falls back to the first existing menu handle, never left unset');
});

test('preserveFooterMenuHandles() — no existing footer section at all still assigns FALLBACK_MENU_HANDLE, never undefined', () => {
    const candidate = {
        blocks: { 'c-ln-1': { type: 'link_list', settings: { heading: 'A' } } },
        block_order: ['c-ln-1']
    };
    const result = preserveFooterMenuHandles(candidate, null);
    assert.strictEqual(result.blocks['c-ln-1'].settings.menu, FALLBACK_MENU_HANDLE);
});

// ---------------------------------------------------------------------
// preserveUnknownFooterBlocks()
// ---------------------------------------------------------------------

const EXISTING_WITH_LOGO = {
    block_order: ['img-1', 'ln-1', 'es-1'],
    blocks: {
        'img-1': { type: 'image', disabled: true, settings: { image: 'shopify://shop_images/logo.png' } },
        'ln-1': { type: 'link_list', settings: { heading: 'Pet Care Hub', menu: 'main-menu' } },
        'es-1': { type: 'email_signup', settings: {} }
    }
};

test('preserveUnknownFooterBlocks() — a block type outside AI scope (e.g. the disabled logo/image block) is spliced back in verbatim, before the AI blocks', () => {
    const candidate = {
        blocks: { 'c-ln-1': { type: 'link_list', settings: { heading: 'Style Guide' } } },
        block_order: ['c-ln-1']
    };
    const result = preserveUnknownFooterBlocks(candidate, EXISTING_WITH_LOGO, ['link_list', 'email_signup']);
    assert.deepStrictEqual(result.block_order, ['img-1', 'c-ln-1']);
    assert.deepStrictEqual(result.blocks['img-1'], EXISTING_WITH_LOGO.blocks['img-1']);
    assert.deepStrictEqual(result.blocks['c-ln-1'], candidate.blocks['c-ln-1']);
});

test('preserveUnknownFooterBlocks() — no unmanaged existing block type means the candidate passes through unchanged', () => {
    const existingAllManaged = {
        block_order: ['ln-1'],
        blocks: { 'ln-1': { type: 'link_list', settings: { heading: 'Old' } } }
    };
    const candidate = { blocks: { 'c-ln-1': { type: 'link_list', settings: {} } }, block_order: ['c-ln-1'] };
    const result = preserveUnknownFooterBlocks(candidate, existingAllManaged, ['link_list', 'email_signup']);
    assert.strictEqual(result, candidate, 'should return the same object, not a needless clone, when nothing needs preserving');
});

test('preserveUnknownFooterBlocks() — no existing footer section returns the candidate unchanged', () => {
    const candidate = { blocks: { 'c-ln-1': { type: 'link_list', settings: {} } }, block_order: ['c-ln-1'] };
    assert.strictEqual(preserveUnknownFooterBlocks(candidate, null, ['link_list']), candidate);
});

// ---------------------------------------------------------------------
// generateAndApplyFooter() — graceful no-op path (no AI call needed: this
// branch returns before ever calling runStagedGeneration())
// ---------------------------------------------------------------------

test('generateAndApplyFooter() — no footer-group template in ThemeState returns applied:false without throwing or calling the AI', async () => {
    const themeState = { templates: {} }; // no 'footer-group' entry
    const result = await generateAndApplyFooter({ brief: {}, schemas: { sectionSchemas: [], blockSchemas: [] }, themeState, themeRoot: '/nonexistent', requestId: 'test-no-footer' });
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.aiCallCount, 0);
    assert.match(result.reason, new RegExp(FOOTER_TEMPLATE_NAME));
});
