/**
 * Phase 9 tests for conversation-session.js — session state shape/lifecycle,
 * file-based persistence (mirrors brief.js's own test convention: explicit
 * sessionId per test, cleaned up via the module's own file-path helper),
 * ThemeState version hashing, cancel detection, and deterministic
 * clarification-answer matching.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;

const {
    SESSION_STATES,
    computeThemeStateVersion,
    createSession,
    sessionFilePath,
    saveSession,
    loadSession,
    resetSession,
    isCancelMessage,
    matchCandidateFromAnswer,
    mergeClarificationAnswer
} = require('../conversation-session');

async function cleanupSession(sessionId) {
    if (!sessionId) return;
    await fs.rm(sessionFilePath(sessionId), { force: true });
}

// ---------------------------------------------------------------------------
// createSession() — shape (§5)
// ---------------------------------------------------------------------------

test('createSession() — defaults to IDLE with no pending state, an auto-generated sessionId, and the default themeId', () => {
    const session = createSession();
    assert.strictEqual(session.status, SESSION_STATES.IDLE);
    assert.strictEqual(session.themeId, 'default');
    assert.ok(session.sessionId);
    assert.strictEqual(session.currentIntent, null);
    assert.strictEqual(session.pendingClarification, null);
    assert.strictEqual(session.resolvedTarget, null);
    assert.strictEqual(session.lastOperation, null);
    assert.strictEqual(session.turnCount, 0);
});

test('createSession() — honors an explicit sessionId/themeId', () => {
    const session = createSession({ sessionId: 'my-session', themeId: 'my-theme' });
    assert.strictEqual(session.sessionId, 'my-session');
    assert.strictEqual(session.themeId, 'my-theme');
});

// ---------------------------------------------------------------------------
// save/load — persistence (§38, mirrors brief.js's file-based approach)
// ---------------------------------------------------------------------------

test('saveSession()/loadSession() — round-trips a session, survives as if a separate process re-loaded it', async () => {
    const sessionId = 'test-conv-session-roundtrip';
    try {
        const session = createSession({ sessionId, themeId: 'default' });
        session.status = SESSION_STATES.NEEDS_CLARIFICATION;
        session.currentIntent = 'Change the banner.';
        session.pendingQuestion = 'Which banner?';
        await saveSession(session);

        const loaded = await loadSession(sessionId);
        assert.strictEqual(loaded.status, SESSION_STATES.NEEDS_CLARIFICATION);
        assert.strictEqual(loaded.currentIntent, 'Change the banner.');
        assert.strictEqual(loaded.pendingQuestion, 'Which banner?');
    } finally {
        await cleanupSession(sessionId);
    }
});

test('loadSession() — returns null for an unknown sessionId (not an error)', async () => {
    const result = await loadSession('does-not-exist-conv-session');
    assert.strictEqual(result, null);
});

// ---------------------------------------------------------------------------
// resetSession() — §30 cancel/reset
// ---------------------------------------------------------------------------

test('resetSession() — clears pending edit context but keeps sessionId/themeId/turnCount', () => {
    const session = createSession({ sessionId: 'test-reset', themeId: 'default' });
    session.status = SESSION_STATES.NEEDS_CLARIFICATION;
    session.currentIntent = 'Change the banner.';
    session.pendingClarification = { kind: 'section', candidates: [] };
    session.resolvedTarget = { templateName: 'index', sectionId: 'hero-1' };
    session.lastOperation = { operation: 'update_section' };
    session.turnCount = 3;

    const reset = resetSession(session);
    assert.strictEqual(reset.status, SESSION_STATES.IDLE);
    assert.strictEqual(reset.currentIntent, null);
    assert.strictEqual(reset.pendingClarification, null);
    assert.strictEqual(reset.resolvedTarget, null);
    assert.strictEqual(reset.lastOperation, null);
    assert.strictEqual(reset.sessionId, 'test-reset');
    assert.strictEqual(reset.themeId, 'default');
    assert.strictEqual(reset.turnCount, 3, 'turn count is conversation history, not pending edit state');
});

// ---------------------------------------------------------------------------
// isCancelMessage() — §30
// ---------------------------------------------------------------------------

test('isCancelMessage() — recognizes the documented cancel vocabulary, case/punctuation-insensitive', () => {
    for (const phrase of ['cancel', 'Cancel.', 'never mind', 'Never Mind!', 'start over', 'nevermind']) {
        assert.strictEqual(isCancelMessage(phrase), true, phrase);
    }
});

test('isCancelMessage() — does not misfire on an ordinary edit request', () => {
    assert.strictEqual(isCancelMessage('Change the hero heading.'), false);
    assert.strictEqual(isCancelMessage('Cancel the discount badge text.'), false, 'the word "cancel" inside a longer sentence is not a cancel command');
});

// ---------------------------------------------------------------------------
// computeThemeStateVersion() — §22 freshness
// ---------------------------------------------------------------------------

function fakeThemeState(sections) {
    return {
        themeId: 'test', sourcePath: '/fake', schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        templates: { index: { sourceFile: 'templates/index.json', raw: { sections, order: Object.keys(sections) } } },
        globalSettings: null,
        meta: { unparseableTemplates: [], globalSettingsError: null }
    };
}

test('computeThemeStateVersion() — identical content produces the identical version, regardless of createdAt/updatedAt', () => {
    const a = fakeThemeState({ 'hero-1': { type: 'slideshow', settings: {} } });
    const b = { ...fakeThemeState({ 'hero-1': { type: 'slideshow', settings: {} } }), createdAt: '2099-01-01T00:00:00.000Z' };
    assert.strictEqual(computeThemeStateVersion(a), computeThemeStateVersion(b));
});

test('computeThemeStateVersion() — a content change produces a different version', () => {
    const a = fakeThemeState({ 'hero-1': { type: 'slideshow', settings: {} } });
    const b = fakeThemeState({ 'hero-1': { type: 'slideshow', settings: { auto_rotate: 'true' } } });
    assert.notStrictEqual(computeThemeStateVersion(a), computeThemeStateVersion(b));
});

// ---------------------------------------------------------------------------
// matchCandidateFromAnswer()/mergeClarificationAnswer() — §9
// ---------------------------------------------------------------------------

const bannerCandidates = [
    { sectionId: 'announcement-banner', type: 'image-with-text', score: 1 },
    { sectionId: 'homepage-hero-banner', type: 'image-with-text', score: 1 }
];

test('matchCandidateFromAnswer() — numeric selection ("1"/"2") picks by position', () => {
    assert.deepStrictEqual(matchCandidateFromAnswer(bannerCandidates, '1'), bannerCandidates[0]);
    assert.deepStrictEqual(matchCandidateFromAnswer(bannerCandidates, '2.'), bannerCandidates[1]);
});

test('matchCandidateFromAnswer() — keyword answer uniquely matching one candidate\'s id resolves it', () => {
    assert.deepStrictEqual(matchCandidateFromAnswer(bannerCandidates, 'Announcement banner.'), bannerCandidates[0]);
    assert.deepStrictEqual(matchCandidateFromAnswer(bannerCandidates, 'the homepage hero one'), bannerCandidates[1]);
});

test('matchCandidateFromAnswer() — a still-ambiguous answer (matches every candidate equally, or none) returns null, never guesses', () => {
    assert.strictEqual(matchCandidateFromAnswer(bannerCandidates, 'the banner'), null, 'both candidates contain "banner" — tie');
    assert.strictEqual(matchCandidateFromAnswer(bannerCandidates, 'the sidebar widget'), null, 'matches neither candidate');
});

test('mergeClarificationAnswer() — resolves against a pending clarification\'s candidates', () => {
    const pending = { kind: 'section', candidates: bannerCandidates };
    const result = mergeClarificationAnswer(pending, 'Announcement banner.');
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.match.sectionId, 'announcement-banner');
    assert.strictEqual(result.kind, 'section');
});

test('mergeClarificationAnswer() — an ambiguous answer stays unresolved rather than guessing', () => {
    const pending = { kind: 'section', candidates: bannerCandidates };
    const result = mergeClarificationAnswer(pending, 'the banner');
    assert.strictEqual(result.resolved, false);
});

test('mergeClarificationAnswer() — no pending clarification is unresolved, not a crash', () => {
    assert.strictEqual(mergeClarificationAnswer(null, 'anything').resolved, false);
});
