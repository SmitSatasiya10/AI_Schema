/**
 * Phase 9 — Conversation/Edit Session State.
 *
 * The minimal piece of state Phase 8's `runTargetedEdit()` never had (§4 of
 * AI_THEME_BUILDER_PHASE9_PLAN.md, confirmed by inspection before writing
 * this file): a `runTargetedEdit()` call is a single stateless function —
 * nothing about a pending clarification, a resolved target, or the last
 * operation survives between two separate calls. This file adds exactly
 * enough state to let a targeted-edit conversation span multiple turns,
 * following the SAME persistence precedent `brief.js` already established
 * for Phase 3's clarification loop (plain JSON files, no database — §38)
 * rather than inventing a new persistence philosophy.
 *
 * This is deliberately NOT a general conversation-memory system (§5 — "do
 * not build a large memory system"). It holds only what's needed to resume
 * one in-progress edit: the original intent, a pending clarification (if
 * any), the last resolved target, the last operation, and a lightweight
 * ThemeState version so a later turn can tell whether the state it's about
 * to act on is the same one the session last saw (§22/§23).
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const instrumentation = require('./instrumentation');
const { DEFAULT_THEME_ID, serializeThemeState } = require('./theme-state');

const SESSIONS_DIR = path.join(__dirname, 'output', 'edit-sessions');

// §6 — the session must know which state it's in. Kept to exactly the
// states the plan names; nothing richer is needed for the actual workflow.
const SESSION_STATES = Object.freeze({
    IDLE: 'IDLE',
    UNDERSTANDING: 'UNDERSTANDING',
    NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
    READY_FOR_OPERATION: 'READY_FOR_OPERATION',
    APPLYING: 'APPLYING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
});

// §30 — a small, deterministic reset/cancel vocabulary. Not NLP.
const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'start over', 'forget it', 'reset', 'nvm'];

function normalize(text) {
    return (text || '').trim().toLowerCase().replace(/[.!]+$/, '');
}

function isCancelMessage(message) {
    const normalized = normalize(message);
    return CANCEL_PHRASES.includes(normalized);
}

// ---------------------------------------------------------------------------
// §22 — ThemeState freshness. Nothing in theme-state.js hashes CONTENT (its
// `schemaVersion` is a fixed contract-shape constant, not a content
// fingerprint — confirmed by inspection). serializeThemeState() already
// gives a pure, deterministic {templates, globalSettings} projection of just
// the content that matters (no createdAt/updatedAt noise), so hashing THAT
// is enough to detect "the ThemeState this session last saw is not the one
// it's being asked to act on now" without adding any new field to
// theme-state.js itself.
// ---------------------------------------------------------------------------

function computeThemeStateVersion(themeState) {
    const serialized = serializeThemeState(themeState);
    return crypto.createHash('sha256').update(JSON.stringify(serialized)).digest('hex');
}

// ---------------------------------------------------------------------------
// Session shape (§5) + persistence (§38 — file-based, mirrors brief.js).
// ---------------------------------------------------------------------------

function createSession({ sessionId, themeId = DEFAULT_THEME_ID } = {}) {
    const id = sessionId || instrumentation.nextRequestId('session');
    const now = new Date().toISOString();
    return {
        sessionId: id,
        themeId,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null, // { kind: 'section'|'block'|'intent', candidates, templateName, sectionId, questions }
        resolvedTarget: null,       // { templateName, sectionId, type, blockId?, blockType? }
        lastOperation: null,        // last proposed/executed operation + its deterministic id
        lastChangeSummary: null,
        lastMessage: null,          // §31 — idempotency: the message that produced lastResultStatus
        lastResultStatus: null,
        themeStateVersion: null,
        turnCount: 0,
        createdAt: now,
        updatedAt: now
    };
}

function sessionIdIsSafe(sessionId) {
    return typeof sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

function sessionFilePath(sessionId) {
    if (!sessionIdIsSafe(sessionId)) {
        throw new Error(`Invalid sessionId: must be a non-empty alphanumeric/dash/underscore string, got "${sessionId}"`);
    }
    return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

async function saveSession(session) {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const toSave = { ...session, updatedAt: new Date().toISOString() };
    await fs.writeFile(sessionFilePath(session.sessionId), JSON.stringify(toSave, null, 2), 'utf8');
    return toSave;
}

async function loadSession(sessionId) {
    try {
        const raw = await fs.readFile(sessionFilePath(sessionId), 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

// §30 — cancel/reset clears the pending edit context without touching the
// theme. themeId/sessionId/turnCount/themeStateVersion survive (this is the
// SAME session continuing idle, not a brand-new one).
function resetSession(session) {
    return {
        ...session,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null,
        resolvedTarget: null,
        lastOperation: null,
        lastChangeSummary: null,
        lastMessage: null,
        lastResultStatus: null
    };
}

// ---------------------------------------------------------------------------
// §9 — deterministic clarification-answer merging. Reuses the exact
// token-overlap philosophy operations.js's resolveSectionTarget/
// resolveBlockTarget already established (tokenize id/type, score overlap,
// a UNIQUE top score wins) rather than inventing a different matching rule
// for answers vs. initial requests.
// ---------------------------------------------------------------------------

function tokenize(text) {
    return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchCandidateFromAnswer(candidates, answerText) {
    const trimmed = (answerText || '').trim();

    // "1" / "1." style numeric selection against the numbered question list.
    if (/^\d+\.?$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= candidates.length) return candidates[num - 1];
        return null;
    }

    const answerTokens = new Set(tokenize(trimmed));
    if (answerTokens.size === 0) return null;

    const scored = candidates.map(candidate => {
        const id = candidate.sectionId || candidate.blockId || '';
        const idTokens = tokenize(id.replace(/[-_]/g, ' '));
        const typeTokens = tokenize((candidate.type || '').replace(/[-_]/g, ' '));
        const candidateTokens = new Set([...idTokens, ...typeTokens]);
        let score = 0;
        for (const token of answerTokens) {
            if (candidateTokens.has(token)) score++;
        }
        return { candidate, score };
    }).filter(entry => entry.score > 0);

    if (scored.length === 0) return null;
    const topScore = Math.max(...scored.map(entry => entry.score));
    const top = scored.filter(entry => entry.score === topScore);
    return top.length === 1 ? top[0].candidate : null; // tie -> unresolved, never guess (§9)
}

/**
 * Merges a clarification answer into a pending clarification. Returns
 * { resolved: true, match, kind } when exactly one candidate matches, or
 * { resolved: false } when the answer is still ambiguous/unrecognized —
 * callers must ask again rather than guess (§9/§14 — "never guess").
 */
function mergeClarificationAnswer(pendingClarification, answerText) {
    if (!pendingClarification || !Array.isArray(pendingClarification.candidates) || pendingClarification.candidates.length === 0) {
        return { resolved: false, reason: 'NO_PENDING_CANDIDATES' };
    }
    const match = matchCandidateFromAnswer(pendingClarification.candidates, answerText);
    if (!match) return { resolved: false };
    return { resolved: true, match, kind: pendingClarification.kind };
}

module.exports = {
    SESSION_STATES,
    SESSIONS_DIR,
    computeThemeStateVersion,
    createSession,
    sessionFilePath,
    saveSession,
    loadSession,
    resetSession,
    isCancelMessage,
    matchCandidateFromAnswer,
    mergeClarificationAnswer
};
