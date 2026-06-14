---
title: MCP 服务器
description: 用于 AI 助手集成的 Model Context Protocol 服务器
source: server/mcp_server.py
---

# MCP 服务器

**源码：** `server/mcp_server.py`

## 概览

CatGo 实现了 Model Context Protocol（MCP），允许外部 AI 助手（例如 Claude Desktop）调用 CatGo 的工具，完成结构分析、结构操作和可视化。

## 架构

MCP 服务器把 CatGo 的 Python 服务器端点封装为 MCP 兼容工具，并通过标准 MCP 协议暴露出去。

## 暴露的工具

### 结构操作

- 解析结构文件
- 查询结构属性
- 生成 slab 和超胞
- 优化结构

### 分析

- 电子结构（能带、DOS、COHP）
- MD 分析（RDF、RMSD、氢键）
- 对称性检测

### 工作流

- 创建并运行计算工作流

## 设置

```bash
python server/main.py --mcp
```

## 客户端配置

在你的 AI 客户端设置中，把 CatGo 添加为 MCP server。

## 相关

- [MCP 服务器教程](/zh/tutorials/server/mcp-server)
- [REST API](/zh/modules/server/rest-api)
