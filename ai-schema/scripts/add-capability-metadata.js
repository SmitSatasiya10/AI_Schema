#!/usr/bin/env node
/**
 * ONE-TIME DATA MIGRATION (Phase 2) — adds `category` and `tags` metadata
 * directly into the existing 16 section + 53 block schema JSON files.
 *
 * This is authored, curated classification data (which of a small closed
 * taxonomy each schema belongs to), not derived data — so per the plan's
 * "do not create a second source of truth" rule it is written into the
 * schema files themselves (the existing convention already keeps id/label/
 * purpose/allowed_on/settings there), rather than into a separately
 * maintained mapping file that could drift out of sync with the schemas.
 *
 * Everything else about each schema file (settings, allowed_blocks,
 * max_blocks, _notes, _image_generation, template) is left untouched —
 * only `category` and `tags` are added, inserted right after `purpose` for
 * readability.
 *
 * This script is a one-time authoring aid, run once and committed as a
 * record of what changed and why. It is NOT part of the ongoing build —
 * that's capability-index.js, which derives the index from these fields
 * (plus fully computed data like block "local vs standalone" scope) every
 * time it runs, so it can never drift from the schema files.
 *
 * Re-running this script is idempotent: it overwrites category/tags with
 * the same table below rather than appending duplicates.
 */
const fs = require('fs');
const path = require('path');

const SECTIONS_DIR = path.join(__dirname, '..', 'sections');
const BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

// Closed taxonomy (Phase 2 §4). "navigation-utility" from the approved
// plan's example taxonomy is deliberately NOT used — nothing in the current
// 16/53 schema catalog fits it (header/footer/nav live outside AI-schema
// coverage today), so it's omitted per "use the smallest taxonomy that
// makes retrieval useful."
const CATEGORIES = [
    'hero', 'content', 'social-proof', 'product-showcase', 'product-detail',
    'conversion', 'trust-badges', 'layout-structural', 'media', 'form-input', 'misc'
];

// Keyed by filename (not id) so every one of the 69 files is targeted
// unambiguously, including the 8 files where the filename and internal
// "id" differ (e.g. atc_button.json -> id "atc-button").
const SECTION_METADATA = {
    'collage.json': { category: 'content', tags: ['visual', 'product'] },
    'comparison-table.json': { category: 'conversion', tags: ['comparison', 'benefits'] },
    'contact-form.json': { category: 'form-input', tags: ['contact'] },
    'content-tabs.json': { category: 'content', tags: ['tabs'] },
    'custom-columns.json': { category: 'content', tags: ['layout', 'legacy'] },
    'featured-collection.json': { category: 'product-showcase', tags: [] },
    'horizontal-ticker.json': { category: 'trust-badges', tags: ['ticker', 'certifications'] },
    'icon-bar.json': { category: 'content', tags: ['benefits', 'icons'] },
    'image-with-text.json': { category: 'content', tags: ['visual'] },
    'main-product.json': { category: 'product-detail', tags: [] },
    'newsletter.json': { category: 'form-input', tags: ['newsletter'] },
    'results.json': { category: 'social-proof', tags: ['stats'] },
    'section-divider.json': { category: 'layout-structural', tags: [] },
    'slideshow.json': { category: 'hero', tags: [] },
    'testimonials.json': { category: 'social-proof', tags: ['testimonial', 'reviews'] },
    'vertical-ticker.json': { category: 'content', tags: ['ticker'] }
};

const BLOCK_METADATA = {
    'accordion.json': { category: 'content', tags: ['expandable'] },
    'atc_button.json': { category: 'conversion', tags: ['cta', 'add-to-cart'] },
    'button.json': { category: 'conversion', tags: ['cta'] },
    'buttons.json': { category: 'conversion', tags: ['cta'] },
    'caption.json': { category: 'content', tags: [] },
    'collapsible-row.json': { category: 'content', tags: ['expandable', 'faq'] },
    'collection.json': { category: 'product-showcase', tags: [] },
    'column.json': { category: 'social-proof', tags: ['testimonial', 'benefits'] },
    'countdown_timer.json': { category: 'conversion', tags: ['urgency'] },
    'custom_liquid.json': { category: 'misc', tags: ['custom-code'] },
    'email_form.json': { category: 'form-input', tags: ['newsletter'] },
    'email_signup.json': { category: 'form-input', tags: ['newsletter'] },
    'heading.json': { category: 'content', tags: [] },
    'icon_with_text.json': { category: 'content', tags: ['benefits', 'icons'] },
    'image.json': { category: 'media', tags: [] },
    'input_row.json': { category: 'form-input', tags: [] },
    'media_slider.json': { category: 'media', tags: ['slider'] },
    'paragraph.json': { category: 'content', tags: [] },
    'payment-badges.json': { category: 'trust-badges', tags: ['payment'] },
    'product-rating.json': { category: 'trust-badges', tags: ['rating', 'reviews'] },
    'product.json': { category: 'product-showcase', tags: [] },
    'product_award-badge.json': { category: 'trust-badges', tags: ['awards', 'certifications'] },
    'product_bundle-offer.json': { category: 'conversion', tags: ['bundle', 'upsell'] },
    'product_buy-buttons.json': { category: 'product-detail', tags: ['cta', 'add-to-cart'] },
    'product_clickable-discount.json': { category: 'conversion', tags: ['discount'] },
    'product_custom-product-field.json': { category: 'product-detail', tags: ['personalization'] },
    'product_description.json': { category: 'product-detail', tags: [] },
    'product_estimated-shipping.json': { category: 'product-detail', tags: ['shipping', 'trust'] },
    'product_inventory.json': { category: 'conversion', tags: ['urgency', 'stock'] },
    'product_price.json': { category: 'product-detail', tags: [] },
    'product_product-variant-picker-block.json': { category: 'product-detail', tags: ['variants'] },
    'product_quantity-gifts.json': { category: 'conversion', tags: ['upsell'] },
    'product_quantity-selector.json': { category: 'product-detail', tags: [] },
    'product_share-button.json': { category: 'product-detail', tags: ['social'] },
    'product_shipping-checkpoints.json': { category: 'trust-badges', tags: ['shipping'] },
    'product_sizing-chart.json': { category: 'product-detail', tags: ['sizing'] },
    'product_sticky-atc.json': { category: 'conversion', tags: ['cta'] },
    'product_subscription.json': { category: 'conversion', tags: ['subscription'] },
    'product_tabs.json': { category: 'product-detail', tags: ['tabs'] },
    'product_title.json': { category: 'product-detail', tags: [] },
    'product_urgency.json': { category: 'conversion', tags: ['urgency'] },
    'rating-stars.json': { category: 'trust-badges', tags: ['rating', 'reviews'] },
    'review-avatars.json': { category: 'social-proof', tags: ['reviews'] },
    'row.json': { category: 'social-proof', tags: ['stats', 'comparison'] },
    'slide.json': { category: 'hero', tags: [] },
    'tab.json': { category: 'content', tags: ['tabs'] },
    'text.json': { category: 'content', tags: [] },
    'text_with_icon.json': { category: 'content', tags: ['icons'] },
    'textarea.json': { category: 'form-input', tags: [] },
    'tnc_checkbox.json': { category: 'form-input', tags: [] },
    'trustpilot_stars.json': { category: 'trust-badges', tags: ['rating', 'reviews'] },
    'video.json': { category: 'media', tags: [] }
};

function applyMetadata(dir, metadataTable, kind) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    const missing = files.filter(f => !metadataTable[f]);
    if (missing.length > 0) {
        throw new Error(`${kind}: no metadata entry for: ${missing.join(', ')} — update the migration table before running.`);
    }
    const extra = Object.keys(metadataTable).filter(f => !files.includes(f));
    if (extra.length > 0) {
        throw new Error(`${kind}: metadata table references files that don't exist on disk: ${extra.join(', ')}`);
    }

    let changed = 0;
    for (const file of files) {
        const filePath = path.join(dir, file);
        const original = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const meta = metadataTable[file];

        if (!CATEGORIES.includes(meta.category)) {
            throw new Error(`${kind}/${file}: category "${meta.category}" is not in the closed taxonomy`);
        }

        // Rebuild the object with category/tags inserted right after "purpose"
        // (or after "label" if purpose is absent), preserving every other
        // field and its original order/content untouched.
        const rebuilt = {};
        let inserted = false;
        for (const [key, value] of Object.entries(original)) {
            rebuilt[key] = value;
            if (key === 'purpose') {
                rebuilt.category = meta.category;
                rebuilt.tags = meta.tags;
                inserted = true;
            }
        }
        if (!inserted) {
            rebuilt.category = meta.category;
            rebuilt.tags = meta.tags;
        }

        const newContent = JSON.stringify(rebuilt, null, 4) + '\n';
        fs.writeFileSync(filePath, newContent, 'utf8');
        changed++;
    }
    return changed;
}

function main() {
    const sectionsChanged = applyMetadata(SECTIONS_DIR, SECTION_METADATA, 'sections');
    const blocksChanged = applyMetadata(BLOCKS_DIR, BLOCK_METADATA, 'blocks');
    console.log(`Added category/tags metadata to ${sectionsChanged} section schemas and ${blocksChanged} block schemas.`);
}

if (require.main === module) {
    main();
}

module.exports = { CATEGORIES, SECTION_METADATA, BLOCK_METADATA };
