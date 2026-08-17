/**
 * Phase 8 tests for operations.js — the deterministic operation contract,
 * target resolution, validation, execution, and atomic multi-operation
 * runner. Uses real schemas (via loadSchemas()) and hand-built
 * ThemeState-shaped fixtures — same convention as test/merge.test.js (plain
 * JSON, no file I/O needed to exercise this logic; theme-state.js's own
 * tests already cover buildThemeState() against the real theme).
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas } = require('../example-implementation');
const {
    OPERATION_ERROR_CODES,
    generateOperationId,
    resolveSectionTarget,
    resolveBlockTarget,
    validateOperation,
    applyOperationToThemeState,
    validateOperationOrder,
    applyOperationsToThemeState,
    dryRunOperations
} = require('../operations');

let schemas;

test.before(async () => {
    schemas = await loadSchemas();
});

function themeState(templates, globalSettings = null) {
    return {
        themeId: 'test', sourcePath: '/fake', schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        templates, globalSettings,
        meta: { unparseableTemplates: [], globalSettingsError: null }
    };
}

function baseIndexTemplate() {
    return {
        sourceFile: 'templates/index.json',
        raw: {
            sections: {
                'hero-1': { type: 'slideshow', settings: {}, blocks: { 'slide-1': { type: 'slide', settings: { heading: 'Old heading' }, decorative_prop: 'keep-me' } }, block_order: ['slide-1'] },
                'testi-1': { type: 'testimonials', settings: {}, blocks: { 'col-1': { type: 'column', settings: {} } }, block_order: ['col-1'] }
            },
            order: ['hero-1', 'testi-1']
        }
    };
}

function codesOf(errors) { return errors.map(e => e.code); }

// ---------------------------------------------------------------------------
// generateOperationId()
// ---------------------------------------------------------------------------

test('generateOperationId() — deterministic, human-readable, stable for the same operation shape', () => {
    const op = { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' } };
    assert.strictEqual(generateOperationId(op), 'update_section:index:hero-1');
    assert.strictEqual(generateOperationId(op), generateOperationId({ ...op }));
});

// ---------------------------------------------------------------------------
// resolveSectionTarget() — §8/§9/§23
// ---------------------------------------------------------------------------

test('resolveSectionTarget() — exact section id resolves directly', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = resolveSectionTarget(ts, 'index', 'hero-1', schemas);
    assert.strictEqual(result.status, 'RESOLVED');
    assert.strictEqual(result.sectionId, 'hero-1');
});

test('resolveSectionTarget() — natural-language query matches via schema category (slideshow.json category: "hero")', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = resolveSectionTarget(ts, 'index', 'hero', schemas);
    assert.strictEqual(result.status, 'RESOLVED');
    assert.strictEqual(result.sectionId, 'hero-1');
});

test('resolveSectionTarget() — no match returns NOT_FOUND, never guesses', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    assert.strictEqual(resolveSectionTarget(ts, 'index', 'nonexistent-widget-xyz', schemas).status, 'NOT_FOUND');
    assert.strictEqual(resolveSectionTarget(ts, 'index', '', schemas).status, 'NOT_FOUND');
});

test('resolveSectionTarget() — missing template returns NOT_FOUND', () => {
    const ts = themeState({});
    assert.strictEqual(resolveSectionTarget(ts, 'index', 'hero', schemas).status, 'NOT_FOUND');
});

test('resolveSectionTarget() — CRITICAL SAFETY: tied candidates return AMBIGUOUS with all tied candidates, never an arbitrary pick', () => {
    const template = baseIndexTemplate();
    template.raw.sections['hero-2'] = { type: 'slideshow', settings: {} };
    template.raw.order.push('hero-2');
    const ts = themeState({ index: template });

    const result = resolveSectionTarget(ts, 'index', 'slideshow', schemas);
    assert.strictEqual(result.status, 'AMBIGUOUS');
    assert.strictEqual(result.candidates.length, 2);
    assert.deepStrictEqual(result.candidates.map(c => c.sectionId).sort(), ['hero-1', 'hero-2']);
});

// ---------------------------------------------------------------------------
// resolveBlockTarget()
// ---------------------------------------------------------------------------

test('resolveBlockTarget() — exact id, natural-language match, ambiguous tie, not found', () => {
    const section = baseIndexTemplate().raw.sections['hero-1'];
    assert.strictEqual(resolveBlockTarget(section, 'slide-1', schemas).status, 'RESOLVED');
    assert.strictEqual(resolveBlockTarget(section, 'slide', schemas).status, 'RESOLVED');
    assert.strictEqual(resolveBlockTarget(section, 'nonexistent', schemas).status, 'NOT_FOUND');

    const tiedSection = { blocks: { 's1': { type: 'slide' }, 's2': { type: 'slide' } } };
    const ambiguous = resolveBlockTarget(tiedSection, 'slide', schemas);
    assert.strictEqual(ambiguous.status, 'AMBIGUOUS');
    assert.strictEqual(ambiguous.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// validateOperation() — §13/§14/§15/§34
// ---------------------------------------------------------------------------

function validCtx(ts) { return { themeState: ts, schemas, knownMerchantData: {} }; }

test('validateOperation() — rejects an unsupported operation type', () => {
    const result = validateOperation({ operation: 'delete_everything', target: { templateName: 'index' } }, validCtx(themeState({})));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_INVALID);
});

test('validateOperation() — update_section: valid target + valid settings accepted', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateOperation() — update_section: nonexistent target rejected', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'update_section', target: { templateName: 'index', sectionId: 'ghost' }, changes: { settings: { x: 1 } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND);
});

test('validateOperation() — update_section: invalid enum setting value rejected', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'sometimes' } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_SETTING_INVALID);
});

test('validateOperation() — update_section: empty changes.settings rejected (must change at least one thing)', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: {} }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_INVALID);
});

test('validateOperation() — remove_section: valid target accepted, missing target rejected', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    assert.strictEqual(validateOperation({ operation: 'remove_section', target: { templateName: 'index', sectionId: 'hero-1' } }, validCtx(ts)).valid, true);
    const missing = validateOperation({ operation: 'remove_section', target: { templateName: 'index', sectionId: 'ghost' } }, validCtx(ts));
    assert.strictEqual(missing.valid, false);
    assert.strictEqual(missing.errors[0].code, OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND);
});

test('validateOperation() — add_section: valid supported type + allowed_on accepted', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'collage' } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateOperation() — add_section: unknown type rejected', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'premium-pet-review-widget' } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_SECTION_NOT_ALLOWED);
});

test('validateOperation() — add_section: real type not allowed on this template rejected (main-product, allowed_on: ["product"], onto index)', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'main-product' } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_SECTION_NOT_ALLOWED);
});

test('validateOperation() — add_block: valid supported block accepted', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'add_block', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { type: 'slide' } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateOperation() — add_block: disallowed block type for the parent section rejected', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    // "column" is real but not in slideshow's allowed_blocks (["slide"]).
    const result = validateOperation({ operation: 'add_block', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { type: 'column' } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_BLOCK_NOT_ALLOWED);
});

test('validateOperation() — add_block: max_blocks enforced (collage max_blocks: 3)', () => {
    const template = {
        sourceFile: 'templates/index.json',
        raw: { sections: { 'collage-1': { type: 'collage', settings: {}, blocks: { i1: { type: 'image', settings: {} }, i2: { type: 'image', settings: {} }, i3: { type: 'image', settings: {} } }, block_order: ['i1', 'i2', 'i3'] } }, order: ['collage-1'] }
    };
    const ts = themeState({ index: template });
    const result = validateOperation({ operation: 'add_block', target: { templateName: 'index', sectionId: 'collage-1' }, changes: { type: 'image' } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_MAX_BLOCKS_EXCEEDED);
});

test('validateOperation() — update_block: valid + invalid target', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    assert.strictEqual(validateOperation({ operation: 'update_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'slide-1' }, changes: { settings: { heading: 'New heading' } } }, validCtx(ts)).valid, true);
    const missing = validateOperation({ operation: 'update_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'ghost' }, changes: { settings: { heading: 'x' } } }, validCtx(ts));
    assert.strictEqual(missing.valid, false);
    assert.strictEqual(missing.errors[0].code, OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND);
});

test('validateOperation() — remove_block: valid + invalid target', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    assert.strictEqual(validateOperation({ operation: 'remove_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'slide-1' } }, validCtx(ts)).valid, true);
    assert.strictEqual(validateOperation({ operation: 'remove_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'ghost' } }, validCtx(ts)).valid, false);
});

test('validateOperation() — data-reference hallucination guard rejects an invented product handle on a block update', () => {
    const template = { sourceFile: 'templates/index.json', raw: { sections: { 'collage-1': { type: 'collage', settings: {}, blocks: { p1: { type: 'product', settings: { product: '' } } }, block_order: ['p1'] } }, order: ['collage-1'] } };
    const ts = themeState({ index: template });
    const result = validateOperation({ operation: 'update_block', target: { templateName: 'index', sectionId: 'collage-1', blockId: 'p1' }, changes: { settings: { product: 'a-completely-invented-handle' } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_DATA_REFERENCE_INVALID);
});

test('validateOperation() — data-reference guard accepts a handle present in knownMerchantData', () => {
    const template = { sourceFile: 'templates/index.json', raw: { sections: { 'collage-1': { type: 'collage', settings: {}, blocks: { p1: { type: 'product', settings: { product: '' } } }, block_order: ['p1'] } }, order: ['collage-1'] } };
    const ts = themeState({ index: template });
    const result = validateOperation({ operation: 'update_block', target: { templateName: 'index', sectionId: 'collage-1', blockId: 'p1' }, changes: { settings: { product: 'real-handle' } } }, { themeState: ts, schemas, knownMerchantData: { products: ['real-handle'] } });
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
});

test('validateOperation() — update_global_settings: valid key accepted, unknown key rejected', () => {
    const ts = themeState({}, { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#000000' }, presets: {}, platform_customizations: {} } });
    assert.strictEqual(validateOperation({ operation: 'update_global_settings', changes: { settings: { colors_accent_1: '#ffffff' } } }, validCtx(ts)).valid, true);
    const bad = validateOperation({ operation: 'update_global_settings', changes: { settings: { totally_made_up: 'x' } } }, validCtx(ts));
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.errors[0].code, OPERATION_ERROR_CODES.OPERATION_SETTING_INVALID);
});

test('validateOperation() — requires target.templateName for template-scoped operations', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = validateOperation({ operation: 'update_section', target: { sectionId: 'hero-1' }, changes: { settings: { x: 1 } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_INVALID);
});

// ---------------------------------------------------------------------------
// applyOperationToThemeState() — §18/§19/§25, single operation
// ---------------------------------------------------------------------------

test('applyOperationToThemeState() — update_section changes only the targeted settings, preserves everything else including unrelated sections/templates', () => {
    const ts = themeState({ index: baseIndexTemplate(), product: { sourceFile: 'templates/product.json', raw: { sections: { main: { type: 'main-product', settings: {} } }, order: ['main'] } } });
    const before = JSON.parse(JSON.stringify(ts));

    const result = applyOperationToThemeState(ts, { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }, validCtx(ts));

    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    assert.deepStrictEqual(ts, before, 'input ThemeState must not be mutated');
    const newHero = result.themeState.templates.index.raw.sections['hero-1'];
    assert.deepStrictEqual(newHero.settings, { auto_rotate: 'true' });
    assert.deepStrictEqual(newHero.blocks, before.templates.index.raw.sections['hero-1'].blocks, 'blocks must be untouched by a settings-only update');
    assert.deepStrictEqual(result.themeState.templates.index.raw.sections['testi-1'], before.templates.index.raw.sections['testi-1']);
    assert.deepStrictEqual(result.themeState.templates.product, before.templates.product);
    assert.deepStrictEqual(result.changeSummary.changed, ['settings.auto_rotate']);
});

test('applyOperationToThemeState() — update_block preserves unknown properties on the block and unrelated blocks in the same section', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationToThemeState(ts, { operation: 'update_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'slide-1' }, changes: { settings: { heading: 'New heading' } } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    const block = result.themeState.templates.index.raw.sections['hero-1'].blocks['slide-1'];
    assert.strictEqual(block.settings.heading, 'New heading');
    assert.strictEqual(block.decorative_prop, 'keep-me', 'unknown property on the block must survive');
});

test('applyOperationToThemeState() — remove_section removes from both sections and order', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationToThemeState(ts, { operation: 'remove_section', target: { templateName: 'index', sectionId: 'testi-1' } }, validCtx(ts));
    assert.strictEqual(result.valid, true);
    assert.ok(!result.themeState.templates.index.raw.sections['testi-1']);
    assert.ok(!result.themeState.templates.index.raw.order.includes('testi-1'));
    assert.deepStrictEqual(result.themeState.templates.index.raw.sections['hero-1'], ts.templates.index.raw.sections['hero-1']);
});

test('applyOperationToThemeState() — add_section generates a deterministic id and appends to order by default', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationToThemeState(ts, { operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'collage' } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    assert.ok(result.themeState.templates.index.raw.sections['collage-1']);
    assert.strictEqual(result.themeState.templates.index.raw.order.at(-1), 'collage-1');
});

test('applyOperationToThemeState() — add_block generates a deterministic id, respects position, preserves the existing block', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationToThemeState(ts, { operation: 'add_block', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { type: 'slide', position: 'start' } }, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    const section = result.themeState.templates.index.raw.sections['hero-1'];
    // hero-1 already has "slide-1" — the next deterministic id is "slide-2".
    assert.ok(section.blocks['slide-2']);
    assert.deepStrictEqual(section.blocks['slide-1'], ts.templates.index.raw.sections['hero-1'].blocks['slide-1'], 'the pre-existing block must be untouched');
    assert.deepStrictEqual(section.block_order, ['slide-2', 'slide-1'], 'position: "start" must insert before the existing block');
});

test('applyOperationToThemeState() — remove_block removes from blocks and block_order, preserves the rest of the section', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationToThemeState(ts, { operation: 'remove_block', target: { templateName: 'index', sectionId: 'hero-1', blockId: 'slide-1' } }, validCtx(ts));
    assert.strictEqual(result.valid, true);
    const section = result.themeState.templates.index.raw.sections['hero-1'];
    assert.deepStrictEqual(section.blocks, {});
    assert.deepStrictEqual(section.block_order, []);
});

test('applyOperationToThemeState() — update_global_settings preserves unrelated settings/presets (reuses merge.js\'s mergeGlobalSettingsChanges)', () => {
    const ts = themeState({}, { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#000000', unrelated: 'keep' }, presets: { Default: {} }, platform_customizations: {} } });
    const result = applyOperationToThemeState(ts, { operation: 'update_global_settings', changes: { settings: { colors_accent_1: '#ffffff' } } }, validCtx(ts));
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.themeState.globalSettings.raw.current.colors_accent_1, '#ffffff');
    assert.strictEqual(result.themeState.globalSettings.raw.current.unrelated, 'keep');
    assert.deepStrictEqual(result.themeState.globalSettings.raw.presets, { Default: {} });
});

test('applyOperationToThemeState() — an invalid operation mutates nothing and returns themeState: null', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const before = JSON.parse(JSON.stringify(ts));
    const result = applyOperationToThemeState(ts, { operation: 'update_section', target: { templateName: 'index', sectionId: 'ghost' }, changes: { settings: { x: 1 } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.themeState, null);
    assert.deepStrictEqual(ts, before);
});

test('applyOperationToThemeState() — post-operation ThemeState validation catches a PRE-EXISTING structural problem elsewhere in the state (§25 — not skipped just because the operation itself is valid)', () => {
    const ts = themeState({
        index: baseIndexTemplate(),
        broken: { sourceFile: 'templates/broken.json', raw: { sections: {}, order: ['ghost-section'] } } // pre-existing, unrelated structural break
    });
    const result = applyOperationToThemeState(ts, { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_CONFLICT);
});

// ---------------------------------------------------------------------------
// validateOperationOrder() / applyOperationsToThemeState() — §20/§21 atomicity
// ---------------------------------------------------------------------------

test('validateOperationOrder() — remove-then-update on the same target is invalid; unrelated sequences are fine', () => {
    const bad = validateOperationOrder([
        { operation: 'remove_section', target: { templateName: 'index', sectionId: 'hero-1' } },
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { x: 1 } } }
    ]);
    assert.strictEqual(bad.length, 1);
    assert.strictEqual(bad[0].code, OPERATION_ERROR_CODES.OPERATION_ORDER_INVALID);

    const ok = validateOperationOrder([
        { operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'collage' } },
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { x: 1 } } }
    ]);
    assert.deepStrictEqual(ok, []);
});

test('applyOperationsToThemeState() — a valid sequence (add_section then update the newly added, predictable, section) succeeds atomically', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const operations = [
        { operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'collage' } },
        // "collage-1" is deterministically predictable: no existing "collage-*" section in the fixture.
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'collage-1' }, changes: { settings: { title: '<p>Hi</p>' } } }
    ];
    const result = applyOperationsToThemeState(ts, operations, validCtx(ts));
    assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
    assert.strictEqual(result.changeSummaries.length, 2);
    assert.deepStrictEqual(result.themeState.templates.index.raw.sections['collage-1'].settings, { title: '<p>Hi</p>' });
});

test('applyOperationsToThemeState() — an invalid operation anywhere in the batch rejects the WHOLE batch and leaves the original untouched', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const before = JSON.parse(JSON.stringify(ts));
    const operations = [
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } },
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'ghost' }, changes: { settings: { x: 1 } } }
    ];
    const result = applyOperationsToThemeState(ts, operations, validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.themeState, null);
    assert.deepStrictEqual(ts, before, 'original ThemeState must remain completely untouched after a rolled-back batch');
});

test('applyOperationsToThemeState() — remove-then-update ordering violation is rejected up front, before any execution', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const before = JSON.parse(JSON.stringify(ts));
    const result = applyOperationsToThemeState(ts, [
        { operation: 'remove_section', target: { templateName: 'index', sectionId: 'hero-1' } },
        { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { x: 1 } } }
    ], validCtx(ts));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors[0].code, OPERATION_ERROR_CODES.OPERATION_ORDER_INVALID);
    assert.deepStrictEqual(ts, before);
});

test('applyOperationsToThemeState() — rejects an empty operations array', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const result = applyOperationsToThemeState(ts, [], validCtx(ts));
    assert.strictEqual(result.valid, false);
});

// ---------------------------------------------------------------------------
// dryRunOperations() — §36
// ---------------------------------------------------------------------------

test('dryRunOperations() — reports the outcome without exposing raw execution internals differently than the real run', () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const report = dryRunOperations(ts, [{ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }], validCtx(ts));
    assert.strictEqual(report.wouldApply, true);
    assert.strictEqual(report.changeSummaries.length, 1);
});
