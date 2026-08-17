/**
 * Phase 7 — Apply (file-system half of merge/apply safety).
 *
 * Takes a `mergeThemeState()` result (merge.js — pure, already validated,
 * never written anywhere) and writes it to a real theme directory. Kept in
 * a separate file from merge.js on purpose (§6 — "this separation is
 * required for testing and safety"): merge.js can be unit-tested with zero
 * file-system I/O; this file is the only place in Phase 7 that touches
 * disk.
 *
 * Write strategy (§21/§29):
 *   1. Resolve + path-safety-check every target file BEFORE any I/O (§30).
 *   2. Write everything into a fresh temp staging directory (same
 *      filesystem/device as the theme root — verified in PHASE7_REPORT.md
 *      — so the later rename step is atomic per file; no cross-filesystem
 *      atomic-rename assumption is made).
 *   3. Read every staged file back, re-parse, and structurally verify it
 *      (§28) BEFORE touching any real file.
 *   4. Back up whatever real files are about to be overwritten into a
 *      single, fixed (not accumulating) backup directory — "smallest safe
 *      local backup strategy" per §29, deliberately NOT a version-history
 *      system (§37): each apply call overwrites the previous backup, it
 *      does not keep a history.
 *   5. Commit by renaming each staged file into place; if any single
 *      rename fails partway through, everything already committed in THIS
 *      call is restored from the backup just taken, then the error is
 *      re-thrown — the live theme never ends up in a half-written state
 *      relative to how it started this call.
 *   6. Re-read + re-verify the REAL files that were just written (§28 —
 *      "do not assume a successful writeFile() means a valid theme").
 *   7. Staging is always cleaned up (success or failure); the backup
 *      directory is left in place so a caller can manually recover if
 *      something goes wrong after this function returns successfully.
 */

const fs = require('fs').promises;
const path = require('path');
const instrumentation = require('./instrumentation');
const { DEFAULT_THEME_ROOT } = require('./theme-state');

const STAGING_DIRNAME = path.join('ai-schema', 'output', '.staging');
const BACKUP_DIRNAME = path.join('ai-schema', 'output', '.apply-backup');

// ---------------------------------------------------------------------------
// §30 — path safety. Resolves both the root and the candidate target, then
// checks the RELATIVE path between them via path.relative() rather than a
// naive string-prefix comparison on unresolved paths (which `../` and
// symlink-style tricks can defeat) — the plan explicitly calls out
// string-prefix-only checks as insufficient.
// ---------------------------------------------------------------------------

function resolveSafeThemePath(themeRoot, relativePath) {
    if (!relativePath || typeof relativePath !== 'string') {
        throw new Error('resolveSafeThemePath() requires a non-empty relativePath');
    }
    const resolvedRoot = path.resolve(themeRoot);
    const resolvedTarget = path.resolve(resolvedRoot, relativePath);
    const rel = path.relative(resolvedRoot, resolvedTarget);

    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`Path traversal rejected: "${relativePath}" resolves outside the theme root "${resolvedRoot}"`);
    }
    return resolvedTarget;
}

// ---------------------------------------------------------------------------
// §31 — file scope: ONLY the ThemeState JSON contract (template files +
// config/settings_data.json). Nothing here ever touches Liquid/CSS/JS/
// snippets/assets/layout.
// ---------------------------------------------------------------------------

function computeTargetFiles(mergedThemeState, options = {}) {
    const { changedTemplates = [], writeGlobalSettings = false } = options;
    const targets = [];

    for (const templateName of changedTemplates) {
        const template = mergedThemeState.templates && mergedThemeState.templates[templateName];
        if (!template) continue;
        targets.push({
            relativePath: template.sourceFile || `templates/${templateName}.json`,
            content: template.raw
        });
    }

    if (writeGlobalSettings && mergedThemeState.globalSettings) {
        targets.push({
            relativePath: mergedThemeState.globalSettings.sourceFile || path.join('config', 'settings_data.json'),
            content: mergedThemeState.globalSettings.raw
        });
    }

    return targets;
}

// ---------------------------------------------------------------------------
// §28 — structural verification. Deliberately lightweight (not a full
// ThemeState rebuild + validateThemeState() pass) since this runs twice per
// apply (staged + post-write) and only needs to catch "the write produced
// something that isn't even shaped like a theme file" — schema/content
// correctness was already the job of validateOutput()/validateCandidate()
// upstream, before merge ever ran (§8).
// ---------------------------------------------------------------------------

function verifyStructuralShape(relativePath, parsed) {
    const normalized = relativePath.split(path.sep).join('/');
    if (normalized.startsWith('templates/')) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.sections || typeof parsed.sections !== 'object' || !Array.isArray(parsed.order)) {
            throw new Error(`Apply verification failed for "${relativePath}": missing/invalid "sections" or "order"`);
        }
        for (const id of parsed.order) {
            if (!parsed.sections.hasOwnProperty(id)) {
                throw new Error(`Apply verification failed for "${relativePath}": order references unknown section "${id}"`);
            }
        }
    } else if (normalized.endsWith('settings_data.json')) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.current || typeof parsed.current !== 'object') {
            throw new Error(`Apply verification failed for "${relativePath}": missing/invalid "current" object`);
        }
    }
}

async function moveFile(src, dest) {
    try {
        await fs.rename(src, dest);
    } catch (error) {
        if (error.code === 'EXDEV') {
            // Cross-device fallback — not expected on this repo's layout
            // (staging lives under the theme root itself), but kept so
            // applyThemeState() doesn't assume a same-filesystem guarantee
            // that isn't actually true in every deployment (§21).
            await fs.copyFile(src, dest);
            await fs.unlink(src);
        } else {
            throw error;
        }
    }
}

async function pathExists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

/**
 * options:
 *   - themeRoot: default the real theme root (DEFAULT_THEME_ROOT); tests
 *     MUST override this with a temp directory (§26 — never mutate the
 *     live theme in tests).
 *   - changedTemplates: array of template names to write, normally taken
 *     directly from merge.js's `summary.changedTemplates`.
 *   - writeGlobalSettings: whether to also write config/settings_data.json
 *     (only true when the merge actually changed a global setting).
 *   - dryRun: report targets/paths without writing anything (§22/§23).
 */
async function applyThemeState(mergedThemeState, options = {}) {
    const {
        themeRoot = DEFAULT_THEME_ROOT,
        changedTemplates = [],
        writeGlobalSettings = false,
        dryRun = false,
        requestId = instrumentation.nextRequestId('apply')
    } = options;

    const startTime = Date.now();
    const targets = computeTargetFiles(mergedThemeState, { changedTemplates, writeGlobalSettings });

    if (targets.length === 0) {
        return { applied: false, dryRun, filesWritten: [], targets: [], durationMs: Date.now() - startTime };
    }

    // Path safety BEFORE any I/O (§30) — a bad target aborts the whole
    // apply, nothing is written.
    const resolvedTargets = targets.map(t => ({ ...t, absolutePath: resolveSafeThemePath(themeRoot, t.relativePath) }));

    if (dryRun) {
        const durationMs = Date.now() - startTime;
        instrumentation.logApply({ requestId, dryRun: true, success: true, filesWritten: 0, targets: resolvedTargets.map(t => t.relativePath), durationMs });
        return { applied: false, dryRun: true, filesWritten: [], targets: resolvedTargets.map(t => t.relativePath), durationMs };
    }

    const stagingRoot = path.join(themeRoot, STAGING_DIRNAME);
    await fs.mkdir(stagingRoot, { recursive: true });
    const stagingDir = await fs.mkdtemp(path.join(stagingRoot, 'apply-'));
    const backupDir = path.join(themeRoot, BACKUP_DIRNAME);

    try {
        // 1) write every target into staging
        for (const t of resolvedTargets) {
            const stagedPath = path.join(stagingDir, t.relativePath);
            await fs.mkdir(path.dirname(stagedPath), { recursive: true });
            await fs.writeFile(stagedPath, JSON.stringify(t.content, null, 2), 'utf8');
        }

        // 2) verify staged output BEFORE touching anything real (§28)
        for (const t of resolvedTargets) {
            const stagedPath = path.join(stagingDir, t.relativePath);
            const parsed = JSON.parse(await fs.readFile(stagedPath, 'utf8'));
            verifyStructuralShape(t.relativePath, parsed);
        }

        // 3) back up whatever real files are about to be overwritten — a
        // single fixed backup dir, overwritten each call (§29, not a
        // history system).
        await fs.rm(backupDir, { recursive: true, force: true });
        await fs.mkdir(backupDir, { recursive: true });
        const backedUp = [];
        for (const t of resolvedTargets) {
            if (await pathExists(t.absolutePath)) {
                const backupPath = path.join(backupDir, t.relativePath);
                await fs.mkdir(path.dirname(backupPath), { recursive: true });
                await fs.copyFile(t.absolutePath, backupPath);
                backedUp.push(t);
            }
        }

        // 4) commit — rename staged files into place one at a time; on any
        // failure, restore everything already committed THIS call from the
        // backup just taken, then re-throw (§20 fail closed, §21 atomic-ish).
        const committed = [];
        try {
            for (const t of resolvedTargets) {
                const stagedPath = path.join(stagingDir, t.relativePath);
                await fs.mkdir(path.dirname(t.absolutePath), { recursive: true });
                await moveFile(stagedPath, t.absolutePath);
                committed.push(t);
            }
        } catch (commitError) {
            for (const t of committed) {
                const backupPath = path.join(backupDir, t.relativePath);
                if (await pathExists(backupPath)) {
                    await fs.copyFile(backupPath, t.absolutePath).catch(() => {});
                } else {
                    // Didn't exist before this apply — remove what we just wrote.
                    await fs.unlink(t.absolutePath).catch(() => {});
                }
            }
            throw commitError;
        }

        // 5) post-write verification against the REAL files (§28)
        for (const t of resolvedTargets) {
            const parsed = JSON.parse(await fs.readFile(t.absolutePath, 'utf8'));
            verifyStructuralShape(t.relativePath, parsed);
        }

        const durationMs = Date.now() - startTime;
        instrumentation.logApply({
            requestId, dryRun: false, success: true,
            filesWritten: resolvedTargets.length,
            targets: resolvedTargets.map(t => t.relativePath),
            durationMs
        });

        return {
            applied: true,
            dryRun: false,
            filesWritten: resolvedTargets.map(t => t.relativePath),
            backupDir,
            durationMs
        };
    } catch (error) {
        instrumentation.logApply({
            requestId, dryRun: false, success: false,
            filesWritten: 0, targets: resolvedTargets.map(t => t.relativePath),
            durationMs: Date.now() - startTime, error: error.message
        });
        throw error;
    } finally {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = {
    resolveSafeThemePath,
    computeTargetFiles,
    verifyStructuralShape,
    applyThemeState
};
