/**
 * Phase 4 — ThemeState.
 *
 * A structured, read-only-by-default representation of the EXISTING live
 * Shopify theme's JSON configuration (templates/*.json + config/
 * settings_data.json at the theme root — see AI_THEME_BUILDER_PHASE4_PLAN.md
 * §1/§4). This is not a design generator and not a copy of the theme's
 * rendering files (Liquid/CSS/JS/snippets/assets stay exactly where they
 * are, untouched — §3). It exists so a later phase can safely target and
 * modify the theme's current configuration instead of regenerating one.
 *
 * Core design choice: buildThemeState() NEVER rewrites or reshapes the
 * parsed JSON it reads. Each template/settings file is stored verbatim as
 * `raw` (whatever `JSON.parse()` produced), and a separate `classification`
 * layer is computed ALONGSIDE it (never merged into `raw`) to say which
 * section/block types the AI schema catalog (ai-schema/sections,
 * ai-schema/blocks) actually recognizes. This is deliberate:
 *   - Preserving unknown data (§5) is automatic and can't regress, because
 *     nothing about `raw` is ever selectively kept or dropped.
 *   - Round-tripping (§6) is trivial: serializeThemeState() just returns
 *     `raw` back out — no lossy reconstruction step to keep in sync.
 *   - Validation (§11-12) can flag structural problems or unknown
 *     components for visibility without ever needing to "sanitize" the
 *     state to do so.
 * This mirrors the same non-destructive "compute metadata over the real
 * data, never duplicate/rewrite it" approach capability-index.js already
 * uses for the AI schema catalog itself.
 */

const fs = require('fs').promises;
const path = require('path');
const instrumentation = require('./instrumentation');
const { loadSchemas } = require('./example-implementation');

// ai-schema/ai-schema/theme-state.js -> one level up is the theme root
// (where templates/, config/, sections/, blocks/, layout/, snippets/,
// assets/ actually live) — the same THEME_ROOT 2-copy-to-theme.js already
// uses to write generated files back.
const DEFAULT_THEME_ROOT = path.join(__dirname, '..');
const DEFAULT_THEME_ID = 'default';
const THEME_STATE_SCHEMA_VERSION = 1;

const STATE_DIR = path.join(__dirname, 'output', 'theme-state');

// Shopify OS 2.0 JSON templates can live directly under templates/ or one
// level deeper under templates/customers/ (account/login/order/etc.). Only
// *.json is a configuration file Phase 4 cares about — sibling *.liquid
// templates (e.g. gift_card.liquid) render directly from Liquid with no
// JSON configuration surface, so they're out of scope (§10: "document
// unsupported templates rather than pretending they are supported").
async function listTemplateFiles(themeRoot) {
    const templatesDir = path.join(themeRoot, 'templates');
    const found = []; // { name, absolutePath, sourceFile }
    const skipped = []; // non-JSON files, for meta.unsupportedTemplateFiles

    async function walk(dir, prefix) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
                continue;
            }
            if (entry.name.endsWith('.json')) {
                const name = (prefix ? `${prefix}/${entry.name}` : entry.name).replace(/\.json$/, '');
                found.push({
                    name,
                    absolutePath: path.join(dir, entry.name),
                    sourceFile: path.posix.join('templates', prefix ? `${prefix}/${entry.name}` : entry.name)
                });
            } else {
                skipped.push(path.posix.join('templates', prefix ? `${prefix}/${entry.name}` : entry.name));
            }
        }
    }

    await walk(templatesDir, '');
    return { found, skipped };
}

// Shopify OS 2.0 "section group" files (header-group.json, footer-group.json)
// live directly under sections/, not templates/, but are structurally
// identical ({sections, order}) — see footer.json's ai-schema coverage for
// why footer-group needs this. Locale-variant files (e.g.
// footer-group.context.international.json) are excluded: they're
// Shopify-managed per-locale overrides, not a separate group to represent
// here. Folded into the same `templates` map as listTemplateFiles() (keyed
// by filename stem, e.g. "footer-group") so merge.js/apply.js — which are
// already sourceFile-driven, not templates/-prefix-driven — need no changes
// to read/write them.
async function listSectionGroupFiles(themeRoot) {
    const sectionsDir = path.join(themeRoot, 'sections');
    const found = [];

    let entries;
    try {
        entries = await fs.readdir(sectionsDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return { found };
        throw error;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('-group.json')) continue;
        if (entry.name.includes('.context.')) continue; // locale-variant override, not a group of its own

        const name = entry.name.replace(/\.json$/, '');
        found.push({
            name,
            absolutePath: path.join(sectionsDir, entry.name),
            sourceFile: path.posix.join('sections', entry.name)
        });
    }

    return { found };
}

async function readJSONSafe(absolutePath) {
    try {
        const raw = await fs.readFile(absolutePath, 'utf8');
        return { ok: true, data: JSON.parse(raw) };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

/**
 * Non-destructive classification layer: for a parsed template's `sections`
 * object, records each section/block's type and whether the AI schema
 * catalog recognizes it — WITHOUT touching the raw section/block objects
 * themselves. `raw` remains the single source of truth for actual content.
 */
function classifyTemplate(raw, knownSectionTypes, knownBlockTypes) {
    const sections = {};
    if (raw && raw.sections && typeof raw.sections === 'object') {
        for (const [sectionId, section] of Object.entries(raw.sections)) {
            const blocks = {};
            if (section && section.blocks && typeof section.blocks === 'object') {
                for (const [blockId, block] of Object.entries(section.blocks)) {
                    blocks[blockId] = {
                        type: block && block.type,
                        knownToAI: !!(block && knownBlockTypes.has(block.type))
                    };
                }
            }
            sections[sectionId] = {
                type: section && section.type,
                knownToAI: !!(section && knownSectionTypes.has(section.type)),
                blockCount: Object.keys(blocks).length,
                blocks
            };
        }
    }
    return { sections };
}

function summarizeClassification(classification) {
    let sectionCount = 0, blockCount = 0, unknownSectionCount = 0, unknownBlockCount = 0;
    for (const section of Object.values(classification.sections)) {
        sectionCount++;
        if (!section.knownToAI) unknownSectionCount++;
        for (const block of Object.values(section.blocks)) {
            blockCount++;
            if (!block.knownToAI) unknownBlockCount++;
        }
    }
    return { sectionCount, blockCount, unknownSectionCount, unknownBlockCount };
}

/**
 * Builds ThemeState from the theme's current on-disk JSON configuration.
 * Deterministic — no AI call (§13). A single unparseable template file
 * doesn't abort the whole build (mirrors loadAllSchemasFromDisk()'s
 * warn-and-continue posture in example-implementation.js); it's recorded
 * in meta.unparseableTemplates and surfaced as a validation error instead,
 * so the caller always gets back a usable ThemeState for everything that
 * DID parse.
 *
 * options:
 *   - themeRoot: absolute path to the theme root (default: this repo's).
 *   - themeId: identifies this ThemeState for persistence (default:
 *     'default' — see PHASE4_REPORT.md "Theme ID" for why a single static
 *     id is sufficient for the current single-theme CLI architecture).
 *   - schemas: pre-loaded { sectionSchemas, blockSchemas } to classify
 *     against; defaults to the full AI schema catalog (loadSchemas() with
 *     no retrieval filter — classification always checks against
 *     everything the AI schema library knows, independent of whatever
 *     subset a later generation call might retrieve).
 */
async function buildThemeState(options = {}) {
    const {
        themeRoot = DEFAULT_THEME_ROOT,
        themeId = DEFAULT_THEME_ID,
        schemas = null,
        context = {}
    } = options;

    const requestId = context.requestId || instrumentation.nextRequestId('themestate');
    const startTime = Date.now();

    const resolvedSchemas = schemas || await loadSchemas();
    const knownSectionTypes = new Set(resolvedSchemas.sectionSchemas.map(s => s.id));
    const knownBlockTypes = new Set(resolvedSchemas.blockSchemas.map(b => b.id));

    const { found: templateFiles, skipped: unsupportedTemplateFiles } = await listTemplateFiles(themeRoot);
    const { found: sectionGroupFiles } = await listSectionGroupFiles(themeRoot);

    const templates = {};
    const unparseableTemplates = [];

    for (const file of [...templateFiles, ...sectionGroupFiles]) {
        const result = await readJSONSafe(file.absolutePath);
        if (!result.ok) {
            unparseableTemplates.push({ name: file.name, sourceFile: file.sourceFile, error: result.error });
            continue;
        }
        templates[file.name] = {
            sourceFile: file.sourceFile,
            raw: result.data,
            classification: classifyTemplate(result.data, knownSectionTypes, knownBlockTypes)
        };
    }

    const settingsPath = path.join(themeRoot, 'config', 'settings_data.json');
    const settingsResult = await readJSONSafe(settingsPath);
    const globalSettings = settingsResult.ok
        ? { sourceFile: 'config/settings_data.json', raw: settingsResult.data }
        : null;
    const globalSettingsError = settingsResult.ok ? null : settingsResult.error;

    let sectionCount = 0, blockCount = 0, unknownSectionCount = 0, unknownBlockCount = 0;
    for (const template of Object.values(templates)) {
        const summary = summarizeClassification(template.classification);
        sectionCount += summary.sectionCount;
        blockCount += summary.blockCount;
        unknownSectionCount += summary.unknownSectionCount;
        unknownBlockCount += summary.unknownBlockCount;
    }

    const now = new Date().toISOString();

    const themeState = {
        themeId,
        sourcePath: themeRoot,
        schemaVersion: THEME_STATE_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        templates,
        globalSettings,
        meta: {
            templateCount: Object.keys(templates).length,
            sectionCount,
            blockCount,
            unknownSectionCount,
            unknownBlockCount,
            unparseableTemplates,
            unsupportedTemplateFiles, // e.g. templates/gift_card.liquid — no JSON config surface
            globalSettingsError
        }
    };

    themeState.validation = validateThemeState(themeState);

    const stateChars = JSON.stringify(themeState).length;
    instrumentation.logThemeState({
        requestId,
        themeId,
        templateCount: themeState.meta.templateCount,
        sectionCount,
        blockCount,
        unknownSectionCount,
        unknownBlockCount,
        unparseableTemplateCount: unparseableTemplates.length,
        stateChars,
        buildDurationMs: Date.now() - startTime,
        valid: themeState.validation.valid,
        errorCount: themeState.validation.errors.length,
        warningCount: themeState.validation.warnings.length
    });

    return themeState;
}

/**
 * Inverse of buildThemeState(): returns the plain JSON each file would
 * contain, keyed by template name plus the settings file — NOT written to
 * the live theme (§14/§15; that belongs to a later merge/apply phase).
 * Because `raw` is stored verbatim, this is a pure passthrough, which is
 * what guarantees round-trip safety (§6) rather than a best-effort
 * reconstruction.
 */
function serializeThemeState(themeState) {
    const templates = {};
    for (const [name, template] of Object.entries(themeState.templates)) {
        templates[name] = template.raw;
    }
    return {
        templates,
        globalSettings: themeState.globalSettings ? themeState.globalSettings.raw : null
    };
}

/**
 * Validates structural integrity without ever rejecting the whole
 * ThemeState merely because it contains a section/block type unknown to
 * the AI schema catalog (§12 — "the goal is safe customization, not
 * destructive normalization"). Unknown components are silently accepted
 * here; they're already visible via themeState.meta.unknownSectionCount/
 * unknownBlockCount and each template's own `classification`.
 *
 * A template referencing a section id in `order` that doesn't exist in
 * `sections` is an ERROR (that section would fail to render at all — a
 * real structural break, independent of whether the AI recognizes it). A
 * section present in `sections` but not listed in `order` is only a
 * WARNING — Shopify allows sections to exist without being placed (e.g.
 * ones toggled via app embeds), so this isn't necessarily broken. The same
 * asymmetry applies to block_order vs. blocks.
 */
function validateThemeState(themeState) {
    const errors = [];
    const warnings = [];

    for (const entry of themeState.meta.unparseableTemplates) {
        errors.push(`Template "${entry.name}" (${entry.sourceFile}): not valid JSON — ${entry.error}`);
    }
    if (themeState.meta.globalSettingsError) {
        errors.push(`config/settings_data.json is not valid JSON — ${themeState.meta.globalSettingsError}`);
    }

    for (const [name, template] of Object.entries(themeState.templates)) {
        const raw = template.raw;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`Template "${name}": root is not a JSON object`);
            continue;
        }
        if (!raw.sections || typeof raw.sections !== 'object') {
            errors.push(`Template "${name}": missing "sections" object`);
            continue;
        }
        if (!Array.isArray(raw.order)) {
            errors.push(`Template "${name}": missing "order" array`);
            continue;
        }

        for (const sectionId of raw.order) {
            if (!raw.sections.hasOwnProperty(sectionId)) {
                errors.push(`Template "${name}": order references unknown section "${sectionId}"`);
            }
        }
        for (const sectionId of Object.keys(raw.sections)) {
            if (!raw.order.includes(sectionId)) {
                warnings.push(`Template "${name}": section "${sectionId}" is not referenced in "order"`);
            }
        }

        for (const [sectionId, section] of Object.entries(raw.sections)) {
            if (!section || typeof section !== 'object') {
                errors.push(`Template "${name}", section "${sectionId}": section is not an object`);
                continue;
            }
            if (!section.type) {
                errors.push(`Template "${name}", section "${sectionId}": missing "type"`);
            }
            if (section.blocks && typeof section.blocks === 'object') {
                const blockIds = Object.keys(section.blocks);
                if (blockIds.length > 0) {
                    if (!Array.isArray(section.block_order)) {
                        warnings.push(`Template "${name}", section "${sectionId}": has blocks but no "block_order" array`);
                    } else {
                        for (const blockId of section.block_order) {
                            if (!section.blocks.hasOwnProperty(blockId)) {
                                errors.push(`Template "${name}", section "${sectionId}": block_order references unknown block "${blockId}"`);
                            }
                        }
                        for (const blockId of blockIds) {
                            if (!section.block_order.includes(blockId)) {
                                warnings.push(`Template "${name}", section "${sectionId}": block "${blockId}" not listed in block_order`);
                            }
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

/**
 * Phase 5 — deterministic selector: extracts only the current-state
 * information relevant to generating for one template, instead of the
 * whole (~333K-char, per PHASE4_REPORT.md) ThemeState. No AI call (§25 —
 * "the selector must be deterministic"). Deliberately excludes full
 * per-section settings for existing content — only id/type/knownToAI/
 * blockCount, enough for a generation prompt to reference "what's already
 * there" without re-embedding it.
 */
function selectGenerationContext(themeState, templateName) {
    const template = themeState.templates[templateName] || null;
    const existingSections = template
        ? Object.entries(template.classification.sections).map(([id, section]) => ({
            id,
            type: section.type,
            knownToAI: section.knownToAI,
            blockCount: section.blockCount
        }))
        : [];
    const globalSettingsCurrent = (themeState.globalSettings && themeState.globalSettings.raw && themeState.globalSettings.raw.current)
        ? themeState.globalSettings.raw.current
        : {};

    return {
        templateName,
        templateExists: !!template,
        existingSectionOrder: template ? template.raw.order : [],
        existingSections,
        globalSettingsCurrent
    };
}

function themeIdIsSafe(themeId) {
    return typeof themeId === 'string' && /^[a-zA-Z0-9_-]+$/.test(themeId);
}

function themeStateFilePath(themeId) {
    if (!themeIdIsSafe(themeId)) {
        throw new Error(`Invalid themeId: must be a non-empty alphanumeric/dash/underscore string, got "${themeId}"`);
    }
    return path.join(STATE_DIR, `${themeId}.json`);
}

async function saveThemeState(themeState) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const filePath = themeStateFilePath(themeState.themeId);
    await fs.writeFile(filePath, JSON.stringify(themeState, null, 2), 'utf8');
    return filePath;
}

async function loadThemeState(themeId) {
    const filePath = themeStateFilePath(themeId);
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

module.exports = {
    DEFAULT_THEME_ROOT,
    DEFAULT_THEME_ID,
    THEME_STATE_SCHEMA_VERSION,
    buildThemeState,
    serializeThemeState,
    validateThemeState,
    saveThemeState,
    loadThemeState,
    themeStateFilePath,
    selectGenerationContext,
    // exported for direct/unit testing without a full buildThemeState() run
    listTemplateFiles,
    listSectionGroupFiles,
    classifyTemplate
};
