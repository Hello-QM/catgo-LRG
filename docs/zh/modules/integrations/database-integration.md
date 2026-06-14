# 数据库集成

从外部数据库搜索并加载晶体结构：OPTIMADE、Materials Project 和 PubChem。

**Source:** `src/lib/api/`

## OPTIMADE

[OPTIMADE](https://www.optimade.org/) API 提供标准化接口，用于查询全球晶体结构数据库。

### 核心函数

```typescript
// List available OPTIMADE databases
fetch_optimade_providers(): Promise<Provider[]>

// Search structures across databases
search_optimade(query, provider): Promise<SearchResult>

// Fetch a specific structure by ID
fetch_optimade_structure(provider_id, structure_id): Promise<Structure>
```

### 支持的数据库

OPTIMADE 可连接多个 provider，包括：
- Materials Project
- AFLOW
- OQMD
- NOMAD
- Materials Cloud
- COD (晶体学 Open Database)
- And many more

### 组件

| 组件 | 说明 |
|-----------|-------------|
| `OptimadeSearchModal.svelte` | 搜索界面，支持 provider 选择、化学式/元素筛选 |
| `OptimadePreviewModal.svelte` | 加载到查看器前预览结构 |

### Query Options

- **化学式** — 精确或部分化学式匹配
- **元素** — 按包含元素筛选
- **Space group** — filter by symmetry
- **Provider 选择** — 选择要搜索的数据库

---

## Materials Project

直接访问 [Materials Project](https://materialsproject.org/) 数据库，获取晶体结构和计算性质。

### 核心函数

```typescript
// Fetch structure and properties by Materials Project ID
fetch_material_data(material_id: string): Promise<MaterialData>
```

### 服务器 Route

```
GET /api/materials_project/structure/{material_id}
```

Returns:
- 晶体结构（pymatgen 格式）
- 摘要性质（带隙、形成能等）
- Robocrystallographer 描述
- Similar structures

---

## PubChem

从 [PubChem](https://pubchem.ncbi.nlm.nih.gov/) 化学数据库搜索分子结构。

### 核心函数

```typescript
// Search compounds by name or formula
search_pubchem(query: string): Promise<SearchResult[]>

// Fetch 3D coordinates for a compound
fetch_pubchem_compound(cid: number): Promise<CompoundData>

// Convert PubChem data to structure format
extract_atoms_from_pubchem(compound_data): Structure
```

### 组件

| 组件 | 说明 |
|-----------|-------------|
| `PubchemSearchModal.svelte` | 按化合物名称、化学式或 CID 搜索 |

### 功能

- 按名称搜索（如 "aspirin"、"caffeine"）
- 按化学式搜索（如 "C6H12O6"）
- 获取三维构象
- 自动转换为查看器格式

---

## 架构

数据库查询可以走两条路径：

1. **客户端直连** — JavaScript 直接从公共 API 获取数据（OPTIMADE、PubChem）
2. **通过 Python 服务器** — 用于需要服务端处理或 API key 的接口（Materials Project）

```
Browser                              External APIs
┌──────────────┐   direct fetch     ┌──────────────┐
│ API Client   │ ──────────────────→│ OPTIMADE     │
│ (TypeScript) │                    │ PubChem      │
└──────┬───────┘                    └──────────────┘
       │
       │ via server (API key)
       ▼
┌──────────────┐                    ┌──────────────┐
│ FastAPI      │ ──────────────────→│ Materials    │
│ Server       │                    │ Project      │
└──────────────┘                    └──────────────┘
```
