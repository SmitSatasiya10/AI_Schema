/**
 * Phase 11 tests for coverage-report.js — the deterministic real-Liquid vs.
 * AI-schema comparison tool. Fixture-based unit tests for the pure pieces
 * (extraction, comparison, duplicate/relationship detection), plus
 * real-repo integration tests asserting the actual current baseline this
 * phase produced.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {
    extractSchemaBlock,
    inventoryRealDefinitions,
    inventoryAISchemas,
    findDuplicateIds,
    compareCoverage,
    findMissingReferencedBlocks,
    buildCoverageReport
} = require('../coverage-report');

// ---------------------------------------------------------------------------
// extractSchemaBlock() — pure
// ---------------------------------------------------------------------------

test('extractSchemaBlock() — parses a well-formed {% schema %} block', () => {
    const source = `<div>hi</div>\n{% schema %}\n{"name": "Test", "settings": []}\n{% endschema %}`;
    const result = extractSchemaBlock(source);
    assert.strictEqual(result.present, true);
    assert.strictEqual(result.parseError, null);
    assert.strictEqual(result.parsed.name, 'Test');
});

test('extractSchemaBlock() — a Liquid file with no schema tag at all is reported, not thrown', () => {
    const result = extractSchemaBlock('<div>just markup, no schema</div>');
    assert.strictEqual(result.present, false);
    assert.strictEqual(result.parsed, null);
});

test('extractSchemaBlock() — malformed JSON inside the tag is a parse error, not a crash', () => {
    const source = `{% schema %}\n{ this is not valid json }\n{% endschema %}`;
    const result = extractSchemaBlock(source);
    assert.strictEqual(result.present, true);
    assert.ok(result.parseError);
});

test('extractSchemaBlock() — handles Shopify\'s whitespace-control dash variant ({%- schema -%})', () => {
    const source = `{%- schema -%}\n{"name": "Test"}\n{%- endschema -%}`;
    const result = extractSchemaBlock(source);
    assert.strictEqual(result.present, true);
    assert.strictEqual(result.parsed.name, 'Test');
});

// ---------------------------------------------------------------------------
// inventoryRealDefinitions()/inventoryAISchemas() — fixture-based I/O
// ---------------------------------------------------------------------------

async function makeTempDir(files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase11-coverage-'));
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content, 'utf8');
    }
    return dir;
}

test('inventoryRealDefinitions() — real Liquid ids come from the FILE BASENAME, not an internal schema field (Shopify sections/standalone blocks carry no such field)', async () => {
    const dir = await makeTempDir({
        'my-section.liquid': `{% schema %}\n{"name": "My Section", "settings": [{"type":"text","id":"title"},{"type":"header","content":"noise"}]}\n{% endschema %}`
    });
    try {
        const entries = await inventoryRealDefinitions(dir);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].id, 'my-section');
        assert.strictEqual(entries[0].hasSchemaTag, true);
        assert.strictEqual(entries[0].settingCount, 1, 'the "header" entry must not count as a real setting');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('inventoryRealDefinitions() — a file with no schema tag is reported as such, not skipped silently', async () => {
    const dir = await makeTempDir({ 'snippet-like.liquid': '<div>no schema here</div>' });
    try {
        const entries = await inventoryRealDefinitions(dir);
        assert.strictEqual(entries[0].hasSchemaTag, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('inventoryRealDefinitions() — returns entries sorted by filename, independent of directory-entry order (§33 determinism)', async () => {
    const dir = await makeTempDir({
        'zeta.liquid': '{% schema %}{"name":"Z"}{% endschema %}',
        'alpha.liquid': '{% schema %}{"name":"A"}{% endschema %}'
    });
    try {
        const entries = await inventoryRealDefinitions(dir);
        assert.deepStrictEqual(entries.map(e => e.id), ['alpha', 'zeta']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('inventoryRealDefinitions() — an empty/missing directory returns an empty array, not a throw', async () => {
    const entries = await inventoryRealDefinitions(path.join(os.tmpdir(), 'phase11-does-not-exist-' + Date.now()));
    assert.deepStrictEqual(entries, []);
});

test('inventoryAISchemas() — keeps BOTH file and id (needed to detect filename/id drift and per-file duplicates)', async () => {
    const dir = await makeTempDir({
        'my-block.json': JSON.stringify({ id: 'my-block', label: 'X', purpose: 'x', settings: {} })
    });
    try {
        const entries = await inventoryAISchemas(dir);
        assert.strictEqual(entries[0].file, 'my-block.json');
        assert.strictEqual(entries[0].id, 'my-block');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// findDuplicateIds() / compareCoverage() / findMissingReferencedBlocks() — pure
// ---------------------------------------------------------------------------

test('findDuplicateIds() — flags a real id collision exactly once, listing every file that declares it', () => {
    const entries = [{ file: 'a.json', id: 'row' }, { file: 'b.json', id: 'row' }, { file: 'c.json', id: 'unique' }];
    const dupes = findDuplicateIds(entries);
    assert.strictEqual(dupes.length, 1);
    assert.strictEqual(dupes[0].id, 'row');
    assert.deepStrictEqual(dupes[0].files, ['a.json', 'b.json']);
});

test('findDuplicateIds() — no false positives when every id is unique', () => {
    assert.deepStrictEqual(findDuplicateIds([{ file: 'a.json', id: 'a' }, { file: 'b.json', id: 'b' }]), []);
});

test('compareCoverage() — classifies supported vs. unsupported vs. stale vs. filename/id mismatch correctly', () => {
    const real = [
        { file: 'covered.liquid', id: 'covered', hasSchemaTag: true, parseError: null, name: null, settingCount: 3, blockTypes: [] },
        { file: 'missing.liquid', id: 'missing', hasSchemaTag: true, parseError: null, name: null, settingCount: 5, blockTypes: [] },
        { file: 'no-schema.liquid', id: 'no-schema', hasSchemaTag: false, parseError: null, name: null, settingCount: 0, blockTypes: [] }
    ];
    const ai = [
        { file: 'covered.json', id: 'covered', parseError: null, allowedBlocks: [] },
        { file: 'orphaned.json', id: 'orphaned', parseError: null, allowedBlocks: [] }
    ];
    const result = compareCoverage(real, ai);
    assert.deepStrictEqual(result.supported, ['covered']);
    assert.strictEqual(result.unsupported.length, 1);
    assert.strictEqual(result.unsupported[0].id, 'missing');
    assert.deepStrictEqual(result.noSchemaTag, ['no-schema.liquid']);
    assert.deepStrictEqual(result.staleAISchemas, [{ id: 'orphaned', file: 'orphaned.json' }]);
});

test('compareCoverage() — unsupported list is sorted by setting count descending (highest content value first, §8 prioritization)', () => {
    const real = [
        { file: 'small.liquid', id: 'small', hasSchemaTag: true, parseError: null, name: null, settingCount: 2, blockTypes: [] },
        { file: 'big.liquid', id: 'big', hasSchemaTag: true, parseError: null, name: null, settingCount: 40, blockTypes: [] }
    ];
    const result = compareCoverage(real, []);
    assert.deepStrictEqual(result.unsupported.map(u => u.id), ['big', 'small']);
});

test('findMissingReferencedBlocks() — flags a section\'s allowed_blocks entry with no matching block schema', () => {
    const sections = [{ file: 's.json', id: 's', allowedBlocks: ['exists', 'ghost'] }];
    const blocks = [{ file: 'b.json', id: 'exists', allowedBlocks: [] }];
    const missing = findMissingReferencedBlocks(sections, blocks);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].missingBlockId, 'ghost');
});

// ---------------------------------------------------------------------------
// Real-repo integration — the actual Phase 11 baseline/result.
// ---------------------------------------------------------------------------

let report;
test.before(async () => {
    report = await buildCoverageReport();
});

test('buildCoverageReport() — real repo: reflects Phase 11\'s actual coverage improvement', () => {
    assert.strictEqual(report.summary.realSectionCount, 86);
    assert.strictEqual(report.summary.aiSectionCount, 26);
    assert.strictEqual(report.summary.supportedSectionCount, 26, 'every AI section schema must correspond to a real Liquid file');
    assert.strictEqual(report.summary.realBlockCount, 80);
    assert.strictEqual(report.summary.aiBlockCount, 58);
    // Denominator includes inline-only block types (declared inside a real
    // section's own schema, no standalone .liquid file — e.g. "hotspot"),
    // which is larger than the standalone-file count alone.
    assert.ok(report.summary.realBlockCountIncludingInline > report.summary.realBlockCount);
    assert.ok(report.summary.supportedBlockCount >= 56, 'Phase 11 raised block coverage (standalone + inline identities) from 41 to at least 56');
});

test('buildCoverageReport() — every Phase 11-added section is present and marked supported', () => {
    const added = ['related-products', 'facebook-testimonials', 'custom-columns-new', 'rich-text', 'collapsible-content', 'track-order', 'email-signup-banner', 'shoppable-image', 'image-slider', 'colors-changer'];
    for (const id of added) {
        assert.ok(report.sections.supported.includes(id), `expected "${id}" to be classified as supported`);
    }
});

test('buildCoverageReport() — every Phase 11-added block is present and marked supported, including inline-only ones (hotspot/image_slide/video_slide/field_row have no standalone .liquid file — they are declared inside their section\'s own schema)', () => {
    const added = ['container', 'collapsible-row-content', 'hotspot', 'image_slide', 'video_slide', 'field_row'];
    for (const id of added) {
        assert.ok(report.blocks.supported.includes(id), `expected block "${id}" to be classified as supported`);
    }
});

test('buildCoverageReport() — merging standalone + inline-declared real block identities leaves NO AI block schema orphaned (every one now matches a real block, standalone or inline)', () => {
    assert.deepStrictEqual(report.blocks.staleAISchemas, [], `unexpected orphaned AI block schema(s): ${JSON.stringify(report.blocks.staleAISchemas)}`);
    assert.deepStrictEqual(report.sections.staleAISchemas, [], 'no AI section schema should be orphaned');
});

test('buildCoverageReport() — the pre-existing "row" duplicate id is still detected (documented, not silently reintroduced or hidden)', () => {
    assert.strictEqual(report.blocks.duplicateAIIds.length, 1);
    assert.strictEqual(report.blocks.duplicateAIIds[0].id, 'row');
});

test('buildCoverageReport() — Phase 11 introduced no NEW duplicate ids beyond the pre-existing "row" one', () => {
    assert.deepStrictEqual(report.sections.duplicateAIIds, []);
});

test('buildCoverageReport() — the input_row -> field_row correction: no stray reference to the old id remains anywhere in the AI catalog', () => {
    const allSectionMismatches = report.sections.filenameIdMismatches;
    const allBlockMismatches = report.blocks.filenameIdMismatches;
    assert.ok(!allBlockMismatches.some(m => m.id === 'input_row'));
    assert.ok(!allSectionMismatches.some(m => m.id === 'input_row'));
});

test('buildCoverageReport() — a documented, unresolved gap (main-product\'s own missing referenced blocks) remains visible, not silently dropped', () => {
    assert.ok(report.missingReferencedBlocks.some(m => m.sectionId === 'main-product'), 'this pre-existing gap must still be reported, not hidden');
});

test('buildCoverageReport() — is deterministic: two runs against the same repo state produce an identical report', async () => {
    const again = await buildCoverageReport();
    assert.deepStrictEqual(again.summary, report.summary);
    assert.deepStrictEqual(again.sections.supported, report.sections.supported);
    assert.deepStrictEqual(again.blocks.supported, report.blocks.supported);
});
