/**
 * Footer-specific post-processing for staged generation's "footer-group"
 * candidate — see docs' footer coverage plan.
 *
 * The footer's "link_list" blocks reference a real Shopify navigation menu
 * handle (e.g. "main-menu") via a "menu" setting. There is no menu
 * inventory anywhere in this pipeline to validate an AI-invented handle
 * against (unlike product/collection handles, which validateDataReferences()
 * can check against known merchant data) — an invented handle could point
 * the footer at a menu that doesn't exist and silently break navigation.
 * So "menu" is deliberately absent from link_list.json's AI-facing schema,
 * and this module splices the REAL existing handles back in by position
 * before the candidate is merged.
 */

const { runStagedGeneration } = require('./generation');
const { validateCandidate } = require('./validation');
const { mergeThemeState } = require('./merge');
const { applyThemeState } = require('./apply');

const FOOTER_TEMPLATE_NAME = 'footer-group';
const FALLBACK_MENU_HANDLE = 'main-menu';

function existingLinkListMenus(existingFooterSection) {
    if (!existingFooterSection || !Array.isArray(existingFooterSection.block_order)) return [];
    const blocks = existingFooterSection.blocks || {};
    return existingFooterSection.block_order
        .map(id => blocks[id])
        .filter(block => block && block.type === 'link_list')
        .map(block => (block.settings && block.settings.menu) || FALLBACK_MENU_HANDLE);
}

/**
 * Returns a NEW candidate section object (does not mutate its input) with
 * "menu" spliced onto every link_list block's settings, matched by
 * positional order among link_list blocks specifically (not overall block
 * position — an image or email_signup block interleaved shouldn't shift the
 * matching). Candidate link_list blocks beyond the existing count fall back
 * to the first existing menu handle (or FALLBACK_MENU_HANDLE if the
 * existing footer had none), never left unset.
 */
function preserveFooterMenuHandles(candidateFooterSection, existingFooterSection) {
    const existingMenus = existingLinkListMenus(existingFooterSection);
    const fallbackMenu = existingMenus[0] || FALLBACK_MENU_HANDLE;

    let linkListIndex = 0;
    const blocks = {};
    for (const [blockId, block] of Object.entries(candidateFooterSection.blocks || {})) {
        if (block && block.type === 'link_list') {
            const menu = existingMenus[linkListIndex] || fallbackMenu;
            blocks[blockId] = { ...block, settings: { ...block.settings, menu } };
            linkListIndex++;
        } else {
            blocks[blockId] = block;
        }
    }

    return { ...candidateFooterSection, blocks };
}

/**
 * Returns a NEW candidate section object with any EXISTING block whose type
 * isn't in `aiManagedBlockTypes` (today: footer.json's allowed_blocks —
 * "link_list"/"email_signup") spliced back in verbatim, placed before the
 * candidate's own blocks. Without this, a block outside AI scope (e.g. the
 * footer's disabled logo/image block — deliberately excluded from
 * footer.json's allowed_blocks because it's a placement control, not
 * content) would silently disappear every regeneration: mergeForcedExclusiveTemplate()
 * fully replaces `blocks`/`block_order`, and the AI never mentions a type
 * it was never told about. This is the same "never silently discard data
 * the AI doesn't own" posture the rest of the pipeline already applies to
 * settings and menu handles.
 */
function preserveUnknownFooterBlocks(candidateFooterSection, existingFooterSection, aiManagedBlockTypes) {
    if (!existingFooterSection || !Array.isArray(existingFooterSection.block_order)) return candidateFooterSection;

    const managed = new Set(aiManagedBlockTypes || []);
    const existingBlocks = existingFooterSection.blocks || {};
    const preservedIds = existingFooterSection.block_order.filter(id => {
        const block = existingBlocks[id];
        return block && !managed.has(block.type);
    });
    if (preservedIds.length === 0) return candidateFooterSection;

    const blocks = {};
    const block_order = [];
    for (const id of preservedIds) {
        blocks[id] = existingBlocks[id];
        block_order.push(id);
    }
    for (const [id, block] of Object.entries(candidateFooterSection.blocks || {})) {
        blocks[id] = block;
        block_order.push(id);
    }

    return { ...candidateFooterSection, blocks, block_order };
}

/**
 * Generates footer content (plan → configure, exactly like an "index" or
 * "product" staged run — see generation.js) and applies it directly via
 * Phase 7 merge/apply — the only viable write path for a sections/*.json
 * file (the legacy 2-copy-to-theme.js copy step only knows about
 * templates/). Independent of the caller's own mergeApplyMode choice for
 * its main candidate; gated only by the caller checking autoCopy before
 * calling this at all, matching every other write in the pipeline.
 *
 * Never throws for an expected/recoverable condition (no footer-group file
 * in this theme, candidate/merge validation failure) — returns
 * {applied: false, reason} instead, so a failure here never undoes the
 * homepage generation that already succeeded by the time this runs. A
 * genuinely unexpected error (e.g. the AI call itself throwing after
 * exhausting retries) is allowed to propagate — the caller is expected to
 * catch and log it, same posture as any other AI call in the pipeline.
 *
 * options: { brief, schemas, themeState, themeRoot, requestId }
 *   - brief: the SAME resolved WebsiteBrief already used for the main
 *     candidate — no second clarification call.
 *   - schemas: the full AI schema catalog (runStagedGeneration narrows it
 *     internally, same as any other staged call).
 *   - themeState: the SAME Phase 4 ThemeState already built for the main
 *     candidate.
 */
async function generateAndApplyFooter(options = {}) {
    const { brief, schemas, themeState, themeRoot, requestId } = options;

    const existingFooterTemplate = themeState.templates[FOOTER_TEMPLATE_NAME];
    if (!existingFooterTemplate) {
        return { applied: false, aiCallCount: 0, reason: `no sections/${FOOTER_TEMPLATE_NAME}.json found in this theme` };
    }

    const staged = await runStagedGeneration({ brief, schemas, themeState, templateName: FOOTER_TEMPLATE_NAME, requestId });

    const candidateValidation = validateCandidate(staged.config, schemas, { templateName: FOOTER_TEMPLATE_NAME, themeState });
    if (!candidateValidation.valid) {
        return {
            applied: false,
            aiCallCount: staged.aiCallCount,
            reason: `candidate failed validation: ${candidateValidation.errors.map(e => `[${e.code}] ${e.path}: ${e.message}`).join('; ')}`
        };
    }

    const existingOrder = existingFooterTemplate.raw && existingFooterTemplate.raw.order;
    const existingFooterSection = Array.isArray(existingOrder) && existingOrder.length > 0
        ? existingFooterTemplate.raw.sections[existingOrder[0]]
        : null;

    // Splicing already-trusted EXISTING theme content (menu handles, blocks
    // the AI was never told about) back in after validation, not before —
    // it doesn't need re-validating, it was already real theme content.
    const candidateSectionId = staged.config.order[0];
    const footerSectionSchema = (schemas.sectionSchemas || []).find(s => s.id === 'footer');
    const aiManagedBlockTypes = (footerSectionSchema && footerSectionSchema.allowed_blocks) || ['link_list', 'email_signup'];
    let preservedSection = preserveUnknownFooterBlocks(staged.config.sections[candidateSectionId], existingFooterSection, aiManagedBlockTypes);
    preservedSection = preserveFooterMenuHandles(preservedSection, existingFooterSection);
    const preservedCandidate = {
        ...staged.config,
        sections: { ...staged.config.sections, [candidateSectionId]: preservedSection }
    };

    const mergeResult = mergeThemeState(themeState, {
        templateName: FOOTER_TEMPLATE_NAME,
        candidate: preservedCandidate,
        candidateValidation,
        requestId
    });
    if (!mergeResult.valid) {
        return {
            applied: false,
            aiCallCount: staged.aiCallCount,
            reason: `merge failed: ${mergeResult.conflicts.map(c => `[${c.code}] ${c.message}`).join('; ')}`
        };
    }

    await applyThemeState(mergeResult.mergedThemeState, {
        themeRoot,
        changedTemplates: [FOOTER_TEMPLATE_NAME],
        requestId
    });

    const linkListCount = Object.values(preservedSection.blocks || {}).filter(b => b && b.type === 'link_list').length;
    return { applied: true, aiCallCount: staged.aiCallCount, linkListCount };
}

module.exports = {
    FOOTER_TEMPLATE_NAME,
    FALLBACK_MENU_HANDLE,
    existingLinkListMenus,
    preserveFooterMenuHandles,
    preserveUnknownFooterBlocks,
    generateAndApplyFooter
};
