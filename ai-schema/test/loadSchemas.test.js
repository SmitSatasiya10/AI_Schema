const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');
const { loadSchemas } = require('../example-implementation');

test('loadSchemas() — global schema loads with a settings object', async () => {
    const schemas = await loadSchemas();
    assert.ok(schemas.globalSchema, 'global schema should be loaded');
    assert.strictEqual(typeof schemas.globalSchema.settings, 'object');
});

test('loadSchemas() — loads every *.json file present in sections/ and blocks/ (characterizes today\'s "load everything, unconditionally" behavior — Phase 2 will make this selective)', async () => {
    const schemas = await loadSchemas();

    const sectionFiles = (await fs.readdir(path.join(__dirname, '..', 'sections')))
        .filter(f => f.endsWith('.json'));
    const blockFiles = (await fs.readdir(path.join(__dirname, '..', 'blocks')))
        .filter(f => f.endsWith('.json'));

    assert.strictEqual(
        schemas.sectionSchemas.length,
        sectionFiles.length,
        'loadSchemas() should load exactly one entry per *.json file in sections/'
    );
    assert.strictEqual(
        schemas.blockSchemas.length,
        blockFiles.length,
        'loadSchemas() should load exactly one entry per *.json file in blocks/'
    );
});

test('loadSchemas() — every loaded section and block schema has an id', async () => {
    const schemas = await loadSchemas();
    for (const section of schemas.sectionSchemas) {
        assert.ok(section.id, `section schema missing "id": ${JSON.stringify(section)}`);
    }
    for (const block of schemas.blockSchemas) {
        assert.ok(block.id, `block schema missing "id": ${JSON.stringify(block)}`);
    }
});

test('loadSchemas() — is idempotent across repeated calls (same counts every time)', async () => {
    const first = await loadSchemas();
    const second = await loadSchemas();
    assert.strictEqual(first.sectionSchemas.length, second.sectionSchemas.length);
    assert.strictEqual(first.blockSchemas.length, second.blockSchemas.length);
});
