---
title: Gesture & Hand Tracking Tutorial
description: Control CatGO's 3D viewer with hand gestures using MediaPipe
source: src/lib/gesture/GestureProvider.svelte
---

# Gesture & Hand Tracking Tutorial

Learn how to use hand gestures to control the 3D structure viewer.

## Overview

CatGO uses MediaPipe Hands for real-time hand tracking through your webcam, enabling gesture-based interaction with 3D structures.

## Step 1: Enable Gesture Mode

Open the Gesture Settings pane and enable hand tracking. Grant camera permission when prompted.

## Step 2: Calibrate

Position your hand in the camera view. The tracking overlay shows detected hand landmarks.

## Step 3: Available Gestures

### Rotation

- **Open palm drag:** Rotate the structure by moving your open hand

### Zoom

- **Pinch:** Bring thumb and index finger together/apart to zoom in/out

### Pan

- **Two-finger drag:** Pan the view

### Selection

- **Point:** Extend index finger to hover over atoms
- **Pinch tap:** Quick pinch to select an atom

## Step 4: Customize

Adjust gesture sensitivity, tracking smoothing, and gesture mappings in the settings pane.

## Troubleshooting

- Ensure good lighting for reliable hand detection
- Keep your hand within the camera frame
- The MediaPipe model is loaded locally for privacy

## Related

- [Gesture Tracking Module](/modules/interaction/gesture-tracking) — Architecture reference
- [Voice Control](/tutorials/interaction/voice-control) — Combine with voice commands
