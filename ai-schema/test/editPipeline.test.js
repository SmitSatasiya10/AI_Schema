/**
 * Phase 8 tests for edit-pipeline.js — request classification, deterministic
 * target resolution wired into the orchestrator, the bounded AI
 * operation-proposal stage (mocked `global.fetch`, no API spend — same
 * convention as test/generation.test.js), and the Phase 7 apply boundary
 * (§27 — a targeted edit must never fall into full-structure replacement).
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase8-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { loadSchemas } = require('../example-implementation');
const { DEFAULT_THEME_ROOT } = require('../theme-state');
const {
    classifyRequest,
    buildAmbiguityQuestion,
    runTargetedEdit
} = require('../edit-pipeline');

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
                'hero-1': { type: 'slideshow', settings: {}, blocks: { 'slide-1': { type: 'slide', settings: { heading: 'Old heading' } } }, block_order: ['slide-1'] },
                'testi-1': { type: 'testimonials', settings: {}, blocks: { 'col-1': { type: 'column', settings: {} } }, block_order: ['col-1'] }
            },
            order: ['hero-1', 'testi-1']
        }
    };
}

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

function throwingFetch() {
    return async () => { throw new Error('global.fetch should not have been called for this classification'); };
}

// ---------------------------------------------------------------------------
// classifyRequest() — §29/§30
// ---------------------------------------------------------------------------

test('classifyRequest() — targeted-edit verbs route to TARGETED_EDIT (the plan\'s own examples)', () => {
    for (const prompt of ['Change the hero heading.', 'Update the announcement bar text.', 'Remove the testimonials section.', 'Add another image block to the existing hero.', 'Move the CTA button.', 'Replace the heading.']) {
        assert.strictEqual(classifyRequest(prompt), 'TARGETED_EDIT', prompt);
    }
});

test('classifyRequest() — clear creation requests route to INITIAL_GENERATION', () => {
    assert.strictEqual(classifyRequest('Create a premium pet wellness store for dogs and cats'), 'INITIAL_GENERATION');
    assert.strictEqual(classifyRequest('Build a homepage for a modern e-commerce store.'), 'INITIAL_GENERATION');
});

test('classifyRequest() — vague/high-level requests are AMBIGUOUS, never auto-generate operations', () => {
    assert.strictEqual(classifyRequest('Make my homepage better'), 'AMBIGUOUS');
    assert.strictEqual(classifyRequest(''), 'AMBIGUOUS');
});

test('buildAmbiguityQuestion() — lists every tied candidate, numbered', () => {
    const question = buildAmbiguityQuestion([{ sectionId: 'hero-1', type: 'slideshow' }, { sectionId: 'hero-2', type: 'slideshow' }], 'section');
    assert.match(question, /1\. hero-1 \(slideshow\)/);
    assert.match(question, /2\. hero-2 \(slideshow\)/);
});

// ---------------------------------------------------------------------------
// runTargetedEdit() — classification short-circuit (zero AI calls)
// ---------------------------------------------------------------------------

test('runTargetedEdit() — a clear creation request never calls the AI at all, routes back to the caller as INITIAL_GENERATION', async () => {
    const originalFetch = global.fetch;
    global.fetch = throwingFetch();
    try {
        const result = await runTargetedEdit('Create a premium pet wellness store', { themeState: themeState({ index: baseIndexTemplate() }), schemas });
        assert.strictEqual(result.status, 'INITIAL_GENERATION');
        assert.strictEqual(result.classification, 'INITIAL_GENERATION');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — an ambiguous target gets one bounded AI resolution call, then falls back to the tied candidates when the AI itself is not confident', async () => {
    const template = baseIndexTemplate();
    template.raw.sections['hero-2'] = { type: 'slideshow', settings: {} };
    template.raw.order.push('hero-2');
    const originalFetch = global.fetch;
    // No clarifyingQuestion offered -> deterministic code falls back to the
    // real tied candidates it already had, same as the old zero-AI-call
    // behavior, just after one bounded resolution attempt.
    const router = jsonFetch(() => ({ confident: false }));
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the slideshow heading', { themeState: themeState({ index: template }), schemas });
        assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
        assert.strictEqual(result.targetStatus, 'AMBIGUOUS');
        assert.strictEqual(result.candidates.length, 2);
        assert.ok(result.questions[0].includes('hero-1'));
        assert.strictEqual(router.callCount(), 1, 'exactly one bounded AI resolution call, no repair needed');
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// runTargetedEdit() — end to end with a mocked, bounded AI proposal
// ---------------------------------------------------------------------------

test('runTargetedEdit() — resolves the hero section, proposes+validates+executes an update_section operation on the first attempt', async () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const router = jsonFetch(() => ({
        operation: 'update_section',
        target: { templateName: 'index', sectionId: 'hero-1' },
        changes: { settings: { auto_rotate: 'true' } }
    }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the hero settings', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
        assert.strictEqual(result.repaired, false);
        assert.strictEqual(router.callCount(), 1);
        assert.deepStrictEqual(result.changeSummary.changed, ['settings.auto_rotate']);
        assert.deepStrictEqual(result.themeState.templates.index.raw.sections['hero-1'].settings, { auto_rotate: 'true' });
        // Sibling section untouched — proof this never became a full-structure replacement.
        assert.deepStrictEqual(result.themeState.templates.index.raw.sections['testi-1'], ts.templates.index.raw.sections['testi-1']);
        assert.deepStrictEqual(ts.templates.index.raw.sections['hero-1'].settings, {}, 'the original ThemeState must remain untouched');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — recovers via one bounded repair when the first proposal is invalid', async () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_section', target: { templateName: 'index', sectionId: 'not-a-real-section' }, changes: { settings: { auto_rotate: 'true' } } }
        : { operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } });
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the hero settings', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
        assert.strictEqual(result.repaired, true);
        assert.strictEqual(router.callCount(), 2, 'exactly one repair attempt');
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — FAILED (not a silent pass) when the proposal is still invalid after the repair attempt, exactly 2 calls', async () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const router = jsonFetch(() => ({ operation: 'update_section', target: { templateName: 'index', sectionId: 'ghost' }, changes: { settings: { x: 1 } } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the hero settings', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'FAILED');
        assert.ok(result.errors.length > 0);
        assert.strictEqual(router.callCount(), 2);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — a hallucinated product handle proposal is rejected by the SAME deterministic validation, never silently applied', async () => {
    const template = { sourceFile: 'templates/index.json', raw: { sections: { 'collage-1': { type: 'collage', settings: {}, blocks: { p1: { type: 'product', settings: { product: '' } } }, block_order: ['p1'] } }, order: ['collage-1'] } };
    const ts = themeState({ index: template });
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'collage-1', blockId: 'p1' }, changes: { settings: { product: 'invented-handle' } } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the featured product', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'FAILED');
        assert.ok(result.errors.some(e => e.code === 'OPERATION_DATA_REFERENCE_INVALID'));
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — remove_section request executes a real removal, sibling sections untouched', async () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const router = jsonFetch(() => ({ operation: 'remove_section', target: { templateName: 'index', sectionId: 'testi-1' } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Remove the testimonials section', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
        assert.ok(!result.themeState.templates.index.raw.sections['testi-1']);
        assert.deepStrictEqual(result.themeState.templates.index.raw.sections['hero-1'], ts.templates.index.raw.sections['hero-1']);
    } finally {
        global.fetch = originalFetch;
    }
});

test('runTargetedEdit() — add_block request adds a real block into the resolved existing section', async () => {
    const ts = themeState({ index: baseIndexTemplate() });
    const router = jsonFetch(() => ({ operation: 'add_block', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { type: 'slide' } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Add another slide to the hero', { themeState: ts, schemas });
        assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
        const section = result.themeState.templates.index.raw.sections['hero-1'];
        assert.strictEqual(Object.keys(section.blocks).length, 2);
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// §26/§27 — Phase 7 apply integration boundary
// ---------------------------------------------------------------------------

async function makeTempTheme(initialFiles = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase8-edit-'));
    for (const [relativePath, content] of Object.entries(initialFiles)) {
        const abs = path.join(dir, relativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, JSON.stringify(content, null, 2), 'utf8');
    }
    return dir;
}

test('runTargetedEdit() — autoApply + dryRunApply reports the change without writing anything', async () => {
    const original = baseIndexTemplate().raw;
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const ts = themeState({ index: { sourceFile: 'templates/index.json', raw: JSON.parse(JSON.stringify(original)) } });
    const router = jsonFetch(() => ({ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the hero settings', { themeState: ts, schemas, autoApply: true, dryRunApply: true, themeRoot });
        assert.strictEqual(result.status, 'DRY_RUN');
        assert.strictEqual(result.applyResult.applied, false);
        const onDisk = JSON.parse(await fs.readFile(path.join(themeRoot, 'templates', 'index.json'), 'utf8'));
        assert.deepStrictEqual(onDisk, original);
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

test('runTargetedEdit() — autoApply writes ONLY the targeted template, preserving the untouched sibling section on disk (never a full-structure replacement, §27)', async () => {
    const original = baseIndexTemplate().raw;
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const ts = themeState({ index: { sourceFile: 'templates/index.json', raw: JSON.parse(JSON.stringify(original)) } });
    const router = jsonFetch(() => ({ operation: 'update_section', target: { templateName: 'index', sectionId: 'hero-1' }, changes: { settings: { auto_rotate: 'true' } } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the hero settings', { themeState: ts, schemas, autoApply: true, themeRoot });
        assert.strictEqual(result.status, 'APPLIED');
        const onDisk = JSON.parse(await fs.readFile(path.join(themeRoot, 'templates', 'index.json'), 'utf8'));
        assert.deepStrictEqual(onDisk.sections['hero-1'].settings, { auto_rotate: 'true' });
        assert.deepStrictEqual(onDisk.sections['testi-1'], original.sections['testi-1'], 'the sibling section must be byte-for-byte untouched on disk');
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

test('runTargetedEdit() — update_global_settings via autoApply writes only config/settings_data.json, not any template', async () => {
    const themeRoot = await makeTempTheme({ 'config/settings_data.json': { current: { colors_accent_1: '#000000', unrelated: 'keep' }, presets: {}, platform_customizations: {} } });
    const ts = themeState({}, { sourceFile: 'config/settings_data.json', raw: { current: { colors_accent_1: '#000000', unrelated: 'keep' }, presets: {}, platform_customizations: {} } });
    const router = jsonFetch(() => ({ operation: 'update_global_settings', changes: { settings: { colors_accent_1: '#ffffff' } } }));
    const originalFetch = global.fetch;
    global.fetch = router;
    try {
        const result = await runTargetedEdit('Change the accent color', { themeState: ts, schemas, autoApply: true, themeRoot });
        assert.strictEqual(result.status, 'APPLIED', JSON.stringify(result));
        assert.deepStrictEqual(result.applyResult.filesWritten, ['config/settings_data.json']);
        const onDisk = JSON.parse(await fs.readFile(path.join(themeRoot, 'config', 'settings_data.json'), 'utf8'));
        assert.strictEqual(onDisk.current.colors_accent_1, '#ffffff');
        assert.strictEqual(onDisk.current.unrelated, 'keep');
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Live theme isolation
// ---------------------------------------------------------------------------

test('editPipeline.test.js — the real repo theme files remain byte-for-byte unchanged after this whole suite', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');
    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before);
});
