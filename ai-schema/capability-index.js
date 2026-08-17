/**
 * Phase 2 — Schema Capability Index.
 *
 * Builds a lightweight, derived index over the section/block schemas —
 * enough metadata for retrieval to decide WHICH schemas are relevant,
 * without duplicating every setting definition (that stays in the full
 * schema files, fetched only for the selected subset).
 *
 * IMPORTANT — single source of truth: buildCapabilityIndex() is a pure
 * function of whatever schemas are passed to it. It is called fresh, in
 * memory, every time retrieval.js runs (see retrieval.js), directly against
 * the schemas loadSchemas() just read off disk. It is NOT read back from a
 * cached file for that purpose — so the index used for actual retrieval
 * decisions can never drift out of sync with the real schema files, no
 * matter how they change. The on-disk capability-index.json this file can
 * also write (via `node capability-index.js` / `npm run build:index`) is a
 * human-inspectable snapshot for debugging, not a runtime dependency.
 *
 * `category` is curated/authored data that lives in the schema files
 * themselves (added once by scripts/add-capability-metadata.js — see that
 * file for why). Everything else here — including which blocks are
 * "local" to a specific section vs. usable more broadly — is fully
 * computed from the schemas' own allowed_blocks relationships, never
 * hand-maintained, so it cannot drift either.
 */

/**
 * A block is "local" if only one section's allowed_blocks references it —
 * i.e. it only makes sense in that one context (e.g. "tab" only inside
 * content-tabs). A block referenced by 0 sections (never actually
 * reachable via any section — e.g. some of main-product's allowed_blocks
 * entries have no matching schema at all, see PHASE2_REPORT.md) or by 2+
 * sections is "standalone" — general-purpose enough to not be tied to one
 * owner. This is purely descriptive/debug metadata for Phase 2: the actual
 * retrieval algorithm (retrieval.js) never selects blocks independently —
 * it always pulls a block's full schema only because some selected
 * section's allowed_blocks named it, so this scope value doesn't gate
 * anything yet, it just documents the relationship for later phases/humans.
 */
function computeBlockSectionUsage(sectionSchemas) {
    const usage = new Map(); // blockId -> Set(sectionId)
    for (const section of sectionSchemas) {
        const allowed = Array.isArray(section.allowed_blocks)
            ? section.allowed_blocks
            : (section.allowed_blocks && typeof section.allowed_blocks === 'object'
                ? Object.keys(section.allowed_blocks)
                : []);
        for (const blockId of allowed) {
            if (!usage.has(blockId)) usage.set(blockId, new Set());
            usage.get(blockId).add(section.id);
        }
    }
    return usage;
}

function buildSectionIndex(sectionSchemas) {
    const seen = new Set();
    const entries = [];
    for (const section of sectionSchemas) {
        if (!section || !section.id) continue;
        if (seen.has(section.id)) {
            console.warn(`⚠️  capability-index: duplicate section id "${section.id}" — keeping the first one encountered.`);
            continue;
        }
        seen.add(section.id);

        const allowedBlocksList = Array.isArray(section.allowed_blocks)
            ? section.allowed_blocks
            : (section.allowed_blocks && typeof section.allowed_blocks === 'object'
                ? Object.keys(section.allowed_blocks)
                : []);

        entries.push({
            id: section.id,
            label: section.label || section.id,
            category: section.category || 'misc',
            tags: Array.isArray(section.tags) ? section.tags : [],
            summary: section.purpose || '',
            allowed_on: Array.isArray(section.allowed_on) ? section.allowed_on : [],
            hasBlocks: allowedBlocksList.length > 0,
            allowedBlockCount: allowedBlocksList.length,
            maxBlocks: typeof section.max_blocks === 'number' ? section.max_blocks : null
        });
    }
    return entries;
}

function buildBlockIndex(blockSchemas, sectionSchemas) {
    // Last-one-wins dedup, matching validateOutput()'s existing
    // `new Map(blockSchemas.map(b => [b.id, b]))` semantics exactly — see
    // PHASE2_REPORT.md for the duplicate "row" id this resolves.
    const byId = new Map();
    for (const block of blockSchemas) {
        if (!block || !block.id) continue;
        byId.set(block.id, block);
    }

    const usage = computeBlockSectionUsage(sectionSchemas);

    const entries = [];
    for (const [id, block] of byId) {
        const usedBy = [...(usage.get(id) || [])];
        entries.push({
            id,
            label: block.label || id,
            category: block.category || 'misc',
            tags: Array.isArray(block.tags) ? block.tags : [],
            summary: block.purpose || '',
            scope: usedBy.length === 1 ? 'local' : 'standalone',
            usedBySectionIds: usedBy
        });
    }
    return entries;
}

/**
 * schemas: { globalSchema, sectionSchemas, blockSchemas } — as returned by
 * loadAllSchemasFromDisk()/loadSchemas() in example-implementation.js.
 */
function buildCapabilityIndex(schemas) {
    return {
        builtAt: null, // filled in only by the CLI writer below; buildCapabilityIndex() itself stays a pure function (no Date.now() side effect) so it's safe to call from tests/retrieval on every request
        sectionCount: schemas.sectionSchemas.length,
        blockCount: schemas.blockSchemas.length,
        sections: buildSectionIndex(schemas.sectionSchemas),
        blocks: buildBlockIndex(schemas.blockSchemas, schemas.sectionSchemas)
    };
}

/**
 * CLI entry point: `node capability-index.js` (or `npm run build:index`)
 * writes a human-inspectable capability-index.json snapshot to disk. Not
 * required for retrieval to function — see the file-level comment above.
 */
async function writeIndexFile() {
    const fs = require('fs').promises;
    const path = require('path');
    const { loadSchemas } = require('./example-implementation');

    const schemas = await loadSchemas(); // full load — the index should describe everything on disk
    const index = buildCapabilityIndex(schemas);
    index.builtAt = new Date().toISOString();

    const outPath = path.join(__dirname, 'capability-index.json');
    await fs.writeFile(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${outPath} — ${index.sectionCount} sections, ${index.blockCount} blocks.`);
    return outPath;
}

module.exports = { buildCapabilityIndex, computeBlockSectionUsage, writeIndexFile };

// IMPORTANT: this must come AFTER module.exports is assigned above. When
// this file is the process entry point (`node capability-index.js`),
// writeIndexFile() requires example-implementation.js, which requires
// retrieval.js, which requires *this* file back (a real circular
// require — retrieval.js needs buildCapabilityIndex, this file's CLI mode
// needs loadSchemas()). Node resolves that cycle using whatever this
// module's exports object contains at the moment the cycle closes — if
// module.exports were still the default `{}` at that point (i.e. if this
// block ran first), retrieval.js would silently destructure
// `buildCapabilityIndex` as undefined. Assigning exports first means the
// cycle closes against the real, fully-populated object instead.
if (require.main === module) {
    writeIndexFile().catch(err => {
        console.error('Failed to build capability index:', err);
        process.exit(1);
    });
}
