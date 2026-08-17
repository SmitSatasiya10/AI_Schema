const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { loadSchemas } = require('../example-implementation');
const { buildCapabilityIndex } = require('../capability-index');
const { CATEGORIES } = require('../scripts/add-capability-metadata');

const execFileAsync = promisify(execFile);

let fullSchemas;

test.before(async () => {
    fullSchemas = await loadSchemas(); // full mode, unaffected by Phase 2
});

test('buildCapabilityIndex() — every loaded section schema is represented exactly once', () => {
    const index = buildCapabilityIndex(fullSchemas);
    assert.strictEqual(index.sections.length, fullSchemas.sectionSchemas.length);
    const ids = index.sections.map(s => s.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'section ids in the index should be unique');
    for (const schema of fullSchemas.sectionSchemas) {
        assert.ok(ids.includes(schema.id), `expected section "${schema.id}" in the index`);
    }
});

test('buildCapabilityIndex() — block ids are deduped (known "row" collision resolves to exactly one entry)', () => {
    const index = buildCapabilityIndex(fullSchemas);
    const uniqueSourceIds = new Set(fullSchemas.blockSchemas.map(b => b.id));
    // fullSchemas.blockSchemas has one fewer UNIQUE id than total entries
    // (result_row.json and row.json both declare id "row" — see
    // PHASE2_REPORT.md). The index must have exactly one entry per unique id.
    assert.strictEqual(index.blocks.length, uniqueSourceIds.size);
    assert.ok(uniqueSourceIds.has('row'));
    const rowEntries = index.blocks.filter(b => b.id === 'row');
    assert.strictEqual(rowEntries.length, 1, 'expected exactly one "row" entry in the index despite two source files declaring that id');
});

test('buildCapabilityIndex() — index resolves the "row" id collision to row.json (the richer, dual-purpose definition)', () => {
    const index = buildCapabilityIndex(fullSchemas);
    const rowEntry = index.blocks.find(b => b.id === 'row');
    // row.json's label is "Row"; result_row.json's label is "Result Row".
    // Deterministic (sorted-filename, last-wins) resolution should pick row.json.
    assert.strictEqual(rowEntry.label, 'Row');
});

test('buildCapabilityIndex() — every category used is within the closed taxonomy', () => {
    const index = buildCapabilityIndex(fullSchemas);
    for (const s of index.sections) {
        assert.ok(CATEGORIES.includes(s.category), `section "${s.id}" has category "${s.category}" outside the closed taxonomy`);
    }
    for (const b of index.blocks) {
        assert.ok(CATEGORIES.includes(b.category), `block "${b.id}" has category "${b.category}" outside the closed taxonomy`);
    }
});

test('buildCapabilityIndex() — rebuilding from the same schemas is deterministic/reproducible', () => {
    const a = buildCapabilityIndex(fullSchemas);
    const b = buildCapabilityIndex(fullSchemas);
    assert.deepStrictEqual(a, b);
});

test('buildCapabilityIndex() — block scope: "slide" is local to slideshow only', () => {
    const index = buildCapabilityIndex(fullSchemas);
    const slide = index.blocks.find(b => b.id === 'slide');
    assert.ok(slide);
    assert.strictEqual(slide.scope, 'local');
    assert.deepStrictEqual(slide.usedBySectionIds, ['slideshow']);
});

test('buildCapabilityIndex() — block scope: "image" is standalone (used by multiple sections)', () => {
    const index = buildCapabilityIndex(fullSchemas);
    const image = index.blocks.find(b => b.id === 'image');
    assert.ok(image);
    assert.strictEqual(image.scope, 'standalone');
    assert.ok(image.usedBySectionIds.length > 1);
});

test('buildCapabilityIndex() — every section entry carries allowed_on and hasBlocks derived correctly', () => {
    const index = buildCapabilityIndex(fullSchemas);
    const slideshow = index.sections.find(s => s.id === 'slideshow');
    assert.deepStrictEqual(slideshow.allowed_on, ['index', 'product', 'page']);
    assert.strictEqual(slideshow.hasBlocks, true);

    const sectionDivider = index.sections.find(s => s.id === 'section-divider');
    assert.strictEqual(sectionDivider.hasBlocks, false);
});

test('buildCapabilityIndex() — is a pure function (no timestamp/side effects; builtAt stays null)', () => {
    const index = buildCapabilityIndex(fullSchemas);
    assert.strictEqual(index.builtAt, null);
});

test('CLI entry point (`node capability-index.js`) runs clean — regression guard for the circular-require hazard between capability-index.js -> example-implementation.js -> retrieval.js -> capability-index.js', async () => {
    // writeIndexFile() (invoked when this file is the process entry point)
    // requires example-implementation.js, which requires retrieval.js,
    // which requires capability-index.js back — a genuine cycle. If
    // module.exports were assigned after the require.main check instead of
    // before it, Node would resolve that cycle against a still-empty
    // exports object and retrieval.js's `buildCapabilityIndex` would
    // silently bind to undefined (Node prints a runtime warning when this
    // happens). Spawning the real CLI as a subprocess is the only way to
    // observe that warning, since requiring these modules from within an
    // already-running test process doesn't reproduce the entry-point cycle.
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase2-tests';
    const { stdout, stderr } = await execFileAsync('node', ['capability-index.js'], {
        cwd: path.join(__dirname, '..'),
        env: process.env
    });
    assert.doesNotMatch(stderr, /circular dependency/i);
    assert.match(stdout, /Wrote .*capability-index\.json/);
});
