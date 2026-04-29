# CatGo Unified Fine-Grained API Layer Specification

**Version:** 1.0.0-draft
**Date:** 2026-02-23
**Status:** Proposed

## Overview

This document defines the unified fine-grained API layer that serves both the built-in AI chat assistant and future MCP (Model Context Protocol) server. The API provides programmatic access to structure manipulation, building, view capture, and multi-provider chat capabilities.

All endpoints are served from the FastAPI backend (`server/main.py`) and registered via the standard router pattern used throughout the codebase.

### Design Principles

1. **Stateless structure operations** -- Structure endpoints receive the full structure JSON in the request body and return the modified structure in the response. No server-side structure state.
2. **Pymatgen-compatible serialization** -- All structure payloads use the pymatgen `Structure.as_dict()` / `Molecule.as_dict()` format, matching the existing `StructureInput` pattern in `server/routers/build.py`.
3. **Uniform error responses** -- All errors return an `ErrorResponse` envelope.
4. **MCP-ready** -- Every endpoint can be wrapped as an MCP tool with zero semantic translation.

### Common Types

#### ErrorResponse

```json
{
  "error": "string -- human-readable error message",
  "code": "string -- machine-readable error code (e.g. INVALID_INDEX, MISSING_LATTICE)",
  "details": {}  // optional structured details
}
```

HTTP status codes: `400` for validation errors, `422` for malformed requests, `500` for server errors.

#### Vec3

A 3-element array of floats representing a 3D vector: `[x, y, z]`

```json
[1.234, 5.678, 9.012]
```

#### StructureJSON

The pymatgen dictionary serialization of a structure. This is the format returned by `pymatgen.core.Structure.as_dict()` or `pymatgen.core.Molecule.as_dict()`. It contains:

```json
{
  "@module": "pymatgen.core.structure",
  "@class": "Structure",
  "lattice": {
    "matrix": [[a1,a2,a3],[b1,b2,b3],[c1,c2,c3]],
    "pbc": [true, true, true],
    "a": 5.43, "b": 5.43, "c": 5.43,
    "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    "volume": 160.1
  },
  "sites": [
    {
      "species": [{"element": "Si", "occu": 1}],
      "abc": [0.0, 0.0, 0.0],
      "xyz": [0.0, 0.0, 0.0],
      "label": "Si",
      "properties": {}
    }
  ],
  "charge": 0
}
```

For molecules (no periodicity), the `lattice` key is absent and `@class` is `"Molecule"`.

---

## 1. Atom Manipulation -- `/api/structure-ops`

**Router file:** `server/routers/structure_ops.py`
**Router prefix:** `/structure-ops`
**Tags:** `["structure-ops"]`

These endpoints provide fine-grained, per-atom manipulation of structures. They mirror the functions in `src/lib/structure/atom-manipulation.ts` but execute on the server using pymatgen, ensuring consistency between frontend and backend operations.

### 1.1 POST `/add-atom`

Add a single atom to a structure.

**Request Body:**

```json
{
  "structure": {},           // StructureJSON (required)
  "element": "O",            // string -- element symbol (required)
  "position": [1.2, 3.4, 5.6] // Vec3 -- Cartesian coordinates in Angstroms (required)
}
```

**Pydantic Model:**

```python
class AddAtomRequest(BaseModel):
    structure: dict                          # pymatgen Structure.as_dict()
    element: str                             # element symbol, e.g. "O", "Fe"
    position: tuple[float, float, float]     # Cartesian [x, y, z] in Angstroms
```

**Response `200 OK`:**

```json
{
  "structure": {},   // StructureJSON -- modified structure with atom added
  "n_atoms": 17,     // int -- total atom count after addition
  "added_index": 16  // int -- 0-based index of the newly added atom
}
```

**Pydantic Model:**

```python
class AtomOpResult(BaseModel):
    structure: dict
    n_atoms: int
    added_index: int | None = None
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Invalid element symbol |
| 400 | Structure JSON cannot be parsed |

---

### 1.2 POST `/add-atoms`

Batch-add multiple atoms. More efficient than repeated `/add-atom` calls.

**Request Body:**

```json
{
  "structure": {},
  "atoms": [
    {"element": "O", "xyz": [1.2, 3.4, 5.6]},
    {"element": "H", "xyz": [2.0, 3.4, 5.6]},
    {"element": "H", "xyz": [0.4, 3.4, 5.6]}
  ]
}
```

**Pydantic Model:**

```python
class AtomEntry(BaseModel):
    element: str
    xyz: tuple[float, float, float]

class AddAtomsRequest(BaseModel):
    structure: dict
    atoms: list[AtomEntry]  # at least 1
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 19,
  "added_indices": [16, 17, 18]  // 0-based indices of all newly added atoms
}
```

**Pydantic Model:**

```python
class AddAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    added_indices: list[int]
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Empty atoms list |
| 400 | Any invalid element symbol |

---

### 1.3 POST `/delete-atoms`

Delete atoms by their site indices.

**Request Body:**

```json
{
  "structure": {},
  "indices": [0, 3, 7]  // 0-based site indices to remove
}
```

**Pydantic Model:**

```python
class DeleteAtomsRequest(BaseModel):
    structure: dict
    indices: list[int]  # 0-based site indices, at least 1
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 13,
  "deleted_count": 3
}
```

**Pydantic Model:**

```python
class DeleteAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    deleted_count: int
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Any index out of bounds |
| 400 | Empty indices list |

---

### 1.4 POST `/replace-atom`

Substitute the element at a specific site index.

**Request Body:**

```json
{
  "structure": {},
  "index": 4,              // 0-based site index
  "new_element": "N"       // replacement element symbol
}
```

**Pydantic Model:**

```python
class ReplaceAtomRequest(BaseModel):
    structure: dict
    index: int
    new_element: str
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 16,
  "old_element": "C",
  "new_element": "N",
  "index": 4
}
```

**Pydantic Model:**

```python
class ReplaceAtomResult(BaseModel):
    structure: dict
    n_atoms: int
    old_element: str
    new_element: str
    index: int
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Index out of bounds |
| 400 | Invalid new_element symbol |

---

### 1.5 POST `/move-atom`

Move a single atom to an absolute Cartesian position.

**Request Body:**

```json
{
  "structure": {},
  "index": 2,
  "new_position": [3.5, 1.0, 7.2]  // new absolute Cartesian [x,y,z] in Angstroms
}
```

**Pydantic Model:**

```python
class MoveAtomRequest(BaseModel):
    structure: dict
    index: int
    new_position: tuple[float, float, float]
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 16,
  "index": 2,
  "old_position": [1.0, 2.0, 3.0],
  "new_position": [3.5, 1.0, 7.2]
}
```

**Pydantic Model:**

```python
class MoveAtomResult(BaseModel):
    structure: dict
    n_atoms: int
    index: int
    old_position: list[float]
    new_position: list[float]
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Index out of bounds |

---

### 1.6 POST `/move-atoms`

Translate multiple atoms by a displacement vector. All specified atoms are shifted by the same `[dx, dy, dz]`.

**Request Body:**

```json
{
  "structure": {},
  "indices": [0, 1, 2, 3],
  "displacement": [0.0, 0.0, 2.5]  // displacement vector [dx, dy, dz] in Angstroms
}
```

**Pydantic Model:**

```python
class MoveAtomsRequest(BaseModel):
    structure: dict
    indices: list[int]
    displacement: tuple[float, float, float]
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 16,
  "moved_count": 4,
  "displacement": [0.0, 0.0, 2.5]
}
```

**Pydantic Model:**

```python
class MoveAtomsResult(BaseModel):
    structure: dict
    n_atoms: int
    moved_count: int
    displacement: list[float]
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Any index out of bounds |
| 400 | Empty indices list |

---

## 2. Structure Building -- `/api/structure-build`

**Router file:** `server/routers/structure_build.py`
**Router prefix:** `/structure-build`
**Tags:** `["structure-build"]`

Higher-level structure construction operations that produce new structures from existing ones. These complement the existing `/api/build` router (which handles defects, strain, doping, intercalation, and combinatorial substitution).

### 2.1 POST `/supercell`

Create a supercell by repeating the unit cell along lattice vectors.

**Request Body:**

```json
{
  "structure": {},
  "scaling": [2, 2, 1]   // [na, nb, nc] repetitions along a, b, c
}
```

**Pydantic Model:**

```python
class SupercellRequest(BaseModel):
    structure: dict
    scaling: tuple[int, int, int]  # each >= 1
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 64,
  "scaling": [2, 2, 1],
  "original_n_atoms": 16,
  "formula": "Si64"
}
```

**Pydantic Model:**

```python
class SupercellResult(BaseModel):
    structure: dict
    n_atoms: int
    scaling: list[int]
    original_n_atoms: int
    formula: str
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Any scaling factor < 1 or > 10 |
| 400 | Structure has no lattice (molecule) |
| 400 | Resulting structure would exceed 10000 atoms |

**Notes:**

- Differs from the existing `/api/build/supercell` which accepts a string like `"2x2x2"` and returns a `BuildResult` with structures/labels arrays. This endpoint accepts integer arrays directly and returns a single-structure result -- better suited for programmatic/AI tool use.
- The existing `/api/build/supercell` endpoint is preserved for backward compatibility with the workflow UI.

---

### 2.2 POST `/slab`

Cut a surface slab from a bulk structure along a Miller index plane.

**Request Body:**

```json
{
  "structure": {},
  "miller": [1, 1, 0],        // Miller indices [h, k, l]
  "thickness": 3,              // number of atomic layers (int) or thickness in Angstroms (float)
  "vacuum": 15.0,              // vacuum thickness in Angstroms
  "center_slab": true,         // optional, default true -- center slab in vacuum
  "primitive": true,           // optional, default true -- reduce to primitive cell
  "max_normal_search": 1,      // optional, default 1 -- max index for normal search
  "symmetrize": false          // optional, default false -- enforce inversion symmetry
}
```

**Pydantic Model:**

```python
class SlabRequest(BaseModel):
    structure: dict
    miller: tuple[int, int, int]
    thickness: float                   # layers (int) or Angstroms (float)
    vacuum: float = 15.0              # Angstroms
    center_slab: bool = True
    primitive: bool = True
    max_normal_search: int = 1
    symmetrize: bool = False
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 32,
  "miller": [1, 1, 0],
  "thickness_angstroms": 8.45,
  "vacuum_angstroms": 15.0,
  "formula": "Si32",
  "surface_area": 29.54,
  "n_terminations": 1,
  "termination_index": 0
}
```

**Pydantic Model:**

```python
class SlabResult(BaseModel):
    structure: dict
    n_atoms: int
    miller: list[int]
    thickness_angstroms: float
    vacuum_angstroms: float
    formula: str
    surface_area: float
    n_terminations: int
    termination_index: int
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Miller indices are all zero |
| 400 | Structure has no lattice |
| 400 | thickness <= 0 or vacuum < 0 |
| 400 | Resulting slab exceeds 10000 atoms |

**Implementation Notes:**

Uses `pymatgen.core.surface.SlabGenerator` internally:

```python
from pymatgen.core.surface import SlabGenerator
slabgen = SlabGenerator(
    structure, miller_index=req.miller,
    min_slab_size=req.thickness, min_vacuum_size=req.vacuum,
    center_slab=req.center_slab, primitive=req.primitive,
    max_normal_search=req.max_normal_search,
)
slabs = slabgen.get_slabs(symmetrize=req.symmetrize)
```

---

### 2.3 POST `/merge`

Merge two structures. The incoming structure is placed at a specified position within (or relative to) the base structure. If the base has a lattice, it is preserved; otherwise the result is a molecule.

**Request Body:**

```json
{
  "base": {},                 // StructureJSON -- base structure (lattice preserved)
  "incoming": {},             // StructureJSON -- structure to merge in
  "position": [5.0, 5.0, 12.0], // Vec3 -- Cartesian position for center of incoming
  "mode": "preserve_lattice"  // optional: "preserve_lattice" (default) | "to_molecule"
}
```

**Pydantic Model:**

```python
class MergeRequest(BaseModel):
    base: dict
    incoming: dict
    position: tuple[float, float, float]
    mode: str = "preserve_lattice"  # "preserve_lattice" | "to_molecule"
```

**Response `200 OK`:**

```json
{
  "structure": {},
  "n_atoms": 48,
  "n_base_atoms": 32,
  "n_incoming_atoms": 16,
  "has_lattice": true
}
```

**Pydantic Model:**

```python
class MergeResult(BaseModel):
    structure: dict
    n_atoms: int
    n_base_atoms: int
    n_incoming_atoms: int
    has_lattice: bool
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Both base and incoming are empty |
| 400 | Invalid mode value |

**Implementation Notes:**

This mirrors the `merge_structures()` and `concatenate_structures()` functions from `src/lib/structure/atom-manipulation.ts`. When `mode="preserve_lattice"`, uses `merge_structures` semantics; when `mode="to_molecule"`, uses `concatenate_structures` semantics.

---

## 3. View Capture -- `/api/view`

**Router file:** `server/routers/view.py`
**Router prefix:** `/view`
**Tags:** `["view"]`

These endpoints interface with the frontend 3D viewer to capture screenshots and query the current viewer state. They require a connected frontend client; the backend acts as a relay.

### Architecture Note

The screenshot and selection endpoints use a request-reply pattern between the backend and the frontend:

1. Backend receives API request.
2. Backend publishes a command to a shared message bus (SSE channel or WebSocket).
3. Frontend executes the command (e.g., captures canvas) and POSTs the result back.
4. Backend returns the result to the original API caller.

For MCP server usage, the frontend must be running and connected.

---

### 3.1 POST `/screenshot`

Request a screenshot from the frontend 3D viewer.

**Request Body:**

```json
{
  "width": 1920,        // optional, default 1920 -- pixel width
  "height": 1080,       // optional, default 1080 -- pixel height
  "format": "png",      // optional, default "png" -- "png" | "jpeg" | "webp"
  "quality": 0.92,      // optional, default 0.92 -- JPEG/WebP quality (0-1)
  "transparent": false,  // optional, default false -- transparent background
  "camera": null        // optional -- override camera: {rotation: [x,y,z], zoom: float}
}
```

**Pydantic Model:**

```python
class ScreenshotRequest(BaseModel):
    width: int = 1920
    height: int = 1080
    format: str = "png"           # "png" | "jpeg" | "webp"
    quality: float = 0.92
    transparent: bool = False
    camera: dict | None = None    # optional camera override
```

**Response `200 OK`:**

```json
{
  "image": "iVBORw0KGgoAAAANSUhEUg...",  // base64-encoded image data
  "format": "png",
  "width": 1920,
  "height": 1080,
  "size_bytes": 245760
}
```

**Pydantic Model:**

```python
class ScreenshotResult(BaseModel):
    image: str          # base64-encoded image
    format: str
    width: int
    height: int
    size_bytes: int
```

**Errors:**

| Code | Condition |
|------|-----------|
| 503 | No frontend client connected |
| 504 | Frontend did not respond within timeout (10s) |
| 400 | Invalid format or dimensions |

---

### 3.2 GET `/structure-info`

Get metadata about the currently loaded structure in the frontend viewer.

**Query Parameters:** None.

**Response `200 OK`:**

```json
{
  "formula": "TiO2",
  "reduced_formula": "TiO2",
  "n_atoms": 6,
  "elements": ["Ti", "O"],
  "element_counts": {"Ti": 2, "O": 4},
  "has_lattice": true,
  "lattice": {
    "a": 4.593, "b": 4.593, "c": 2.959,
    "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
    "volume": 62.42,
    "matrix": [[4.593,0,0],[0,4.593,0],[0,0,2.959]]
  },
  "symmetry": {
    "space_group": "P4_2/mnm",
    "space_group_number": 136,
    "crystal_system": "tetragonal",
    "point_group": "4/mmm"
  },
  "sites": [
    {
      "index": 0,
      "element": "Ti",
      "xyz": [0.0, 0.0, 0.0],
      "abc": [0.0, 0.0, 0.0],
      "label": "Ti"
    }
  ],
  "density": 4.23,
  "is_molecule": false
}
```

**Pydantic Model:**

```python
class LatticeInfo(BaseModel):
    a: float
    b: float
    c: float
    alpha: float
    beta: float
    gamma: float
    volume: float
    matrix: list[list[float]]

class SymmetryInfo(BaseModel):
    space_group: str
    space_group_number: int
    crystal_system: str
    point_group: str

class SiteInfo(BaseModel):
    index: int
    element: str
    xyz: list[float]
    abc: list[float]
    label: str

class StructureInfoResult(BaseModel):
    formula: str
    reduced_formula: str
    n_atoms: int
    elements: list[str]
    element_counts: dict[str, int]
    has_lattice: bool
    lattice: LatticeInfo | None
    symmetry: SymmetryInfo | None
    sites: list[SiteInfo]
    density: float | None
    is_molecule: bool
```

**Errors:**

| Code | Condition |
|------|-----------|
| 503 | No frontend client connected |
| 404 | No structure currently loaded |

---

### 3.3 GET `/selection`

Get the currently selected atoms in the 3D viewer.

**Query Parameters:** None.

**Response `200 OK`:**

```json
{
  "selected_indices": [0, 3, 7],
  "n_selected": 3,
  "selected_atoms": [
    {"index": 0, "element": "Ti", "xyz": [0.0, 0.0, 0.0], "label": "Ti1"},
    {"index": 3, "element": "O",  "xyz": [1.45, 1.45, 0.0], "label": "O1"},
    {"index": 7, "element": "O",  "xyz": [3.14, 3.14, 1.48], "label": "O4"}
  ],
  "has_selection": true
}
```

**Pydantic Model:**

```python
class SelectedAtom(BaseModel):
    index: int
    element: str
    xyz: list[float]
    label: str

class SelectionResult(BaseModel):
    selected_indices: list[int]
    n_selected: int
    selected_atoms: list[SelectedAtom]
    has_selection: bool
```

**Errors:**

| Code | Condition |
|------|-----------|
| 503 | No frontend client connected |

---

## 4. Multi-Provider Chat -- `/api/chat`

**Router file:** `server/routers/chat.py` (enhanced existing router)
**Router prefix:** `/chat`
**Tags:** `["chat"]`

Enhances the existing chat router with OpenAI-compatible endpoint support (for DeepSeek, Qwen, Kimi, Ollama, and other providers), CLI agent spawning, and provider discovery.

### 4.1 POST `/stream` (existing -- preserved)

Existing SSE streaming endpoint for Anthropic and OpenAI providers. No changes.

**Request Body:** (unchanged)

```json
{
  "messages": [
    {"role": "user", "content": "What is this structure?"}
  ],
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.3,
  "max_tokens": 2048,
  "system": "You are a materials science assistant."
}
```

**Response:** SSE stream of `data: {"text": "..."}` events, terminated by `data: [DONE]`.

---

### 4.2 POST `/stream-openai-compat`

OpenAI-compatible chat completions endpoint that works with any provider implementing the OpenAI API format. This includes DeepSeek, Qwen, Kimi, Ollama (local), OpenRouter, Together AI, and others.

**Request Body:**

```json
{
  "messages": [
    {"role": "system", "content": "You are a materials science assistant."},
    {"role": "user", "content": "Describe the crystal structure of TiO2 rutile."}
  ],
  "provider": "deepseek",
  "model": "deepseek-chat",
  "temperature": 0.3,
  "max_tokens": 2048,
  "tools": null,
  "tool_choice": null,
  "base_url": null,
  "api_key": null
}
```

**Pydantic Model:**

```python
class OpenAICompatMessage(BaseModel):
    role: str       # "system" | "user" | "assistant" | "tool"
    content: str | list | None = None
    name: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None

class OpenAICompatRequest(BaseModel):
    messages: list[OpenAICompatMessage]
    provider: str = "deepseek"    # provider key for URL/key lookup
    model: str = "deepseek-chat"
    temperature: float = 0.3
    max_tokens: int = 2048
    tools: list[dict] | None = None       # OpenAI function-calling tools
    tool_choice: str | dict | None = None # "auto" | "none" | {"type":"function","function":{"name":"..."}}
    base_url: str | None = None           # override provider URL
    api_key: str | None = None            # override provider API key
```

**Provider Resolution:**

The endpoint resolves `base_url` and `api_key` from the `provider` field if not explicitly supplied:

| provider | base_url | env var for API key |
|----------|----------|---------------------|
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `kimi` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| `ollama` | `http://localhost:11434/v1` | (none required) |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `together` | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `custom` | (must supply `base_url`) | (must supply `api_key`) |

**Response:** SSE stream in OpenAI format:

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"TiO2"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

The server normalizes this to the CatGo internal format for the frontend:

```
data: {"text": "TiO2"}
data: {"tool_call": {"id": "call_abc", "name": "toggle_atoms", "arguments": "{\"visible\":false}"}}
data: [DONE]
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Unknown provider and no base_url supplied |
| 401 | API key missing or invalid |
| 502 | Upstream provider returned an error |

---

### 4.3 POST `/stream-cli-agent`

Spawn a CLI-based AI agent (Claude Code, Gemini CLI, Codex CLI) as a subprocess and stream its structured output back. This enables long-running agentic workflows that can call CatGo tools.

**Request Body:**

```json
{
  "agent": "claude",
  "prompt": "Optimize the TiO2 slab and report the surface energy.",
  "model": null,
  "context": {
    "structure_json": {},
    "working_directory": "/tmp/catgo-work",
    "available_tools": ["add_atom", "delete_atoms", "supercell", "screenshot"]
  },
  "timeout": 300,
  "max_turns": 20
}
```

**Pydantic Model:**

```python
class CLIAgentContext(BaseModel):
    structure_json: dict | None = None
    working_directory: str = "/tmp/catgo-work"
    available_tools: list[str] | None = None

class CLIAgentRequest(BaseModel):
    agent: str                     # "claude" | "gemini" | "codex"
    prompt: str
    model: str | None = None       # agent-specific model override
    context: CLIAgentContext | None = None
    timeout: int = 300             # max seconds
    max_turns: int = 20
```

**Agent Resolution:**

| agent | command | default model |
|-------|---------|---------------|
| `claude` | `claude --output-format stream-json` | (default) |
| `gemini` | `gemini` | `gemini-2.5-pro` |
| `codex` | `codex --quiet` | `o4-mini` |

**Response:** SSE stream of structured events:

```
data: {"type": "thinking", "text": "I need to first create a slab..."}
data: {"type": "text", "text": "I'll create a (001) slab of TiO2."}
data: {"type": "tool_use", "name": "supercell", "input": {"structure": {}, "scaling": [2,2,1]}}
data: {"type": "tool_result", "name": "supercell", "output": {"structure": {}, "n_atoms": 48}}
data: {"type": "text", "text": "The supercell has been created with 48 atoms."}
data: {"type": "done", "usage": {"input_tokens": 1200, "output_tokens": 450}}
data: [DONE]
```

**Pydantic Model for events:**

```python
class AgentStreamEvent(BaseModel):
    type: str      # "thinking" | "text" | "tool_use" | "tool_result" | "error" | "done"
    text: str | None = None
    name: str | None = None          # tool name (for tool_use / tool_result)
    input: dict | None = None        # tool input (for tool_use)
    output: dict | str | None = None # tool output (for tool_result)
    usage: dict | None = None        # token usage (for done)
```

**Errors:**

| Code | Condition |
|------|-----------|
| 400 | Unknown agent |
| 404 | Agent CLI not found on PATH |
| 504 | Agent exceeded timeout |
| 500 | Agent process crashed |

---

### 4.4 GET `/providers`

List all available AI providers and their current status.

**Query Parameters:** None.

**Response `200 OK`:**

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "type": "api",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "context_window": 200000},
        {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "context_window": 200000}
      ],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream"
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "api",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "gpt-4o", "name": "GPT-4o", "context_window": 128000},
        {"id": "o3", "name": "o3", "context_window": 200000}
      ],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream"
    },
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "type": "openai-compat",
      "available": true,
      "has_api_key": true,
      "models": [
        {"id": "deepseek-chat", "name": "DeepSeek V3", "context_window": 65536},
        {"id": "deepseek-reasoner", "name": "DeepSeek R1", "context_window": 65536}
      ],
      "supports_tools": true,
      "supports_vision": false,
      "endpoint": "/api/chat/stream-openai-compat"
    },
    {
      "id": "ollama",
      "name": "Ollama (Local)",
      "type": "openai-compat",
      "available": false,
      "has_api_key": true,
      "models": [],
      "supports_tools": false,
      "supports_vision": false,
      "endpoint": "/api/chat/stream-openai-compat",
      "status_message": "Ollama not running at localhost:11434"
    },
    {
      "id": "claude-cli",
      "name": "Claude Code (CLI Agent)",
      "type": "cli-agent",
      "available": true,
      "has_api_key": true,
      "models": [],
      "supports_tools": true,
      "supports_vision": true,
      "endpoint": "/api/chat/stream-cli-agent"
    }
  ]
}
```

**Pydantic Model:**

```python
class ModelInfo(BaseModel):
    id: str
    name: str
    context_window: int

class ProviderInfo(BaseModel):
    id: str
    name: str
    type: str                     # "api" | "openai-compat" | "cli-agent"
    available: bool
    has_api_key: bool
    models: list[ModelInfo]
    supports_tools: bool
    supports_vision: bool
    endpoint: str
    status_message: str | None = None

class ProvidersResult(BaseModel):
    providers: list[ProviderInfo]
```

**Detection Logic:**

- **API providers:** Check for env var presence (e.g., `ANTHROPIC_API_KEY`).
- **Ollama:** Attempt `GET http://localhost:11434/api/tags` with 2s timeout.
- **CLI agents:** Check if binary exists on `PATH` via `shutil.which()`.

---

## 5. AI Tool Definitions -- Frontend

**File:** `src/lib/chat/tools.ts`

The following tool definitions should be added to the `TOOL_DEFINITIONS` array in `tools.ts`. Each tool is callable by the AI chat assistant and maps to one of the API endpoints defined above.

### 5.1 Existing Tools (preserved)

The current tools in `tools.ts` remain unchanged:

- `toggle_atoms` -- show/hide atoms
- `toggle_bonds` -- show/hide bonds
- `toggle_unit_cell` -- show/hide unit cell
- `toggle_labels` -- show/hide labels
- `toggle_force_vectors` -- show/hide force vectors
- `reset_camera` -- reset camera position
- `set_rotation` -- set view rotation
- `select_atoms` -- select atoms by index
- `select_by_element` -- select atoms by element
- `clear_selection` -- clear selection
- `set_atom_radius` -- set atom display size
- `set_bond_color` -- set bond color

### 5.2 New Tool: `add_atom`

```typescript
{
  name: `add_atom`,
  description: `Add a single atom to the structure at a specified Cartesian position.`,
  input_schema: {
    type: `object`,
    properties: {
      element: {
        type: `string`,
        description: `Element symbol (e.g. "O", "Fe", "Li").`,
      },
      position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Cartesian coordinates [x, y, z] in Angstroms.`,
      },
    },
    required: [`element`, `position`],
  },
}
```

**Calls:** `POST /api/structure-ops/add-atom`
**Executor behavior:** Reads the current structure from the Svelte store, sends it with the parameters to the API, then updates the store with the returned structure.

---

### 5.3 New Tool: `add_atoms`

```typescript
{
  name: `add_atoms`,
  description: `Add multiple atoms to the structure in a single operation. More efficient than repeated add_atom calls.`,
  input_schema: {
    type: `object`,
    properties: {
      atoms: {
        type: `array`,
        items: {
          type: `object`,
          properties: {
            element: { type: `string`, description: `Element symbol.` },
            xyz: {
              type: `array`,
              items: { type: `number` },
              minItems: 3,
              maxItems: 3,
              description: `Cartesian coordinates [x, y, z] in Angstroms.`,
            },
          },
          required: [`element`, `xyz`],
        },
        description: `Array of atoms to add.`,
      },
    },
    required: [`atoms`],
  },
}
```

**Calls:** `POST /api/structure-ops/add-atoms`

---

### 5.4 New Tool: `delete_atoms`

```typescript
{
  name: `delete_atoms`,
  description: `Delete atoms from the structure by their 0-based site indices.`,
  input_schema: {
    type: `object`,
    properties: {
      indices: {
        type: `array`,
        items: { type: `integer` },
        description: `0-based site indices of atoms to delete.`,
      },
    },
    required: [`indices`],
  },
}
```

**Calls:** `POST /api/structure-ops/delete-atoms`

---

### 5.5 New Tool: `replace_atom`

```typescript
{
  name: `replace_atom`,
  description: `Replace the element of a specific atom (substitution). Keeps the atom at the same position but changes its element.`,
  input_schema: {
    type: `object`,
    properties: {
      index: {
        type: `integer`,
        description: `0-based site index of the atom to replace.`,
      },
      new_element: {
        type: `string`,
        description: `New element symbol (e.g. "N", "Fe").`,
      },
    },
    required: [`index`, `new_element`],
  },
}
```

**Calls:** `POST /api/structure-ops/replace-atom`

---

### 5.6 New Tool: `move_atom`

```typescript
{
  name: `move_atom`,
  description: `Move a single atom to a new absolute Cartesian position.`,
  input_schema: {
    type: `object`,
    properties: {
      index: {
        type: `integer`,
        description: `0-based site index of the atom to move.`,
      },
      new_position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `New Cartesian coordinates [x, y, z] in Angstroms.`,
      },
    },
    required: [`index`, `new_position`],
  },
}
```

**Calls:** `POST /api/structure-ops/move-atom`

---

### 5.7 New Tool: `move_atoms`

```typescript
{
  name: `move_atoms`,
  description: `Translate multiple atoms by a displacement vector. All specified atoms are shifted by the same [dx, dy, dz].`,
  input_schema: {
    type: `object`,
    properties: {
      indices: {
        type: `array`,
        items: { type: `integer` },
        description: `0-based site indices of atoms to move.`,
      },
      displacement: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Displacement vector [dx, dy, dz] in Angstroms.`,
      },
    },
    required: [`indices`, `displacement`],
  },
}
```

**Calls:** `POST /api/structure-ops/move-atoms`

---

### 5.8 New Tool: `make_supercell`

```typescript
{
  name: `make_supercell`,
  description: `Create a supercell by repeating the unit cell along lattice vectors. Only works on periodic structures.`,
  input_schema: {
    type: `object`,
    properties: {
      scaling: {
        type: `array`,
        items: { type: `integer`, minimum: 1, maximum: 10 },
        minItems: 3,
        maxItems: 3,
        description: `Number of repetitions along [a, b, c] lattice vectors.`,
      },
    },
    required: [`scaling`],
  },
}
```

**Calls:** `POST /api/structure-build/supercell`

---

### 5.9 New Tool: `cut_slab`

```typescript
{
  name: `cut_slab`,
  description: `Cut a surface slab from a bulk crystal along a Miller index plane. Adds vacuum layer for surface calculations.`,
  input_schema: {
    type: `object`,
    properties: {
      miller: {
        type: `array`,
        items: { type: `integer` },
        minItems: 3,
        maxItems: 3,
        description: `Miller indices [h, k, l] defining the surface plane.`,
      },
      thickness: {
        type: `number`,
        description: `Slab thickness: integer for number of layers, float for Angstroms.`,
      },
      vacuum: {
        type: `number`,
        description: `Vacuum thickness in Angstroms (default: 15).`,
        default: 15.0,
      },
    },
    required: [`miller`, `thickness`],
  },
}
```

**Calls:** `POST /api/structure-build/slab`

---

### 5.10 New Tool: `merge_structures`

```typescript
{
  name: `merge_structures`,
  description: `Merge another structure (e.g. adsorbate, molecule) into the current structure at a specified position.`,
  input_schema: {
    type: `object`,
    properties: {
      incoming_structure: {
        type: `object`,
        description: `The structure to merge in (pymatgen dict format).`,
      },
      position: {
        type: `array`,
        items: { type: `number` },
        minItems: 3,
        maxItems: 3,
        description: `Cartesian position [x, y, z] for the center of the incoming structure.`,
      },
    },
    required: [`incoming_structure`, `position`],
  },
}
```

**Calls:** `POST /api/structure-build/merge`
**Executor behavior:** The current structure is used as the `base`; the `incoming_structure` from the tool input is sent as `incoming`.

---

### 5.11 New Tool: `take_screenshot`

```typescript
{
  name: `take_screenshot`,
  description: `Capture a screenshot of the current 3D structure view. Returns a base64-encoded image.`,
  input_schema: {
    type: `object`,
    properties: {
      width: {
        type: `integer`,
        description: `Image width in pixels (default: 1920).`,
        default: 1920,
      },
      height: {
        type: `integer`,
        description: `Image height in pixels (default: 1080).`,
        default: 1080,
      },
    },
  },
}
```

**Calls:** `POST /api/view/screenshot`

---

### 5.12 New Tool: `get_structure_info`

```typescript
{
  name: `get_structure_info`,
  description: `Get detailed information about the currently loaded structure: formula, atom count, lattice parameters, symmetry, density.`,
  input_schema: {
    type: `object`,
    properties: {},
  },
}
```

**Calls:** `GET /api/view/structure-info`

---

### 5.13 New Tool: `get_selection`

```typescript
{
  name: `get_selection`,
  description: `Get the currently selected atoms in the 3D viewer, including their indices, elements, and positions.`,
  input_schema: {
    type: `object`,
    properties: {},
  },
}
```

**Calls:** `GET /api/view/selection`

---

## Appendix A: Router Registration

New routers should be registered in `server/routers/__init__.py` and `server/main.py` following the existing pattern:

### `server/routers/__init__.py` additions

```python
from .structure_ops import router as structure_ops_router
from .structure_build import router as structure_build_router
from .view import router as view_router

__all__ = [
    # ... existing entries ...
    "structure_ops_router",
    "structure_build_router",
    "view_router",
]
```

### `server/main.py` additions

```python
from routers import (
    # ... existing imports ...
    structure_ops_router,
    structure_build_router,
    view_router,
)

# ... after existing include_router calls ...
app.include_router(structure_ops_router, prefix="/api")
app.include_router(structure_build_router, prefix="/api")
app.include_router(view_router, prefix="/api")
```

This produces the full endpoint paths:

| Router prefix | + endpoint | = Full path |
|---------------|-----------|-------------|
| `/structure-ops` | `/add-atom` | `/api/structure-ops/add-atom` |
| `/structure-ops` | `/add-atoms` | `/api/structure-ops/add-atoms` |
| `/structure-ops` | `/delete-atoms` | `/api/structure-ops/delete-atoms` |
| `/structure-ops` | `/replace-atom` | `/api/structure-ops/replace-atom` |
| `/structure-ops` | `/move-atom` | `/api/structure-ops/move-atom` |
| `/structure-ops` | `/move-atoms` | `/api/structure-ops/move-atoms` |
| `/structure-build` | `/supercell` | `/api/structure-build/supercell` |
| `/structure-build` | `/slab` | `/api/structure-build/slab` |
| `/structure-build` | `/merge` | `/api/structure-build/merge` |
| `/view` | `/screenshot` | `/api/view/screenshot` |
| `/view` | `/structure-info` | `/api/view/structure-info` |
| `/view` | `/selection` | `/api/view/selection` |
| `/chat` | `/stream` | `/api/chat/stream` (existing) |
| `/chat` | `/stream-openai-compat` | `/api/chat/stream-openai-compat` |
| `/chat` | `/stream-cli-agent` | `/api/chat/stream-cli-agent` |
| `/chat` | `/providers` | `/api/chat/providers` |

---

## Appendix B: MCP Server Mapping

Each API endpoint maps directly to an MCP tool. The MCP server (`server/mcp.py`, future) will expose these tools using the MCP protocol:

| MCP Tool Name | API Endpoint | Input Schema Source |
|---------------|-------------|---------------------|
| `catgo_add_atom` | `POST /api/structure-ops/add-atom` | `AddAtomRequest` |
| `catgo_add_atoms` | `POST /api/structure-ops/add-atoms` | `AddAtomsRequest` |
| `catgo_delete_atoms` | `POST /api/structure-ops/delete-atoms` | `DeleteAtomsRequest` |
| `catgo_replace_atom` | `POST /api/structure-ops/replace-atom` | `ReplaceAtomRequest` |
| `catgo_move_atom` | `POST /api/structure-ops/move-atom` | `MoveAtomRequest` |
| `catgo_move_atoms` | `POST /api/structure-ops/move-atoms` | `MoveAtomsRequest` |
| `catgo_supercell` | `POST /api/structure-build/supercell` | `SupercellRequest` |
| `catgo_slab` | `POST /api/structure-build/slab` | `SlabRequest` |
| `catgo_merge` | `POST /api/structure-build/merge` | `MergeRequest` |
| `catgo_screenshot` | `POST /api/view/screenshot` | `ScreenshotRequest` |
| `catgo_structure_info` | `GET /api/view/structure-info` | (none) |
| `catgo_selection` | `GET /api/view/selection` | (none) |
| `catgo_providers` | `GET /api/chat/providers` | (none) |

MCP tools are prefixed with `catgo_` to avoid collisions in multi-server MCP configurations.

---

## Appendix C: Tool Executor Wiring

The `ToolExecutor` function in the frontend (`src/lib/chat/tools.ts`) should be extended to handle the new tools. The pattern for server-backed tools differs from the existing client-only tools:

```typescript
// Existing client-only tools (toggle_atoms, set_rotation, etc.)
// execute directly on the Svelte store / Three.js scene.

// New server-backed tools call the API and update the store:
async function executeServerTool(
  name: string,
  input: Record<string, unknown>,
  currentStructure: AnyStructure,
): Promise<string> {
  const endpoint = TOOL_ENDPOINT_MAP[name]
  if (!endpoint) throw new Error(`Unknown tool: ${name}`)

  const body = endpoint.buildBody(input, currentStructure)
  const response = await fetch(endpoint.url, {
    method: endpoint.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.json()
    return `Error: ${error.error}`
  }

  const result = await response.json()

  // Update the structure store if the result contains a structure
  if (result.structure) {
    structureStore.set(result.structure)
  }

  return JSON.stringify(result)
}
```

**Tool endpoint map:**

```typescript
const TOOL_ENDPOINT_MAP: Record<string, {url: string, method: string, buildBody: Function}> = {
  add_atom: {
    url: `/api/structure-ops/add-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, element: input.element, position: input.position
    }),
  },
  add_atoms: {
    url: `/api/structure-ops/add-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, atoms: input.atoms
    }),
  },
  delete_atoms: {
    url: `/api/structure-ops/delete-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, indices: input.indices
    }),
  },
  replace_atom: {
    url: `/api/structure-ops/replace-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, index: input.index, new_element: input.new_element
    }),
  },
  move_atom: {
    url: `/api/structure-ops/move-atom`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, index: input.index, new_position: input.new_position
    }),
  },
  move_atoms: {
    url: `/api/structure-ops/move-atoms`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, indices: input.indices, displacement: input.displacement
    }),
  },
  make_supercell: {
    url: `/api/structure-build/supercell`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, scaling: input.scaling
    }),
  },
  cut_slab: {
    url: `/api/structure-build/slab`,
    method: `POST`,
    buildBody: (input, structure) => ({
      structure: structure, miller: input.miller,
      thickness: input.thickness, vacuum: input.vacuum ?? 15.0
    }),
  },
  merge_structures: {
    url: `/api/structure-build/merge`,
    method: `POST`,
    buildBody: (input, structure) => ({
      base: structure, incoming: input.incoming_structure, position: input.position
    }),
  },
  take_screenshot: {
    url: `/api/view/screenshot`,
    method: `POST`,
    buildBody: (input) => ({
      width: input.width ?? 1920, height: input.height ?? 1080
    }),
  },
  get_structure_info: {
    url: `/api/view/structure-info`,
    method: `GET`,
    buildBody: () => null,
  },
  get_selection: {
    url: `/api/view/selection`,
    method: `GET`,
    buildBody: () => null,
  },
}
```

---

## Appendix D: Relationship to Existing Endpoints

This API layer coexists with the existing routers. It does not replace them.

| Existing Router | Prefix | Relationship |
|----------------|--------|-------------|
| `build_router` | `/api/build` | **Kept.** The new `/api/structure-build` provides simpler single-structure endpoints for AI tools, while `/api/build` continues to serve the workflow UI with its `BuildResult` (multi-structure + labels) format. |
| `chat_router` | `/api/chat` | **Enhanced.** The existing `/stream` endpoint is preserved. New endpoints (`/stream-openai-compat`, `/stream-cli-agent`, `/providers`) are added to the same router. |
| `adsorption_router` | `/api/adsorption` | **Kept.** The adsorption site finder is a specialized algorithm not replicated in the new API. The AI can call it via its existing endpoints. |
| `heterostructure_router` | `/api/heterostructure` | **Kept.** Complex interface matching stays in its dedicated router. |

---

## Appendix E: Frontend/Backend Dual Execution Strategy

For atom manipulation operations (Section 1), the same logic exists in both:

- **Frontend:** `src/lib/structure/atom-manipulation.ts` (TypeScript, instant, no server round-trip)
- **Backend:** `server/routers/structure_ops.py` (Python/pymatgen, authoritative, MCP-accessible)

The strategy:

1. **Interactive UI** -- Uses frontend functions directly for instant feedback (drag, keyboard moves).
2. **AI chat tools** -- Calls backend API to ensure consistency and to keep the AI agent's tool-calling path simple (single HTTP request).
3. **MCP server** -- Calls backend API exclusively.

Both paths produce identical results because the math (Cartesian-to-fractional conversion, displacement application) is the same.
