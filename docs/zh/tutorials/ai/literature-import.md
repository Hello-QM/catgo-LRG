---
title: 导入论文
description: 上传 PDF 或粘贴 DOI，让 CatBot 在构建工作流时引用论文内容
source: server/catgo/routers/paper.py
---

# 导入论文

CatBot 可以读取科学论文，并在构建工作流时将其作为上下文。向 CatBot 提供论文有两种方式：直接上传 PDF，或粘贴 DOI 让 CatGo 获取元数据。

本教程会介绍这两种方式，并说明 CatBot 对导入结果能做什么、不能做什么。

## 选项 1：上传 PDF

1. 打开 CatBot 聊天面板。
2. 将 PDF 拖到聊天输入框中，或点击附件图标并选择文件。
3. CatBot 会把 PDF 上传到后端（`POST /paper/upload`），接收一个 session ID，并显示包含论文标题和页数的确认卡片。
4. 在 session TTL 过期之前，论文文本会作为后续对话的上下文可用；TTL 通常是在 1 小时无活动后过期。

## 选项 2：粘贴 DOI

1. 在聊天输入框中粘贴 DOI（`10.1038/nature12345`）或 DOI URL（`https://doi.org/10.1038/nature12345`）。
2. CatBot 会通过 CrossRef 解析它（`POST /paper/resolve-doi`），并显示标题、作者、期刊、年份和摘要。
3. 元数据会进入聊天上下文。注意，DOI 解析只会提供元数据，不会提供全文。

## CatBot 可以如何使用导入的论文

- 回答关于论文内容的问题：使用的方法、泛函、基组、k-point 网格、后处理步骤
- 比较两篇论文的计算设置
- 建议一个复现论文方法的工作流
- 根据请求构建工作流，并用论文中讨论的参数填充节点

## CatBot 不能做什么

- 自动一键生成“根据这篇论文为我构建一个工作流”；目前没有能在不经过聊天轮次的情况下从 PDF 直接生成工作流的提取器
- 读取 PDF 中的图、表或嵌入图片；只有提取出的文本可用
- 在 CatGo 重启后保留论文；session 保存在内存中，并受 TTL 限制

## 示例对话

```
[You upload "Kreitz_2021_CO2_desorption_Ni.pdf"]
[CatBot: "Loaded — 18 pages, abstract mentions Ni(111), (100), (110), (211) facets."]

You:    What functional did they use and at what ENCUT?

CatBot: PBE-D3(BJ) with a 450 eV plane-wave cutoff. K-point sampling
        was 8×8×1 for slabs and 12×12×12 for the bulk.

You:    Good. Build a workflow that reproduces their Ni(111) setup —
        slab construction, adsorbate placement for CO, then a VASP
        relax with their parameters.

CatBot: [adds Slab → Adsorbate → VASP Relax nodes, populates ENCUT=450,
        KPOINTS=8x8x1, with PBE-D3 selected; opens the run config.]
```

## 手动清除 session

session 会自动过期，但你也可以从聊天菜单中提前清除它；论文附件卡片中有一个 "Forget paper" 操作，它会在底层调用 `DELETE /paper/{session_id}`。

## 相关内容

- [论文导入模块](/zh/modules/ai/literature-import) - API 参考和数据模型
- [工作流教程](/zh/tutorials/workflows/workflows) - 手动构建工作流
