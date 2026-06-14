---
title: MCP 服务器教程
description: 将 CatGo 作为 Model Context Protocol 服务器使用
source: server/mcp_server.py
---

# MCP 服务器教程

了解如何使用 CatGo 的 MCP（Model Context Protocol）服务器，与 Claude 等 AI 助手集成。

## 概述

CatGo 实现了 Model Context Protocol，使 AI 助手能够调用 CatGo 的工具进行结构分析、结构操作和可视化。

## 步骤 1：启动服务器

```bash
# Start the CatGo server with MCP support
python server/main.py --mcp
```

## 步骤 2：配置你的 AI 客户端

在你的 AI 客户端配置中将 CatGo 添加为 MCP server，例如 Claude Desktop。

## 步骤 3：可用工具

MCP server 会将 CatGo 的能力暴露为工具：

### 结构工具

- 加载和解析结构文件
- 查询结构属性
- 生成 slab 和超胞

### 分析工具

- 计算 RDF、band structure、DOS
- 运行结构优化
- 检测对称性

### 工作流工具

- 创建和运行计算工作流

## 步骤 4：示例交互

通过支持 MCP 的 AI 助手：
- "加载 POSCAR 文件并显示空间群"
- "生成一个 3 层的 (111) slab"
- "设置一个 VASP 结构弛豫工作流"

## 相关内容

- [MCP 服务器模块](/zh/modules/server/mcp-server) - 架构参考
- [REST API](/zh/tutorials/server/server-api) - 直接访问 HTTP API
