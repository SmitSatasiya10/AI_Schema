#!/usr/bin/env node

/**
 * Complete AI Theme Generation Pipeline
 * 
 * This script:
 * 1. Generates theme configuration using AI
 * 2. Optionally generates images
 * 3. Automatically copies files to the theme folder
 * 4. Outputs a summary of changes
 */

const path = require('path');
const { 
    loadSchemas, 
    buildSystemPrompt, 
    makeAIRequest, 
    validateOutput, 
    generateThemeFiles, 
    loadGlobalSettings,
    detectNicheAndGetColors,
    generateAIColorPalette 
} = require('./example-implementation');

const { copyGeneratedFilesToTheme, checkOutputFiles } = require('./2-copy-to-theme');

const DEBUG = process.env.DEBUG === 'true';

/**
 * Full pipeline: Generate → Validate → Copy
 */
async function runFullPipeline(userPrompt, options = {}) {
    const {
        templateName = 'index',
        generateImages = false,
        autoCopy = true,
        cleanup = false
    } = options;

    try {
        console.log('\n' + '='.repeat(70));
        console.log('🚀 ECOMSKALE AI THEME GENERATOR - FULL PIPELINE');
        console.log('='.repeat(70) + '\n');

        // STEP 1: Load schemas
        console.log('📚 STEP 1: Loading AI schemas...');
        const schemas = await loadSchemas();
        console.log(`✅ Loaded: ${schemas.sectionSchemas.length} sections, ${schemas.blockSchemas.length} blocks\n`);

        // STEP 2: Build system prompt
        console.log('📝 STEP 2: Building system prompt...');
        const systemPrompt = buildSystemPrompt(schemas);
        console.log(`✅ System prompt ready (${systemPrompt.length} characters)\n`);

        // STEP 3: Handle colors
        console.log('🎨 STEP 3: Generating color palette...');
        let colors = null;
        const aiColors = await generateAIColorPalette(userPrompt);
        
        if (aiColors) {
            colors = aiColors;
            console.log(`✅ AI Color Palette: ${aiColors.niche.toUpperCase()}`);
            console.log(`   Primary: ${aiColors.colors_accent_1}`);
            console.log(`   Secondary: ${aiColors.colors_accent_2}`);
            console.log(`   Reason: ${aiColors.description}\n`);
        } else {
            const result = detectNicheAndGetColors(userPrompt);
            colors = result.colors;
            console.log(`✅ Using predefined palette: ${result.niche.toUpperCase()}`);
            console.log(`   Primary color: ${colors.colors_accent_1}\n`);
        }

        // STEP 4: AI Configuration
        console.log('🤖 STEP 4: Requesting AI-generated configuration...');
        console.log(`   Prompt: "${userPrompt}"\n`);
        
        const aiOutput = await makeAIRequest(userPrompt, systemPrompt);
        console.log('✅ AI response received\n');

        // STEP 5: Validate
        console.log('✅ STEP 5: Validating configuration...');
        const validation = validateOutput(aiOutput, schemas);

        if (validation.warnings && validation.warnings.length > 0) {
            console.log('⚠️  Warnings:');
            validation.warnings.forEach(w => console.log(`   - ${w}`));
            console.log();
        }

        if (!validation.valid) {
            throw new Error(`Validation failed: ${validation.error}`);
        }
        console.log('✅ Configuration is valid!\n');

        // STEP 6: Generate theme files
        console.log('📁 STEP 6: Generating theme files...');
        const outputDir = path.join(__dirname, 'output');
        const files = await generateThemeFiles(
            validation.config,
            templateName,
            {},
            colors
        );
        console.log('✅ Theme files generated\n');

        // STEP 7: Copy to theme (if auto-copy enabled)
        if (autoCopy) {
            console.log('📋 STEP 7: Copying files to theme folder...');
            const copied = await copyGeneratedFilesToTheme();
            if (!copied) {
                console.warn('⚠️  Some files could not be copied. Please check the output folder.\n');
            }
        }

        // Final summary
        console.log('='.repeat(70));
        console.log('✨ GENERATION COMPLETE!\n');
        
        console.log('📊 Summary:');
        console.log(`   Sections: ${validation.config.order.length}`);
        console.log(`   Template: ${templateName}.json`);
        console.log(`   Colors: ${colors.niche || 'custom'} palette`);
        
        const outputFiles = await checkOutputFiles();
        if (outputFiles.template) console.log('   ✓ templates/index.json');
        if (outputFiles.settings) console.log('   ✓ config/settings_data.json');
        if (outputFiles.images) console.log('   ✓ images/ (generated)');
        
        console.log('\n🎯 Generated sections:');
        validation.config.order.forEach((sectionId, index) => {
            const section = validation.config.sections[sectionId];
            console.log(`   ${index + 1}. ${sectionId} (${section.type})`);
        });

        console.log('\n' + '='.repeat(70) + '\n');

        return {
            success: true,
            config: validation.config,
            colors,
            files
        };

    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        if (DEBUG) console.error(error.stack);
        process.exit(1);
    }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        templateName: 'index',
        generateImages: false,
        autoCopy: true,
        cleanup: false
    };

    let userPrompt = 'Create a beautiful homepage for a modern e-commerce store.';

    // Parse named arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--prompt' && args[i + 1]) {
            userPrompt = args[i + 1];
            i++;
        } else if (arg === '--template' && args[i + 1]) {
            options.templateName = args[i + 1];
            i++;
        } else if (arg === '--images') {
            options.generateImages = true;
        } else if (arg === '--no-copy') {
            options.autoCopy = false;
        } else if (arg === '--cleanup') {
            options.cleanup = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node generate-and-copy.js [options]

Options:
  --prompt TEXT           User prompt for theme generation
  --template NAME         Template name (default: index)
  --images                Generate images for sections
  --no-copy               Don't copy files to theme folder
  --cleanup               Remove output files after copying
  --help                  Show this help message

Examples:
  node generate-and-copy.js
  node generate-and-copy.js --prompt "Pet food store homepage"
  node generate-and-copy.js --prompt "Luxury fashion" --images
  node generate-and-copy.js --template home --no-copy
`);
            process.exit(0);
        }
    }

    return { userPrompt, options };
}

// Main execution
async function main() {
    const { userPrompt, options } = parseArgs();
    await runFullPipeline(userPrompt, options);
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = { runFullPipeline };
