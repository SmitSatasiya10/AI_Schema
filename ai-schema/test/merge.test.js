/**
 * Phase 7 tests for merge.js — the pure, non-writing half of merge/apply
 * safety. Uses real schemas (validateCandidate() evidence) and hand-built
 * ThemeState-shaped fixtures (ThemeState itself is just plain JSON — see
 * theme-state.js — so building one directly here, rather than reading real
 * files, keeps these tests focused and independent of live theme content;
 * theme-state.js's OWN tests already cover buildThemeState() against the
 * real theme).
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas } = require('../example-implementation');
const { validateOutput } = require('../example-implementation');
const { validateCandidate } = require('../validation');
const {
    MERGE_ERROR_CODES,
    mergeGlobalSettingsChanges,
    mergeThemeState,
    dryRunMerge
} = require('../merge');

let schemas;

test.before(async () => {
    schemas = await loadSchemas();
});

function buildValidCandidateValidation(templateName, config) {
    const output = validateOutput(JSON.stringify(config), schemas);
    assert.strictEqual(output.valid, true, `test fixture candidate must itself be valid: ${output.error}`);
    const candidateValidation = validateCandidate(output.config, schemas, { templateName });
    assert.strictEqual(candidateValidation.valid, true, `test fixture candidate must pass Phase 6 validation: ${JSON.stringify(candidateValidation.errors)}`);
    return candidateValidation;
}

function themeState(templates, globalSettings) {
    return {
        themeId: 'test',
        sourcePath: '/fake/theme',
        schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        templates,
        globalSettings
    };
}

function classify(sections) {
    // sections: {id: {type, knownToAI}}
    return { sections: Object.fromEntries(Object.entries(sections).map(([id, s]) => [id, { type: s.type, knownToAI: s.knownToAI, blockCount: 0, blocks: {} }])) };
}

// ---------------------------------------------------------------------------
// mergeGlobalSettingsChanges() — §14, targeted settings merge
// ---------------------------------------------------------------------------

test('mergeGlobalSettingsChanges() — only touches the given keys, preserves everything else including unknown keys', () => {
    const existing = { current: { colors_accent_1: '#000000', some_unrelated_app_setting: 'keep-me' }, presets: { Default: { a: 1 } }, platform_customizations: { custom_css: ['a'] } };
    const { mergedRaw, changedKeys } = mergeGlobalSettingsChanges(existing, { colors_accent_1: '#ffffff' });
    assert.strictEqual(mergedRaw.current.colors_accent_1, '#ffffff');
    assert.strictEqual(mergedRaw.current.some_unrelated_app_setting, 'keep-me');
    assert.deepStrictEqual(mergedRaw.presets, existing.presets);
    assert.deepStrictEqual(mergedRaw.platform_customizations, existing.platform_customizations);
    assert.deepStrictEqual(changedKeys, ['colors_accent_1']);
});

test('mergeGlobalSettingsChanges() — no changes given returns the existing object untouched, no false positives in changedKeys', () => {
    const existing = { current: { colors_accent_1: '#000000' }, presets: {}, platform_customizations: {} };
    const { changedKeys } = mergeGlobalSettingsChanges(existing, null);
    assert.deepStrictEqual(changedKeys, []);
    const { changedKeys: sameValue } = mergeGlobalSettingsChanges(existing, { colors_accent_1: '#000000' });
    assert.deepStrictEqual(sameValue, [], 'setting to the same value it already has should not count as changed');
});

test('mergeGlobalSettingsChanges() — does not mutate the existing object', () => {
    const existing = { current: { colors_accent_1: '#000000' }, presets: {}, platform_customizations: {} };
    mergeGlobalSettingsChanges(existing, { colors_accent_1: '#ffffff' });
    assert.strictEqual(existing.current.colors_accent_1, '#000000');
});

// ---------------------------------------------------------------------------
// mergeThemeState() — fail-closed preconditions (§8)
// ---------------------------------------------------------------------------

test('mergeThemeState() — fails closed without candidateValidation evidence', () => {
    const result = mergeThemeState(themeState({}, null), {
        templateName: 'index',
        candidate: { sections: {}, order: [] }
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.conflicts[0].code, MERGE_ERROR_CODES.MERGE_INVALID_TARGET);
});

test('mergeThemeState() — fails closed when candidateValidation.valid is false', () => {
    const result = mergeThemeState(themeState({}, null), {
        templateName: 'index',
        candidate: { sections: { a: { type: 'slideshow', settings: {} } }, order: ['a'] },
        candidateValidation: { valid: false, errors: [{ code: 'X', message: 'bad' }] }
    });
    assert.strictEqual(result.valid, false);
});

test('mergeThemeState() — requires templateName and a well-shaped candidate', () => {
    const cv = buildValidCandidateValidation('index', { sections: { 'hero-1': { type: 'slideshow', settings: {} } }, order: ['hero-1'] });
    assert.strictEqual(mergeThemeState(themeState({}, null), { candidate: { sections: {}, order: [] }, candidateValidation: cv }).valid, false);
    assert.strictEqual(mergeThemeState(themeState({}, null), { templateName: 'index', candidateValidation: cv }).valid, false);
});

// ---------------------------------------------------------------------------
// Full-structure template policy (e.g. "index") — §11/§18
// ---------------------------------------------------------------------------

const INDEX_CANDIDATE = {
    sections: {
        'hero-1': { type: 'slideshow', settings: {}, blocks: { s1: { type: 'slide', settings: { image: '' } } }, block_order: ['s1'] },
        'testi-1': { type: 'testimonials', settings: {}, blocks: {}, block_order: [] }
    },
    order: ['hero-1', 'testi-1']
};

test('mergeThemeState() — full-structure template: does not mutate the input ThemeState', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const existing = themeState({
        index: { sourceFile: 'templates/index.json', raw: { sections: { old1: { type: 'slideshow', settings: {} } }, order: ['old1'] }, classification: classify({ old1: { type: 'slideshow', knownToAI: true } }) }
    }, { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#111111' }, presets: {}, platform_customizations: {} } });
    const before = JSON.parse(JSON.stringify(existing));

    mergeThemeState(existing, { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.deepStrictEqual(existing, before);
});

test('mergeThemeState() — full-structure template: does not mutate the candidate', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const candidateCopy = JSON.parse(JSON.stringify(INDEX_CANDIDATE));
    const before = JSON.parse(JSON.stringify(candidateCopy));
    mergeThemeState(themeState({}, null), { templateName: 'index', candidate: candidateCopy, candidateValidation: cv });
    assert.deepStrictEqual(candidateCopy, before);
});

test('mergeThemeState() — full-structure template replaces sections/order with the candidate, all previous (known) sections become removedSections', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const existing = themeState({
        index: { sourceFile: 'templates/index.json', raw: { sections: { old1: { type: 'slideshow', settings: {} } }, order: ['old1'] }, classification: classify({ old1: { type: 'slideshow', knownToAI: true } }) }
    }, null);

    const result = mergeThemeState(existing, { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true, JSON.stringify(result.conflicts));
    assert.deepStrictEqual(result.mergedThemeState.templates.index.raw, INDEX_CANDIDATE);
    assert.deepStrictEqual(result.summary.addedSections.sort(), ['hero-1', 'testi-1']);
    assert.deepStrictEqual(result.summary.removedSections, ['old1']);
    assert.deepStrictEqual(result.summary.updatedSections, []);
    assert.strictEqual(result.summary.preservedUnknownComponents.length, 0);
});

test('mergeThemeState() — full-structure template: UNRELATED templates and untouched global settings are preserved byte-for-byte', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const productTemplate = { sourceFile: 'templates/product.json', raw: { sections: { main: { type: 'main-product', settings: {} } }, order: ['main'] }, classification: classify({ main: { type: 'main-product', knownToAI: true } }) };
    const existing = themeState(
        { index: { sourceFile: 'templates/index.json', raw: { sections: {}, order: [] }, classification: classify({}) }, product: productTemplate },
        { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#111111', unrelated_app_setting: 'keep' }, presets: {}, platform_customizations: {} } }
    );

    const result = mergeThemeState(existing, { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.mergedThemeState.templates.product, productTemplate);
    assert.deepStrictEqual(result.mergedThemeState.globalSettings.raw.current, existing.globalSettings.raw.current);
    assert.deepStrictEqual(result.summary.changedFiles, ['templates/index.json']);
});

test('mergeThemeState() — full-structure template FAILS CLOSED when it would silently discard existing sections unknown to the AI schema catalog', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const existing = themeState({
        index: { sourceFile: 'templates/index.json', raw: { sections: { mystery: { type: 'colors-changer', settings: {} } }, order: ['mystery'] }, classification: classify({ mystery: { type: 'colors-changer', knownToAI: false } }) }
    }, null);

    const result = mergeThemeState(existing, { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, false);
    assert.ok(result.conflicts.some(c => c.code === MERGE_ERROR_CODES.MERGE_UNSAFE_REPLACEMENT));
});

test('mergeThemeState() — the same replacement succeeds once explicitly acknowledged', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const existing = themeState({
        index: { sourceFile: 'templates/index.json', raw: { sections: { mystery: { type: 'colors-changer', settings: {} } }, order: ['mystery'] }, classification: classify({ mystery: { type: 'colors-changer', knownToAI: false } }) }
    }, null);

    const result = mergeThemeState(existing, { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv, acknowledgeUnknownSectionReplacement: true });
    assert.strictEqual(result.valid, true, JSON.stringify(result.conflicts));
});

test('mergeThemeState() — full-structure template: a missing target template is created fresh, not an error', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const result = mergeThemeState(themeState({}, null), { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.mergedThemeState.templates.index.raw, INDEX_CANDIDATE);
});

test('mergeThemeState() — MERGE_DUPLICATE_ID rejects a candidate whose order lists the same id twice', () => {
    const dup = { sections: { a: { type: 'slideshow', settings: {} } }, order: ['a', 'a'] };
    // Bypass buildValidCandidateValidation (a duplicate order wouldn't build a
    // real valid candidate anyway) — construct fake-but-plausible evidence to
    // isolate this specific merge-level check.
    const cv = { valid: true, errors: [] };
    const result = mergeThemeState(themeState({}, null), { templateName: 'index', candidate: dup, candidateValidation: cv });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.conflicts[0].code, MERGE_ERROR_CODES.MERGE_DUPLICATE_ID);
});

// ---------------------------------------------------------------------------
// Forced-exclusive-section template policy (e.g. "product") — §10/§16/§17,
// generalizing the existing mergeProductTemplate() pattern.
// ---------------------------------------------------------------------------

const PRODUCT_CANDIDATE = {
    sections: { main: { type: 'main-product', settings: {}, blocks: { t1: { type: 'product_title', settings: {} } }, block_order: ['t1'] } },
    order: ['main']
};

test('mergeThemeState() — forced-exclusive template: splices into an EXISTING same-type section by type match, preserving unrelated sections and unknown section properties', () => {
    const cv = buildValidCandidateValidation('product', PRODUCT_CANDIDATE);
    const existing = themeState({
        product: {
            sourceFile: 'templates/product.json',
            raw: {
                sections: {
                    'colors_changer_7arBdR': { type: 'colors-changer', settings: { foo: 'bar' } },
                    'main': { type: 'main-product', settings: { old: true }, theme_specific_property: 'keep-me', blocks: { old_block: { type: 'product_price', settings: {} } }, block_order: ['old_block'] },
                    'results_aVyfVq': { type: 'results', settings: {} }
                },
                order: ['colors_changer_7arBdR', 'main', 'results_aVyfVq']
            },
            classification: classify({
                colors_changer_7arBdR: { type: 'colors-changer', knownToAI: false },
                main: { type: 'main-product', knownToAI: true },
                results_aVyfVq: { type: 'results', knownToAI: false }
            })
        }
    }, null);

    const result = mergeThemeState(existing, { templateName: 'product', candidate: PRODUCT_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true, JSON.stringify(result.conflicts));

    const mergedRaw = result.mergedThemeState.templates.product.raw;
    // Unrelated sections (including unknown ones) untouched, same order.
    assert.deepStrictEqual(mergedRaw.sections['colors_changer_7arBdR'], { type: 'colors-changer', settings: { foo: 'bar' } });
    assert.deepStrictEqual(mergedRaw.sections['results_aVyfVq'], { type: 'results', settings: {} });
    assert.deepStrictEqual(mergedRaw.order, ['colors_changer_7arBdR', 'main', 'results_aVyfVq']);
    // Targeted section: candidate owns type/blocks/block_order outright...
    // settings is a SPREAD, not a replace — the candidate contributes no
    // keys here, so the pre-existing "old: true" setting must survive (a
    // full replace would silently wipe merchant-set settings the candidate
    // doesn't know about — see merge.js's mergeForcedExclusiveTemplate()).
    assert.deepStrictEqual(mergedRaw.sections.main.settings, { old: true });
    assert.deepStrictEqual(mergedRaw.sections.main.blocks, { t1: { type: 'product_title', settings: {} } });
    // ...but an unknown property on that same section survives (§13).
    assert.strictEqual(mergedRaw.sections.main.theme_specific_property, 'keep-me');

    assert.deepStrictEqual(result.summary.updatedSections, ['main']);
    assert.deepStrictEqual(result.summary.addedSections, []);
    assert.deepStrictEqual(result.summary.removedSections, []);
    assert.ok(result.summary.preservedUnknownComponents.includes('colors_changer_7arBdR'));
    assert.ok(result.summary.preservedUnknownComponents.includes('results_aVyfVq'));
});

test('mergeThemeState() — forced-exclusive template: no existing match creates a new "main" section, preserving everything else', () => {
    const cv = buildValidCandidateValidation('product', PRODUCT_CANDIDATE);
    const existing = themeState({
        product: {
            sourceFile: 'templates/product.json',
            raw: { sections: { 'results_aVyfVq': { type: 'results', settings: {} } }, order: ['results_aVyfVq'] },
            classification: classify({ results_aVyfVq: { type: 'results', knownToAI: false } })
        }
    }, null);

    const result = mergeThemeState(existing, { templateName: 'product', candidate: PRODUCT_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true);
    const mergedRaw = result.mergedThemeState.templates.product.raw;
    assert.ok(mergedRaw.sections.main);
    assert.deepStrictEqual(mergedRaw.sections['results_aVyfVq'], { type: 'results', settings: {} });
    assert.deepStrictEqual(mergedRaw.order, ['main', 'results_aVyfVq']);
    assert.deepStrictEqual(result.summary.addedSections, ['main']);
});

test('mergeThemeState() — forced-exclusive template: missing target template is created fresh with just the one section', () => {
    const cv = buildValidCandidateValidation('product', PRODUCT_CANDIDATE);
    const result = mergeThemeState(themeState({}, null), { templateName: 'product', candidate: PRODUCT_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.mergedThemeState.templates.product.raw.order, ['main']);
});

test('mergeThemeState() — forced-exclusive template: MERGE_SECTION_TYPE_CONFLICT when the existing template ambiguously has TWO sections of the forced type', () => {
    const cv = buildValidCandidateValidation('product', PRODUCT_CANDIDATE);
    const existing = themeState({
        product: {
            sourceFile: 'templates/product.json',
            raw: { sections: { a: { type: 'main-product', settings: {} }, b: { type: 'main-product', settings: {} } }, order: ['a', 'b'] },
            classification: classify({ a: { type: 'main-product', knownToAI: true }, b: { type: 'main-product', knownToAI: true } })
        }
    }, null);
    const result = mergeThemeState(existing, { templateName: 'product', candidate: PRODUCT_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.conflicts[0].code, MERGE_ERROR_CODES.MERGE_SECTION_TYPE_CONFLICT);
});

test('mergeThemeState() — forced-exclusive template: MERGE_INVALID_TARGET when the candidate does not match the single-forced-section shape', () => {
    const badCandidate = { sections: { a: { type: 'main-product', settings: {} }, b: { type: 'main-product', settings: {} } }, order: ['a', 'b'] };
    const cv = { valid: true, errors: [] };
    const result = mergeThemeState(themeState({}, null), { templateName: 'product', candidate: badCandidate, candidateValidation: cv });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.conflicts[0].code, MERGE_ERROR_CODES.MERGE_INVALID_TARGET);
});

// ---------------------------------------------------------------------------
// Global settings integration in mergeThemeState()
// ---------------------------------------------------------------------------

test('mergeThemeState() — global settings changes are merged, unrelated/unknown settings preserved, reflected in changedFiles/changedSettings', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const existing = themeState(
        {},
        { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#000000', unrelated: 'keep' }, presets: {}, platform_customizations: {} } }
    );
    const result = mergeThemeState(existing, {
        templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv,
        globalSettingsChanges: { colors_accent_1: '#ffffff' }
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.mergedThemeState.globalSettings.raw.current.colors_accent_1, '#ffffff');
    assert.strictEqual(result.mergedThemeState.globalSettings.raw.current.unrelated, 'keep');
    assert.ok(result.summary.changedFiles.includes('config/settings_data.json'));
    assert.deepStrictEqual(result.summary.changedSettings, ['colors_accent_1']);
});

test('mergeThemeState() — no globalSettingsChanges means settings_data.json is not listed as a changed file', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const result = mergeThemeState(themeState({}, { sourceFile: 'config/settings_data.json', raw: { current: {}, presets: {}, platform_customizations: {} } }), {
        templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.summary.changedFiles, ['templates/index.json']);
});

// ---------------------------------------------------------------------------
// dryRunMerge() — §23
// ---------------------------------------------------------------------------

test('dryRunMerge() — reports the same outcome as mergeThemeState() without exposing the raw mergedThemeState object', () => {
    const cv = buildValidCandidateValidation('index', INDEX_CANDIDATE);
    const report = dryRunMerge(themeState({}, null), { templateName: 'index', candidate: INDEX_CANDIDATE, candidateValidation: cv });
    assert.strictEqual(report.wouldApply, true);
    assert.deepStrictEqual(report.conflicts, []);
    assert.ok(report.summary);
    assert.strictEqual(report.mergedThemeState, undefined);
});

test('dryRunMerge() — surfaces conflicts without throwing', () => {
    const report = dryRunMerge(themeState({}, null), { templateName: 'index', candidate: { sections: {}, order: [] } });
    assert.strictEqual(report.wouldApply, false);
    assert.ok(report.conflicts.length > 0);
});
