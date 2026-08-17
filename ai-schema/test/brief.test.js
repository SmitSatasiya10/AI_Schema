const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const path = require('path');
const brief = require('../brief');

test('createEmptyBrief() — every declared field starts missing/null', () => {
    const b = brief.createEmptyBrief();
    for (const key of brief.BRIEF_FIELDS) {
        assert.deepStrictEqual(b[key], { value: null, status: 'missing', source: null });
    }
});

test('isReady()/missingBlockingFields() — businessType is the only blocking field', () => {
    const b = brief.createEmptyBrief();
    assert.strictEqual(brief.isReady(b), false);
    assert.deepStrictEqual(brief.missingBlockingFields(b), ['businessType']);

    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    assert.strictEqual(brief.isReady(b), true);
    assert.deepStrictEqual(brief.missingBlockingFields(b), []);
});

test('isReady() — every other missing field never blocks readiness', () => {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    // Everything else still missing.
    assert.strictEqual(brief.isReady(b), true);
});

test('mergeField() — a confirmed value is never overwritten by a later inferred one', () => {
    const existing = { value: 'PawWell', status: 'confirmed', source: 'user' };
    const incoming = { value: 'GuessBrand', status: 'inferred', source: 'ai_inference' };
    assert.deepStrictEqual(brief.mergeField(existing, incoming), existing);
});

test('mergeField() — a later confirmed value overwrites an earlier inferred one', () => {
    const existing = { value: 'GuessBrand', status: 'inferred', source: 'ai_inference' };
    const incoming = { value: 'PawWell', status: 'confirmed', source: 'user' };
    assert.deepStrictEqual(brief.mergeField(existing, incoming), incoming);
});

test('mergeField() — an empty/missing incoming value never erases a previously known value', () => {
    const existing = { value: 'PawWell', status: 'confirmed', source: 'user' };
    assert.deepStrictEqual(brief.mergeField(existing, { value: null, status: 'missing', source: null }), existing);
    assert.deepStrictEqual(brief.mergeField(existing, undefined), existing);
});

test('mergeBrief() — preserves prior fields not present in the new partial (multi-turn preservation)', () => {
    const turn1 = brief.mergeBrief(null, {
        niche: { value: 'pet wellness', status: 'confirmed', source: 'user' }
    });
    assert.strictEqual(turn1.niche.value, 'pet wellness');
    assert.strictEqual(turn1.businessType.status, 'missing');

    const turn2 = brief.mergeBrief(turn1, {
        businessType: { value: 'pet supplements store', status: 'confirmed', source: 'user' }
    });
    // Turn 2 didn't mention niche again — it must still be there.
    assert.strictEqual(turn2.niche.value, 'pet wellness');
    assert.strictEqual(turn2.businessType.value, 'pet supplements store');
});

test('isValidBriefShape() — rejects a brief missing a required field key', () => {
    const b = brief.createEmptyBrief();
    delete b.businessType;
    assert.strictEqual(brief.isValidBriefShape(b), false);
});

test('isValidBriefShape() — rejects an invalid status enum value', () => {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'x', status: 'definitely-sure', source: 'user' };
    assert.strictEqual(brief.isValidBriefShape(b), false);
});

test('isValidBriefShape() — rejects a field claiming "missing" while still carrying a value (contradictory)', () => {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet store', status: 'missing', source: null };
    assert.strictEqual(brief.isValidBriefShape(b), false);
});

test('isValidBriefShape() — accepts a well-formed full brief', () => {
    const b = brief.createEmptyBrief();
    b.businessType = { value: 'pet wellness store', status: 'confirmed', source: 'user' };
    assert.strictEqual(brief.isValidBriefShape(b), true);
});

test('saveBrief()/loadBrief() — round-trips state for a session id, returns null when absent', async () => {
    const sessionId = 'test-brief-roundtrip-session';
    const filePath = brief.briefFilePath(sessionId);
    try {
        assert.strictEqual(await brief.loadBrief(sessionId), null);

        const state = {
            sessionId,
            originalRequest: 'Create a premium pet wellness store.',
            answers: [],
            brief: brief.createEmptyBrief(),
            askedQuestions: [],
            round: 0,
            status: 'NEEDS_CLARIFICATION'
        };
        await brief.saveBrief(sessionId, state);

        const loaded = await brief.loadBrief(sessionId);
        assert.deepStrictEqual(loaded, state);
    } finally {
        await fs.rm(filePath, { force: true });
    }
});

test('briefFilePath() — rejects a session id with path-traversal-unsafe characters', () => {
    assert.throws(() => brief.briefFilePath('../../etc/passwd'));
    assert.throws(() => brief.briefFilePath(''));
});
