# 📝 Schema Creation Guide

## How to Create Section and Block Schema JSON Files

This guide explains how to create schema files for sections and blocks that the AI will use to generate theme configurations.

---

## 📁 File Structure

```
ai-schema/
├── sections/           ← Section schemas go here
│   ├── slideshow.json
│   ├── featured-product.json
│   └── ...
├── blocks/            ← Block schemas go here
│   ├── slide.json
│   ├── product.json
│   └── ...
└── global.json        ← Global theme settings
```

---

## 🎯 Section Schema Structure

### Basic Template

```json
{
    "id": "unique-section-id",
    "label": "Human Readable Name",
    "purpose": "Brief description of what this section does",
    "allowed_on": [
        "index",
        "product",
        "collection",
        "page"
    ],
    "settings": {
        "setting_name": "setting_type"
    },
    "allowed_blocks": [
        "block-id-1",
        "block-id-2"
    ],
    "_image_generation": {
        "enabled": true,
        "field_name": "background_image",
        "prompt_template": "A beautiful {style} background for {purpose}"
    }
}
```

### Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ Yes | Unique identifier (kebab-case) |
| `label` | string | ✅ Yes | Display name for the section |
| `purpose` | string | ✅ Yes | What the section is used for |
| `allowed_on` | array | ✅ Yes | Which pages can use this section |
| `settings` | object | ✅ Yes | Settings configuration |

### Optional Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `allowed_blocks` | array | ❌ No | Block types this section can contain |
| `_image_generation` | object | ❌ No | AI image generation configuration |
| `_notes` | string | ❌ No | Important notes for AI (constraints, rules) |

---

## 🧩 Block Schema Structure

### Basic Template

```json
{
    "id": "unique-block-id",
    "label": "Human Readable Name",
    "purpose": "Brief description of what this block does",
    "settings": {
        "setting_name": "setting_type"
    },
    "_notes": "Special instructions for AI"
}
```

### Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ Yes | Unique identifier (kebab-case) |
| `label` | string | ✅ Yes | Display name for the block |
| `purpose` | string | ✅ Yes | What the block is used for |
| `settings` | object | ✅ Yes | Settings configuration |

---

## ⚙️ Settings Types

### Simple Types (String Values)

```json
{
    "title": "text",
    "description": "textarea",
    "heading": "inline_richtext",
    "content": "richtext",
    "html_content": "html",
    "image": "image_picker",
    "video": "video",
    "url": "url",
    "color": "color"
}
```

### Array Types (Multiple Options)

```json
{
    "layout": ["horizontal", "vertical", "grid"],
    "style": ["modern", "classic", "minimal"],
    "alignment": ["left", "center", "right"]
}
```

### Object Types (Complex Settings)

#### Number with Constraints
```json
{
    "animation_duration": {
        "type": "number",
        "min": 0,
        "max": 1000,
        "default": 500
    }
}
```

#### Range Slider
```json
{
    "opacity": {
        "type": "range",
        "min": 0,
        "max": 100,
        "step": 5,
        "unit": "%",
        "default": 80
    }
}
```

#### Select with Options
```json
{
    "section_height": {
        "type": "select",
        "options": [
            { "value": "small", "label": "Small" },
            { "value": "medium", "label": "Medium" },
            { "value": "large", "label": "Large" }
        ],
        "default": "medium"
    }
}
```

---

## 📋 Common Setting Types Reference

| Type | Description | Example Use |
|------|-------------|-------------|
| `text` | Short text input | Titles, headings |
| `textarea` | Multi-line text | Descriptions, paragraphs |
| `inline_richtext` | Rich text (one line) | Formatted titles |
| `richtext` | Rich text (multi-line) | Long content |
| `html` | HTML code | Custom code |
| `image_picker` | Image selector | Backgrounds, logos |
| `video` | Video URL | Hero videos |
| `url` | Link URL | Button links |
| `color` | Color picker | Brand colors |
| `number` | Numeric input | Counts, durations |
| `range` | Slider | Opacity, sizes |
| `select` | Dropdown | Pre-defined options |
| `checkbox` | True/false | Enable/disable features |
| `radio` | Single choice | Layout options |

---

## 📝 Real Examples

### Example 1: Simple Section (Image Banner)

```json
{
    "id": "image-banner",
    "label": "Image Banner",
    "purpose": "Display a promotional banner with image and text overlay",
    "allowed_on": ["index", "page"],
    "settings": {
        "image": "image_picker",
        "title": "inline_richtext",
        "subtitle": "text",
        "button_text": "text",
        "button_url": "url",
        "overlay_opacity": {
            "type": "range",
            "min": 0,
            "max": 100,
            "step": 10,
            "unit": "%",
            "default": 50
        },
        "text_alignment": ["left", "center", "right"],
        "height": ["small", "medium", "large", "full"]
    },
    "_image_generation": {
        "enabled": true,
        "field_name": "image",
        "prompt_template": "A professional {height} banner image for an e-commerce store"
    }
}
```

### Example 2: Section with Blocks (Slideshow)

```json
{
    "id": "slideshow",
    "label": "Slideshow",
    "purpose": "Display a rotating carousel of slides with images and content",
    "allowed_on": ["index"],
    "settings": {
        "autoplay": ["true", "false"],
        "slide_duration": {
            "type": "number",
            "min": 2000,
            "max": 10000,
            "default": 5000
        },
        "show_arrows": ["true", "false"],
        "show_dots": ["true", "false"],
        "transition": ["fade", "slide", "zoom"]
    },
    "allowed_blocks": ["slide"],
    "_notes": "Slideshow must have at least 2 slides to function properly"
}
```

### Example 3: Simple Block (Slide)

```json
{
    "id": "slide",
    "label": "Slide",
    "purpose": "Individual slide in a slideshow with image and text",
    "settings": {
        "image": "image_picker",
        "heading": "inline_richtext",
        "subheading": "text",
        "button_label": "text",
        "button_link": "url",
        "text_color": "color",
        "content_position": ["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"]
    },
    "_image_generation": {
        "enabled": true,
        "field_name": "image",
        "prompt_template": "Hero slide image for {heading}"
    }
}
```

### Example 4: Complex Block (Product Card)

```json
{
    "id": "product-card",
    "label": "Product Card",
    "purpose": "Display a featured product with customizable layout",
    "settings": {
        "product": "product_picker",
        "show_vendor": ["true", "false"],
        "show_price": ["true", "false"],
        "show_rating": ["true", "false"],
        "image_ratio": ["square", "portrait", "landscape", "original"],
        "badge_text": "text",
        "badge_color": "color",
        "hover_effect": ["none", "zoom", "fade", "lift"]
    },
    "_notes": "Product must be selected. If no product is selected, the block will not display."
}
```

---

## 🎨 Image Generation Configuration

Add `_image_generation` to enable AI image generation for a field:

```json
{
    "_image_generation": {
        "enabled": true,
        "field_name": "background_image",
        "prompt_template": "A {style} background for {purpose}"
    }
}
```

### Configuration Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | ✅ Yes | Enable image generation |
| `field_name` | string | ✅ Yes | Which setting field to populate |
| `prompt_template` | string | ❌ No | Custom prompt (uses placeholders) |

### Available Placeholders

- `{style}` - Style from settings or detected
- `{purpose}` - Section/block purpose
- `{heading}` - Heading text
- `{title}` - Title text
- Store description from user prompt

---

## 📌 Important Notes & Best Practices

### 1. Use `_notes` for AI Constraints

```json
{
    "settings": {
        "description": "richtext"
    },
    "_notes": "Description must be wrapped in <p> tags for proper rendering"
}
```

### 2. Naming Conventions

- **IDs**: Use `kebab-case` (e.g., `featured-product`, `hero-banner`)
- **Labels**: Use `Title Case` (e.g., "Featured Product", "Hero Banner")
- **Settings**: Use `snake_case` (e.g., `button_text`, `show_arrows`)

### 3. Default Values

Always provide sensible defaults:

```json
{
    "autoplay": {
        "type": "checkbox",
        "default": true
    },
    "duration": {
        "type": "number",
        "min": 1000,
        "max": 10000,
        "default": 5000
    }
}
```

### 4. Validation Rules

```json
{
    "email": {
        "type": "text",
        "validation": "email"
    },
    "phone": {
        "type": "text",
        "validation": "phone"
    }
}
```

### 5. Allowed On Pages

Common page templates:
- `index` - Homepage
- `product` - Product pages
- `collection` - Collection pages
- `page` - Static pages
- `blog` - Blog pages
- `article` - Blog post pages
- `cart` - Cart page
- `account` - Account pages

---

## ✅ Schema Validation Checklist

Before creating a schema, ensure:

- [ ] `id` is unique across all sections/blocks
- [ ] `label` is descriptive and human-readable
- [ ] `purpose` explains what the section/block does
- [ ] `allowed_on` includes all relevant page types
- [ ] All settings have appropriate types
- [ ] Complex settings include `min`, `max`, `default` values
- [ ] Array options are relevant and complete
- [ ] `_notes` document any special requirements
- [ ] `_image_generation` is configured if needed
- [ ] Naming follows conventions (kebab-case for IDs)

---

## 🔍 Testing Your Schema

After creating a schema file:

1. **Verify JSON is valid**:
   ```bash
   cat sections/your-section.json | jq .
   ```

2. **Test with AI generation**:
   ```bash
   cd ai-schema
   node generate-and-copy.js --prompt "Test with my new section"
   ```

3. **Check if AI uses your section**:
   - Look at generated `templates/index.json`
   - Verify settings are populated correctly
   - Check if image generation works (if enabled)

---

## 📚 Additional Examples

### Testimonials Section

```json
{
    "id": "testimonials",
    "label": "Testimonials",
    "purpose": "Display customer testimonials and reviews",
    "allowed_on": ["index", "page"],
    "settings": {
        "heading": "inline_richtext",
        "subheading": "text",
        "layout": ["grid", "slider", "masonry"],
        "columns": {
            "type": "range",
            "min": 1,
            "max": 4,
            "default": 3
        },
        "show_stars": ["true", "false"],
        "background_color": "color"
    },
    "allowed_blocks": ["testimonial"],
    "_notes": "Testimonials section should have at least 3 testimonial blocks for best appearance"
}
```

### Testimonial Block

```json
{
    "id": "testimonial",
    "label": "Testimonial",
    "purpose": "Individual customer testimonial with quote and author",
    "settings": {
        "quote": "textarea",
        "author": "text",
        "author_title": "text",
        "author_image": "image_picker",
        "rating": {
            "type": "range",
            "min": 1,
            "max": 5,
            "step": 1,
            "default": 5
        }
    },
    "_notes": "Quote should be the actual testimonial text, not wrapped in quotes"
}
```

---

## 🎯 Common Patterns

### Enable/Disable Feature

```json
{
    "show_feature": ["true", "false"]
}
```

### Layout Options

```json
{
    "layout": ["horizontal", "vertical", "grid"]
}
```

### Size Options

```json
{
    "size": ["small", "medium", "large"]
}
```

### Alignment

```json
{
    "alignment": ["left", "center", "right"]
}
```

### Duration/Timing

```json
{
    "duration": {
        "type": "number",
        "min": 0,
        "max": 1000,
        "default": 500
    }
}
```

---

## 📞 Need Help?

- Check existing schemas in `ai-schema/sections/` and `ai-schema/blocks/`
- Review `global.json` for theme-wide settings
- Test your schema with `node generate-and-copy.js`
- Look at generated output in `ai-schema/output/templates/`

---

## 🚀 Quick Start Example

Create a new section:

```bash
# 1. Create new section file
touch ai-schema/sections/my-new-section.json

# 2. Add schema structure (use examples above)

# 3. Test with AI
cd ai-schema
node generate-and-copy.js --prompt "Use my new section"

# 4. Check output
cat output/templates/index.json | jq .
```

---

**Happy schema creating!** 🎨

For more info, see:
- `GENERATION_GUIDE.md` - AI generation system
- `example-implementation.js` - How schemas are used
- Existing schemas in `sections/` and `blocks/`
