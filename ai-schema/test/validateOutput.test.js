/**
 * Characterization tests for validateOutput() — Phase 1 regression safety net.
 *
 * These fixtures use REAL schemas (via loadSchemas()) rather than invented
 * ones, so the tests exercise the actual current schema data, not a stand-in.
 * Every check here documents behavior that already exists today and must
 * keep working unchanged through later phases (per AUDIT.md §10):
 *   - section type membership
 *   - block type membership
 *   - allowed_blocks enforcement
 *   - max_blocks enforcement
 *   - block_order completeness/consistency
 *   - image/image_picker hallucination guard
 *
 * A few tests also CHARACTERIZE known gaps (documented in AUDIT.md §3/§11)
 * without fixing them — e.g. product_picker hallucination is NOT caught
 * today. Those tests assert today's (gap-having) behavior on purpose, so a
 * later phase (Phase 6) that closes the gap will have to consciously update
 * this test rather than silently regress it back open.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas, validateOutput } = require('../example-implementation');

let schemas;

test.before(async () => {
    schemas = await loadSchemas();
});

test('validateOutput() — accepts a well-formed config built from real schemas', () => {
    const config = {
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

    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, true, result.error);
    assert.deepStrictEqual(result.config.order, config.order);
});

test('validateOutput() — rejects an unknown section type', () => {
    const config = {
        sections: {
            'bogus-1': { type: 'not-a-real-section', settings: {} }
        },
        order: ['bogus-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /unknown section type/);
});

test('validateOutput() — rejects an unknown block type', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'slide-1': { type: 'not-a-real-block', settings: {} } },
                block_order: ['slide-1']
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /unknown block type/);
});

test('validateOutput() — rejects a block type not present in the section\'s allowed_blocks', () => {
    // "column" is a real block, just not one slideshow's allowed_blocks (["slide"]) permits.
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'col-1': { type: 'column', settings: {} } },
                block_order: ['col-1']
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /not allowed in section/);
});

test('validateOutput() — rejects exceeding a section\'s max_blocks', () => {
    // collage.json declares max_blocks: 3 and allowed_blocks: ["image", "product"].
    const config = {
        sections: {
            'collage-1': {
                type: 'collage',
                settings: {},
                blocks: {
                    'img-1': { type: 'image', settings: { image: '' } },
                    'img-2': { type: 'image', settings: { image: '' } },
                    'img-3': { type: 'image', settings: { image: '' } },
                    'img-4': { type: 'image', settings: { image: '' } }
                },
                block_order: ['img-1', 'img-2', 'img-3', 'img-4']
            }
        },
        order: ['collage-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /maximum allowed is 3/);
});

test('validateOutput() — rejects blocks present without a block_order array', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'slide-1': { type: 'slide', settings: {} } }
                // block_order intentionally omitted
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /missing "block_order"/);
});

test('validateOutput() — rejects a block_order entry that references a nonexistent block', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: { 'slide-1': { type: 'slide', settings: {} } },
                block_order: ['slide-1', 'slide-ghost']
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /references unknown block/);
});

test('validateOutput() — rejects a block missing from block_order', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: {
                    'slide-1': { type: 'slide', settings: {} },
                    'slide-2': { type: 'slide', settings: {} }
                },
                block_order: ['slide-1']
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /not listed in block_order/);
});

test('validateOutput() — image hallucination guard rejects an invented filename on a block-level image_picker', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: {},
                blocks: {
                    'slide-1': { type: 'slide', settings: { image: 'vegan-bowl.jpg' } }
                },
                block_order: ['slide-1']
            }
        },
        order: ['hero-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /invalid image value/);
});

test('validateOutput() — image hallucination guard accepts empty string, shopify://, and https:// values', () => {
    for (const value of ['', 'shopify://shop_images/hero.jpg', 'https://cdn.example.com/hero.jpg']) {
        const config = {
            sections: {
                'hero-1': {
                    type: 'slideshow',
                    settings: {},
                    blocks: { 'slide-1': { type: 'slide', settings: { image: value } } },
                    block_order: ['slide-1']
                }
            },
            order: ['hero-1']
        };
        const result = validateOutput(JSON.stringify(config), schemas);
        assert.strictEqual(result.valid, true, `expected "${value}" to pass but got: ${result.error}`);
    }
});

test('validateOutput() — rejects order referencing a section id not present in sections', () => {
    const config = {
        sections: {
            'hero-1': { type: 'slideshow', settings: {} }
        },
        order: ['hero-1', 'ghost-section']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /references unknown section/);
});

test('validateOutput() — rejects an empty order array', () => {
    const config = { sections: {}, order: [] };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /at least 1 section/);
});

test('validateOutput() — rejects more than 10 sections in order', () => {
    const config = {
        sections: {},
        order: Array.from({ length: 11 }, (_, i) => `section-${i}`)
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /Maximum 10 sections/);
});

test('validateOutput() — rejects malformed (non-JSON) output', () => {
    const result = validateOutput('{not valid json', schemas);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
});

test('validateOutput() — KNOWN GAP (documented, not fixed in Phase 1): a hallucinated product_picker handle is NOT caught, unlike image_picker', () => {
    // Mirrors the real committed artifact in ai-schema/output/ containing
    // "product": "signature-vegan-chicken" that passed validation untouched
    // (AUDIT.md §4). Only image/image_picker settings are hallucination-checked
    // today; product_picker/collection are not. Phase 6 closes this gap.
    const config = {
        sections: {
            'collage-1': {
                type: 'collage',
                settings: {},
                blocks: {
                    'prod-1': { type: 'product', settings: { product: 'a-completely-invented-handle' } }
                },
                block_order: ['prod-1']
            }
        },
        order: ['collage-1']
    };
    const result = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(
        result.valid,
        true,
        'this currently passes validation — if this assertion starts failing, the gap has already been closed and this test should be updated/removed, not "fixed back open"'
    );
});

test('validateOutput() — KNOWN GAP (documented, not fixed in Phase 1): allowed_on is not enforced against a target template', () => {
    // slideshow.json's allowed_on is ["index", "product", "page"] — but
    // validateOutput() has no templateName parameter today, so a section
    // schema'd only for those templates could be silently placed anywhere
    // and nothing here would catch it. This test just documents that
    // validateOutput's signature is (output, schemas[, context]) with no
    // template-awareness yet — Phase 6 adds it.
    assert.strictEqual(validateOutput.length, 2, 'validateOutput has 2 required params today (output, schemas); templateName enforcement is a Phase 6 addition');
});
