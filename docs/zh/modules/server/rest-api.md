---
title: REST API
description: 用于程序化访问 CatGo 的 HTTP API 参考
source: server/main.py
---

# REST API

**Source:** `server/main.py`

## 概述

CatGo 的 Python 服务器提供基于 FastAPI 构建的 REST API，用于程序化访问全部计算与分析功能。

## Base URL

`http://localhost:8000/api`

## Endpoints

### Structure

| Method | Path | Description |
|--------|------|-------------|
| POST | `/structure/parse` | 解析结构文件 |
| POST | `/structure/optimize` | 运行几何优化 |
| POST | `/structure/slab` | Generate a slab |

### Electronic

| Method | Path | Description |
|--------|------|-------------|
| POST | `/bands` | 能带结构计算 |
| POST | `/dos` | Density of states |
| POST | `/cohp` | COHP analysis |

### MD 分析

| Method | Path | Description |
|--------|------|-------------|
| POST | `/md/rdf` | 径向分布函数 |
| POST | `/md/rmsd` | RMSD computation |
| POST | `/md/density` | Density profile |
| POST | `/md/hbonds` | H-bond detection |
| POST | `/md/clustering` | 聚类与 PCA |

### 工作流

| Method | Path | Description |
|--------|------|-------------|
| POST | `/workflow/create` | Create workflow |
| POST | `/workflow/run` | Execute workflow |
| GET | `/workflow/{id}` | 获取工作流状态 |

### HPC

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hpc/submit` | Submit HPC job |
| GET | `/hpc/status` | Check job status |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | Single-turn chat |
| POST | `/chat/multi` | 多轮对话 |

### Paper

| Method | Path | Description |
|--------|------|-------------|
| POST | `/paper/upload` | 上传 PDF 并创建会话 |
| GET | `/paper/{session_id}` | 获取会话信息（标题、作者、过期时间） |
| GET | `/paper/{session_id}/text` | 获取提取出的正文文本 |
| POST | `/paper/resolve-doi` | 通过 CrossRef 解析 DOI |
| DELETE | `/paper/{session_id}` | 手动清理会话 |

## Authentication

当前本地服务器不需要认证。可在 `server/main.py` 中配置 CORS。

## 相关内容

- [服务器 API 教程](/zh/tutorials/server/server-api)
- [MCP 服务器](/zh/modules/server/mcp-server)
