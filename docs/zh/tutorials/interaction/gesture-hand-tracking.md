---
title: 手势与手部追踪教程
description: 使用 MediaPipe 手势追踪控制 CatGo 的 3D 查看器
source: src/lib/gesture/GestureProvider.svelte
---

# 手势与手部追踪教程

了解如何使用手势控制 3D 结构查看器。

## 概述

CatGo 使用 MediaPipe Hands 通过摄像头进行实时手部追踪，从而支持基于手势与 3D 结构交互。

## 步骤 1：启用手势模式

打开 Gesture Settings 面板并启用手部追踪。在浏览器或系统提示时授予摄像头权限。

## 步骤 2：校准

将手放在摄像头画面中。追踪叠加层会显示检测到的手部关键点。

## 步骤 3：可用手势

### 旋转

- **Open palm drag:** 张开手掌并移动，用于旋转结构

### 缩放

- **Pinch:** 让拇指和食指靠近或分开，用于放大或缩小

### 平移

- **Two-finger drag:** 双指拖动，用于平移视图

### 选择

- **Point:** 伸出食指，将指针悬停在原子上
- **Pinch tap:** 快速捏合，用于选择原子

## 步骤 4：自定义

在设置面板中调整手势灵敏度、追踪平滑程度和手势映射。

## 故障排查

- 确保光照良好，以获得可靠的手部检测
- 保持手在摄像头画面内
- 为了保护隐私，MediaPipe 模型会在本地加载

## 相关内容

- [手势追踪模块](/zh/modules/interaction/gesture-tracking) - 架构参考
- [语音控制](/zh/tutorials/interaction/voice-control) - 与语音命令结合使用
