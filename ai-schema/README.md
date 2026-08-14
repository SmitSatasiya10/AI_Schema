# AI Theme Generator

AI-powered Shopify theme configuration system using schema constraints and automated file deployment.

## Quick Start

```bash
npm install
npm start
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm start` | Interactive menu for all options |
| `npm run generate` | Generate theme with AI and auto-copy to theme folder |
| `npm run copy` | Copy existing generated files to theme folder |
| `npm run menu` | Show interactive menu |

## Setup

1. Copy `.env.example` to `.env`
2. Add your OpenRouter API key to `.env`
3. Run `npm install`
4. Run `npm start`

## File Structure

```
ai-schema/
├── 1-generate-theme.js      # Main generation script
├── 2-copy-to-theme.js        # Copy utility
├── 3-interactive-menu.js     # Interactive menu
├── example-implementation.js # Core AI logic
├── SCHEMA_CREATION_GUIDE.md  # Schema documentation
├── sections/                 # Section schemas
├── blocks/                   # Block schemas
└── output/                   # Generated files (auto-copied)
```

## How It Works

1. **Load Schemas**: Reads JSON schemas from `sections/` and `blocks/`
2. **AI Generation**: Uses OpenRouter API to generate theme configuration
3. **Validation**: Validates output against schemas
4. **Auto-Deploy**: Copies generated files to theme folders automatically

## Schema Creation

See `SCHEMA_CREATION_GUIDE.md` for detailed instructions on creating section and block schemas.

## Generated Files

All generated files are automatically copied to:
- `templates/index.json` → Theme homepage configuration
- `config/settings_data.json` → Theme settings
- `assets/generated-images/` → AI-generated images (if enabled)

## Environment Variables

```env
OPENROUTER_API_KEY=your_key_here
```

---

**Need Help?** Check `SCHEMA_CREATION_GUIDE.md` for schema creation guidelines.
