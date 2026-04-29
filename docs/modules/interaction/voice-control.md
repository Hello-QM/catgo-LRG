---
title: Voice Control
description: Speech-to-text and voice command system
source: src/lib/gesture/voice-engine.ts
---

# Voice Control

**Source:** `src/lib/gesture/voice-engine.ts`, `src/lib/gesture/whisper-voice-engine.ts`, `src/lib/gesture/tts-engine.ts`

## Overview

CatGO's voice control system provides speech-to-text (via Whisper) and text-to-speech for hands-free interaction with the application.

## Architecture

### VoiceEngine

Base voice engine interface for speech recognition.

### WhisperVoiceEngine

Local Whisper model for privacy-preserving speech-to-text. Model downloaded on first use.

### TTSEngine

Text-to-speech engine for voice feedback on executed commands.

## Voice Commands

### Structure Manipulation

- Rotation, zoom, pan commands
- Show/hide bonds, labels, axes
- Reset view

### Atom Art

- Place atoms by element name
- Build molecular fragments

### Analysis

- Trigger computations by voice

## Configuration

- Microphone selection
- Voice activation sensitivity
- Language setting
- TTS voice selection

## Related

- [Voice Control Tutorial](/tutorials/interaction/voice-control)
- [Gesture Tracking](/modules/interaction/gesture-tracking)
- [Atom Art](/modules/interaction/atom-art)
