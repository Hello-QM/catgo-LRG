---
title: 服务器 API 教程
description: 使用 CatGo 的 REST API 进行程序化访问
source: server/main.py
---

# 服务器 API 教程

了解如何使用 CatGo 的 REST API，以编程方式访问计算和分析工具。

## 概述

CatGo 的 Python 服务器提供 REST API，可供外部脚本和应用运行计算、管理工作流并访问分析工具。

## 步骤 1：启动服务器

```bash
python server/main.py
```

默认情况下，API 可在 `http://localhost:8000` 访问。

## 步骤 2：API 端点

### 结构操作

- `POST /api/structure/parse` - 解析结构文件
- `POST /api/structure/optimize` - 运行几何优化
- `POST /api/structure/slab` - 生成 slab

### 电子结构分析

- `POST /api/bands` - 计算/获取能带结构
- `POST /api/dos` - 计算/获取态密度
- `POST /api/cohp` - 计算 COHP

### MD 分析

- `POST /api/md/rdf` - 计算径向分布函数
- `POST /api/md/rmsd` - 计算 RMSD
- `POST /api/md/hbonds` - 检测氢键
- `POST /api/md/clustering` - 对轨迹帧聚类

### 工作流

- `POST /api/workflow/create` - 创建新工作流
- `POST /api/workflow/run` - 执行工作流
- `GET /api/workflow/{id}` - 获取工作流状态

## 步骤 3：身份认证

API 身份认证细节（如适用）和 CORS 配置。

## 相关内容

- [REST API 模块](/zh/modules/server/rest-api) - 完整 API 参考
- [MCP 服务器](/zh/tutorials/server/mcp-server) - MCP 协议集成
