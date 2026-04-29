# CatGo Contributing Guide

> This guide is for contributors who use **AI assistants** (Claude Code / Cursor / GitHub Copilot) to work on CatGo.
> Even if you're new to the project, just follow the steps below.

---

## 1. Setting Up Your Environment

```bash
# 1. Clone the project
git clone https://github.com/Hello-QM/CatGO.git
cd CatGO

# 2. Install dependencies
pnpm install

# 3. Start the dev server (pick one)
pnpm dev              # Web version — opens http://localhost:3000
pnpm desktop:dev      # Desktop version (requires Rust + Tauri)

# 4. Start the backend (only needed for plugin/analysis/MCP development)
cd server
pip install -r requirements.txt
python main.py        # Backend runs at http://localhost:8000
```

---

## 2. All Project Knowledge Lives in the Repo

All architecture knowledge, code indexes, and implementation plans are **documented in repository files** — no external resources needed.

### Documentation Overview

| File | What It's For |
|------|---------------|
| `CLAUDE.md` | Project overview — tech stack, architecture, build commands, common pitfalls |
| `code_frame/*.md` | Code structure docs — detailed indexes for each subsystem |
| `plans/*.md` / `tasks_done/*.md` | Active implementation plans + completed task archives + ready-to-use AI prompts |
| `src/lib/*/CLAUDE.md` | Per-module development guides |

**You don't need to read everything.** Just read the files relevant to your task. Here's how.

---

## 3. How to Develop with AI Assistants (Step-by-Step)

### Scenario 1: You just joined and want to understand the architecture

Copy and paste the following to your AI:

```
Please read these two files, then give me a brief overview of the project architecture:
1. CLAUDE.md
2. code_frame/README.md
```

After reading, the AI will have a full picture of the project. Then you can ask anything, such as:
- "What does the DOS analysis data flow look like?"
- "How do I add support for a new file format?"
- "Why is Structure.svelte so large?"

---

### Scenario 2: You need to work on a specific Phase of the plugin system

We've prepared **ready-to-copy AI prompts** for each development phase.

**Step 1**: Open `plans/ai-prompts-for-implementation.md`

**Step 2**: Find the Phase you need (e.g., Phase 1: ReaderPlugin)

**Step 3**: Copy the entire prompt and send it to your AI

That's it. Each prompt already includes:
- Which files the AI should read
- What code to write
- How to verify the result

**Phase Reference**:

| Phase | Task | Difficulty |
|-------|------|------------|
| Phase 0 | Fix Calculator plugin circuit break | Easy (3 files) |
| Phase 1 | Implement ReaderPlugin + CP2K DOS | Medium (new base class + example plugin) |
| Phase 2 | Implement AnalyzerPlugin | Medium (similar to Phase 1) |
| Phase 3 | Implement WorkflowNodePlugin | Medium (frontend + backend changes) |
| Phase 4 | MCP dynamic tool registration | Easy (1 file) |
| Phase 5 | Frontend dynamic tabs | Medium (Svelte components) |

---

### Scenario 3: You need to fix a bug or add a small feature

Send your AI a prompt like this:

```
Please read CLAUDE.md first, then help me [describe your task].

For example:
- "Help me fix the DOS chart being hard to see in dark mode"
- "Help me add an Export PNG button to the XRD chart"
- "Help me add an atom radius scaling slider to the settings panel"
```

If the AI isn't sure where to make changes, point it to the relevant code_frame file:

```
Please read docs/modules/electronic/dos.md,
then help me modify the dark mode styles in DosPlot.svelte.
```

---

### Scenario 4: You want to add support for a new file format (e.g., Quantum ESPRESSO DOS)

```
Please read the following files:
1. CLAUDE.md
2. docs/modules/core/file-io.md — current file format and IO reference
3. docs/modules/electronic/dos.md — current DOS module reference

Task: I want CatGo to read Quantum ESPRESSO .dos files and display a DOS plot.
First explain the QE .dos file format, then propose an implementation plan.
```

---

### Scenario 5: You want to understand a complex module

```
Please read code_frame/structure-controllers.md,
then explain how the controller extraction from Structure.svelte works.
I want to understand what user interactions interaction.svelte.ts handles.
```

---

## 4. Tips for Writing Good Prompts

### A good prompt looks like this

```
Please read the following files:
1. [specific file path]
2. [specific file path]

Context: [one sentence of background]

Task: [clear action — e.g., "add", "fix", "refactor"]

Requirements:
- [specific requirement 1]
- [specific requirement 2]

Verification: Run pnpm check to confirm zero errors
```

### A bad prompt looks like this

```
"Help me change the plugin system"      → Too vague, AI doesn't know what to change
"Check if the code has any problems"    → Too open-ended, AI wastes time searching blindly
"Refactor all the code"                 → Too broad, high risk of errors
```

### Universal Prompt Template

Not sure how to write a prompt? Use this template:

```
Please read CLAUDE.md and code_frame/README.md first.

What I want to do: [describe in one sentence]

Before writing any code, please tell me:
1. Which files need to be modified
2. A rough implementation approach
3. Any risks or things to watch out for

I'll give you the go-ahead to start coding after I confirm.
```

This way the AI does its research first and presents a plan. You approve it, then it starts coding. This prevents the AI from immediately making random changes.

---

## 5. Which Document for Which Task

| What You Want to Do | What to Have the AI Read |
|---------------------|--------------------------|
| Understand the project overview | `CLAUDE.md` |
| Plugin system development | `tasks_done/unified-plugin-system-plan-done.md` + `plans/ai-prompts-for-implementation.md` |
| Add a new file format | `docs/modules/core/file-io.md` |
| DOS/COHP/Band analysis | `docs/modules/electronic/dos.md` + `docs/modules/electronic/band-structure.md` + `docs/modules/electronic/cohp.md` |
| Workflow / architecture entry | `code_frame/README.md` + `src/lib/workflow/CLAUDE.md` |
| MCP / backend tool layer | `server/CLAUDE.md` + `docs/modules/server/mcp-server.md` |
| Modify Structure.svelte | `code_frame/structure-controllers.md` |
| Understand plugin architecture | `code_frame/plugin-architecture-analysis.md` |
| Charts / visualization | `src/lib/chat/CLAUDE.md` + relevant `docs/modules/*` pages |
| Entry point for code_frame docs | `code_frame/README.md` |

---

## 6. Development Standards

### Before Every Commit

```bash
pnpm check    # TypeScript + Svelte type checking — must have 0 errors
```

If there are errors, have the AI fix them:
```
pnpm check reported the following errors, please fix them:
[paste error messages here]
```

### Code Style

- **TypeScript** — strict mode, no `any`
- **Svelte 5** — use `$state`, `$derived`, `$effect` (not the legacy Store API)
- **Comments** — write in Chinese
- **Strings** — use template literals (backticks `` ` ``)

### Git Branches

- `main` — stable releases
- `dev` — development branch (day-to-day work happens here)
- Feature branches — branch off `dev`, merge back into `dev` when done

---

## 7. Task Assignment Reference

### Dependency Graph

```
Phase 0 (Calculator circuit break) ← Do this first, everything else depends on it
  ↓
Phase 1 (ReaderPlugin)   ←─┐
Phase 2 (AnalyzerPlugin) ←─┤ These three can be done in parallel by three people
Phase 3 (WorkflowNode)   ←─┘
  ↓
Phase 4 (MCP dynamic registration) ←─┐
Phase 5 (Frontend dynamic tabs)    ←─┘ Do these after Phases 1/2/3 are complete
```

### Starter Prompts for Each Developer

**Developer A — ReaderPlugin**:
```
Please read the following files:
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md (completed Phase 0 and Phase 1 reference)
3. plans/ai-prompts-for-implementation.md (Prompt 0 and Prompt 1)
4. docs/modules/core/file-io.md
5. docs/modules/electronic/dos.md

Task: First complete Phase 0 (fix the calculator plugin circuit break),
then implement Phase 1 (ReaderPlugin base class + CP2K DOS reader example plugin).
```

**Developer B — AnalyzerPlugin**:
```
Please read the following files:
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md (completed Phase 2 reference)
3. plans/ai-prompts-for-implementation.md (Prompt 2)
4. docs/modules/electronic/dos.md
5. code_frame/plugin-architecture-analysis.md

Task: Implement Phase 2 (AnalyzerPlugin base class + bond-histogram example plugin).
```

**Developer C — WorkflowNodePlugin**:
```
Please read the following files:
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md (completed Phase 3 reference)
3. plans/ai-prompts-for-implementation.md (Prompt 3)
4. code_frame/README.md

Task: Implement Phase 3 (WorkflowNodePlugin + dynamic node registration).
```

---

## 8. Troubleshooting

| Problem | Solution |
|---------|----------|
| AI doesn't know the project structure | Have it read `CLAUDE.md` |
| AI edited the wrong file | Have it read the relevant `code_frame/*.md` first |
| pnpm check reports errors | Paste the error messages to the AI |
| Don't know which docs to read | Have the AI read `code_frame/README.md` (master index) |
| Backend API not working | Make sure `python main.py` is running, try `curl http://localhost:8000/docs` |
| Frontend hot reload not responding | Restart `pnpm dev`, clear browser cache |

---

## 9. Documentation Maintenance

If you discover a new pitfall during development:

```
Please record this finding in [relevant module]/CLAUDE.md under the Pitfalls section.
```

Or add it yourself to the corresponding file in `code_frame/`.

Keeping docs up to date = the next person doesn't have to hit the same pitfalls.
