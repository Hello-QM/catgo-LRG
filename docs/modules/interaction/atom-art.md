---
title: Atom Art
description: Voice-driven atom placement and molecular building
source: src/lib/gesture/atom-art.ts
---

# Atom Art

**Source:** `src/lib/gesture/atom-art.ts`, `src/lib/gesture/structure-adapter.ts`

## Overview

Atom Art enables creative molecular building through voice commands and gesture interaction. Place atoms, build molecular fragments, and sculpt structures interactively.

## Architecture

### atom-art.ts

Core logic for interpreting voice/gesture commands into structure modifications.

### structure-adapter.ts

Bridge between the atom art system and CatGO's structure data model.

## Features

### Voice-Driven Placement

Place atoms by speaking element names: "Place a carbon", "Add oxygen here".

### Gesture Positioning

Use hand tracking to position atoms in 3D space.

### Fragment Building

Build common molecular fragments (benzene ring, water molecule, etc.).

## Related

- [Gesture Tracking](/modules/interaction/gesture-tracking)
- [Voice Control](/modules/interaction/voice-control)
- [Gesture Tutorial](/tutorials/interaction/gesture-hand-tracking)
