---
title: 语音控制教程
description: 使用语音命令与 CatGo 交互
source: src/lib/gesture/voice-engine.ts
---

# 语音控制教程

了解如何使用语音命令与 CatGo 进行免手动交互。

## 概述

CatGo 通过 Whisper（本地语音转文字）支持语音输入，并通过文本转语音支持语音输出，从而实现对话式交互。

## 步骤 1：启用语音

打开 Gesture Settings 面板并启用语音输入，然后选择你的麦克风。

## 步骤 2：语音转文字设置

### Whisper Engine

CatGo 使用本地 Whisper 模型进行保护隐私的语音识别。模型会在首次使用时下载。

## 步骤 3：语音命令

### 结构命令

- "向左/向右/向上/向下旋转"
- "放大/缩小"
- "重置视图"
- "显示化学键/标签/坐标轴"

### Atom Art

- "放置一个碳原子"
- "在这里添加氧原子"
- "构建一个苯环"

### 分析命令

- "计算 RDF"
- "显示能带结构"
- "优化结构"

## 步骤 4：文本转语音响应

CatGo 会针对已执行的命令给出语音反馈。

## 步骤 5：自定义

在设置中调整语音激活灵敏度、语言和 TTS 声音。

## 相关内容

- [语音控制模块](/zh/modules/interaction/voice-control) - 架构参考
- [手势追踪](/zh/tutorials/interaction/gesture-hand-tracking) - 与手势结合使用
- [Atom Art 模块](/zh/modules/interaction/atom-art) - 语音驱动的原子放置
