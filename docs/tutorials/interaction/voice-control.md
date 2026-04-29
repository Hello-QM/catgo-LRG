---
title: Voice Control Tutorial
description: Use voice commands to interact with CatGO
source: src/lib/gesture/voice-engine.ts
---

# Voice Control Tutorial

Learn how to use voice commands for hands-free interaction with CatGO.

## Overview

CatGO supports voice input via Whisper (local speech-to-text) and voice output via text-to-speech, enabling conversational interaction.

## Step 1: Enable Voice

Open the Gesture Settings pane and enable voice input. Select your microphone.

## Step 2: Speech-to-Text Setup

### Whisper Engine

CatGO uses a local Whisper model for privacy-preserving speech recognition. The model is downloaded on first use.

## Step 3: Voice Commands

### Structure Commands

- "Rotate left/right/up/down"
- "Zoom in/out"
- "Reset view"
- "Show bonds/labels/axes"

### Atom Art

- "Place a carbon atom"
- "Add oxygen here"
- "Build a benzene ring"

### Analysis Commands

- "Compute RDF"
- "Show band structure"
- "Optimize structure"

## Step 4: Text-to-Speech Response

CatGO responds with voice feedback for executed commands.

## Step 5: Customize

Adjust voice activation sensitivity, language, and TTS voice in settings.

## Related

- [Voice Control Module](/modules/interaction/voice-control) — Architecture reference
- [Gesture Tracking](/tutorials/interaction/gesture-hand-tracking) — Combine with hand gestures
- [Atom Art Module](/modules/interaction/atom-art) — Voice-driven atom placement
