/**
 * Phase 4 tests for theme-state.js. Split into two groups:
 *   - Real-theme tests: read-only against this repo's actual top-level
 *     templates/config (never written to — see the "isolation" tests
 *     below, which prove that empirically, not just by code inspection).
 *   - Fixture tests: a disposable temp theme root (os.tmpdir()) used for
 *     scenarios the real theme can't safely exercise (malformed JSON,
 *     path-traversal attempts) — mirrors the existing convention of using
 *     ai-schema/output/ as a scratch dir for Phase 1-3 tests.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase4-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const themeState = require('../theme-state');
const {
    buildThemeState,
    serializeThemeState,
    validateThemeState,
    saveThemeState,
    loadThemeState,
    themeStateFilePath,
    listTemplateFiles,
    listSectionGroupFiles,
    classifyTemplate,
    DEFAULT_THEME_ROOT
} = themeState;

// ---------------------------------------------------------------------------
// Real theme (read-only)
// ---------------------------------------------------------------------------

let realState;

test.before(async () => {
    realState = await buildThemeState();
});

test('buildThemeState() — against the real theme, detects every *.json template on disk plus section-group files', async () => {
    const { found, skipped } = await listTemplateFiles(DEFAULT_THEME_ROOT);
    const { found: groupFound } = await listSectionGroupFiles(DEFAULT_THEME_ROOT);
    assert.strictEqual(realState.meta.templateCount, found.length + groupFound.length);
    assert.ok(found.some(f => f.name === 'index'));
    assert.ok(found.some(f => f.name === 'product'));
    assert.ok(found.some(f => f.name === 'customers/account'), 'expected a nested customers/ template to be detected');
    // gift_card.liquid has no JSON configuration surface — documented as
    // unsupported (§10), not silently treated as if it were a JSON template.
    assert.ok(skipped.some(s => s.endsWith('gift_card.liquid')));
    assert.deepStrictEqual(realState.meta.unsupportedTemplateFiles, skipped);

    // footer coverage (see footer.json) depends on footer-group.json being
    // discovered and given the right sourceFile — the one thing merge.js/
    // apply.js actually rely on to write it correctly.
    assert.ok(groupFound.some(f => f.name === 'footer-group'));
    assert.ok(realState.templates['footer-group'], 'expected footer-group to be represented in ThemeState');
    assert.strictEqual(realState.templates['footer-group'].sourceFile, 'sections/footer-group.json');
    // Locale-variant override files must NOT be treated as their own group.
    assert.ok(!groupFound.some(f => f.name.includes('.context.')));
});

test('buildThemeState() — real theme: known types come from the AI schema catalog, unknown types are still counted (not dropped)', () => {
    assert.ok(realState.meta.sectionCount > 0);
    assert.ok(realState.meta.blockCount > 0);
    // collection.json is known to contain section types with no
    // ai-schema/sections match today (Shopify's own built-in
    // "main-collection-banner"/"main-collection-product-grid" — deliberately
    // deprioritized by Phase 11's coverage expansion, see PHASE11_REPORT.md
    // "Known Limitations": these are structural, one-per-template sections,
    // not merchant content). This assertion would catch a regression where
    // classification silently started treating everything as known (i.e.
    // stopped actually checking).
    assert.ok(realState.meta.unknownSectionCount > 0, 'expected at least one section type unknown to the AI schema catalog in the real theme');

    const collection = realState.templates['collection'];
    assert.ok(collection, 'expected a "collection" template to be represented');
    const banner = Object.values(collection.classification.sections).find(s => s.type === 'main-collection-banner');
    assert.ok(banner, 'expected the real collection.json to contain a main-collection-banner section');
    assert.strictEqual(banner.knownToAI, false);

    const product = realState.templates['product'];
    assert.ok(product, 'expected a "product" template to be represented');
    const mainProduct = Object.values(product.classification.sections).find(s => s.type === 'main-product');
    assert.ok(mainProduct);
    assert.strictEqual(mainProduct.knownToAI, true, 'main-product has a matching ai-schema/sections/main-product.json schema');
});

test('buildThemeState() — unknown sections are preserved verbatim in raw, not stripped', () => {
    const collection = realState.templates['collection'];
    const rawTypes = Object.values(collection.raw.sections).map(s => s.type);
    assert.ok(rawTypes.includes('main-collection-banner'), 'unknown section type must still be present in raw');
});

test('serializeThemeState() — round-trips every template byte-identically against a fresh disk read (real theme)', async () => {
    const serialized = serializeThemeState(realState);
    for (const [name, template] of Object.entries(realState.templates)) {
        const onDisk = JSON.parse(await fs.readFile(path.join(DEFAULT_THEME_ROOT, template.sourceFile), 'utf8'));
        assert.deepStrictEqual(serialized.templates[name], onDisk, `template "${name}" must round-trip exactly`);
    }
    const onDiskSettings = JSON.parse(await fs.readFile(path.join(DEFAULT_THEME_ROOT, 'config', 'settings_data.json'), 'utf8'));
    assert.deepStrictEqual(serialized.globalSettings, onDiskSettings);
});

test('buildThemeState() — real theme validates structurally (order/sections/block_order consistent)', () => {
    // The real theme is a shipped, working theme — its templates should not
    // trip the structural (order<->sections, block_order<->blocks) checks.
    // A failure here means the real theme JSON itself is broken, which is
    // useful signal independent of AI-schema coverage.
    assert.deepStrictEqual(realState.validation.errors, []);
    assert.strictEqual(realState.validation.valid, true);
});

test('buildThemeState() — isolation: never writes to the live theme (real files are byte-identical before/after)', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const settingsPath = path.join(DEFAULT_THEME_ROOT, 'config', 'settings_data.json');
    const before = [await fs.readFile(indexPath, 'utf8'), await fs.readFile(settingsPath, 'utf8')];

    await buildThemeState();
    await buildThemeState({ themeId: 'isolation-check' }); // different themeId, still read-only

    const after = [await fs.readFile(indexPath, 'utf8'), await fs.readFile(settingsPath, 'utf8')];
    assert.deepStrictEqual(after, before, 'buildThemeState() must never modify the live theme files');
});

// ---------------------------------------------------------------------------
// classifyTemplate() — pure unit tests
// ---------------------------------------------------------------------------

test('classifyTemplate() — flags known vs unknown section/block types without mutating input', () => {
    const raw = {
        sections: {
            's1': { type: 'slideshow', blocks: { 'b1': { type: 'slide' }, 'b2': { type: 'mystery-block' } } },
            's2': { type: 'totally-custom-section' }
        },
        order: ['s1', 's2']
    };
    const knownSectionTypes = new Set(['slideshow']);
    const knownBlockTypes = new Set(['slide']);
    const result = classifyTemplate(raw, knownSectionTypes, knownBlockTypes);

    assert.strictEqual(result.sections.s1.knownToAI, true);
    assert.strictEqual(result.sections.s2.knownToAI, false);
    assert.strictEqual(result.sections.s1.blocks.b1.knownToAI, true);
    assert.strictEqual(result.sections.s1.blocks.b2.knownToAI, false);
    // raw must be untouched
    assert.strictEqual(raw.sections.s1.blocks.b2.type, 'mystery-block');
});

// ---------------------------------------------------------------------------
// validateThemeState() — pure unit tests against synthetic state
// ---------------------------------------------------------------------------

function stateWithTemplate(raw) {
    return {
        templates: { t: { sourceFile: 'templates/t.json', raw, classification: { sections: {} } } },
        globalSettings: { sourceFile: 'config/settings_data.json', raw: { current: {} } },
        meta: { unparseableTemplates: [], globalSettingsError: null }
    };
}

test('validateThemeState() — order referencing a nonexistent section is an error', () => {
    const state = stateWithTemplate({ sections: { a: { type: 'x' } }, order: ['a', 'ghost'] });
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('order references unknown section "ghost"')));
});

test('validateThemeState() — a section not listed in order is only a warning, not an error', () => {
    const state = stateWithTemplate({ sections: { a: { type: 'x' }, b: { type: 'y' } }, order: ['a'] });
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('section "b" is not referenced in "order"')));
});

test('validateThemeState() — block_order referencing a nonexistent block is an error', () => {
    const state = stateWithTemplate({
        sections: { a: { type: 'x', blocks: { b1: { type: 'y' } }, block_order: ['b1', 'ghost'] } },
        order: ['a']
    });
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('block_order references unknown block "ghost"')));
});

test('validateThemeState() — a block missing from block_order is only a warning', () => {
    const state = stateWithTemplate({
        sections: { a: { type: 'x', blocks: { b1: { type: 'y' }, b2: { type: 'y' } }, block_order: ['b1'] } },
        order: ['a']
    });
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.some(w => w.includes('block "b2" not listed in block_order')));
});

test('validateThemeState() — an unrecognized section type never produces an error by itself (no destructive rejection)', () => {
    const state = stateWithTemplate({ sections: { a: { type: 'nobody-has-heard-of-this' } }, order: ['a'] });
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
});

test('validateThemeState() — a recorded unparseable template surfaces as an error', () => {
    const state = {
        templates: {},
        globalSettings: null,
        meta: { unparseableTemplates: [{ name: 'broken', sourceFile: 'templates/broken.json', error: 'Unexpected token' }], globalSettingsError: null }
    };
    const result = validateThemeState(state);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('broken') && e.includes('not valid JSON')));
});

// ---------------------------------------------------------------------------
// Fixture-based tests (disposable temp theme root)
// ---------------------------------------------------------------------------

async function makeFixtureTheme() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theme-state-fixture-'));
    await fs.mkdir(path.join(root, 'templates', 'customers'), { recursive: true });
    await fs.mkdir(path.join(root, 'config'), { recursive: true });

    await fs.writeFile(path.join(root, 'templates', 'index.json'), JSON.stringify({
        sections: {
            hero: { type: 'slideshow', settings: {}, blocks: { s1: { type: 'slide', settings: {} } }, block_order: ['s1'] },
            weird: { type: 'not-in-ai-schema', settings: { custom_field: 'anything' } }
        },
        order: ['hero', 'weird']
    }, null, 2), 'utf8');

    await fs.writeFile(path.join(root, 'templates', 'broken.json'), '{ this is not valid json', 'utf8');
    await fs.writeFile(path.join(root, 'templates', 'customers', 'account.json'), JSON.stringify({ sections: { main: { type: 'main-account' } }, order: ['main'] }), 'utf8');
    await fs.writeFile(path.join(root, 'templates', 'gift_card.liquid'), '{% comment %}not json{% endcomment %}', 'utf8');
    await fs.writeFile(path.join(root, 'config', 'settings_data.json'), JSON.stringify({ current: { colors_accent_1: '#000000' }, presets: {}, platform_customizations: { custom_css: [] } }, null, 2), 'utf8');

    return root;
}

test('buildThemeState() — fixture: a malformed template does not abort the build, and is flagged (not silently dropped)', async () => {
    const root = await makeFixtureTheme();
    try {
        const state = await buildThemeState({ themeRoot: root, themeId: 'fixture-theme', schemas: { sectionSchemas: [{ id: 'slideshow' }], blockSchemas: [{ id: 'slide' }] } });

        assert.strictEqual(state.meta.templateCount, 2); // index, customers/account (broken.json is excluded — unparseable)
        assert.strictEqual(state.meta.unparseableTemplates.length, 1);
        assert.strictEqual(state.meta.unparseableTemplates[0].name, 'broken');
        assert.strictEqual(state.validation.valid, false);
        assert.ok(state.validation.errors.some(e => e.includes('broken')));

        // The unknown section still made it into the state, untouched.
        assert.strictEqual(state.templates.index.raw.sections.weird.type, 'not-in-ai-schema');
        assert.strictEqual(state.templates.index.classification.sections.weird.knownToAI, false);
        assert.strictEqual(state.templates.index.classification.sections.hero.knownToAI, true);

        assert.ok(state.meta.unsupportedTemplateFiles.some(f => f.endsWith('gift_card.liquid')));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('serializeThemeState() — fixture: round-trip preserves the unknown section and all its custom settings', async () => {
    const root = await makeFixtureTheme();
    try {
        const state = await buildThemeState({ themeRoot: root, themeId: 'fixture-theme', schemas: { sectionSchemas: [{ id: 'slideshow' }], blockSchemas: [{ id: 'slide' }] } });
        const serialized = serializeThemeState(state);
        assert.deepStrictEqual(serialized.templates.index.sections.weird, { type: 'not-in-ai-schema', settings: { custom_field: 'anything' } });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('saveThemeState()/loadThemeState() — round-trips, returns null when absent', async () => {
    const themeId = 'test-theme-state-roundtrip';
    const filePath = themeStateFilePath(themeId);
    try {
        assert.strictEqual(await loadThemeState(themeId), null);

        const fakeState = { themeId, sourcePath: '/tmp/x', schemaVersion: 1, createdAt: 'x', updatedAt: 'x', templates: {}, globalSettings: null, meta: {}, validation: { valid: true, errors: [], warnings: [] } };
        await saveThemeState(fakeState);

        const loaded = await loadThemeState(themeId);
        assert.deepStrictEqual(loaded, fakeState);
    } finally {
        await fs.rm(filePath, { force: true });
    }
});

test('themeStateFilePath() — rejects a theme id with path-traversal-unsafe characters', () => {
    assert.throws(() => themeStateFilePath('../../etc/passwd'));
    assert.throws(() => themeStateFilePath(''));
});
