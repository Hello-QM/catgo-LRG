---
title: Voice Control
description: 语音转文本与语音命令系统
source: src/lib/gesture/voice-engine.ts
---

# 语音控制

**Source:** `src/lib/gesture/voice-engine.ts`, `src/lib/gesture/whisper-voice-engine.ts`, `src/lib/gesture/tts-engine.ts`

## 概述

CatGo 的语音控制系统提供基于 Whisper 的语音转文本和文本转语音能力，用于免手操作应用。

## 架构

### VoiceEngine

用于语音识别的基础语音引擎接口。

### WhisperVoiceEngine

本地 Whisper 模型用于保护隐私的语音转文本；模型会在首次使用时下载。

### TTSEngine

文本转语音引擎，用于对已执行命令进行语音反馈。

## 语音命令

### 结构操作

- 旋转、缩放、平移命令
- 显示/隐藏化学键、标签、坐标轴
- Reset view

### Atom Art

- 按元素名称放置原子
- 构建分子片段

### Analysis

- 通过语音触发计算

## 配置

- 麦克风选择
- 语音激活灵敏度
- Language setting
- TTS 语音选择

## 相关内容

- [语音控制教程](/zh/tutorials/interaction/voice-control)
- [手势追踪](/zh/modules/interaction/gesture-tracking)
- [Atom Art](/zh/modules/interaction/atom-art)
