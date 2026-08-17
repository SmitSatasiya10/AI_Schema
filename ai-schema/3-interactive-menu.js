#!/usr/bin/env node

/**
 * Quick Start Script
 * Interactive menu to generate and copy theme files
 */

const readline = require('readline');
const { runFullPipeline } = require('./1-generate-theme');
const { understandRequest } = require('./clarification');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

/**
 * Prompt user for input
 */
function prompt(question) {
    return new Promise(resolve => {
        rl.question(question, resolve);
    });
}

/**
 * Show menu and get user choice
 */
async function showMenu() {
    console.clear();
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  🚀 EcomSkale AI Theme Generator                     ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    console.log('Choose an option:\n');
    console.log('  1️⃣  Generate Homepage from niche templates');
    console.log('  2️⃣  Generate Product Page from niche templates');
    console.log('  3️⃣  Generate both Homepage + Product Page');
    console.log('  4️⃣  Custom description (homepage)');
    console.log('  5️⃣  Custom description with AI clarification (homepage)');
    console.log('  6️⃣  View documentation');
    console.log('  7️⃣  Just copy existing files');
    console.log('  8️⃣  Exit\n');

    const choice = await prompt('Select option (1-8): ');
    return choice.trim();
}

/**
 * Show niche selection menu
 */
async function showNicheMenu() {
    console.log('\n🎯 Select your store niche:\n');
    console.log('  1. Fashion & Apparel');
    console.log('  2. Jewelry & Accessories');
    console.log('  3. Electronics & Gadgets');
    console.log('  4. Home & Living');
    console.log('  5. Beauty & Cosmetics');
    console.log('  6. Food & Beverage');
    console.log('  7. Fitness & Sports');
    console.log('  8. Pet Supplies');
    console.log('  9. Custom (enter your own)\n');

    const choice = await prompt('Select niche (1-9): ');
    return choice.trim();
}

/**
 * Generate varied prompts based on niche
 */
function getNichePrompt(nicheChoice) {
    const prompts = {
        '1': [
            'Create an elegant fashion boutique homepage with modern aesthetics, featuring trending collections and style inspiration',
            'Build a sustainable fashion store homepage emphasizing eco-friendly materials and ethical production',
            'Design a streetwear brand homepage with bold visuals, limited drops, and urban culture vibes',
            'Create a luxury fashion homepage with sophisticated layouts, high-end products, and exclusive collections'
        ],
        '2': [
            'Design a handcrafted jewelry store homepage showcasing artisan pieces, craftsmanship stories, and customization options',
            'Create a luxury watch and jewelry homepage with premium feel, trust badges, and exclusive collections',
            'Build a minimalist jewelry brand homepage with clean design, focusing on everyday elegance and sustainability',
            'Design a vintage jewelry store homepage featuring unique finds, history, and collector pieces'
        ],
        '3': [
            'Create a tech gadgets store homepage with innovation focus, product comparisons, and technical specifications',
            'Build a smart home devices homepage emphasizing convenience, automation benefits, and lifestyle improvements',
            'Design a gaming accessories store with dynamic visuals, featured products, and gamer community focus',
            'Create a mobile accessories homepage with trending products, compatibility info, and protective solutions'
        ],
        '4': [
            'Design a modern home decor store with room inspiration, curated collections, and interior design tips',
            'Create a sustainable home goods homepage focusing on eco-friendly products and conscious living',
            'Build a luxury furniture store homepage with elegant layouts, room visualizers, and premium materials',
            'Design a minimalist home essentials store with clean aesthetics and functional product focus'
        ],
        '5': [
            'Create a natural skincare brand homepage emphasizing organic ingredients, skin health, and product benefits',
            'Build a luxury cosmetics store with glamorous visuals, makeup tutorials, and beauty inspiration',
            'Design a men\'s grooming homepage with modern masculinity, product education, and routine builders',
            'Create a K-beauty store homepage featuring innovative products, skincare routines, and Korean beauty trends'
        ],
        '6': [
            'Design a gourmet food store homepage showcasing artisan products, recipes, and culinary inspiration',
            'Create an organic grocery homepage emphasizing farm-fresh produce, health benefits, and sustainability',
            'Build a specialty coffee store with brewing guides, origin stories, and subscription options',
            'Design a vegan food products homepage featuring plant-based alternatives, nutrition info, and lifestyle content'
        ],
        '7': [
            'Create a fitness equipment store homepage with workout inspiration, training guides, and transformation stories',
            'Build an outdoor sports gear homepage featuring adventure content, product durability, and activity guides',
            'Design a yoga and wellness store with calming aesthetics, mindfulness content, and community focus',
            'Create an athletic wear homepage with performance features, size guides, and athlete testimonials'
        ],
        '8': [
            'Design a premium pet nutrition homepage emphasizing quality ingredients, health benefits, and pet care tips',
            'Create a pet accessories store with playful design, product variety, and pet parent community',
            'Build a natural pet care homepage focusing on holistic wellness, organic products, and vet recommendations',
            'Design a luxury pet products store with sophisticated aesthetics and high-end pet lifestyle'
        ]
    };

    const nichePrompts = prompts[nicheChoice];
    if (!nichePrompts) return null;

    // Randomly select one prompt from the niche
    const randomIndex = Math.floor(Math.random() * nichePrompts.length);
    return nichePrompts[randomIndex];
}

/**
 * Generate product page prompts based on niche
 */
function getProductPrompt(nicheChoice) {
    const prompts = {
        '1': [
            'Create a product page for a premium organic cotton t-shirt with size chart, sustainability features, and style recommendations',
            'Design a product page for designer jeans with fit guide, wash instructions, and styling tips',
            'Build a product page for a luxury evening dress with fabric details, size chart, and care instructions',
            'Create a product page for sustainable sneakers with eco-certifications, sizing guide, and comfort features'
        ],
        '2': [
            'Design a product page for a handcrafted gold necklace with customization options, metal purity, and care guide',
            'Create a product page for a luxury watch with technical specifications, warranty, and authentication',
            'Build a product page for custom engagement ring with diamond details, sizing guide, and engraving options',
            'Design a product page for artisan earrings with material details, hypoallergenic info, and styling options'
        ],
        '3': [
            'Create a product page for wireless headphones with technical specs, battery life, and compatibility info',
            'Design a product page for a smart home device with setup guide, features, and integration options',
            'Build a product page for gaming laptop with detailed specs, performance benchmarks, and warranty',
            'Create a product page for smartphone with features comparison, storage options, and trade-in program'
        ],
        '4': [
            'Design a product page for modern sofa with dimensions, fabric options, and delivery information',
            'Create a product page for handmade ceramic vase with artist story, care instructions, and gift options',
            'Build a product page for luxury bedding set with thread count, material details, and washing guide',
            'Create a product page for eco-friendly storage solution with dimensions, assembly guide, and sustainability'
        ],
        '5': [
            'Create a product page for anti-aging serum with ingredients, usage instructions, and before/after results',
            'Design a product page for organic makeup palette with shade guide, ingredient list, and application tips',
            'Build a product page for men\'s grooming kit with product details, usage guide, and subscription option',
            'Create a product page for K-beauty skincare with step-by-step routine, ingredients, and skin type guide'
        ],
        '6': [
            'Design a product page for artisan coffee beans with origin story, roast profile, and brewing guide',
            'Create a product page for organic honey with health benefits, sourcing info, and recipe ideas',
            'Build a product page for specialty tea with tasting notes, brewing instructions, and health benefits',
            'Create a product page for vegan protein powder with nutrition facts, flavor options, and recipes'
        ],
        '7': [
            'Create a product page for yoga mat with material details, size guide, and care instructions',
            'Design a product page for running shoes with fit technology, size chart, and performance features',
            'Build a product page for home gym equipment with specs, assembly guide, and workout tips',
            'Create a product page for activewear leggings with fabric technology, size guide, and washing instructions'
        ],
        '8': [
            'Design a product page for organic dog food with ingredients, feeding guide, and nutritional analysis',
            'Create a product page for interactive pet toy with features, safety info, and size recommendations',
            'Build a product page for pet grooming kit with product details, usage guide, and tutorial videos',
            'Create a product page for premium cat litter with benefits, usage instructions, and subscription option'
        ]
    };

    const productPrompts = prompts[nicheChoice];
    if (!productPrompts) return null;

    const randomIndex = Math.floor(Math.random() * productPrompts.length);
    return productPrompts[randomIndex];
}

/**
 * Main interactive flow
 */
async function main() {
    try {
        while (true) {
            const choice = await showMenu();

            switch (choice) {
                case '1':
                    // Homepage from niche
                    const nicheChoice1 = await showNicheMenu();
                    let selectedHomepagePrompt;

                    if (nicheChoice1 === '9') {
                        selectedHomepagePrompt = await prompt('\n📝 Describe your store:\n> ');
                        if (!selectedHomepagePrompt.trim()) {
                            console.log('❌ Prompt cannot be empty');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                    } else {
                        selectedHomepagePrompt = getNichePrompt(nicheChoice1);
                        if (!selectedHomepagePrompt) {
                            console.log('❌ Invalid niche selection');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                        console.log(`\n📝 Homepage prompt: "${selectedHomepagePrompt}"\n`);
                    }

                    console.log('🚀 Generating homepage...\n');
                    await runFullPipeline(selectedHomepagePrompt.trim(), { 
                        templateName: 'index',
                        autoCopy: true 
                    });
                    await prompt('\n✅ Done! Press Enter to continue...');
                    break;

                case '2':
                    // Product page from niche
                    const nicheChoice2 = await showNicheMenu();
                    let selectedProductPrompt;

                    if (nicheChoice2 === '9') {
                        selectedProductPrompt = await prompt('\n📝 Describe your product:\n> ');
                        if (!selectedProductPrompt.trim()) {
                            console.log('❌ Prompt cannot be empty');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                    } else {
                        selectedProductPrompt = getProductPrompt(nicheChoice2);
                        if (!selectedProductPrompt) {
                            console.log('❌ Invalid niche selection');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                        console.log(`\n📝 Product prompt: "${selectedProductPrompt}"\n`);
                    }

                    console.log('🚀 Generating product page...\n');
                    await runFullPipeline(selectedProductPrompt.trim(), { 
                        templateName: 'product',
                        autoCopy: true 
                    });
                    await prompt('\n✅ Done! Press Enter to continue...');
                    break;

                case '3':
                    // Both homepage + product page
                    const nicheChoice3 = await showNicheMenu();
                    let homepagePrompt3, productPrompt3;

                    if (nicheChoice3 === '9') {
                        homepagePrompt3 = await prompt('\n📝 Describe your store:\n> ');
                        productPrompt3 = await prompt('\n📝 Describe a typical product:\n> ');
                        if (!homepagePrompt3.trim() || !productPrompt3.trim()) {
                            console.log('❌ Both prompts are required');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                    } else {
                        homepagePrompt3 = getNichePrompt(nicheChoice3);
                        productPrompt3 = getProductPrompt(nicheChoice3);
                        if (!homepagePrompt3 || !productPrompt3) {
                            console.log('❌ Invalid niche selection');
                            await prompt('Press Enter to continue...');
                            break;
                        }
                        console.log(`\n📝 Homepage: "${homepagePrompt3}"`);
                        console.log(`📝 Product: "${productPrompt3}"\n`);
                    }

                    console.log('🚀 Generating homepage...\n');
                    await runFullPipeline(homepagePrompt3.trim(), { 
                        templateName: 'index',
                        autoCopy: true 
                    });
                    
                    console.log('\n🚀 Generating product page...\n');
                    await runFullPipeline(productPrompt3.trim(), { 
                        templateName: 'product',
                        autoCopy: true 
                    });
                    await prompt('\n✅ Done! Press Enter to continue...');
                    break;

                case '4':
                    // Custom homepage prompt
                    const customHomepagePrompt = await prompt(
                        '\n📝 Describe your store (e.g., "Premium pet food store"):\n> '
                    );
                    if (!customHomepagePrompt.trim()) {
                        console.log('❌ Prompt cannot be empty');
                        await prompt('Press Enter to continue...');
                        break;
                    }
                    console.log('\n🚀 Generating homepage...\n');
                    await runFullPipeline(customHomepagePrompt.trim(), { autoCopy: true });
                    await prompt('\n✅ Done! Press Enter to continue...');
                    break;

                case '5':
                    // Custom homepage prompt with Phase 3 clarification loop.
                    // Real Q&A loop (supersedes the canned niche picklist for
                    // this path only — options 1-4 are left exactly as they
                    // were, per the phase's own rollback requirement).
                    const initialDescription = await prompt(
                        '\n📝 Describe your store:\n> '
                    );
                    if (!initialDescription.trim()) {
                        console.log('❌ Description cannot be empty');
                        await prompt('Press Enter to continue...');
                        break;
                    }

                    let understanding = await understandRequest(initialDescription.trim());
                    let rounds = 0;
                    while (understanding.status === 'NEEDS_CLARIFICATION' && rounds < 5) {
                        console.log('\n❓ A few quick questions before we generate your store:\n');
                        understanding.questions.forEach((q, i) => console.log(`   ${i + 1}. ${q}`));
                        const answer = await prompt('\n> ');
                        understanding = await understandRequest(answer.trim(), { sessionId: understanding.sessionId });
                        rounds++;
                    }

                    if (understanding.status !== 'READY') {
                        console.log('\n⚠️  Could not fully resolve requirements after several rounds — generating with what we have.\n');
                    } else {
                        console.log('\n✅ Got it! Generating your store...\n');
                    }

                    await runFullPipeline(initialDescription.trim(), { autoCopy: true });
                    await prompt('\n✅ Done! Press Enter to continue...');
                    break;

                case '6':
                    // View documentation
                    console.log('\n� Documentation:\n');
                    console.log('AI Theme Generation:');
                    console.log('  - Homepage: 10 sections with varied layouts');
                    console.log('  - Product Page: 12-18 blocks with conversion optimization');
                    console.log('  - Both: Complete store setup\n');
                    console.log('Available niches:');
                    console.log('  Fashion, Jewelry, Electronics, Home, Beauty,');
                    console.log('  Food, Fitness, Pet Supplies\n');
                    await prompt('Press Enter to continue...');
                    break;

                case '7':
                    // Just copy
                    console.log('\n📋 Copying existing files...\n');
                    const { copyGeneratedFilesToTheme } = require('./2-copy-to-theme');
                    await copyGeneratedFilesToTheme();
                    await prompt('Press Enter to continue...');
                    break;

                case '8':
                    // Exit
                    console.log('\n👋 Goodbye!\n');
                    rl.close();
                    return;

                default:
                    console.log('\n❌ Invalid option. Please choose 1-8.\n');
                    await prompt('Press Enter to continue...');
            }
        }
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        rl.close();
        process.exit(1);
    }
}

// Run the interactive menu
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { showMenu };
