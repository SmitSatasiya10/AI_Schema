/**
 * Copy generated files from ai-schema/output to the main theme folder
 * 
 * This script copies:
 * - templates/index.json → ../templates/index.json
 * - config/settings_data.json → ../config/settings_data.json
 * - images/* → ../assets/generated-images/*
 * - images-manifest.json → ../ai-schema/output/images-manifest.json (stays in output)
 */

const fs = require('fs').promises;
const path = require('path');

// Configuration
const OUTPUT_DIR = path.join(__dirname, 'output');
const THEME_ROOT = path.join(__dirname, '..');
const THEME_TEMPLATES_DIR = path.join(THEME_ROOT, 'templates');
const THEME_CONFIG_DIR = path.join(THEME_ROOT, 'config');
const THEME_ASSETS_DIR = path.join(THEME_ROOT, 'assets');
const THEME_IMAGES_DIR = path.join(THEME_ASSETS_DIR, 'generated-images');

const DEBUG = process.env.DEBUG === 'true';

/**
 * Copy a file from source to destination
 */
async function copyFile(source, destination) {
    try {
        const dir = path.dirname(destination);
        await fs.mkdir(dir, { recursive: true });
        await fs.copyFile(source, destination);
        if (DEBUG) console.log(`  📋 Copied: ${path.relative(THEME_ROOT, destination)}`);
        return true;
    } catch (error) {
        console.error(`  ❌ Error copying ${path.basename(source)}: ${error.message}`);
        return false;
    }
}

/**
 * Copy entire directory recursively
 */
async function copyDirectory(source, destination) {
    try {
        await fs.mkdir(destination, { recursive: true });
        const files = await fs.readdir(source, { withFileTypes: true });
        
        for (const file of files) {
            const sourcePath = path.join(source, file.name);
            const destPath = path.join(destination, file.name);
            
            if (file.isDirectory()) {
                await copyDirectory(sourcePath, destPath);
            } else {
                await fs.copyFile(sourcePath, destPath);
                if (DEBUG) console.log(`  📋 Copied: ${path.relative(THEME_ROOT, destPath)}`);
            }
        }
        return true;
    } catch (error) {
        console.error(`  ❌ Error copying directory: ${error.message}`);
        return false;
    }
}

/**
 * Check if output files exist
 */
async function checkOutputFiles() {
    const settingsPath = path.join(OUTPUT_DIR, 'config', 'settings_data.json');
    const imagesPath = path.join(OUTPUT_DIR, 'images');
    const templatesSourceDir = path.join(OUTPUT_DIR, 'templates');

    let templateFiles = [];
    try {
        templateFiles = (await fs.readdir(templatesSourceDir)).filter(f => f.endsWith('.json'));
    } catch {
        templateFiles = [];
    }

    const exists = { templateFiles, template: templateFiles.length > 0 };

    for (const [name, filepath] of [['settings', settingsPath], ['images', imagesPath]]) {
        try {
            const stat = await fs.stat(filepath);
            exists[name] = stat.isFile() || stat.isDirectory();
        } catch {
            exists[name] = false;
        }
    }

    return exists;
}

/**
 * Product templates only ever get a single AI-generated "main-product"
 * section (see the PRODUCT PAGE STRUCTURE rule in example-implementation.js).
 * The real theme's product templates also carry other pre-existing sections
 * (tickers, comparison tables, related products, etc.) below it, so instead
 * of replacing the whole file we splice the generated main-product section
 * into place and leave every other section untouched.
 */
function isProductTemplate(templateName) {
    return templateName === 'product' || templateName.startsWith('product.');
}

async function mergeProductTemplate(sourcePath, destPath) {
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const sourceSectionId = source.order[0];
    const sourceSection = source.sections[sourceSectionId];

    let dest;
    try {
        dest = JSON.parse(await fs.readFile(destPath, 'utf8'));
    } catch {
        dest = { sections: {}, order: [] };
    }

    // Reuse whatever key the real theme already uses for its main-product
    // section (conventionally "main"); only create a new one if the
    // destination template doesn't have a main-product section yet.
    let mainKey = Object.keys(dest.sections).find(
        key => dest.sections[key]?.type === 'main-product'
    );
    if (!mainKey) {
        mainKey = 'main';
        dest.order = [mainKey, ...dest.order.filter(id => id !== mainKey)];
    }

    dest.sections[mainKey] = {
        ...dest.sections[mainKey],
        type: sourceSection.type,
        settings: sourceSection.settings,
        blocks: sourceSection.blocks,
        block_order: sourceSection.block_order
    };

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, JSON.stringify(dest, null, 2), 'utf8');
}

/**
 * Copy every generated template file to the theme. Product templates are
 * merged (see mergeProductTemplate); everything else (e.g. index.json, which
 * is meant to replace the whole homepage) is copied wholesale.
 */
async function copyTemplates(templateFiles) {
    let successCount = 0;

    for (const file of templateFiles) {
        const sourcePath = path.join(OUTPUT_DIR, 'templates', file);
        const destPath = path.join(THEME_TEMPLATES_DIR, file);
        const templateName = file.replace(/\.json$/, '');

        try {
            if (isProductTemplate(templateName)) {
                await mergeProductTemplate(sourcePath, destPath);
                console.log(`  ✅ Merged theme template: templates/${file} (main-product section only, other sections kept)`);
            } else {
                await copyFile(sourcePath, destPath);
                console.log(`  ✅ Theme template: templates/${file}`);
            }
            successCount++;
        } catch (error) {
            console.error(`  ❌ Error processing ${file}: ${error.message}`);
        }
    }

    return successCount;
}

/**
 * Main copy function
 */
async function copyGeneratedFilesToTheme() {
    console.log('\n🔄 Checking generated files...\n');
    
    const files = await checkOutputFiles();
    
    if (!files.template && !files.settings && !files.images) {
        console.log('❌ No generated files found in ai-schema/output/');
        console.log('   Please run the AI schema generation first.');
        console.log('   Usage: node example-implementation.js\n');
        return false;
    }

    console.log('📁 Copying generated files to theme...\n');
    
    let successCount = 0;

    // Copy/merge template files
    if (files.template) {
        console.log('📦 Copying templates...');
        successCount += await copyTemplates(files.templateFiles);
    }

    // Copy settings file
    if (files.settings) {
        console.log('\n🎨 Copying settings...');
        const settingsSource = path.join(OUTPUT_DIR, 'config', 'settings_data.json');
        const settingsDest = path.join(THEME_CONFIG_DIR, 'settings_data.json');
        
        if (await copyFile(settingsSource, settingsDest)) {
            successCount++;
            console.log(`  ✅ Theme settings: config/settings_data.json`);
        }
    }

    // Copy images directory
    if (files.images) {
        console.log('\n🖼️  Copying images...');
        const imagesSource = path.join(OUTPUT_DIR, 'images');
        
        try {
            const imageFiles = await fs.readdir(imagesSource);
            if (imageFiles.length > 0) {
                await copyDirectory(imagesSource, THEME_IMAGES_DIR);
                console.log(`  ✅ Generated images: assets/generated-images/`);
                console.log(`     (${imageFiles.length} images copied)`);
                successCount++;
            } else {
                console.log('  ⊘ No images found in output/images/');
            }
        } catch (error) {
            console.log(`  ⊘ Images directory not ready: ${error.message}`);
        }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ Successfully copied ${successCount} item(s) to theme!\n`);

    const templatePaths = files.templateFiles.map(f => `templates/${f}`);

    console.log('📂 Generated files are now in your theme:\n');
    templatePaths.forEach(p => console.log(`  • ${p}`));
    console.log(`  • config/settings_data.json`);
    if (files.images) {
        console.log(`  • assets/generated-images/`);
    }
    console.log(`\n✨ Next steps:`);
    console.log(`  1. Git add these files: git add ${templatePaths.join(' ')} config/settings_data.json`);
    console.log(`  2. Commit your changes`);
    console.log(`  3. Push to your branch`);
    console.log(`  4. Test in Shopify admin to see the generated page(s)\n`);
    
    return true;
}

/**
 * Cleanup - remove generated output after copying (optional)
 */
async function cleanupOutput(keepImages = false) {
    try {
        const templatesDir = path.join(OUTPUT_DIR, 'templates');
        const settingsPath = path.join(OUTPUT_DIR, 'config', 'settings_data.json');

        try {
            const templateFiles = (await fs.readdir(templatesDir)).filter(f => f.endsWith('.json'));
            for (const file of templateFiles) {
                await fs.unlink(path.join(templatesDir, file));
                if (DEBUG) console.log(`  🗑️  Removed: output/templates/${file}`);
            }
        } catch {
            // Templates dir might not exist
        }

        if (await fs.stat(settingsPath).then(() => true).catch(() => false)) {
            await fs.unlink(settingsPath);
            if (DEBUG) console.log('  🗑️  Removed: output/config/settings_data.json');
        }
        
        if (!keepImages) {
            const imagesPath = path.join(OUTPUT_DIR, 'images');
            try {
                const files = await fs.readdir(imagesPath);
                for (const file of files) {
                    await fs.unlink(path.join(imagesPath, file));
                }
                if (DEBUG) console.log('  🗑️  Removed: output/images/');
            } catch {
                // Images dir might not exist
            }
        }
    } catch (error) {
        if (DEBUG) console.log(`  ⚠️  Cleanup error: ${error.message}`);
    }
}

// Main execution
async function main() {
    try {
        const success = await copyGeneratedFilesToTheme();
        
        if (success && process.argv.includes('--cleanup')) {
            console.log('Cleaning up output directory...\n');
            await cleanupOutput(true); // Keep images in case they're needed later
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    copyGeneratedFilesToTheme,
    cleanupOutput,
    checkOutputFiles,
    mergeProductTemplate
};
