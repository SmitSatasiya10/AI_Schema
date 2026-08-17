/**
 * Proves that wiring instrumentation into makeAIRequest() / generateAIColorPalette()
 * did not change their generation behavior: same return values, same retry/backoff
 * behavior, same fallback-to-null on failure. `global.fetch` is mocked here so these
 * tests run offline/deterministically — no real OpenRouter calls are made.
 *
 * OPENROUTER_API_KEY is set before requiring example-implementation.js because the
 * module reads it into a module-level constant at require time (existing behavior,
 * unchanged by Phase 1) — `node --test` runs each test file in its own process, so
 * this doesn't leak into other test files.
 */
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-for-phase1-tests';

const test = require('node:test');
const assert = require('node:assert');
const { makeAIRequest, generateAIColorPalette } = require('../example-implementation');

function jsonResponse(body, status = 200) {
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
    });
}

test('makeAIRequest() — returns AI content unchanged when an instrumentation context is supplied', async () => {
    const originalFetch = global.fetch;
    global.fetch = jsonResponse({ choices: [{ message: { content: '{"sections":{},"order":[]}' } }] });
    try {
        const result = await makeAIRequest('test prompt', 'test system prompt', 3, { requestId: 'test-req-1', callType: 'test' });
        assert.strictEqual(result, '{"sections":{},"order":[]}');
    } finally {
        global.fetch = originalFetch;
    }
});

test('makeAIRequest() — returns identical output with and without an explicit context argument', async () => {
    const originalFetch = global.fetch;
    global.fetch = jsonResponse({ choices: [{ message: { content: 'same-content' } }] });
    try {
        const withoutContext = await makeAIRequest('p', 's');
        const withContext = await makeAIRequest('p', 's', 3, { requestId: 'x' });
        assert.strictEqual(withoutContext, withContext);
    } finally {
        global.fetch = originalFetch;
    }
});

test('makeAIRequest() — still throws after exhausting retries on a 5xx response (network-retry behavior unchanged)', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
        calls++;
        return { ok: false, status: 500, text: async () => 'server error' };
    };
    try {
        await assert.rejects(() => makeAIRequest('p', 's', 1), /OpenRouter API error/);
        assert.strictEqual(calls, 1, 'with maxRetries=1 there should be exactly one attempt and no retry sleep');
    } finally {
        global.fetch = originalFetch;
    }
});

test('makeAIRequest() — logs a structured AI_CALL instrumentation line without altering the return value', async () => {
    const originalFetch = global.fetch;
    const originalLog = console.log;
    const lines = [];
    console.log = (msg) => lines.push(msg);
    global.fetch = jsonResponse({ choices: [{ message: { content: 'hello' } }] });
    let result;
    try {
        result = await makeAIRequest('p', 's', 3, { requestId: 'log-test', callType: 'main_generation' });
    } finally {
        global.fetch = originalFetch;
        console.log = originalLog;
    }
    assert.strictEqual(result, 'hello');
    const line = lines.find(l => typeof l === 'string' && l.startsWith('[AI_CALL]'));
    assert.ok(line, 'expected an [AI_CALL] instrumentation log line');
    const payload = JSON.parse(line.replace('[AI_CALL] ', ''));
    assert.strictEqual(payload.requestId, 'log-test');
    assert.strictEqual(payload.callType, 'main_generation');
    assert.strictEqual(payload.success, true);
    assert.ok(payload.durationMs >= 0);
    assert.ok(payload.promptChars > 0);
    assert.strictEqual(payload.estimatedInputTokens, Math.ceil(payload.promptChars / 4));
});

test('generateAIColorPalette() — returns null on API failure without throwing (unchanged fallback behavior)', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'fail' });
    try {
        const result = await generateAIColorPalette('a test store', 2, { requestId: 'color-1' });
        assert.strictEqual(result, null);
    } finally {
        global.fetch = originalFetch;
    }
});

test('generateAIColorPalette() — returns the parsed palette unchanged when the API succeeds', async () => {
    const originalFetch = global.fetch;
    const palette = { niche: 'test', colors_accent_1: '#111111', colors_accent_2: '#222222' };
    global.fetch = jsonResponse({ choices: [{ message: { content: JSON.stringify(palette) } }] });
    try {
        const result = await generateAIColorPalette('a test store', 2, { requestId: 'color-2' });
        assert.strictEqual(result.colors_accent_1, palette.colors_accent_1);
        assert.strictEqual(result.colors_accent_2, palette.colors_accent_2);
    } finally {
        global.fetch = originalFetch;
    }
});
