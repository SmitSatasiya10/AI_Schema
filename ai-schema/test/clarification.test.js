/**
 * Phase 3 tests for clarification.js. `global.fetch` is mocked throughout —
 * these tests characterize orchestration (merging, dedup, round caps,
 * validation, persistence), not real model output quality, which can't be
 * unit-tested offline. See test/runFullPipeline.test.js for the equivalent
 * mocking pattern used elsewhere in this repo.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase3-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const brief = require('../brief');
const clarification = require('../clarification');
const {
    buildUnderstandingPrompt,
    validateUnderstandingResult,
    understandRequest,
    MAX_CLARIFICATION_ROUNDS,
    MAX_QUESTIONS_PER_ROUND
} = clarification;

function jsonFetch(bodyOrFn) {
    return async (url, opts) => {
        const body = typeof bodyOrFn === 'function' ? bodyOrFn(JSON.parse(opts.body)) : bodyOrFn;
        return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
            text: async () => JSON.stringify(body)
        };
    };
}

function readyResult(overrides = {}) {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    return { status: 'READY', brief: b, missing: [], questions: [], ...overrides };
}

function clarifyResult(question, overrides = {}) {
    const b = brief.createEmptyBrief();
    return {
        status: 'NEEDS_CLARIFICATION',
        brief: b,
        missing: ['businessType'],
        questions: [question],
        ...overrides
    };
}

async function cleanupSession(sessionId) {
    if (!sessionId) return;
    await fs.rm(brief.briefFilePath(sessionId), { force: true });
}

test('buildUnderstandingPrompt() — stays in the small-prompt cost tier, never dumps the full schema catalog', () => {
    const prompt = buildUnderstandingPrompt('Original request: Make me a store.');
    assert.ok(!prompt.includes('AVAILABLE SECTIONS'));
    assert.ok(!prompt.includes('AVAILABLE BLOCKS'));
    // The full main-generation system prompt is ~60K chars with all schemas
    // attached (see BASELINE_REPORT.md); this must stay far below that.
    assert.ok(prompt.length < 5000, `expected a lightweight prompt, got ${prompt.length} chars`);
});

test('buildUnderstandingPrompt() — appends repair instructions only when repairErrors is given', () => {
    const base = buildUnderstandingPrompt('conversation');
    const repaired = buildUnderstandingPrompt('conversation', ['status must be READY or NEEDS_CLARIFICATION']);
    assert.ok(!base.includes('Your previous response was invalid'));
    assert.ok(repaired.includes('Your previous response was invalid'));
});

test('validateUnderstandingResult() — accepts a well-formed READY result', () => {
    const result = validateUnderstandingResult(readyResult());
    assert.strictEqual(result.valid, true);
});

test('validateUnderstandingResult() — accepts a well-formed NEEDS_CLARIFICATION result', () => {
    const result = validateUnderstandingResult(clarifyResult('What type of store is this?'));
    assert.strictEqual(result.valid, true);
});

test('validateUnderstandingResult() — rejects an invalid status value', () => {
    const result = validateUnderstandingResult({ ...readyResult(), status: 'MAYBE' });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('status')));
});

test('validateUnderstandingResult() — rejects a malformed brief', () => {
    const result = validateUnderstandingResult({ ...readyResult(), brief: { businessType: 'not-an-object' } });
    assert.strictEqual(result.valid, false);
});

test('validateUnderstandingResult() — rejects contradictory READY with a still-missing blocking field', () => {
    const result = validateUnderstandingResult(readyResult({ brief: brief.createEmptyBrief() }));
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('READY but blocking field')));
});

test('validateUnderstandingResult() — rejects contradictory NEEDS_CLARIFICATION with no questions', () => {
    const result = validateUnderstandingResult({ ...clarifyResult('x'), questions: [] });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('NEEDS_CLARIFICATION but questions')));
});

test('validateUnderstandingResult() — rejects a non-minimal question list', () => {
    const questions = Array.from({ length: MAX_QUESTIONS_PER_ROUND + 5 }, (_, i) => `Question ${i}?`);
    const result = validateUnderstandingResult(clarifyResult('x', { questions }));
    assert.strictEqual(result.valid, false);
});

test('understandRequest() — vague request (scenario A): stays NEEDS_CLARIFICATION, does not fabricate a theme', async () => {
    const originalFetch = global.fetch;
    global.fetch = jsonFetch(clarifyResult('What type of products or store are you creating?'));
    let sessionId;
    try {
        const result = await understandRequest('Make me a premium store.');
        sessionId = result.sessionId;
        assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
        assert.ok(result.questions.length > 0);
        assert.strictEqual(result.brief.businessType.status, 'missing');
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('understandRequest() — specific request (scenario B): READY when businessType is present', async () => {
    const originalFetch = global.fetch;
    global.fetch = jsonFetch(readyResult());
    let sessionId;
    try {
        const result = await understandRequest('Create a premium pet wellness store for dogs and cats.');
        sessionId = result.sessionId;
        assert.strictEqual(result.status, 'READY');
        assert.strictEqual(result.questions.length, 0);
        assert.strictEqual(result.brief.businessType.value, 'pet wellness store');
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('understandRequest() — multi-turn (scenario D): preserves turn-1 info, merges turn-2 answer, does not repeat asked questions', async () => {
    const originalFetch = global.fetch;
    let call = 0;
    global.fetch = jsonFetch(() => {
        call++;
        if (call === 1) {
            const b = brief.createEmptyBrief();
            b.niche = { value: 'pet wellness', status: 'confirmed', source: 'user' };
            return {
                status: 'NEEDS_CLARIFICATION',
                brief: b,
                missing: ['businessType'],
                questions: ['What is your brand name and what products do you sell?']
            };
        }
        const b = brief.createEmptyBrief();
        b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
        b.brandName = { value: 'PawWell', status: 'confirmed', source: 'user' };
        b.products = { value: ['dog supplements', 'grooming products'], status: 'confirmed', source: 'user' };
        return { status: 'READY', brief: b, missing: [], questions: [] };
    });

    let sessionId;
    try {
        const turn1 = await understandRequest('Create a premium pet wellness store.');
        sessionId = turn1.sessionId;
        assert.strictEqual(turn1.status, 'NEEDS_CLARIFICATION');
        assert.strictEqual(turn1.brief.niche.value, 'pet wellness');

        const turn2 = await understandRequest('PawWell. We sell dog supplements and grooming products.', { sessionId });
        assert.strictEqual(turn2.status, 'READY');
        // Preserved from turn 1 even though turn 2's mocked extraction didn't repeat it.
        assert.strictEqual(turn2.brief.niche.value, 'pet wellness');
        assert.strictEqual(turn2.brief.brandName.value, 'PawWell');
        assert.deepStrictEqual(turn2.brief.products.value, ['dog supplements', 'grooming products']);

        const persisted = await brief.loadBrief(sessionId);
        assert.strictEqual(persisted.answers.length, 1);
        assert.strictEqual(persisted.originalRequest, 'Create a premium pet wellness store.');
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('understandRequest() — caps clarification at MAX_CLARIFICATION_ROUNDS to avoid an unbounded loop', async () => {
    const originalFetch = global.fetch;
    let call = 0;
    global.fetch = jsonFetch(() => {
        call++;
        return clarifyResult(`Follow-up question number ${call}?`);
    });

    let sessionId;
    try {
        let result = await understandRequest('Make me a store.');
        sessionId = result.sessionId;
        let rounds = 0;
        while (result.status === 'NEEDS_CLARIFICATION' && rounds < MAX_CLARIFICATION_ROUNDS + 3) {
            result = await understandRequest(`Answer ${rounds}`, { sessionId });
            rounds++;
        }
        assert.strictEqual(result.status, 'READY', 'must eventually force READY rather than looping forever');
        assert.ok(rounds <= MAX_CLARIFICATION_ROUNDS + 1, `expected to stop within ${MAX_CLARIFICATION_ROUNDS} rounds, took ${rounds}`);
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('understandRequest() — bounded repair retry recovers from one invalid AI response', async () => {
    const originalFetch = global.fetch;
    let call = 0;
    global.fetch = jsonFetch(() => {
        call++;
        // First response is contradictory (READY but businessType missing);
        // second (the repair attempt) is valid.
        if (call === 1) return readyResult({ brief: brief.createEmptyBrief() });
        return readyResult();
    });

    let sessionId;
    try {
        const result = await understandRequest('Create a premium pet wellness store for dogs and cats.');
        sessionId = result.sessionId;
        assert.strictEqual(result.status, 'READY');
        assert.strictEqual(call, 2, 'expected exactly one repair retry, not an unbounded loop');
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});

test('understandRequest() — throws (does not silently continue) when the repair attempt is also invalid', async () => {
    const originalFetch = global.fetch;
    global.fetch = jsonFetch(readyResult({ brief: brief.createEmptyBrief() }));
    let sessionId;
    try {
        await assert.rejects(async () => {
            await understandRequest('Make me a store.', { sessionId: 'test-clarification-throws-session' });
        }, /invalid/i);
        sessionId = 'test-clarification-throws-session';
    } finally {
        global.fetch = originalFetch;
        await cleanupSession(sessionId);
    }
});
