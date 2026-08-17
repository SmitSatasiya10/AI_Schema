const test = require('node:test');
const assert = require('node:assert');
const { loadSchemas, buildSystemPrompt } = require('../example-implementation');

test('buildSystemPrompt() — includes the required section headers', async () => {
    const schemas = await loadSchemas();
    const prompt = buildSystemPrompt(schemas);

    assert.ok(prompt.includes('CRITICAL RULES'));
    assert.ok(prompt.includes('AVAILABLE GLOBAL SETTINGS'));
    assert.ok(prompt.includes('AVAILABLE SECTIONS'));
    assert.ok(prompt.includes('AVAILABLE BLOCKS'));
    assert.ok(prompt.includes('OUTPUT FORMAT'));
});

test('buildSystemPrompt() — embeds every loaded section and block id verbatim (characterizes today\'s "dump everything into one prompt" behavior)', async () => {
    const schemas = await loadSchemas();
    const prompt = buildSystemPrompt(schemas);

    for (const section of schemas.sectionSchemas) {
        assert.ok(
            prompt.includes(`"id": "${section.id}"`),
            `system prompt should contain section id "${section.id}"`
        );
    }
    for (const block of schemas.blockSchemas) {
        assert.ok(
            prompt.includes(`"id": "${block.id}"`),
            `system prompt should contain block id "${block.id}"`
        );
    }
});

test('buildSystemPrompt() — is deterministic for the same schema input', async () => {
    const schemas = await loadSchemas();
    const promptA = buildSystemPrompt(schemas);
    const promptB = buildSystemPrompt(schemas);
    assert.strictEqual(promptA, promptB);
});
