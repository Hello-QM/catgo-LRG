# Contributing to CatGO

Thank you for your interest in contributing to CatGO! This guide covers how to set up your development environment, follow the project's conventions, and submit contributions.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) package manager
- [Rust](https://rustup.rs/) toolchain (for WASM development)
- [Python 3.10+](https://python.org/) (for the computation server)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-org/CatGO.git
cd CatGO

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

The dev server runs on `http://localhost:3000` with hot module replacement.

## Project Structure

```
CatGO/
├── src/lib/                  # Svelte component library
│   ├── structure/            # 3D structure viewer (largest module)
│   ├── bands/                # Band structure & DOS
│   ├── periodic-table/       # Interactive periodic table
│   ├── phase-diagram/        # Phase diagram components
│   ├── trajectory/           # MD trajectory player
│   ├── api/                  # API clients (OPTIMADE, MP, PubChem)
│   └── settings.ts           # Unified settings schema
├── extensions/rust/          # Rust library compiled to WASM
├── server/                   # Python FastAPI backend
├── src-tauri/                # Tauri desktop app shell
├── extensions/vscode/        # VSCode extension
├── tests/vitest/             # Unit tests
├── tests/playwright/         # E2E tests
└── docs/                     # Documentation (you are here)
```

## Development Workflow

### Branch Naming

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring
- `chore/description` — Tooling, CI, dependencies

### Running Tests

```bash
# Unit tests (Vitest + happy-dom)
pnpm test              # Run once
pnpm vitest            # Watch mode

# Type checking (TypeScript + Svelte)
pnpm check

# End-to-end tests (Playwright)
npx playwright test
```

### Building

```bash
# Production web build
pnpm build

# Desktop app (development)
pnpm tauri:dev

# Desktop app (production)
pnpm tauri:build
```

## Code Style

### General

- **Template literals** (backticks) for strings
- **ESM imports** throughout
- **TypeScript** in strict mode
- No semicolons (unless required for disambiguation)

### Svelte 5

CatGO uses **Svelte 5 runes**, not the older Store API:

```svelte
<!-- Correct: Svelte 5 runes -->
<script lang="ts">
  let count = $state(0)
  let doubled = $derived(count * 2)

  $effect(() => {
    console.log(`Count is ${count}`)
  })
</script>

<!-- Incorrect: old Store API -->
<script>
  import { writable } from 'svelte/store'
  const count = writable(0)  // Don't use this
</script>
```

### File Organization

- Types live alongside their implementations (not in separate `types/` directories)
- Exports are collected via `index.ts` files
- Feature-based directory structure (group by feature, not by file type)

### Settings

All configurable options are defined in `src/lib/settings.ts` with:
- Type definitions
- Default values
- Min/max constraints
- Human-readable descriptions
- Context annotations (web, editor, notebook, all)

When adding a new setting, add it to the schema in `settings.ts` so it's automatically available across all deployment targets.

## Adding Features

### Where Does the Code Go?

| Feature Type | Location |
|-------------|----------|
| Geometry / math / structure operations | `extensions/rust/` (Rust/WASM) |
| UI components and visualization | `src/lib/` (Svelte) |
| Database / API / auth operations | `server/` (FastAPI) |
| Settings and configuration | `src/lib/settings.ts` |

### Adding a New WASM Function

See the [Development Guide](/developer/development-guide) for the full WASM development workflow:

1. Implement in Rust (`extensions/rust/src/wasm.rs`)
2. Build with wasm-pack
3. Add TypeScript wrapper (`src/lib/structure/ferrox-wasm.ts`)
4. Add types (`src/lib/structure/ferrox-wasm-types.ts`)

### Naming Conventions

- WASM function names that conflict with TypeScript: prefix with `wasm_`
- WASM type names that conflict: prefix with `Wasm`
- Settings keys: `snake_case`
- Component names: `PascalCase.svelte`
- Utility functions: `snake_case`

## Testing

### Unit Tests

Located in `tests/vitest/`. Uses **Vitest** with **happy-dom** environment.

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm vitest tests/vitest/parse.test.ts

# Watch mode
pnpm vitest
```

### Adding a Test

```typescript
import { describe, it, expect } from 'vitest'

describe(`my feature`, () => {
  it(`should do something`, () => {
    const result = my_function(input)
    expect(result).toBe(expected)
  })
})
```

### Test Fixtures

Place test data in `tests/vitest/fixtures/`. Supported fixture formats:
- CIF, POSCAR, XYZ files for structure parsing tests
- JSON files for expected output comparisons

### E2E Tests

Located in `tests/playwright/`. Uses **Playwright** for browser-based testing.

```bash
npx playwright test
```

## Pull Request Process

1. **Create a branch** from `main` with a descriptive name
2. **Make your changes** following the code style above
3. **Run tests** — `pnpm test` and `pnpm check` must pass
4. **Write a clear PR description** with:
   - What the change does
   - Why it's needed
   - How to test it
5. **Request review** — PRs require at least one approval
6. **Squash and merge** — Commits are squashed on merge

### PR Description Template

```markdown
## Summary
Brief description of changes.

## Changes
- List of specific changes

## Test plan
- [ ] Unit tests pass
- [ ] Manual testing steps
- [ ] Edge cases considered
```

## Documentation

Documentation lives in `docs/` as Markdown files. When adding or changing features:

- Update the relevant module doc in `docs/modules/`
- Add a tutorial in `docs/tutorials/` for user-facing features
- Update the [FAQ](/reference/faq) if the change addresses a common question
- Update the [Changelog](/reference/changelog) with the change

## Reporting Issues

Open an issue on GitHub with:

1. **Steps to reproduce** — Minimal, concrete steps
2. **Expected behavior** — What should happen
3. **Actual behavior** — What actually happens
4. **Environment** — Browser, OS, CatGO version
5. **Sample file** — Attach if the issue involves a specific structure

## Getting Help

- Open an issue for bugs or feature requests
- Check the [FAQ](/reference/faq) for common questions
- Read the [Tips and Tricks](/guide/tips-and-tricks) for usage guidance
