# LAMMPS Module Improvement - Long-Running Agent Harness

This directory contains a harness setup for improving the LAMMPS input file generation module using the long-running agent pattern described in [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

## Overview

The harness follows a two-agent pattern:

1. **Initializer Agent** (run once) - Sets up the environment with:
   - `lammps_features.json` - Complete feature list with all improvements
   - `claude-progress.txt` - Progress tracking log
   - `init.sh` - Script to start development servers
   - Initial state documentation

2. **Coding Agent** (run repeatedly) - Makes incremental progress:
   - Reads git logs and progress files to get up to speed
   - Reads the feature list and chooses ONE feature to work on
   - Tests the code before and after changes
   - Commits progress with descriptive messages
   - Updates the progress file

## Files

| File | Purpose |
|------|---------|
| `lammps_features.json` | Complete feature list with all improvements needed |
| `claude-progress.txt` | Log of what has been done |
| `init.sh` | Script to start dev servers (frontend on :3000, backend on :8000) |
| `docs/LAMMPS_MODULE_IMPROVEMENTS.md` | Original improvement document |
| `LAMMPS_HARNESS_README.md` | This file |

## Usage for Coding Agent Sessions

When starting a new coding session, follow this sequence:

### 1. Get Your Bearings

```bash
# Check your directory
pwd

# Read recent progress
cat claude-progress.txt

# Read the feature list
cat lammps_features.json

# Check git status (if using git)
git log --oneline -20
```

### 2. Start the Development Server

```bash
./init.sh
# Or manually: pnpm dev  # Frontend on port 3000
# And: cd server && python -m uvicorn main:app --reload  # Backend on port 8000
```

### 3. Test Basic Functionality

Before implementing new features, verify existing functionality works:
- Navigate to http://localhost:3000
- Load a structure file
- Generate LAMMPS inputs
- Verify the output is correct

### 4. Choose and Implement ONE Feature

From `lammps_features.json`, select:
1. The highest priority feature not yet passing (`"passes": false`)
2. Implement it completely
3. Test thoroughly
4. Update `lammps_features.json` to set `"passes": true`

### 5. Commit and Document

```bash
# Commit your changes
git add .
git commit -m "Fix: <feature description>

- Implemented <feature-id>
- <summary of changes>
- Tested with <test description>

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

# Update progress log
echo "<date> - Completed <feature-id>" >> claude-progress.txt
```

## Feature Priority Order

From `docs/LAMMPS_MODULE_IMPROVEMENTS.md`:

1. **CRITICAL-1**: Fix charge style bug (blocks functionality)
2. **CRITICAL-2**: Fix non-contiguous fixed atoms (data loss risk)
3. **HIGH-1**: Add input validation (user experience)
4. **HIGH-2**: Triclinic support in frontend (consistency)
5. **MEDIUM-1**: Unit tests (prevent regressions)
6. **MEDIUM-2**: Potential templates (user convenience)
7. **MEDIUM-3**: Enhanced error messages (debugging)
8. **LOW-1**: Additional atom styles (feature expansion)

## Important Rules

1. **Work on ONE feature at a time** - Do not try to implement multiple features in a single session
2. **Test thoroughly** - Run the application and verify the feature works end-to-end
3. **Commit frequently** - Each feature should be its own commit
4. **Update progress** - Always update `claude-progress.txt` after completing work
5. **Mark features as passing** - Only set `"passes": true` after verification

## Testing

### Unit Tests
```bash
# Run unit tests
deno task vitest

# Run specific test file
deno task vitest lammps.test.ts
```

### E2E Tests
```bash
# Run Playwright tests
npx playwright test

# Run specific test
npx playwright test lammps.spec.ts
```

## Module Structure

```
server/routers/lammps.py      # Backend API endpoints
├── extract_structure_info()   # Extract atoms, types, charges
├── get_box_bounds()          # Calculate LAMMPS box dimensions
├── transform_coords_to_lammps() # Convert coordinate systems
├── generate_data_file()      # Create .data file
└── generate_input_script()   # Create .in file

src/lib/structure/ExportPane.svelte  # Frontend UI
├── LAMMPS settings (lines 92-110)
├── generate_lammps() (lines 405-436)
└── gen_lammps_local() (lines 476-523) - Offline fallback
```

## Common Issues

| Issue | Solution |
|-------|----------|
| Charge style fails with JSON | Check CRITICAL-1 |
| Non-contiguous atoms error | Check CRITICAL-2 |
| Triclinic cells wrong offline | Check HIGH-2 |
| No validation warnings | Check HIGH-1 |

## Contact

For questions about this harness or the improvement process, refer to the [Anthropic article](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
