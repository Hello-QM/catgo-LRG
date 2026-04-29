# Phase 3: WorkflowNodePlugin Manual Test Guide

> Archived as done on 2026-03-13.
> This task guide is kept for historical reference because the WorkflowNodePlugin phase is already implemented.

## Prerequisites

- Node.js >= 18, pnpm
- Python 3.10+ with conda env (CatGo01 or equivalent)
- `mcp` package installed: `pip install "mcp>=1.0.0"`

## Step 0: Install the Example Plugin

Copy the example plugin to the plugins directory:

```bash
cp -r examples/plugins/lammps-workflow plugins/lammps-workflow
```

Verify the plugin directory structure:

```
plugins/
  lammps-workflow/
    catgo-plugin.json
    plugin.py
```

## Step 1: Start the Backend

```bash
# From project root
pnpm desktop:serve
# Or directly:
# python server/main.py
```

Watch the console output for:
```
INFO: Registered workflow node: lammps_nvt_plugin
INFO: PluginManager initialized: 1 plugins, 0 calculators, 0 optimizers, 1 workflow nodes
```

If you see "1 workflow nodes", the plugin loaded successfully.

## Step 2: Test the REST API

### 2a. List all plugins

```bash
curl http://localhost:8000/api/plugins/
```

Expected: JSON response with `plugins` array containing an entry with:
- `name: "lammps-nvt-plugin"`
- `plugin_type: "workflow_node"`
- `enabled: true`

### 2b. List workflow node plugins

```bash
curl http://localhost:8000/api/plugins/workflow-nodes
```

Expected:
```json
{
  "nodes": [
    {
      "type": "lammps_nvt_plugin",
      "label": "LAMMPS NVT (Plugin)",
      "color": "#22c55e",
      "icon": "...",
      "category": "Plugin",
      "description": "Run NVT MD using LAMMPS with a custom force field",
      "inputs": ["structure"],
      "outputs": ["structure", "trajectory"],
      "default_params": { "timestep": 1.0, "temperature": 300, "steps": 1000, "potential": "eam" },
      "param_schema": [...]
    }
  ],
  "total": 1
}
```

### 2c. Run the automated API test

```bash
python tests/manual/test_phase3_api.py
```

This script tests all three API endpoints automatically.

## Step 3: Test the Frontend (Desktop App)

### 3a. Start the Desktop Dev Server

```bash
pnpm desktop:dev
```

Or if testing in the web app:

```bash
pnpm dev
```

### 3b. Open the Workflow Editor

1. Navigate to **Projects** in the sidebar
2. Create or open a project
3. Create a new workflow or open an existing one
4. The **Workflow Editor** should appear

### 3c. Check the Sidebar for Plugin Nodes

In the left sidebar of the workflow editor, look for a new category:

**"Plugin"** (with a puzzle piece icon)

Under this category, you should see:

- **LAMMPS NVT (Plugin)** - with a runner icon and green color

If you DON'T see it:
- Open browser DevTools (F12) → Console
- Look for: `[workflow] Failed to load plugin nodes: ...`
- If you see a network error, make sure the backend is running on the correct port
- Refresh the page and check again

### 3d. Drag the Plugin Node onto the Canvas

1. Drag **"LAMMPS NVT (Plugin)"** from the sidebar onto the workflow canvas
2. A green node should appear with the label "LAMMPS NVT (Plugin)"
3. Click the node to select it

### 3e. Check the Config Panel

With the plugin node selected, the right-side config panel should show:

- **Timestep (fs)**: number input, default 1.0
- **Temperature (K)**: number input, default 300
- **MD Steps**: number input, default 1000
- **Potential**: dropdown with EAM / Lennard-Jones / ReaxFF

Try changing values — they should persist when you deselect and reselect the node.

### 3f. Connect Nodes

1. Add a **Structure Input** node (from the "Input" category)
2. Import any structure (e.g., a simple Cu crystal)
3. Draw an edge from Structure Input's output port to LAMMPS NVT's input port
4. The connection should be accepted (both have "structure" port type)

### 3g. Run the Workflow (Optional - requires HPC or local execution setup)

1. Click the **Run** button
2. Configure execution mode as "Local"
3. Start the workflow

Expected behavior:
- Structure Input node completes instantly
- LAMMPS NVT (Plugin) node shows "running" status, then "completed"
- The plugin returns a mock result with energy = -42.0

## Step 4: Test Plugin Enable/Disable

### 4a. Disable the plugin

```bash
curl -X POST http://localhost:8000/api/plugins/lammps-nvt-plugin/disable
```

### 4b. Verify it's disabled

```bash
curl http://localhost:8000/api/plugins/workflow-nodes
```

Expected: `{"nodes": [], "total": 0}` (disabled plugins are excluded)

### 4c. Re-enable

```bash
curl -X POST http://localhost:8000/api/plugins/lammps-nvt-plugin/enable
```

### 4d. Verify it's back

```bash
curl http://localhost:8000/api/plugins/workflow-nodes
```

Expected: 1 node returned again.

## Step 5: Verify No Regressions

1. **Built-in nodes still work**: Drag a "Geometry Optimization" node — should work normally
2. **Sidebar categories unchanged**: Input, Calculation, Tools, Specialized, Logic, Analysis should all appear as before
3. **Existing workflows load correctly**: Open any saved workflow — all nodes should render

## Checklist

| Test | Pass? |
|------|-------|
| Backend starts and logs "1 workflow nodes" | |
| `GET /api/plugins/` shows lammps-nvt-plugin | |
| `GET /api/plugins/workflow-nodes` returns 1 node | |
| Sidebar shows "Plugin" category | |
| Plugin node can be dragged to canvas | |
| Config panel shows correct params | |
| Node can connect to Structure Input | |
| Disable/enable API works | |
| Built-in nodes unaffected | |
