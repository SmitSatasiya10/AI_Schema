/**
 * CLI-wiring tests for 3-interactive-menu.js's runEditSession() — the menu
 * option that exposes Phase 8/9's targeted-edit engine (edit-pipeline.js /
 * conversational-edit.js) through the interactive menu. Stubs
 * runConversationalEdit(), buildThemeState() and loadSchemas() directly (by
 * mutating the exported functions on their modules — runEditSession()
 * re-requires each module on every call, so a mutated export is picked up
 * immediately) so these tests assert only the CLI loop's own branching:
 * which status leads to another prompt vs. ending the session, and that the
 * session id / themeState-seeding contract is honored across turns. No real
 * AI call, no real theme file I/O.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-menu-tests';

const test = require('node:test');
const assert = require('node:assert');

const themeStateModule = require('../theme-state');
const schemaModule = require('../example-implementation');
const conversationalEditModule = require('../conversational-edit');
const { runEditSession, rl } = require('../3-interactive-menu');

const FAKE_THEME_STATE = { meta: { templateCount: 1, sectionCount: 2 } };
const FAKE_SCHEMAS = { sectionSchemas: [], blockSchemas: [] };

// rl is a real readline.Interface bound to process.stdin/stdout — stub just
// its question() method so no test ever waits on real stdin, and close it
// once at the end so the readline interface doesn't keep the test process
// alive after the suite finishes.
function queueAnswers(answers) {
    let i = 0;
    rl.question = (_question, cb) => {
        const answer = i < answers.length ? answers[i] : '';
        i++;
        cb(answer);
    };
}

function stubEngine(responses) {
    const originalBuildThemeState = themeStateModule.buildThemeState;
    const originalLoadSchemas = schemaModule.loadSchemas;
    const originalRunConversationalEdit = conversationalEditModule.runConversationalEdit;

    const calls = [];
    themeStateModule.buildThemeState = async () => FAKE_THEME_STATE;
    schemaModule.loadSchemas = async () => FAKE_SCHEMAS;
    let callIndex = 0;
    conversationalEditModule.runConversationalEdit = async (message, options) => {
        calls.push({ message, options });
        const response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex++;
        return response;
    };

    return {
        calls,
        async restore() {
            themeStateModule.buildThemeState = originalBuildThemeState;
            schemaModule.loadSchemas = originalLoadSchemas;
            conversationalEditModule.runConversationalEdit = originalRunConversationalEdit;
        }
    };
}

test.after(() => rl.close());

test('runEditSession() — a single APPLIED turn seeds themeState once and ends on an empty follow-up', async () => {
    const stub = stubEngine([
        {
            status: 'APPLIED', sessionId: 's1',
            changeSummary: { operation: 'update_block', target: 'index.homepage-hero.hero-heading', changed: ['settings.title'] },
            applyResult: { filesWritten: ['templates/index.json'] }
        }
    ]);
    queueAnswers(['']); // "Anything else?" -> Enter to finish
    try {
        await runEditSession('Change the hero heading to Summer Sale');
    } finally {
        await stub.restore();
    }

    assert.strictEqual(stub.calls.length, 1);
    assert.strictEqual(stub.calls[0].message, 'Change the hero heading to Summer Sale');
    assert.strictEqual(stub.calls[0].options.sessionId, null);
    assert.strictEqual(stub.calls[0].options.autoApply, true);
    assert.strictEqual(stub.calls[0].options.themeState, FAKE_THEME_STATE);
});

test('runEditSession() — NEEDS_CLARIFICATION prints the question, feeds the answer back into the SAME session, and stops re-seeding themeState', async () => {
    const stub = stubEngine([
        { status: 'NEEDS_CLARIFICATION', sessionId: 's1', questions: ['Which banner did you mean?\n1. announcement-banner\n2. homepage-hero-banner'] },
        {
            status: 'APPLIED', sessionId: 's1',
            changeSummary: { operation: 'update_block', target: 'index.announcement-banner.banner-slide', changed: ['settings.text_color'] },
            applyResult: { filesWritten: ['templates/index.json'] }
        }
    ]);
    queueAnswers(['Announcement banner.', '']);
    try {
        await runEditSession('Change the banner.');
    } finally {
        await stub.restore();
    }

    assert.strictEqual(stub.calls.length, 2);
    assert.strictEqual(stub.calls[0].options.themeState, FAKE_THEME_STATE);
    assert.strictEqual(stub.calls[1].message, 'Announcement banner.');
    assert.strictEqual(stub.calls[1].options.sessionId, 's1');
    assert.strictEqual(stub.calls[1].options.themeState, undefined);
});

test('runEditSession() — a FAILED turn stays resumable in the same session instead of aborting', async () => {
    const stub = stubEngine([
        {
            status: 'FAILED', sessionId: 's1',
            errors: [{ code: 'OPERATION_TARGET_NOT_FOUND', path: 'operation.target.sectionId', message: 'Section "nope" does not exist.' }]
        },
        {
            status: 'APPLIED', sessionId: 's1',
            changeSummary: { operation: 'update_section', target: 'index.testi-1', changed: ['settings.heading'] },
            applyResult: { filesWritten: ['templates/index.json'] }
        }
    ]);
    queueAnswers(['Change the testimonials heading instead.', '']);
    try {
        await runEditSession('Change the nope section.');
    } finally {
        await stub.restore();
    }

    assert.strictEqual(stub.calls.length, 2);
    assert.strictEqual(stub.calls[1].message, 'Change the testimonials heading instead.');
    assert.strictEqual(stub.calls[1].options.sessionId, 's1');
});

test('runEditSession() — "exit" ends the session immediately without another engine call', async () => {
    const stub = stubEngine([
        { status: 'NEEDS_CLARIFICATION', sessionId: 's1', questions: ['Which banner did you mean?'] }
    ]);
    queueAnswers(['exit']);
    try {
        await runEditSession('Change the banner.');
    } finally {
        await stub.restore();
    }

    assert.strictEqual(stub.calls.length, 1);
});

test('runEditSession() — INITIAL_GENERATION redirects the merchant instead of silently doing nothing', async () => {
    const stub = stubEngine([
        { status: 'INITIAL_GENERATION', sessionId: 's1' },
        {
            status: 'APPLIED', sessionId: 's1',
            changeSummary: { operation: 'update_section', target: 'index.homepage-hero', changed: ['settings.heading'] },
            applyResult: { filesWritten: ['templates/index.json'] }
        }
    ]);
    queueAnswers(['Change the hero heading instead.', '']);
    try {
        await runEditSession('Create a whole new store.');
    } finally {
        await stub.restore();
    }

    assert.strictEqual(stub.calls.length, 2);
    assert.strictEqual(stub.calls[1].message, 'Change the hero heading instead.');
});
