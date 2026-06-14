---
title: Atom Art
description: 语音驱动的原子放置与分子构建
source: src/lib/gesture/atom-art.ts
---

# Atom Art

**Source:** `src/lib/gesture/atom-art.ts`, `src/lib/gesture/structure-adapter.ts`

## 概述

Atom Art 支持通过语音命令和手势交互进行创造性的分子构建，可交互式放置原子、构建分子片段并塑造结构。

## 架构

### atom-art.ts

核心逻辑，用于把语音/手势命令解释为结构修改。

### structure-adapter.ts

atom art 系统与 CatGo 结构数据模型之间的桥接层。

## 功能

### 语音驱动放置

通过说出元素名称放置原子，例如 "Place a carbon"、"Add oxygen here"。

### 手势定位

使用手部追踪在三维空间中定位原子。

### Fragment Building

构建常见分子片段（苯环、水分子等）。

## 相关内容

- [手势追踪](/zh/modules/interaction/gesture-tracking)
- [语音控制](/zh/modules/interaction/voice-control)
- [手势教程](/zh/tutorials/interaction/gesture-hand-tracking)
