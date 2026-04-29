---
title: AI Chat Tutorial
description: Using the AI assistant for materials science tasks in CatGO
source: src/lib/chat/ChatPane.svelte
---

# AI Chat Tutorial

Learn how to use CatGO's built-in AI assistant for materials science tasks.

## Overview

The AI chat system integrates with CatGO's tools to help you with structure manipulation, analysis, and workflow creation through natural language.

## Step 1: Open the Chat Pane

Click the chat icon in the sidebar or press the keyboard shortcut to open the AI chat panel.

## Step 2: Ask Questions

### Structure Queries

Ask about the currently loaded structure:
- "What is the space group of this structure?"
- "List all unique bond lengths"
- "What are the coordination numbers?"

### Analysis Requests

Request computations:
- "Compute the RDF for O-H pairs"
- "Generate a slab with Miller indices (1,1,1)"
- "Optimize this structure with MACE"

### Workflow Creation

Ask the AI to build workflows:
- "Create a workflow to compute adsorption energies"
- "Set up a convergence test for k-points"

## Step 3: Tool Execution

The AI can execute tools that interact with CatGO:

### Structure Tools

Modify structures, add atoms, create supercells, and more.

### Workflow Tools

Create and configure workflow nodes programmatically.

## Step 4: Context

The chat system has access to:
- Current structure data
- Active analysis results
- Loaded files and metadata

## Related

- [Chat System Module](/modules/ai/chat-system) — Architecture reference
- [Workflow Tools](/modules/ai/workflow-tools) — Available workflow tools
