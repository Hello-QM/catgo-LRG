---
title: Gesture Tracking
description: MediaPipe hand tracking integration for CatGO
source: src/lib/gesture/GestureProvider.svelte
---

# Gesture Tracking

**Source:** `src/lib/gesture/GestureProvider.svelte`, `src/lib/gesture/hand-tracker.ts`, `src/lib/gesture/gesture-recognizer.ts`

## Overview

CatGO integrates MediaPipe Hands for real-time hand tracking through the webcam, enabling gesture-based control of the 3D structure viewer. The MediaPipe model runs locally in the browser for privacy.

## Architecture

### GestureProvider

Svelte component that wraps the application and provides gesture context to child components.

### HandTracker

Manages the MediaPipe Hands pipeline: camera capture, hand landmark detection, and smoothing.

### GestureRecognizer

Interprets hand landmarks into semantic gestures (rotate, zoom, pan, select).

### GestureOverlay

Visual feedback overlay showing detected hands and gesture state.

### GestureSettingsPane

UI for configuring gesture sensitivity, smoothing, and mappings.

## Gesture Types

- `ROTATE` — Open palm drag for structure rotation
- `ZOOM` — Pinch gesture for zoom in/out
- `PAN` — Two-finger drag for panning
- `SELECT` — Point to hover, pinch-tap to select

## Configuration

Settings available in `gesture-config-store.ts`:
- Tracking smoothing factor
- Gesture activation thresholds
- Camera selection
- Overlay visibility

## Related

- [Gesture Tutorial](/tutorials/interaction/gesture-hand-tracking)
- [Voice Control](/modules/interaction/voice-control)
- [Atom Art](/modules/interaction/atom-art)
