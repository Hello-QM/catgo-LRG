# 文件 I/O

CatGo 支持读取和写出多种标准晶体与分子结构文件格式。

**源码：** `src/lib/structure/parse.ts`、`src/lib/structure/ferrox-wasm.ts`、`src/lib/io/`

## 支持的导入格式

| 格式 | 扩展名 | 说明 |
|--------|-----------|-------------|
| CIF | `.cif` | 晶体学信息文件，晶体结构的标准格式 |
| POSCAR | `.poscar`, `.vasp`, `POSCAR`, `CONTCAR` | VASP 结构格式 |
| XYZ | `.xyz` | 简单笛卡尔坐标 |
| Extended XYZ | `.extxyz` | 带晶格和逐原子属性的 XYZ |
| ASE Trajectory | `.traj` | ASE 原生二进制轨迹格式 |
| HDF5 | `.hdf5`, `.h5` | 层次化数据格式（多帧） |
| XDATCAR | `XDATCAR` | VASP 分子动力学轨迹 |
| CUBE | `.cube` | Gaussian/VASP 体数据 |

### 压缩文件

所有格式都可以从压缩归档中加载：

- **gzip**（`.gz`），例如 `structure.cif.gz`
- **bzip2**（`.bz2`）
- **zip**（`.zip`）

## 支持的导出格式

| 格式 | 函数 | 说明 |
|--------|----------|-------------|
| CIF | `export_structure_as_cif()` | 晶体学信息文件 |
| POSCAR | `export_structure_as_poscar()` | VASP 结构格式 |
| XYZ | `export_structure_as_xyz()` | 简单笛卡尔坐标 |
| Extended XYZ | `export_structure_as_extxyz()` | 带晶格信息的 XYZ |
| JSON | `export_structure_as_json()` | 与 Pymatgen 兼容的 JSON |
| GLB | `export_scene_as_glb()` | 3D 模型（glTF Binary） |
| OBJ | `export_scene_as_obj()` | Wavefront 3D 模型 |

## 关键函数

### 解析

```typescript
// Parse structure from file content (auto-detects format)
parse_structure_from_file(content: string | ArrayBuffer, filename: string): PymatgenStructure

// Individual parsers (also available via WASM)
wasm_parse_cif(cif_string: string): PymatgenStructure
wasm_parse_poscar(poscar_string: string): PymatgenStructure
```

### 导出

```typescript
// Export to string (for saving)
structure_to_cif_str(structure): string
structure_to_poscar_str(structure): string
structure_to_xyz_str(structure): string
structure_to_extxyz_str(structure): string
structure_to_json_str(structure): string

// Export with file download
export_structure_as_cif(structure, filename?)
export_structure_as_poscar(structure, filename?)
```

### 文件处理

```typescript
// Generate filename from structure
create_structure_filename(structure, format): string

// Load from URL (auto-detect binary vs text, decompress)
load_from_url(url: string): Promise<string | ArrayBuffer>

// Handle drag-drop URL
handle_url_drop(url: string): Promise<PymatgenStructure>

// Trigger file download
download(content, filename, mime_type?)
```

## 加载方式

结构可以从多个入口加载：

1. **文件选择器** - 通过文件对话框浏览本地文件
2. **拖放** - 直接把文件拖到查看器中
3. **URL 加载** - 从远程 URL 获取结构
4. **粘贴内容** - 直接粘贴 CIF/POSCAR/XYZ 文本
5. **数据库搜索** - 从 OPTIMADE、Materials Project 或 PubChem 加载
6. **桌面文件系统** - 通过 Tauri 使用原生文件访问

## 数据格式

内部结构使用**与 pymatgen 兼容的 JSON 格式**：

```json
{
  "lattice": {
    "matrix": [[a1, a2, a3], [b1, b2, b3], [c1, c2, c3]],
    "pbc": [true, true, true]
  },
  "sites": [
    {
      "species": [{ "element": "Si", "occu": 1.0 }],
      "abc": [0.0, 0.0, 0.0],
      "xyz": [0.0, 0.0, 0.0]
    }
  ]
}
```

晶格矩阵遵循 **rows = lattice vectors** 约定（与 pymatgen 相同）。分数坐标到笛卡尔坐标的转换使用 `xyz = M^T * abc`。
