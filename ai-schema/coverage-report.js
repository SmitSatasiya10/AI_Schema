/**
 * Phase 11 — Schema Coverage Discovery.
 *
 * A deterministic comparison of the REAL Shopify theme's Liquid section/
 * block files (ground truth, §4 of AI_THEME_BUILDER_PHASE11_PLAN.md)
 * against the AI schema catalog (`sections/*.json`, `blocks/*.json`).
 * Produces a machine-readable coverage report (§6/§7) that the rest of
 * Phase 11 uses to prioritize additions, and that a test suite can assert
 * against directly.
 *
 * Two things this file intentionally does NOT do:
 *   - It never writes/modifies any `.liquid` file (§26 — read-only source
 *     material).
 *   - It never decides "which schemas to add" — that's an editorial
 *     judgment (§8/§9), made once per report by a human/AI reading its
 *     output, not automated here.
 *
 * Determinism (§33): every directory listing is sorted before use; nothing
 * here depends on filesystem iteration order.
 */

const fs = require('fs').promises;
const path = require('path');
const { DEFAULT_THEME_ROOT } = require('./theme-state');

const REAL_SECTIONS_DIR = path.join(DEFAULT_THEME_ROOT, 'sections');
const REAL_BLOCKS_DIR = path.join(DEFAULT_THEME_ROOT, 'blocks');
const AI_SECTIONS_DIR = path.join(__dirname, 'sections');
const AI_BLOCKS_DIR = path.join(__dirname, 'blocks');

// ---------------------------------------------------------------------------
// Real Liquid `{% schema %}` extraction. Real Shopify section/standalone-
// block schema JSON does NOT carry its own "type"/"id" field — Shopify
// identifies a section/block by its FILE BASENAME (confirmed: `slideshow`
// used as a `type` value in templates/*.json corresponds to
// `sections/slideshow.liquid`, whose own {% schema %} has no "type" key at
// all — only inline blocks defined WITHIN a section's own `blocks` array
// carry a local "type"). The basename is therefore the correct real-world
// identifier to compare against the AI catalog's own `id` field.
// ---------------------------------------------------------------------------

const HEADER_TYPES = new Set(['header', 'paragraph']); // Shopify UI-only, never real settings

function extractSchemaBlock(liquidSource) {
    const match = liquidSource.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
    if (!match) return { present: false, parsed: null, parseError: null };
    try {
        return { present: true, parsed: JSON.parse(match[1]), parseError: null };
    } catch (error) {
        return { present: true, parsed: null, parseError: error.message };
    }
}

async function listFiles(dir, extension) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return entries.filter(e => e.isFile() && e.name.endsWith(extension)).map(e => e.name).sort();
}

/**
 * Inventories every real `.liquid` file in `dir`. Returns one entry per
 * file: { file, id, hasSchemaTag, parseError, name, settingCount, blockTypes }.
 * `settingCount` excludes Shopify's UI-only `header`/`paragraph` settings
 * entries (§11 — those aren't real configurable settings at all).
 */
async function inventoryRealDefinitions(dir) {
    const files = await listFiles(dir, '.liquid');
    const entries = [];
    for (const file of files) {
        const source = await fs.readFile(path.join(dir, file), 'utf8');
        const schema = extractSchemaBlock(source);
        const id = file.replace(/\.liquid$/, '');
        const settings = schema.parsed && Array.isArray(schema.parsed.settings) ? schema.parsed.settings : [];
        entries.push({
            file,
            id,
            hasSchemaTag: schema.present,
            parseError: schema.parseError,
            name: schema.parsed ? (schema.parsed.name || null) : null,
            settingCount: settings.filter(s => !HEADER_TYPES.has(s.type)).length,
            blockTypes: schema.parsed && Array.isArray(schema.parsed.blocks)
                ? [...new Set(schema.parsed.blocks.map(b => b.type).filter(Boolean))]
                : []
        });
    }
    return entries;
}

/**
 * Inventories every AI schema `.json` file in `dir`. Returns one entry per
 * file: { file, id, parseError, allowedBlocks }. Unlike
 * `example-implementation.js`'s `loadAllSchemasFromDisk()` (which discards
 * the filename after parsing — correct for its own purposes), this keeps
 * BOTH file and id, since coverage discovery needs to detect filename/id
 * drift and duplicate ids by file, not just resolve a final id → schema
 * mapping.
 */
async function inventoryAISchemas(dir) {
    const files = await listFiles(dir, '.json');
    const entries = [];
    for (const file of files) {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        let parsed = null, parseError = null;
        try { parsed = JSON.parse(raw); } catch (error) { parseError = error.message; }
        entries.push({
            file,
            id: parsed ? parsed.id : null,
            parseError,
            allowedBlocks: parsed && Array.isArray(parsed.allowed_blocks) ? parsed.allowed_blocks : []
        });
    }
    return entries;
}

function findDuplicateIds(entries) {
    const seenAt = new Map();
    const duplicates = [];
    const reportedIds = new Set();
    for (const entry of entries) {
        if (!entry.id) continue;
        if (seenAt.has(entry.id)) {
            if (!reportedIds.has(entry.id)) {
                duplicates.push({ id: entry.id, files: [seenAt.get(entry.id), entry.file] });
                reportedIds.add(entry.id);
            } else {
                duplicates.find(d => d.id === entry.id).files.push(entry.file);
            }
        } else {
            seenAt.set(entry.id, entry.file);
        }
    }
    return duplicates;
}

/**
 * Pure comparison — takes already-inventoried real/AI entries (both
 * sections and blocks) and produces the coverage report. Split from I/O
 * (`buildCoverageReport()` below) the same way `theme-state.js` splits
 * `buildThemeState()` (I/O) from its pure validators.
 */
function compareCoverage(real, aiEntries) {
    const aiIds = new Set(aiEntries.filter(e => e.id).map(e => e.id));
    const realWithSchema = real.filter(r => r.hasSchemaTag && r.parseError === null);
    const realNoSchema = real.filter(r => !r.hasSchemaTag);
    const realParseError = real.filter(r => r.hasSchemaTag && r.parseError !== null);

    const supported = realWithSchema.filter(r => aiIds.has(r.id)).map(r => r.id).sort();
    const unsupported = realWithSchema.filter(r => !aiIds.has(r.id))
        .map(r => ({ id: r.id, file: r.file, name: r.name, settingCount: r.settingCount, blockTypes: r.blockTypes }))
        .sort((a, b) => b.settingCount - a.settingCount || a.id.localeCompare(b.id));

    const realIds = new Set(real.map(r => r.id));
    const staleAISchemas = aiEntries.filter(e => e.id && !realIds.has(e.id)).map(e => ({ id: e.id, file: e.file }));

    const filenameIdMismatches = aiEntries
        .filter(e => e.id && e.file.replace(/\.json$/, '') !== e.id)
        .map(e => ({ file: e.file, id: e.id }));

    return {
        totalReal: real.length,
        totalAI: aiEntries.length,
        supported,
        unsupported,
        noSchemaTag: realNoSchema.map(r => r.file).sort(),
        schemaParseErrors: realParseError.map(r => ({ file: r.file, error: r.parseError })),
        staleAISchemas,
        filenameIdMismatches,
        duplicateAIIds: findDuplicateIds(aiEntries)
    };
}

/**
 * Real Shopify block "types" come from two genuinely different sources:
 * standalone `blocks/*.liquid` files (their basename IS their id), AND
 * block types declared INLINE inside a real SECTION's own `blocks` array
 * with no separate `.liquid` file at all (e.g. `hotspot`, only ever defined
 * inside `sections/shoppable-image.liquid`'s schema — confirmed by
 * inspection during Phase 11, see PHASE11_REPORT.md "Discovery Method").
 * Comparing block coverage against standalone files ALONE would falsely
 * flag every inline-only block's AI schema as "stale" (id matches nothing
 * real) even when it correctly represents a real inline block type. This
 * merges both sources into one real-block identity list before comparison;
 * a standalone file's own (richer) inventory always wins if an id
 * improbably appears as both.
 */
function collectInlineBlockDeclarations(realSections) {
    const declaredBy = new Map(); // blockType -> [sectionFile, ...]
    for (const section of realSections) {
        for (const blockType of section.blockTypes) {
            if (!declaredBy.has(blockType)) declaredBy.set(blockType, []);
            declaredBy.get(blockType).push(section.file);
        }
    }
    return declaredBy;
}

function mergeStandaloneAndInlineBlocks(standaloneBlocks, inlineDeclarations) {
    const standaloneIds = new Set(standaloneBlocks.map(b => b.id));
    const merged = [...standaloneBlocks];
    for (const [id, declaredBySections] of inlineDeclarations.entries()) {
        if (standaloneIds.has(id)) continue;
        merged.push({
            file: null, id, hasSchemaTag: true, parseError: null, name: null,
            settingCount: 0, blockTypes: [], inlineOnly: true, declaredBySections
        });
    }
    return merged;
}

/**
 * Cross-references every AI SECTION's `allowed_blocks` list against the AI
 * block catalog (§13/§14 — block relationships / missing blocks). Returns
 * every (section, blockId) pair where the section declares a block the AI
 * catalog doesn't actually define.
 */
function findMissingReferencedBlocks(aiSectionEntries, aiBlockEntries) {
    const blockIds = new Set(aiBlockEntries.filter(b => b.id).map(b => b.id));
    const missing = [];
    for (const section of aiSectionEntries) {
        for (const blockId of section.allowedBlocks) {
            if (!blockIds.has(blockId)) {
                missing.push({ sectionFile: section.file, sectionId: section.id, missingBlockId: blockId });
            }
        }
    }
    return missing;
}

/**
 * Full report: sections + blocks, both directions, plus the block-
 * relationship cross-check. This is the one function a caller/test needs.
 */
async function buildCoverageReport(options = {}) {
    const {
        realSectionsDir = REAL_SECTIONS_DIR,
        realBlocksDir = REAL_BLOCKS_DIR,
        aiSectionsDir = AI_SECTIONS_DIR,
        aiBlocksDir = AI_BLOCKS_DIR
    } = options;

    const [realSections, realBlocks, aiSections, aiBlocks] = await Promise.all([
        inventoryRealDefinitions(realSectionsDir),
        inventoryRealDefinitions(realBlocksDir),
        inventoryAISchemas(aiSectionsDir),
        inventoryAISchemas(aiBlocksDir)
    ]);

    const inlineDeclarations = collectInlineBlockDeclarations(realSections);
    const mergedRealBlocks = mergeStandaloneAndInlineBlocks(realBlocks, inlineDeclarations);

    const sections = compareCoverage(realSections, aiSections);
    const blocks = compareCoverage(mergedRealBlocks, aiBlocks);
    const missingReferencedBlocks = findMissingReferencedBlocks(aiSections, aiBlocks);

    return {
        sections,
        blocks,
        missingReferencedBlocks,
        summary: {
            realSectionCount: realSections.length,
            aiSectionCount: aiSections.length,
            supportedSectionCount: sections.supported.length,
            unsupportedSectionCount: sections.unsupported.length,
            // realBlockCount is the literal standalone blocks/*.liquid FILE
            // count (§7's exact ask). supported/unsupportedBlockCount are
            // computed against the fuller identity list (standalone files +
            // inline-only block types declared inside real sections' own
            // schemas — see mergeStandaloneAndInlineBlocks()), so they can
            // legitimately be measured against more real identities than
            // realBlockCount alone; realBlockCountIncludingInline makes that
            // denominator explicit rather than leaving it implicit.
            realBlockCount: realBlocks.length,
            realBlockCountIncludingInline: mergedRealBlocks.length,
            aiBlockCount: aiBlocks.length,
            supportedBlockCount: blocks.supported.length,
            unsupportedBlockCount: blocks.unsupported.length
        }
    };
}

module.exports = {
    REAL_SECTIONS_DIR,
    REAL_BLOCKS_DIR,
    AI_SECTIONS_DIR,
    AI_BLOCKS_DIR,
    extractSchemaBlock,
    inventoryRealDefinitions,
    inventoryAISchemas,
    findDuplicateIds,
    collectInlineBlockDeclarations,
    mergeStandaloneAndInlineBlocks,
    compareCoverage,
    findMissingReferencedBlocks,
    buildCoverageReport
};
