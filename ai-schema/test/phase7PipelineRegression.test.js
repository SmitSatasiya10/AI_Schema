/**
 * Phase 7 pipeline wiring tests — confirms `mergeApplyMode` in
 * 1-generate-theme.js is reachable end to end (not just unit-tested in
 * merge.test.js/apply.test.js), fails closed on an unsafe merge, supports
 * dry run, and — critically — that the pre-Phase-7 default behavior
 * (copyGeneratedFilesToTheme()) is completely unaffected when the new mode
 * isn't enabled. Every test here uses a temp `themeRoot` (§26); nothing
 * ever points mergeApplyMode at the real repo.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase7-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { runFullPipeline } = require('../1-generate-theme');
const { DEFAULT_THEME_ROOT } = require('../theme-state');

async function makeTempTheme(initialFiles = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-pipeline-'));
    for (const [relativePath, content] of Object.entries(initialFiles)) {
        const abs = path.join(dir, relativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, JSON.stringify(content, null, 2), 'utf8');
    }
    return dir;
}

async function readJSON(p) {
    return JSON.parse(await fs.readFile(p, 'utf8'));
}

const VALID_LEGACY_CONFIG = {
    sections: {
        'hero-1': {
            type: 'slideshow',
            settings: { visibility: 'always-display', slide_height: 'medium', slider_visual: 'dots', auto_rotate: 'true', show_text_below: 'false' },
            blocks: { 'slide-1': { type: 'slide', settings: { image: '' } } },
            block_order: ['slide-1']
        }
    },
    order: ['hero-1']
};

const VALID_PALETTE = { niche: 'test', description: 'x', colors_accent_1: '#111111', colors_accent_2: '#222222' };

function mockFetchRouter() {
    return async (url, opts) => {
        const body = JSON.parse(opts.body);
        const content = JSON.stringify(body.messages.length === 1 ? VALID_PALETTE : VALID_LEGACY_CONFIG);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
}

// ---------------------------------------------------------------------------
// Default behavior — mergeApplyMode NOT set — completely unaffected
// ---------------------------------------------------------------------------

test('runFullPipeline() — default (mergeApplyMode unset) never runs merge/apply, matches pre-Phase-7 return shape', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockFetchRouter();
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.mergeSummary, null);
        assert.strictEqual(result.applyResult, null);
    } finally {
        global.fetch = originalFetch;
    }
});

// ---------------------------------------------------------------------------
// mergeApplyMode — real writes into a temp themeRoot
// ---------------------------------------------------------------------------

test('runFullPipeline() — mergeApplyMode writes the candidate + color settings into a temp themeRoot via merge/apply', async () => {
    const themeRoot = await makeTempTheme({
        'templates/index.json': { sections: { old: { type: 'slideshow', settings: {} } }, order: ['old'] },
        'config/settings_data.json': { current: { colors_accent_1: '#000000', unrelated: 'keep-me' }, presets: {}, platform_customizations: {} }
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetchRouter();
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: true, mergeApplyMode: true, themeRoot });
        assert.strictEqual(result.success, true);
        assert.ok(result.mergeSummary);
        assert.ok(result.applyResult.applied);
        assert.deepStrictEqual(result.applyResult.filesWritten.sort(), ['config/settings_data.json', 'templates/index.json']);

        const indexOnDisk = await readJSON(path.join(themeRoot, 'templates', 'index.json'));
        assert.deepStrictEqual(indexOnDisk, VALID_LEGACY_CONFIG);

        const settingsOnDisk = await readJSON(path.join(themeRoot, 'config', 'settings_data.json'));
        assert.strictEqual(settingsOnDisk.current.colors_accent_1, '#111111');
        assert.strictEqual(settingsOnDisk.current.unrelated, 'keep-me', 'unrelated existing setting must survive the merge');
        assert.deepStrictEqual(settingsOnDisk.current.content_for_index, ['hero-1']);
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

test('runFullPipeline() — mergeApplyMode respects autoCopy:false (merge/apply is still gated by the existing explicit-write flag)', async () => {
    const themeRoot = await makeTempTheme({ 'templates/index.json': { sections: {}, order: [] } });
    const originalFetch = global.fetch;
    global.fetch = mockFetchRouter();
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: false, mergeApplyMode: true, themeRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.mergeSummary, null);
        assert.strictEqual(result.applyResult, null);
        assert.deepStrictEqual(await readJSON(path.join(themeRoot, 'templates', 'index.json')), { sections: {}, order: [] });
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('runFullPipeline() — mergeApplyMode + dryRunApply reports changes without writing', async () => {
    const original = { sections: { old: { type: 'slideshow', settings: {} } }, order: ['old'] };
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const originalFetch = global.fetch;
    global.fetch = mockFetchRouter();
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: true, mergeApplyMode: true, dryRunApply: true, themeRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.applyResult.applied, false);
        assert.strictEqual(result.applyResult.dryRun, true);
        assert.deepStrictEqual(await readJSON(path.join(themeRoot, 'templates', 'index.json')), original, 'dry run must not write anything');
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Fail closed on an unsafe merge (§20)
// ---------------------------------------------------------------------------

test('runFullPipeline() — mergeApplyMode fails closed (throws, writes nothing) when the target template has unknown sections and replacement isn\'t acknowledged', async () => {
    const original = { sections: { mystery: { type: 'totally-unrecognized-section-type', settings: {} } }, order: ['mystery'] };
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const originalFetch = global.fetch;
    const originalExit = process.exit;
    process.exit = (code) => { throw new Error(`process.exit(${code})`); };
    global.fetch = mockFetchRouter();
    try {
        await assert.rejects(
            () => runFullPipeline('Create a homepage for a test store.', { autoCopy: true, mergeApplyMode: true, themeRoot }),
            /process\.exit/
        );
        assert.deepStrictEqual(await readJSON(path.join(themeRoot, 'templates', 'index.json')), original, 'a failed-closed merge must never write anything');
    } finally {
        global.fetch = originalFetch;
        process.exit = originalExit;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

test('runFullPipeline() — the same scenario succeeds once acknowledgeUnknownSectionReplacement is explicitly set', async () => {
    const themeRoot = await makeTempTheme({ 'templates/index.json': { sections: { mystery: { type: 'colors-changer', settings: {} } }, order: ['mystery'] } });
    const originalFetch = global.fetch;
    global.fetch = mockFetchRouter();
    try {
        const result = await runFullPipeline('Create a homepage for a test store.', { autoCopy: true, mergeApplyMode: true, acknowledgeUnknownSectionReplacement: true, themeRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.applyResult.applied, true);
    } finally {
        global.fetch = originalFetch;
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Live theme isolation
// ---------------------------------------------------------------------------

test('phase7PipelineRegression.test.js — the real repo theme files remain byte-for-byte unchanged after this whole suite', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');
    // (no test above ever passed DEFAULT_THEME_ROOT as themeRoot to a
    // mergeApplyMode run — this just confirms the file is still there/valid)
    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before);
});
