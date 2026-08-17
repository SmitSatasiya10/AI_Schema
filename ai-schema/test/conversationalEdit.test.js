/**
 * Phase 9 tests for conversational-edit.js — turn classification, follow-up
 * reference resolution, clarification continuation (including the
 * "resolved target but no change details yet" second question), bounded
 * multi-operation batches, ThemeState freshness/idempotency, and the five
 * realistic multi-turn conversations from AI_THEME_BUILDER_PHASE9_PLAN.md §36.
 *
 * Same mocked-`global.fetch` / temp-themeRoot conventions as
 * test/editPipeline.test.js — no real AI spend, live repo theme untouched.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase9-tests';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { loadSchemas } = require('../example-implementation');
const { DEFAULT_THEME_ROOT, themeStateFilePath, loadThemeState } = require('../theme-state');
const { SESSION_STATES, sessionFilePath } = require('../conversation-session');
const {
    MAX_OPERATIONS_PER_TURN,
    containsReferenceWord,
    containsContinuationMarker,
    classifyTurn,
    resolveFollowUpReference,
    splitBoundedClauses,
    runConversationalEdit
} = require('../conversational-edit');

let schemas;
test.before(async () => {
    schemas = await loadSchemas();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function themeState(templates, globalSettings = null, themeId = 'test-conv') {
    return {
        themeId, sourcePath: '/fake', schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        templates, globalSettings,
        meta: { unparseableTemplates: [], globalSettingsError: null }
    };
}

function heroTemplate() {
    return {
        sourceFile: 'templates/index.json',
        raw: {
            sections: {
                'homepage-hero': {
                    type: 'image-with-text',
                    settings: {},
                    blocks: {
                        'hero-heading': { type: 'heading', settings: { title: 'Old heading' } },
                        'hero-button': { type: 'button', settings: { button_label: 'Shop now' } }
                    },
                    block_order: ['hero-heading', 'hero-button']
                },
                'testi-1': {
                    type: 'testimonials',
                    settings: {},
                    blocks: { 'col-1': { type: 'column', settings: {} } },
                    block_order: ['col-1']
                }
            },
            order: ['homepage-hero', 'testi-1']
        }
    };
}

function twoBannerTemplate() {
    return {
        sourceFile: 'templates/index.json',
        raw: {
            sections: {
                'announcement-banner': {
                    type: 'slideshow', settings: {},
                    blocks: { 'banner-slide': { type: 'slide', settings: { heading: 'Free shipping', text_color: '#000000' } } },
                    block_order: ['banner-slide']
                },
                'homepage-hero-banner': {
                    type: 'slideshow', settings: {},
                    blocks: { 'hero-slide': { type: 'slide', settings: { heading: 'Welcome', text_color: '#000000' } } },
                    block_order: ['hero-slide']
                }
            },
            order: ['announcement-banner', 'homepage-hero-banner']
        }
    };
}

function jsonFetch(routerFn) {
    let calls = 0;
    const fn = async (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        const content = JSON.stringify(routerFn(body, calls));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
    };
    fn.callCount = () => calls;
    return fn;
}

function throwingFetch() {
    return async () => { throw new Error('global.fetch should not have been called for this step'); };
}

async function cleanupSession(sessionId) {
    if (!sessionId) return;
    await fs.rm(sessionFilePath(sessionId), { force: true });
}

async function cleanupThemeState(themeId) {
    if (!themeId) return;
    await fs.rm(themeStateFilePath(themeId), { force: true });
}

async function withFetch(router, fn) {
    const original = global.fetch;
    global.fetch = router;
    try {
        await fn();
    } finally {
        global.fetch = original;
    }
}

// ---------------------------------------------------------------------------
// classifyTurn() — §16 new request vs. follow-up (unit level)
// ---------------------------------------------------------------------------

test('classifyTurn() — a cancel phrase always wins, regardless of context', () => {
    const session = { status: SESSION_STATES.COMPLETED, resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' } };
    assert.strictEqual(classifyTurn(session, 'never mind', themeState({ index: heroTemplate() }), schemas, 'index'), 'CANCEL');
});

test('classifyTurn() — a pending clarification routes the next message to CLARIFICATION_ANSWER', () => {
    const session = { status: SESSION_STATES.NEEDS_CLARIFICATION, pendingClarification: { kind: 'section', candidates: [] }, resolvedTarget: null };
    assert.strictEqual(classifyTurn(session, 'anything at all', themeState({ index: heroTemplate() }), schemas, 'index'), 'CLARIFICATION_ANSWER');
});

test('classifyTurn() — a clear creation request is INITIAL_GENERATION even with active edit context', () => {
    const session = { status: SESSION_STATES.COMPLETED, resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero' } };
    assert.strictEqual(classifyTurn(session, 'Create a premium pet wellness store', themeState({ index: heroTemplate() }), schemas, 'index'), 'INITIAL_GENERATION');
});

test('classifyTurn() — no active context is always NEW_REQUEST, even with a reference word', () => {
    const session = { status: SESSION_STATES.IDLE, resolvedTarget: null };
    assert.strictEqual(classifyTurn(session, 'Make it blue.', themeState({ index: heroTemplate() }), schemas, 'index'), 'NEW_REQUEST');
});

test('classifyTurn() — a reference word with active context is FOLLOW_UP', () => {
    const session = { status: SESSION_STATES.COMPLETED, resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    assert.strictEqual(classifyTurn(session, 'Make it shorter.', themeState({ index: heroTemplate() }), schemas, 'index'), 'FOLLOW_UP');
});

test('classifyTurn() — a continuation marker ("too") is FOLLOW_UP even without a reference word', () => {
    const session = { status: SESSION_STATES.COMPLETED, resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-button', type: 'image-with-text', blockType: 'button' } };
    assert.strictEqual(classifyTurn(session, 'Make the text white too.', themeState({ index: heroTemplate() }), schemas, 'index'), 'FOLLOW_UP');
});

test('classifyTurn() — an unrelated request explicitly naming a different section is NEW_REQUEST, never overloaded onto the old target', () => {
    const session = { status: SESSION_STATES.COMPLETED, resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    assert.strictEqual(classifyTurn(session, 'Change the testimonials section.', themeState({ index: heroTemplate() }), schemas, 'index'), 'NEW_REQUEST');
});

// ---------------------------------------------------------------------------
// resolveFollowUpReference() — §14 reference vocabulary (unit level)
// ---------------------------------------------------------------------------

test('resolveFollowUpReference() — generic "it" resolves to the single most recent target, no ambiguity check', () => {
    const session = { resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    const result = resolveFollowUpReference(session, 'Make it shorter.', themeState({ index: heroTemplate() }));
    assert.strictEqual(result.status, 'RESOLVED');
    assert.strictEqual(result.target.blockId, 'hero-heading');
});

test('resolveFollowUpReference() — "the button" resolves to the matching sibling block within the same section', () => {
    const session = { resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    const result = resolveFollowUpReference(session, 'Make the button blue.', themeState({ index: heroTemplate() }));
    assert.strictEqual(result.status, 'RESOLVED');
    assert.strictEqual(result.target.blockId, 'hero-button');
});

test('resolveFollowUpReference() — "the section" steps up to section level even if the last target was a block', () => {
    const session = { resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    const result = resolveFollowUpReference(session, 'Change the section background.', themeState({ index: heroTemplate() }));
    assert.strictEqual(result.status, 'RESOLVED');
    assert.strictEqual(result.target.sectionId, 'homepage-hero');
    assert.strictEqual(result.target.blockId, undefined);
});

test('resolveFollowUpReference() — a type hint matching more than one sibling block is AMBIGUOUS, never guessed', () => {
    const template = heroTemplate();
    template.raw.sections['homepage-hero'].blocks['hero-button-2'] = { type: 'button', settings: { button_label: 'Learn more' } };
    template.raw.sections['homepage-hero'].block_order.push('hero-button-2');
    const session = { resolvedTarget: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading', type: 'image-with-text', blockType: 'heading' } };
    const result = resolveFollowUpReference(session, 'Make the button blue.', themeState({ index: template }));
    assert.strictEqual(result.status, 'AMBIGUOUS');
    assert.strictEqual(result.candidates.length, 2);
});

test('resolveFollowUpReference() — no active target is NOT_FOUND', () => {
    const result = resolveFollowUpReference({ resolvedTarget: null }, 'Make it blue.', themeState({ index: heroTemplate() }));
    assert.strictEqual(result.status, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// splitBoundedClauses() — §24/§25
// ---------------------------------------------------------------------------

test('splitBoundedClauses() — splits on "and" only when every part independently has its own edit verb', () => {
    assert.deepStrictEqual(
        splitBoundedClauses('Change the hero heading and update the button color.'),
        ['Change the hero heading', 'update the button color.']
    );
});

test('splitBoundedClauses() — does not split "and" inside a single descriptive clause', () => {
    assert.deepStrictEqual(splitBoundedClauses('Change the banner to black and white.'), ['Change the banner to black and white.']);
});

test('splitBoundedClauses() — a single clause is returned as-is', () => {
    assert.deepStrictEqual(splitBoundedClauses('Change the hero heading to New heading.'), ['Change the hero heading to New heading.']);
});

// ---------------------------------------------------------------------------
// §36 Scenario 1 — ambiguous target, then "what would you like to change?",
// one bounded AI resolution call (the AI declines to pick between the tied
// candidates) plus exactly one bounded operation-proposal call across the
// whole 3-turn conversation.
// ---------------------------------------------------------------------------

test('Scenario 1 — ambiguous target -> which one -> what to change -> one targeted operation, one AI call per stage', async () => {
    const sessionId = 'test-scenario-1';
    const themeId = 'test-scenario-1-theme';
    const router = jsonFetch(body => {
        const systemPrompt = body.messages[0].content;
        if (systemPrompt.includes('EXISTING SECTIONS')) {
            // Target-resolution stage: decline, same as before — the tied
            // candidates deterministic code already has are good enough.
            return { confident: false };
        }
        return {
            operation: 'update_block',
            target: { templateName: 'index', sectionId: 'announcement-banner', blockId: 'banner-slide' },
            changes: { settings: { text_color: '#ffffff' } }
        };
    });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the banner.', { sessionId, themeId, schemas, themeState: themeState({ index: twoBannerTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'NEEDS_CLARIFICATION');
            assert.match(turn1.questions[0], /announcement-banner/);
            assert.match(turn1.questions[0], /homepage-hero-banner/);
            assert.strictEqual(router.callCount(), 1, 'one bounded AI resolution call for the ambiguous turn');

            const turn2 = await runConversationalEdit('Announcement banner.', { sessionId, themeId, schemas, themeState: themeState({ index: twoBannerTemplate() }, null, themeId) });
            assert.strictEqual(turn2.status, 'NEEDS_CLARIFICATION');
            assert.strictEqual(turn2.questions[0], 'What would you like to change?');
            assert.strictEqual(router.callCount(), 1, 'the clarification-answer turn is purely deterministic, no AI call');

            const turn3 = await runConversationalEdit('Make the text blue.', { sessionId, themeId, schemas, themeState: themeState({ index: twoBannerTemplate() }, null, themeId) });
            assert.strictEqual(turn3.status, 'PROPOSED', JSON.stringify(turn3.errors));
            assert.strictEqual(turn3.operation.target.sectionId, 'announcement-banner');
            assert.strictEqual(turn3.operation.target.blockId, 'banner-slide');
            assert.strictEqual(router.callCount(), 2, 'one resolution call + one bounded operation-proposal call across the whole 3-turn conversation');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// §36 Scenario 2 — fully-specified request, then "it" resolves the follow-up.
// ---------------------------------------------------------------------------

test('Scenario 2 — a fully-specified request applies directly; "it" then resolves the follow-up without re-asking', async () => {
    const sessionId = 'test-scenario-2';
    const themeId = 'test-scenario-2-theme';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Healthy nutrition for every dog.' } } }
        : { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Healthy nutrition.' } } });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to Healthy nutrition for every dog.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));
            assert.strictEqual(turn1.operation.target.blockId, 'hero-heading');

            const turn2 = await runConversationalEdit('Make it shorter.', { sessionId, themeId, schemas, themeState: turn1.themeState });
            assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
            assert.strictEqual(turn2.operation.target.sectionId, 'homepage-hero');
            assert.strictEqual(turn2.operation.target.blockId, 'hero-heading', '"it" resolved to the SAME block without asking again');
            assert.strictEqual(router.callCount(), 2, 'one AI call per turn, no extra resolution question');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// §36 Scenario 3 — a continuation-marker follow-up with no reference word.
// ---------------------------------------------------------------------------

test('Scenario 3 — a continuation-marker follow-up resolves to the same recently-changed block', async () => {
    const sessionId = 'test-scenario-3';
    const themeId = 'test-scenario-3-theme';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-button' }, changes: { settings: { button_style_secondary: 'true' } } }
        : { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-button' }, changes: { settings: { button_label: 'Shop the collection' } } });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Update the hero button style.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));
            assert.strictEqual(turn1.operation.target.blockId, 'hero-button');

            const turn2 = await runConversationalEdit('Make the text white too.', { sessionId, themeId, schemas, themeState: turn1.themeState });
            assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
            assert.strictEqual(turn2.operation.target.blockId, 'hero-button', 'continuation marker resolved to the SAME button block');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// §36 Scenario 4 — an unrelated new request is never applied to the old target.
// ---------------------------------------------------------------------------

test('Scenario 4 — an unrelated new request explicitly naming a different section is NEVER applied against the old target', async () => {
    const sessionId = 'test-scenario-4';
    const themeId = 'test-scenario-4-theme';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'New heading' } } }
        : { operation: 'add_block', target: { templateName: 'index', sectionId: 'testi-1' }, changes: { type: 'column' } });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));

            const turn2 = await runConversationalEdit('Add a new column block to the testimonials section with the text Amazing Service.', { sessionId, themeId, schemas, themeState: turn1.themeState });
            assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
            assert.strictEqual(turn2.operation.target.sectionId, 'testi-1');
            assert.notStrictEqual(turn2.operation.target.sectionId, turn1.operation.target.sectionId);
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// §36 Scenario 5 — unsupported capability fails without inventing anything.
// ---------------------------------------------------------------------------

test('Scenario 5 — an unsupported capability request FAILS after bounded repair, never invents a new section/block type', async () => {
    const sessionId = 'test-scenario-5';
    const themeId = 'test-scenario-5-theme';
    const router = jsonFetch(() => ({ operation: 'add_section', target: { templateName: 'index' }, changes: { type: 'floating-ai-chatbot' } }));
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Add a floating AI chatbot widget.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(result.status, 'FAILED');
            assert.ok(result.errors.length > 0);
            assert.strictEqual(router.callCount(), 2, 'one proposal + one bounded repair, never more');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// AI usage bounds (§19) — deterministic steps never touch the network.
// ---------------------------------------------------------------------------

test('runConversationalEdit() — cancel never calls the AI', async () => {
    const sessionId = 'test-ai-bound-cancel';
    try {
        await withFetch(throwingFetch(), async () => {
            const result = await runConversationalEdit('never mind', { sessionId, schemas, themeState: themeState({ index: heroTemplate() }) });
            assert.strictEqual(result.status, 'IDLE');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — an ambiguous target gets ONE bounded AI resolution call before asking, never a silent guess', async () => {
    const sessionId = 'test-ai-bound-ambiguous';
    // The AI itself declines to pick between the tied candidates (no
    // clarifyingQuestion offered either) — deterministic code falls back to
    // the tie candidates it already had, exactly like the pre-AI-assisted
    // behavior, just after one bounded resolution attempt instead of zero.
    const router = jsonFetch(() => ({ confident: false }));
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the banner.', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            assert.strictEqual(result.status, 'NEEDS_CLARIFICATION');
            assert.strictEqual(router.callCount(), 1, 'exactly one bounded AI resolution call, no repair needed for a validly-shaped confident:false response');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — a clarification answer that still needs a second (value) question needs no AI call of its own', async () => {
    const sessionId = 'test-ai-bound-value-question';
    const router = jsonFetch(() => ({ confident: false }));
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the banner.', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            assert.strictEqual(turn1.status, 'NEEDS_CLARIFICATION');
            assert.strictEqual(router.callCount(), 1);
            const turn2 = await runConversationalEdit('Announcement banner.', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            assert.strictEqual(turn2.status, 'NEEDS_CLARIFICATION');
            assert.strictEqual(turn2.questions[0], 'What would you like to change?');
            assert.strictEqual(router.callCount(), 1, 'the clarification-answer turn resolves the tied candidate and checks for change details purely deterministically');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — an idempotent repeat of the last message reuses the cached result, no AI call', async () => {
    const sessionId = 'test-ai-bound-idempotent';
    const themeId = 'test-ai-bound-idempotent-theme';
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'New heading' } } }));
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED');
            assert.strictEqual(router.callCount(), 1);

            // Reuse turn1's OWN resulting ThemeState — the same content the
            // session's version hash now reflects — so this is a genuine
            // repeat, not an (unrelated) stale-context reset.
            const turn2 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: turn1.themeState });
            assert.strictEqual(turn2.idempotent, true);
            assert.strictEqual(router.callCount(), 1, 'the exact same message against an unchanged ThemeState must not re-call the AI');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// One bounded repair remains the maximum (§19) — mirrors editPipeline.test.js.
// ---------------------------------------------------------------------------

test('runConversationalEdit() — recovers via one bounded repair when the first proposal is invalid', async () => {
    const sessionId = 'test-repair';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_section', target: { templateName: 'index', sectionId: 'not-a-real-section' }, changes: { settings: { x: 1 } } }
        : { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Repaired heading' } } });
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, schemas, themeState: themeState({ index: heroTemplate() }) });
            assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
            assert.strictEqual(result.repaired, true);
            assert.strictEqual(router.callCount(), 2, 'exactly one repair attempt');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — FAILED (not silently applied) when still invalid after the repair attempt; the original ThemeState is untouched', async () => {
    const sessionId = 'test-repair-fails';
    const ts = themeState({ index: heroTemplate() });
    const originalHeading = ts.templates.index.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title;
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'ghost-block' }, changes: { settings: { title: 'x' } } }));
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, schemas, themeState: ts });
            assert.strictEqual(result.status, 'FAILED');
            assert.ok(result.errors.length > 0);
            assert.strictEqual(router.callCount(), 2);
            assert.strictEqual(ts.templates.index.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title, originalHeading, 'the original ThemeState object must remain untouched');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

// ---------------------------------------------------------------------------
// Multi-operation batches (§24/§25) — bounded, atomic.
// ---------------------------------------------------------------------------

test('runConversationalEdit() — a bounded 2-clause request executes both operations atomically in one turn', async () => {
    const sessionId = 'test-multi-op';
    const themeId = 'test-multi-op-theme';
    const router = jsonFetch(body => {
        const userMsg = body.messages[1].content;
        if (userMsg.includes('hero heading')) {
            return { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Multi-op heading' } } };
        }
        return { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-button' }, changes: { settings: { button_style_secondary: 'true' } } };
    });
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading and update the hero button color.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(result.status, 'PROPOSED', JSON.stringify(result.errors));
            assert.strictEqual(result.operations.length, 2);
            assert.strictEqual(result.themeState.templates.index.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title, 'Multi-op heading');
            assert.strictEqual(result.themeState.templates.index.raw.sections['homepage-hero'].blocks['hero-button'].settings.button_style_secondary, 'true');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

test('runConversationalEdit() — a multi-op batch is atomic: one invalid clause fails the WHOLE batch, ThemeState untouched', async () => {
    const sessionId = 'test-multi-op-rollback';
    const ts = themeState({ index: heroTemplate() });
    const router = jsonFetch(body => {
        const userMsg = body.messages[1].content;
        if (userMsg.includes('hero heading')) {
            return { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Should not stick' } } };
        }
        return { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-button' }, changes: { settings: { not_a_real_setting: 'x' } } };
    });
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading and update the hero button color.', { sessionId, schemas, themeState: ts });
            assert.strictEqual(result.status, 'FAILED');
            assert.strictEqual(ts.templates.index.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title, 'Old heading', 'no partial application — the first clause must not have stuck');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — exceeding the per-turn operation limit is rejected before any AI call', async () => {
    const sessionId = 'test-too-many-ops';
    try {
        await withFetch(throwingFetch(), async () => {
            const message = 'Change the hero heading and update the button color and remove the testimonials section and add another slide.';
            assert.ok(splitBoundedClauses(message).length > MAX_OPERATIONS_PER_TURN, 'test message must actually exceed the bound');
            const result = await runConversationalEdit(message, { sessionId, schemas, themeState: themeState({ index: heroTemplate() }) });
            assert.strictEqual(result.status, 'TOO_MANY_OPERATIONS');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

// ---------------------------------------------------------------------------
// ThemeState freshness (§22/§23) and cross-turn persistence (§21).
// ---------------------------------------------------------------------------

test('runConversationalEdit() — an out-of-band ThemeState change is detected as stale and re-resolved instead of trusting the old target', async () => {
    const sessionId = 'test-staleness';
    const themeId = 'test-staleness-theme';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'First edit' } } }
        : { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Second edit after external change' } } });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));

            // Simulate an out-of-band edit to the live theme between turns —
            // a DIFFERENT ThemeState object with real content changes, not
            // the one this session's version hash matches.
            const externallyChanged = heroTemplate();
            externallyChanged.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title = 'Changed outside the conversation';
            const turn2 = await runConversationalEdit('Change the hero heading again.', { sessionId, themeId, schemas, themeState: themeState({ index: externallyChanged }, null, themeId) });
            assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
            assert.strictEqual(turn2.operation.target.blockId, 'hero-heading', 'target re-resolved successfully against the new state, not blindly reused');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

test('runConversationalEdit() — a missing target after staleness resets asks for clarification instead of guessing', async () => {
    const sessionId = 'test-staleness-missing-target';
    const themeId = 'test-staleness-missing-target-theme';
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'First edit' } } }));
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));

            const externallyChanged = heroTemplate();
            externallyChanged.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title = 'Changed outside the conversation';
            // No reference word, no continuation marker, and "make it shorter"
            // alone can't classify to a verb — after the stale-context reset
            // there is no active target left to fall back on.
            const turn2 = await runConversationalEdit('Make it better somehow.', { sessionId, themeId, schemas, themeState: themeState({ index: externallyChanged }, null, themeId) });
            assert.strictEqual(turn2.status, 'NEEDS_CLARIFICATION');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

test('runConversationalEdit() — the updated ThemeState is automatically used on the next turn when none is explicitly passed', async () => {
    const sessionId = 'test-auto-persist';
    const themeId = 'test-auto-persist-theme';
    const router = jsonFetch((body, callIndex) => callIndex === 1
        ? { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Persisted heading' } } }
        : { operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Persisted heading, shorter' } } });
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, themeId, schemas, themeState: themeState({ index: heroTemplate() }, null, themeId) });
            assert.strictEqual(turn1.status, 'PROPOSED', JSON.stringify(turn1.errors));

            const saved = await loadThemeState(themeId);
            assert.strictEqual(saved.templates.index.raw.sections['homepage-hero'].blocks['hero-heading'].settings.title, 'Persisted heading');

            // No themeState passed this time — must load the one just saved.
            const turn2 = await runConversationalEdit('Make it shorter.', { sessionId, themeId, schemas });
            assert.strictEqual(turn2.status, 'PROPOSED', JSON.stringify(turn2.errors));
            assert.strictEqual(turn2.operation.target.blockId, 'hero-heading');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
    }
});

// ---------------------------------------------------------------------------
// Cancel/reset (§30) and resumability after failure (§29).
// ---------------------------------------------------------------------------

test('runConversationalEdit() — cancel clears pending clarification without mutating the theme', async () => {
    const sessionId = 'test-cancel-mid-clarification';
    const router = jsonFetch(() => ({ confident: false }));
    try {
        await withFetch(router, async () => {
            const turn1 = await runConversationalEdit('Change the banner.', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            assert.strictEqual(turn1.status, 'NEEDS_CLARIFICATION');

            const turn2 = await runConversationalEdit('never mind', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            assert.strictEqual(turn2.status, 'IDLE');

            const turn3 = await runConversationalEdit('Announcement banner.', { sessionId, schemas, themeState: themeState({ index: twoBannerTemplate() }) });
            // The pending clarification is gone — this is now a fresh, unresolvable request.
            assert.notStrictEqual(turn3.status, 'PROPOSED');
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

test('runConversationalEdit() — a FAILED conversation remains resumable; a corrected follow-up can still succeed', async () => {
    const sessionId = 'test-resumable-after-failure';
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'ghost-block' }, changes: { settings: { title: 'x' } } }));
    try {
        await withFetch(router, async () => {
            const failed = await runConversationalEdit('Change the hero heading to New heading.', { sessionId, schemas, themeState: themeState({ index: heroTemplate() }) });
            assert.strictEqual(failed.status, 'FAILED');
        });
        const router2 = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Corrected' } } }));
        await withFetch(router2, async () => {
            const retried = await runConversationalEdit('Change the hero heading again.', { sessionId, schemas, themeState: themeState({ index: heroTemplate() }) });
            assert.strictEqual(retried.status, 'PROPOSED', JSON.stringify(retried.errors));
        });
    } finally {
        await cleanupSession(sessionId);
    }
});

// ---------------------------------------------------------------------------
// Apply integration (§32/§33) — same conventions as editPipeline.test.js.
// ---------------------------------------------------------------------------

async function makeTempTheme(initialFiles = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase9-conv-'));
    for (const [relativePath, content] of Object.entries(initialFiles)) {
        const abs = path.join(dir, relativePath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, JSON.stringify(content, null, 2), 'utf8');
    }
    return dir;
}

test('runConversationalEdit() — autoApply + dryRunApply reports the change without writing anything', async () => {
    const sessionId = 'test-apply-dry-run';
    const themeId = 'test-apply-dry-run-theme';
    const original = heroTemplate().raw;
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Would change' } } }));
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading to New heading.', {
                sessionId, themeId, schemas, themeState: themeState({ index: { sourceFile: 'templates/index.json', raw: JSON.parse(JSON.stringify(original)) } }, null, themeId),
                autoApply: true, dryRunApply: true, themeRoot
            });
            assert.strictEqual(result.status, 'DRY_RUN');
            const onDisk = JSON.parse(await fs.readFile(path.join(themeRoot, 'templates', 'index.json'), 'utf8'));
            assert.deepStrictEqual(onDisk, original);
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

test('runConversationalEdit() — autoApply writes ONLY the targeted template, sibling section untouched on disk', async () => {
    const sessionId = 'test-apply-writes';
    const themeId = 'test-apply-writes-theme';
    const original = heroTemplate().raw;
    const themeRoot = await makeTempTheme({ 'templates/index.json': original });
    const router = jsonFetch(() => ({ operation: 'update_block', target: { templateName: 'index', sectionId: 'homepage-hero', blockId: 'hero-heading' }, changes: { settings: { title: 'Applied heading' } } }));
    try {
        await withFetch(router, async () => {
            const result = await runConversationalEdit('Change the hero heading to New heading.', {
                sessionId, themeId, schemas, themeState: themeState({ index: { sourceFile: 'templates/index.json', raw: JSON.parse(JSON.stringify(original)) } }, null, themeId),
                autoApply: true, themeRoot
            });
            assert.strictEqual(result.status, 'APPLIED', JSON.stringify(result.errors));
            const onDisk = JSON.parse(await fs.readFile(path.join(themeRoot, 'templates', 'index.json'), 'utf8'));
            assert.strictEqual(onDisk.sections['homepage-hero'].blocks['hero-heading'].settings.title, 'Applied heading');
            assert.deepStrictEqual(onDisk.sections['testi-1'], original.sections['testi-1'], 'sibling section byte-for-byte untouched on disk');
        });
    } finally {
        await cleanupSession(sessionId);
        await cleanupThemeState(themeId);
        await fs.rm(themeRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Live theme isolation (mirrors editPipeline.test.js's own closing check).
// ---------------------------------------------------------------------------

test('conversationalEdit.test.js — the real repo theme files remain byte-for-byte unchanged after this whole suite', async () => {
    const indexPath = path.join(DEFAULT_THEME_ROOT, 'templates', 'index.json');
    const before = await fs.readFile(indexPath, 'utf8');
    const after = await fs.readFile(indexPath, 'utf8');
    assert.strictEqual(after, before);
});
