/**
 * Phase 6 tests for validation.js. Fixtures use REAL schemas (via
 * loadSchemas()) and, where a real ThemeState is needed, the actual theme
 * on disk (via buildThemeState()) — matching the existing convention in
 * test/validateOutput.test.js and test/generation.test.js rather than
 * inventing schemas (AI_THEME_BUILDER_PHASE6_PLAN.md §30).
 *
 * validateOutput() itself (example-implementation.js) is never called or
 * modified here — these tests exercise the NEW layer that assumes its
 * input already passed validateOutput() (§5's pipeline: Output Validation
 * happens before Theme Compatibility Validation).
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas } = require('../example-implementation');
const { buildThemeState } = require('../theme-state');
const {
    ERROR_CODES,
    validateAllowedOn,
    getSettingKind,
    validateSettingValue,
    validateSettings,
    validateDataReferences,
    validateThemeCompatibility,
    validateCandidate
} = require('../validation');

let schemas;

test.before(async () => {
    schemas = await loadSchemas();
});

function codesOf(result) {
    return result.errors.map(e => e.code);
}

// ---------------------------------------------------------------------------
// getSettingKind() — the three real schema setting-definition shapes
// ---------------------------------------------------------------------------

test('getSettingKind() — normalizes string/array/object setting definitions', () => {
    assert.deepStrictEqual(getSettingKind('richtext'), { kind: 'typeName', typeName: 'richtext' });
    assert.deepStrictEqual(getSettingKind(['a', 'b']), { kind: 'enum', options: ['a', 'b'] });
    const obj = { type: 'range', min: 1, max: 5 };
    assert.deepStrictEqual(getSettingKind(obj), { kind: 'object', typeName: 'range', def: obj });
});

// ---------------------------------------------------------------------------
// validateAllowedOn() — §7/§8, against real allowed_on data
// ---------------------------------------------------------------------------

test('validateAllowedOn() — accepts a section whose allowed_on includes the target template (slideshow on index)', () => {
    const config = { sections: { 'hero-1': { type: 'slideshow', settings: {} } }, order: ['hero-1'] };
    const result = validateAllowedOn(config, schemas, 'index');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
});

test('validateAllowedOn() — rejects a section placed on a template outside its allowed_on (main-product, allowed_on: ["product"], placed on index)', () => {
    const config = { sections: { 'main-1': { type: 'main-product', settings: {} } }, order: ['main-1'] };
    const result = validateAllowedOn(config, schemas, 'index');
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.SECTION_NOT_ALLOWED_ON_TEMPLATE]);
    assert.match(result.errors[0].message, /does not include the target template "index"/);
});

test('validateAllowedOn() — the same main-product section is accepted on its actual allowed template', () => {
    const config = { sections: { 'main-1': { type: 'main-product', settings: {} } }, order: ['main-1'] };
    const result = validateAllowedOn(config, schemas, 'product');
    assert.strictEqual(result.valid, true);
});

test('validateAllowedOn() — an unknown section type is silently skipped (validateOutput()\'s job, not this layer\'s)', () => {
    const config = { sections: { 'x-1': { type: 'not-a-real-section', settings: {} } }, order: ['x-1'] };
    const result = validateAllowedOn(config, schemas, 'index');
    assert.strictEqual(result.valid, true);
});

// ---------------------------------------------------------------------------
// validateSettingValue() — §12, per real setting-shape
// ---------------------------------------------------------------------------

test('validateSettingValue() — enum (array) setting: accepts a listed option, rejects an unlisted one', () => {
    const schema = ['true', 'false']; // e.g. slideshow.json's auto_rotate
    assert.deepStrictEqual(validateSettingValue(schema, 'true', 'p'), []);
    const bad = validateSettingValue(schema, 'maybe', 'p');
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].code, ERROR_CODES.SETTING_INVALID_OPTION);
});

test('validateSettingValue() — object range/number setting: enforces declared min/max (featured-collection.json columns_desktop, min 1 max 10)', () => {
    const schema = { type: 'range', min: 1, max: 10, default: 4 };
    assert.deepStrictEqual(validateSettingValue(schema, 7, 'p'), []);
    const tooHigh = validateSettingValue(schema, 15, 'p');
    assert.strictEqual(tooHigh[0].code, ERROR_CODES.SETTING_OUT_OF_RANGE);
    const wrongType = validateSettingValue(schema, '7', 'p');
    assert.strictEqual(wrongType[0].code, ERROR_CODES.SETTING_INVALID_TYPE);
});

test('validateSettingValue() — object checkbox setting requires a real boolean, not a truthy string (main-product.json enable_sticky_info)', () => {
    const schema = { type: 'checkbox', default: true };
    assert.deepStrictEqual(validateSettingValue(schema, true, 'p'), []);
    const bad = validateSettingValue(schema, 'true', 'p');
    assert.strictEqual(bad[0].code, ERROR_CODES.SETTING_INVALID_TYPE);
});

test('validateSettingValue() — free-form string types (text/richtext/color/url) only check JS type, never content shape (§16)', () => {
    assert.deepStrictEqual(validateSettingValue('richtext', '<p>Anything: commas, dashes—em dashes, "quotes" etc.</p>', 'p'), []);
    assert.deepStrictEqual(validateSettingValue('color', '#ABCDEF', 'p'), []);
    const bad = validateSettingValue('text', 42, 'p');
    assert.strictEqual(bad[0].code, ERROR_CODES.SETTING_INVALID_TYPE);
});

test('validateSettingValue() — image/image_picker/product_picker/collection are intentionally skipped here (owned by validateOutput()/validateDataReferences())', () => {
    assert.deepStrictEqual(validateSettingValue('image_picker', 'invented-file.jpg', 'p'), []);
    assert.deepStrictEqual(validateSettingValue('product_picker', 'invented-handle', 'p'), []);
});

test('validateSettingValue() — undefined value (setting simply omitted) is always fine — schemas declare no required settings', () => {
    assert.deepStrictEqual(validateSettingValue({ type: 'range', min: 1, max: 10 }, undefined, 'p'), []);
});

// ---------------------------------------------------------------------------
// validateSettings() — full section+block walk against real schemas
// ---------------------------------------------------------------------------

test('validateSettings() — accepts a well-formed candidate using only real, valid setting values (slideshow + slide)', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: { visibility: 'always-display', slide_height: 'medium', slider_visual: 'dots', auto_rotate: 'true', show_text_below: 'false' },
                blocks: { 's1': { type: 'slide', settings: { heading: 'Welcome', text: '<p>Hi</p>', text_color: '#111111', content_position: 'center' } } },
                block_order: ['s1']
            }
        },
        order: ['hero-1']
    };
    const result = validateSettings(config, schemas);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.valid, true);
});

test('validateSettings() — rejects an AI-generated setting key the schema does not define (§13)', () => {
    const config = {
        sections: { 'hero-1': { type: 'slideshow', settings: { totally_made_up_setting: 'x' } } },
        order: ['hero-1']
    };
    const result = validateSettings(config, schemas);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.SETTING_UNKNOWN]);
});

test('validateSettings() — rejects an invalid enum value on a real section setting', () => {
    const config = {
        sections: { 'hero-1': { type: 'slideshow', settings: { auto_rotate: 'sometimes' } } },
        order: ['hero-1']
    };
    const result = validateSettings(config, schemas);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.SETTING_INVALID_OPTION]);
});

test('validateSettings() — validates BLOCK settings too (column.json star_rating, min 1 max 5)', () => {
    const config = {
        sections: {
            'testi-1': {
                type: 'testimonials',
                settings: {},
                blocks: { 'c1': { type: 'column', settings: { star_rating: 12 } } },
                block_order: ['c1']
            }
        },
        order: ['testi-1']
    };
    const result = validateSettings(config, schemas);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.SETTING_OUT_OF_RANGE]);
    assert.match(result.errors[0].path, /sections\.testi-1\.blocks\.c1\.settings\.star_rating/);
});

test('validateSettings() — an unknown section/block type contributes no findings (validateOutput()\'s job)', () => {
    const config = { sections: { 'x-1': { type: 'not-real', settings: { anything: 'x' } } }, order: ['x-1'] };
    const result = validateSettings(config, schemas);
    assert.deepStrictEqual(result.errors, []);
});

// ---------------------------------------------------------------------------
// validateDataReferences() — §14, product/collection hallucination guard
// ---------------------------------------------------------------------------

test('validateDataReferences() — accepts an empty product_picker/collection value (the existing safe-blank pattern)', () => {
    const config = {
        sections: {
            'collage-1': {
                type: 'collage', settings: {},
                blocks: { 'p1': { type: 'product', settings: { product: '' } } },
                block_order: ['p1']
            },
            'feat-1': { type: 'featured-collection', settings: { collection: '' } }
        },
        order: ['collage-1', 'feat-1']
    };
    const result = validateDataReferences(config, schemas);
    assert.deepStrictEqual(result.errors, []);
});

test('validateDataReferences() — rejects a hallucinated product handle (the exact AUDIT.md artifact shape) when no merchant data is known', () => {
    const config = {
        sections: {
            'collage-1': {
                type: 'collage', settings: {},
                blocks: { 'p1': { type: 'product', settings: { product: 'signature-vegan-chicken' } } },
                block_order: ['p1']
            }
        },
        order: ['collage-1']
    };
    const result = validateDataReferences(config, schemas);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.DATA_REFERENCE_HALLUCINATED]);
});

test('validateDataReferences() — accepts a product/collection handle present in knownMerchantData', () => {
    const config = {
        sections: {
            'collage-1': {
                type: 'collage', settings: {},
                blocks: { 'p1': { type: 'product', settings: { product: 'real-dog-food-bag' } } },
                block_order: ['p1']
            },
            'feat-1': { type: 'featured-collection', settings: { collection: 'best-sellers' } }
        },
        order: ['collage-1', 'feat-1']
    };
    const result = validateDataReferences(config, schemas, {
        knownMerchantData: { products: ['real-dog-food-bag'], collections: ['best-sellers'] }
    });
    assert.deepStrictEqual(result.errors, []);
});

test('validateDataReferences() — a hallucinated handle for a KNOWN product but wrong collection list is still rejected', () => {
    const config = { sections: { 'feat-1': { type: 'featured-collection', settings: { collection: 'made-up-collection' } } }, order: ['feat-1'] };
    const result = validateDataReferences(config, schemas, { knownMerchantData: { collections: ['best-sellers'] } });
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(codesOf(result), [ERROR_CODES.DATA_REFERENCE_HALLUCINATED]);
});

// ---------------------------------------------------------------------------
// validateThemeCompatibility() — §20/§21, informational-only boundary
// ---------------------------------------------------------------------------

test('validateThemeCompatibility() — with no ThemeState, returns a trivially valid empty result', () => {
    const result = validateThemeCompatibility(null, 'index');
    assert.deepStrictEqual(result, { valid: true, errors: [], warnings: [] });
});

test('validateThemeCompatibility() — against the REAL theme, never blocks (valid:true) and surfaces unknown-component context as warnings only', async () => {
    const themeState = await buildThemeState();
    const result = validateThemeCompatibility(themeState, 'index');
    assert.strictEqual(result.valid, true, 'compatibility checks must never block generation (§21)');
    assert.deepStrictEqual(result.errors, []);
    // The real theme's index template is known (per PHASE4_REPORT.md) to
    // contain sections the AI schema catalog doesn't recognize — this must
    // surface as context, not an error.
    if (themeState.templates.index) {
        assert.ok(Array.isArray(result.warnings));
    }
});

// ---------------------------------------------------------------------------
// validateCandidate() — orchestrator, the actual gap-closing behavior
// ---------------------------------------------------------------------------

test('validateCandidate() — accepts a fully well-formed real-schema candidate end to end', () => {
    const config = {
        sections: {
            'hero-1': {
                type: 'slideshow',
                settings: { visibility: 'always-display', slide_height: 'medium', slider_visual: 'dots', auto_rotate: 'true', show_text_below: 'false' },
                blocks: { 's1': { type: 'slide', settings: { image: '' } }, 's2': { type: 'slide', settings: { image: '' } } },
                block_order: ['s1', 's2']
            },
            'testimonials-1': {
                type: 'testimonials',
                settings: {},
                blocks: { 'col-1': { type: 'column', settings: {} }, 'col-2': { type: 'column', settings: {} }, 'col-3': { type: 'column', settings: {} } },
                block_order: ['col-1', 'col-2', 'col-3']
            }
        },
        order: ['hero-1', 'testimonials-1']
    };
    const result = validateCandidate(config, schemas, { templateName: 'index' });
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateCandidate() — GAP CLOSED (was open through Phase 5, see test/validateOutput.test.js\'s KNOWN GAP test): a hallucinated product_picker handle IS now rejected by this layer', () => {
    const config = {
        sections: {
            'collage-1': {
                type: 'collage', settings: {},
                blocks: { 'prod-1': { type: 'product', settings: { product: 'a-completely-invented-handle' } } },
                block_order: ['prod-1']
            }
        },
        order: ['collage-1']
    };
    const result = validateCandidate(config, schemas, { templateName: 'index' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.code === ERROR_CODES.DATA_REFERENCE_HALLUCINATED));
});

test('validateCandidate() — GAP CLOSED: allowed_on is now enforced against templateName (main-product forced onto index)', () => {
    const config = { sections: { 'main-1': { type: 'main-product', settings: {} } }, order: ['main-1'] };
    const result = validateCandidate(config, schemas, { templateName: 'index' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.code === ERROR_CODES.SECTION_NOT_ALLOWED_ON_TEMPLATE));
});

test('validateCandidate() — aggregates findings from every layer at once (not fail-fast on the first one)', () => {
    const config = {
        sections: {
            'main-1': { type: 'main-product', settings: { totally_bogus: 'x' } }
        },
        order: ['main-1']
    };
    const result = validateCandidate(config, schemas, { templateName: 'index' });
    assert.strictEqual(result.valid, false);
    const codes = new Set(codesOf(result));
    assert.ok(codes.has(ERROR_CODES.SECTION_NOT_ALLOWED_ON_TEMPLATE));
    assert.ok(codes.has(ERROR_CODES.SETTING_UNKNOWN));
});

test('validateCandidate() — defaults templateName to "index" when not provided', () => {
    const config = { sections: { 'hero-1': { type: 'slideshow', settings: {} } }, order: ['hero-1'] };
    const result = validateCandidate(config, schemas, {});
    assert.strictEqual(result.valid, true);
});
