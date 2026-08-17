/**
 * Phase 8 — Targeted Editing Orchestration.
 *
 * Wires together: deterministic request classification (§29/§30) →
 * deterministic target resolution against ThemeState (operations.js, §8/§9)
 * → clarification on ambiguity (§10/§23) → ONE bounded AI operation
 * PROPOSAL scoped to just the resolved target (§12) → deterministic
 * validation/execution (operations.js, unmodified) → optional Phase 7
 * apply (§26).
 *
 * The split this file preserves, matching §24 exactly (and the same split
 * Phase 5 already established for GenerationPlan): the AI PROPOSES one
 * operation object; this file's `runOperationProposalStage()` never trusts
 * it directly — `operations.js`'s `validateOperation()`/
 * `applyOperationToThemeState()` (both untouched, reused as-is) are the
 * only code that decides whether a proposal is safe and the only code that
 * actually mutates a ThemeState. This file adds no new mutation logic of
 * its own.
 *
 * §27 — a targeted edit must never fall into Phase 7's full-structure
 * replacement path. It doesn't: `runTargetedEdit()`'s optional apply step
 * calls `apply.js`'s `applyThemeState()` DIRECTLY on the
 * operation-mutated ThemeState, never `merge.js`. `merge.js`'s two
 * policies (splice-by-type / full-structure-replace) exist specifically to
 * reconcile a whole-template INITIAL GENERATION candidate against existing
 * state (see merge.js's file header) — an operation's result is neither of
 * those; `executeOperation()` in operations.js already knows precisely
 * what changed and what to preserve, so there is nothing left for
 * merge.js's policy logic to decide. This is the one Phase 7 boundary
 * worth calling out explicitly, per §27's own warning.
 */

const instrumentation = require('./instrumentation');
const { retrieveRelevantSchemas } = require('./retrieval');
const { makeAIRequest } = require('./example-implementation');
const {
    OPERATION_TYPES,
    resolveSectionTarget,
    resolveBlockTarget,
    validateOperation,
    applyOperationToThemeState
} = require('./operations');
const { applyThemeState } = require('./apply');

// ---------------------------------------------------------------------------
// §29/§30 — deterministic request classification. Intentionally small: a
// short, curated verb list, not NLP. "Do not over-classify" — an unclear
// request routes to AMBIGUOUS (clarification), never a guessed operation
// count.
// ---------------------------------------------------------------------------

const CREATE_SIGNAL_PHRASES = ['create a', 'create an', 'build a', 'build me', 'design a', 'generate a', 'make me a store', 'make a store', 'make a homepage', 'redesign', 'entire store', 'whole store', 'entire homepage'];
const EDIT_VERBS = ['change', 'update', 'remove', 'delete', 'add', 'move', 'replace', 'edit', 'modify', 'set'];

// A request only has a legitimate reason to target NO existing section when
// it's asking to CREATE one — everything else (update/remove/a vague "change
// one section" with no section named) needs an existing target, so a
// NOT_FOUND resolution there must ask which section rather than let the AI
// guess an operation with zero grounding.
const ADD_SIGNAL_VERBS = ['add', 'create', 'insert', 'new'];

function classifyRequest(userPrompt) {
    const lower = (userPrompt || '').toLowerCase();
    if (CREATE_SIGNAL_PHRASES.some(phrase => lower.includes(phrase))) {
        return 'INITIAL_GENERATION';
    }
    if (EDIT_VERBS.some(verb => new RegExp(`\\b${verb}\\b`).test(lower))) {
        return 'TARGETED_EDIT';
    }
    return 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------
// §10 — clarification question shape, matching clarification.js's existing
// protocol (an array of plain-text questions) rather than inventing a
// second question format.
// ---------------------------------------------------------------------------

function buildAmbiguityQuestion(candidates, kind) {
    const options = candidates.map((c, i) => `${i + 1}. ${c.sectionId || c.blockId} (${c.type})`).join('\n');
    return `Which ${kind} did you mean?\n${options}`;
}

// ---------------------------------------------------------------------------
// §12 — bounded operation-proposal prompt. Scoped to the resolved target's
// CURRENT settings + its own schema (never the whole ThemeState, never the
// whole catalog); for add-shaped requests where nothing resolved, scoped to
// Phase 2's deterministic retrieval pool for this template (already
// bounded, already tested) rather than the full 69-schema catalog.
// ---------------------------------------------------------------------------

function buildProposalSystemPrompt(templateName, targetContext, candidatePool) {
    let rules = `You are a Shopify theme EDITOR. The merchant wants exactly ONE targeted change to their EXISTING theme. Propose exactly ONE structured operation as JSON:
{
  "operation": "<one of: ${OPERATION_TYPES.join(', ')}>",
  "target": { "templateName": "${templateName}", "sectionId": "<existing section id, if editing/removing one>", "blockId": "<existing block id, if editing/removing one>" },
  "changes": { "settings": { }, "type": "<existing schema type id, only for add_section/add_block>", "position": "start|end" }
}

CRITICAL RULES:
1. If the operation targets an EXISTING section or block, target.sectionId/target.blockId MUST be copied VERBATIM from CURRENT TARGET CONTEXT below — never invent an id.
2. changes.settings must use ONLY setting keys defined by the relevant schema below, and must include ONLY the settings that are actually changing — do not restate settings that aren't changing.
3. For add_section/add_block, changes.type must be copied VERBATIM from an "id" listed in AVAILABLE TYPES below.
4. Never invent a product handle, collection handle, or other merchant-specific data — leave such a setting out of changes entirely if you don't know a real value.
5. Return ONLY the JSON object — no explanation, no markdown.
6. If the request does not clearly map to exactly one of the supported operation types, still propose your best single guess — validation will catch anything unsafe.`;

    if (targetContext) {
        rules += `\n\nCURRENT TARGET CONTEXT (the existing component you are most likely editing):\n${JSON.stringify(targetContext, null, 2)}`;
    }
    if (candidatePool) {
        rules += `\n\nAVAILABLE TYPES (for add_section/add_block only):\n${JSON.stringify(candidatePool, null, 2)}`;
    }
    return rules;
}

function buildProposalUserPrompt(userPrompt, repairErrors) {
    let prompt = `Merchant request: "${userPrompt}"\n\nProduce the operation JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

/**
 * ONE bounded AI call, ONE bounded repair — the exact same shape
 * generation.js's runPlanningStage() already established for GenerationPlan
 * (§21's "bounded recovery" architecture, reused, not reinvented).
 */
async function runOperationProposalStage({ userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId }) {
    const systemPrompt = buildProposalSystemPrompt(templateName, targetContext, candidatePool);
    const validationContext = { themeState, schemas, knownMerchantData };

    function parseAndValidate(content) {
        let operation;
        try {
            operation = JSON.parse(content);
        } catch (error) {
            return { operation: null, validation: { valid: false, errors: [{ code: 'OPERATION_INVALID', path: 'operation', message: `not valid JSON: ${error.message}` }] } };
        }
        return { operation, validation: validateOperation(operation, validationContext) };
    }

    const firstContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, null), systemPrompt, 2, { requestId, callType: 'operation_proposal' });
    let { operation, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairErrors = validation.errors.map(e => e.message);
        const repairContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, repairErrors), systemPrompt, 2, { requestId, callType: 'operation_proposal_repair' });
        ({ operation, validation } = parseAndValidate(repairContent));
    }

    return { operation, validation, repaired };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * options:
 *   - themeState: REQUIRED, a Phase 4 ThemeState.
 *   - schemas: REQUIRED, the full AI schema catalog.
 *   - templateName: default 'index'.
 *   - knownMerchantData: optional {products:[], collections:[]}.
 *   - autoApply: if true, a successfully executed operation is also
 *     persisted via apply.js (still an explicit, opt-in step — §22's
 *     "apply must be explicit" applies here exactly as it does in
 *     1-generate-theme.js).
 *   - themeRoot / dryRunApply: forwarded to applyThemeState() when
 *     autoApply is set.
 */
async function runTargetedEdit(userPrompt, options = {}) {
    const {
        themeState,
        schemas,
        templateName = 'index',
        knownMerchantData = {},
        autoApply = false,
        themeRoot,
        dryRunApply = false,
        requestId = instrumentation.nextRequestId('edit')
    } = options;

    if (!themeState) throw new Error('runTargetedEdit() requires a ThemeState');
    if (!schemas || !Array.isArray(schemas.sectionSchemas)) throw new Error('runTargetedEdit() requires the full AI schema catalog');

    const startTime = Date.now();
    const classification = classifyRequest(userPrompt);

    if (classification !== 'TARGETED_EDIT') {
        instrumentation.logEditPipeline({ requestId, status: classification, classification, durationMs: Date.now() - startTime });
        return { status: classification, classification };
    }

    // §8/§9 — deterministic target resolution against ThemeState, using the
    // raw request text as the natural-language query. An exact existing
    // section id embedded in the prompt (unlikely from a human, common from
    // a programmatic caller) short-circuits via resolveSectionTarget()'s own
    // exact-match fast path.
    const sectionTarget = resolveSectionTarget(themeState, templateName, userPrompt, schemas);

    if (sectionTarget.status === 'AMBIGUOUS') {
        const result = {
            status: 'NEEDS_CLARIFICATION',
            classification,
            targetStatus: sectionTarget.status,
            templateName,
            candidates: sectionTarget.candidates,
            questions: [buildAmbiguityQuestion(sectionTarget.candidates, 'section')]
        };
        instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, durationMs: Date.now() - startTime });
        return result;
    }

    // §10/§29 — NOT_FOUND means no existing section matched at all. When the
    // template exists but nothing in it matched (a vague "change one
    // section" that names no section), there's no target to propose an
    // operation against, so ask which section instead of sending an
    // ungrounded AI call that can only guess. This does NOT apply when the
    // template itself isn't present in the ThemeState at all — that's the
    // legitimate shape of a global-settings-only request (no section is
    // ever the target for update_global_settings), which must still reach
    // the AI proposal below.
    const targetTemplate = themeState.templates[templateName];
    if (sectionTarget.status === 'NOT_FOUND' && targetTemplate) {
        const looksLikeAdd = ADD_SIGNAL_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, 'i').test(userPrompt));
        if (!looksLikeAdd) {
            const availableSections = Object.entries(targetTemplate.raw.sections || {}).map(([sectionId, section]) => ({ sectionId, type: section.type }));
            const result = {
                status: 'NEEDS_CLARIFICATION',
                classification,
                targetStatus: sectionTarget.status,
                templateName,
                candidates: availableSections,
                questions: [buildAmbiguityQuestion(availableSections, 'section')]
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, durationMs: Date.now() - startTime });
            return result;
        }
    }

    let targetContext = null;
    if (sectionTarget.status === 'RESOLVED') {
        const sectionSchema = schemas.sectionSchemas.find(s => s.id === sectionTarget.section.type);
        targetContext = {
            sectionId: sectionTarget.sectionId,
            type: sectionTarget.section.type,
            currentSettings: sectionTarget.section.settings || {},
            schemaSettings: sectionSchema ? sectionSchema.settings : {}
        };

        const blockTarget = resolveBlockTarget(sectionTarget.section, userPrompt, schemas);
        if (blockTarget.status === 'AMBIGUOUS') {
            const result = {
                status: 'NEEDS_CLARIFICATION',
                classification,
                targetStatus: blockTarget.status,
                templateName,
                sectionId: sectionTarget.sectionId,
                candidates: blockTarget.candidates,
                questions: [buildAmbiguityQuestion(blockTarget.candidates, 'block')]
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: blockTarget.status, durationMs: Date.now() - startTime });
            return result;
        }
        if (blockTarget.status === 'RESOLVED') {
            const blockSchema = schemas.blockSchemas.find(b => b.id === blockTarget.block.type);
            targetContext.block = {
                blockId: blockTarget.blockId,
                type: blockTarget.block.type,
                currentSettings: blockTarget.block.settings || {},
                schemaSettings: blockSchema ? blockSchema.settings : {}
            };
        }
    }

    // §12 — bounded candidate pool for add-shaped requests, reusing Phase 2
    // retrieval rather than sending the full 69-schema catalog.
    const retrieved = retrieveRelevantSchemas(schemas, { userPrompt, templateName, requestId });
    const candidatePool = {
        sections: retrieved.sectionSchemas.map(s => ({ id: s.id, label: s.label, summary: s.purpose })),
        blocks: retrieved.blockSchemas.map(b => ({ id: b.id, label: b.label, summary: b.purpose }))
    };

    const { operation, validation, repaired } = await runOperationProposalStage({
        userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId
    });

    if (!validation.valid) {
        const result = { status: 'FAILED', classification, targetStatus: sectionTarget.status, errors: validation.errors, operation, repaired };
        instrumentation.logEditPipeline({ requestId, status: 'FAILED', classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: repaired ? 2 : 1, durationMs: Date.now() - startTime });
        return result;
    }

    const executed = applyOperationToThemeState(themeState, operation, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        const result = { status: 'FAILED', classification, targetStatus: sectionTarget.status, errors: executed.errors, operation, repaired };
        instrumentation.logEditPipeline({ requestId, status: 'FAILED', classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: repaired ? 2 : 1, durationMs: Date.now() - startTime });
        return result;
    }

    let applyResult = null;
    if (autoApply) {
        const changedTemplates = operation.operation === 'update_global_settings' ? [] : [operation.target.templateName];
        applyResult = await applyThemeState(executed.themeState, {
            themeRoot,
            changedTemplates,
            writeGlobalSettings: operation.operation === 'update_global_settings',
            dryRun: dryRunApply,
            requestId
        });
    }

    const result = {
        status: autoApply ? (dryRunApply ? 'DRY_RUN' : 'APPLIED') : 'PROPOSED',
        classification,
        targetStatus: sectionTarget.status,
        operation,
        changeSummary: executed.changeSummary,
        themeState: executed.themeState,
        applyResult,
        repaired
    };
    instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: repaired ? 2 : 1, durationMs: Date.now() - startTime });
    return result;
}

module.exports = {
    CREATE_SIGNAL_PHRASES,
    EDIT_VERBS,
    classifyRequest,
    buildAmbiguityQuestion,
    buildProposalSystemPrompt,
    buildProposalUserPrompt,
    runOperationProposalStage,
    runTargetedEdit
};
