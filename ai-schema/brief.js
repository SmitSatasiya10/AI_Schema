/**
 * Phase 3 — WebsiteBrief model + temporary persistence.
 *
 * A WebsiteBrief holds the merchant's requirements as understood so far.
 * Every field uses the same per-field shape so callers can always tell
 * WHY a value is present (or absent) without guessing:
 *
 *   { value: <anything|null>, status: 'confirmed'|'inferred'|'missing', source: <string|null> }
 *
 *   - 'confirmed' — the merchant stated this directly (source: 'user').
 *   - 'inferred'  — the understanding call derived this from context
 *                   (source: 'ai_inference'), e.g. "premium pet wellness
 *                   store" implies targetAudience ~ "pet owners".
 *   - 'missing'   — no value yet.
 *
 * Only `businessType` is hard-blocking (BLOCKING_FIELD_KEYS) — see
 * AI_THEME_BUILDER_PHASE_PLAN.md Phase 3 spec: without knowing what kind of
 * store this is, nothing downstream can be meaningfully configured. Every
 * other field can receive a reasonable default later (Phase 5+), so its
 * absence never blocks READY_TO_GENERATE.
 *
 * Persistence is the smallest mechanism compatible with the current
 * CLI-only architecture: plain JSON files under output/briefs/, matching
 * the existing fs-based read/write pattern already used throughout
 * example-implementation.js and 2-copy-to-theme.js. No database. This is
 * explicitly designed to be swappable for durable (e.g. PostgreSQL)
 * storage in a later phase without changing the shape callers work with —
 * saveBrief()/loadBrief() are the only functions that know about the
 * filesystem.
 */

const fs = require('fs').promises;
const path = require('path');

const BRIEF_FIELDS = [
    'businessType',
    'niche',
    'brandName',
    'targetAudience',
    'products',
    'brandPersonality',
    'visualDirection',
    'colorDirection',
    'contentTone',
    'requiredPages',
    'homepageGoals',
    'conversionGoals',
    'contentRequirements',
    'additionalRequirements'
];

const BLOCKING_FIELD_KEYS = ['businessType'];

const VALID_STATUSES = new Set(['confirmed', 'inferred', 'missing']);

const BRIEFS_DIR = path.join(__dirname, 'output', 'briefs');

function createEmptyBrief() {
    const brief = {};
    for (const key of BRIEF_FIELDS) {
        brief[key] = { value: null, status: 'missing', source: null };
    }
    return brief;
}

function isFieldPresent(field) {
    return !!field && field.value !== null && field.value !== undefined &&
        field.value !== '' && field.status !== 'missing';
}

/**
 * Merge one incoming field update into a brief field, never letting a
 * later 'inferred' overwrite an earlier 'confirmed' value for the same
 * field (a merchant's direct statement always outranks an AI guess), and
 * never letting an empty/missing incoming value erase a value already
 * known from a previous turn (Phase 3 spec: "must not restart from zero").
 */
function mergeField(existing, incoming) {
    if (!incoming || incoming.value === null || incoming.value === undefined || incoming.value === '') {
        return existing;
    }
    if (existing && existing.status === 'confirmed' && incoming.status !== 'confirmed') {
        return existing;
    }
    return {
        value: incoming.value,
        status: VALID_STATUSES.has(incoming.status) ? incoming.status : 'inferred',
        source: incoming.source || (incoming.status === 'confirmed' ? 'user' : 'ai_inference')
    };
}

/**
 * Merge a partial brief (e.g. extracted from the latest understanding
 * call) into an existing brief, field by field. Unknown keys in `partial`
 * are ignored (defensive — the AI call is a schema, not a free field bag).
 */
function mergeBrief(existingBrief, partial) {
    const base = existingBrief ? { ...existingBrief } : createEmptyBrief();
    const merged = {};
    for (const key of BRIEF_FIELDS) {
        merged[key] = mergeField(base[key], partial ? partial[key] : undefined);
    }
    return merged;
}

function missingBlockingFields(brief) {
    return BLOCKING_FIELD_KEYS.filter(key => !isFieldPresent(brief[key]));
}

function isReady(brief) {
    return missingBlockingFields(brief).length === 0;
}

/**
 * true only when the brief object has exactly the known fields, each with
 * a well-formed { value, status, source } shape. Used by clarification.js
 * to reject a malformed AI-extracted brief before it's trusted.
 */
function isValidBriefShape(brief) {
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return false;
    for (const key of BRIEF_FIELDS) {
        const field = brief[key];
        if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
        if (!('value' in field) || !('status' in field)) return false;
        if (!VALID_STATUSES.has(field.status)) return false;
        if (field.status === 'missing' && field.value !== null && field.value !== undefined && field.value !== '') {
            return false; // contradictory: claims missing but carries a value
        }
    }
    return true;
}

/**
 * Flattens a resolved WebsiteBrief into a single natural-language-ish
 * string — the form Phase 5's retrieval/generation prompts consume. Only
 * fields that actually carry a value are included (isFieldPresent), so an
 * empty/missing optional field never shows up as literal "null" text.
 */
function briefToSummaryText(brief) {
    const parts = [];
    for (const key of BRIEF_FIELDS) {
        const field = brief[key];
        if (isFieldPresent(field)) {
            const value = Array.isArray(field.value) ? field.value.join(', ') : field.value;
            parts.push(`${key}: ${value}`);
        }
    }
    return parts.join('; ');
}

async function ensureBriefsDir() {
    await fs.mkdir(BRIEFS_DIR, { recursive: true });
}

function briefFilePath(sessionId) {
    if (!sessionId || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        throw new Error(`Invalid sessionId: must be a non-empty alphanumeric/dash/underscore string, got "${sessionId}"`);
    }
    return path.join(BRIEFS_DIR, `${sessionId}.json`);
}

/**
 * state shape persisted per session (Phase 3 spec §16 — "Temporary State"):
 *   {
 *     sessionId, originalRequest, answers: string[], brief: {...},
 *     askedQuestions: string[], round, status
 *   }
 */
async function saveBrief(sessionId, state) {
    await ensureBriefsDir();
    const filePath = briefFilePath(sessionId);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
    return filePath;
}

async function loadBrief(sessionId) {
    const filePath = briefFilePath(sessionId);
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

module.exports = {
    BRIEF_FIELDS,
    BLOCKING_FIELD_KEYS,
    createEmptyBrief,
    mergeField,
    mergeBrief,
    missingBlockingFields,
    isReady,
    isValidBriefShape,
    isFieldPresent,
    briefToSummaryText,
    saveBrief,
    loadBrief,
    briefFilePath
};
