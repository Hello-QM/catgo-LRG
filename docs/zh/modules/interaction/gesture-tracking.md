---
title: 手势追踪
description: CatGo 的 MediaPipe 手部追踪集成
source: src/lib/gesture/GestureProvider.svelte
---

# 手势追踪

**源码：** `src/lib/gesture/GestureProvider.svelte`、`src/lib/gesture/hand-tracker.ts`、`src/lib/gesture/gesture-recognizer.ts`

## 概览

CatGo 集成了 MediaPipe Hands，可以通过摄像头实时追踪手部，从而用手势控制 3D 结构查看器。出于隐私考虑，MediaPipe 模型会在浏览器本地运行。

## 架构

### GestureProvider

Svelte 组件，包裹应用并向子组件提供手势上下文。

### HandTracker

管理 MediaPipe Hands pipeline，包括摄像头采集、手部关键点检测和平滑处理。

### GestureRecognizer

把手部关键点解释成语义化手势，例如旋转、缩放、平移和选择。

### GestureOverlay

视觉反馈叠加层，用于显示检测到的手和当前手势状态。

### 手势设置面板

用于配置手势灵敏度、平滑和映射关系的 UI。

## 手势类型

- `ROTATE` - 张开手掌并拖动，用于旋转结构
- `ZOOM` - 捏合手势，用于放大/缩小
- `PAN` - 双指拖动，用于平移
- `SELECT` - 指向以 hover，捏合点击以选择

## 配置

`gesture-config-store.ts` 中可用的设置包括：

- 追踪平滑系数
- 手势激活阈值
- 摄像头选择
- 叠加层可见性

## 相关

- [手势教程](/zh/tutorials/interaction/gesture-hand-tracking)
- [语音控制](/zh/modules/interaction/voice-control)
- [Atom Art](/zh/modules/interaction/atom-art)
