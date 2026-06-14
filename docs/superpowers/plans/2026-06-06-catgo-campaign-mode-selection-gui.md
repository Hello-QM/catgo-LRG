# CatGO Campaign — mode-selection GUI (P4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** At project creation, let the user pick **Visual workflow (DB engine)** vs **md-orchestration (file-first)**. Visual keeps the current path; md scaffolds a folder via a new backend route and shows next-steps. md projects live on disk (NOT the DB) — consistent with file-first.

**Architecture:** Backend `POST /api/campaign/new` (`server/catgo/routers/campaign.py`) calls the campaign lib's `scaffold_project`. Frontend adds a mode toggle to the existing inline create dialog in `src/lib/workflow/ProjectListView.svelte`; md mode calls a new `src/lib/api/campaign.ts` client (HTTP-only, no tri-modal DB). New i18n strings in `en/app.ts` + `zh/app.ts` (parity).

**Tech Stack:** FastAPI (backend), SvelteKit2 / Svelte 5 runes (frontend), pytest + svelte-check.

**Prior:** campaign MVP+P2+P3 shipped on branch `feat/campaign-md-orchestration`; `scaffold_project(base, name, template)` at `server/catgo/workflow/skills/campaign/scripts/campaign_lib.py:360`; `slugify` in the same module.

**Gotchas:**
- Do NOT push (private repo). Do NOT start/stop `:8000`. Do NOT `deno fmt` (it skips `.svelte`/`.md`; `.ts`/`.py` it does touch — but don't run it; let the user's pre-commit hook format).
- Backend test: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_campaign_router.py -v`.
- Frontend type-check: `pnpm check` (svelte-check; not a CI gate but run it — confirm no NEW errors in touched files).
- Formatting: single quotes, no semicolons, 2-space (deno.jsonc) — match the surrounding files.

---

### Task 1: Backend `POST /api/campaign/new` + register

**Files:**
- Create: `server/catgo/routers/campaign.py`
- Modify: `server/catgo/routers/__init__.py` (add to `_ROUTERS`)
- Modify: `server/main.py` (eager import + include_router)
- Test: `server/tests/test_campaign_router.py`

- [ ] **Step 1: Write the failing test** — create `server/tests/test_campaign_router.py`:

```python
"""POST /api/campaign/new scaffolds an md-orchestration campaign on disk."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from catgo.routers.campaign import router


def _client():
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


def test_create_campaign_scaffolds_saa_her(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "SAA HER", "base": str(tmp_path), "template": "saa_her"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is True
    root = tmp_path / "SAA-HER"                    # readable slug, never a hash
    assert (root / "plan.md").is_file()
    assert (root / "calc" / "02-activity-dGH" / "INDEX.md").is_file()
    assert data["path"].endswith("SAA-HER")
    assert data["template"] == "saa_her"


def test_create_campaign_blank_default(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "My Study", "base": str(tmp_path)})
    assert r.status_code == 200
    assert (tmp_path / "My-Study" / "README.md").is_file()


def test_bad_template_is_400(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "x", "base": str(tmp_path), "template": "bogus"})
    assert r.status_code == 400


def test_empty_name_is_400(tmp_path):
    r = _client().post("/api/campaign/new", json={
        "name": "   ", "base": str(tmp_path)})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_campaign_router.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'catgo.routers.campaign'`

- [ ] **Step 3: Write minimal implementation**

Create `server/catgo/routers/campaign.py`:

```python
"""Campaign scaffolding HTTP route — POST /api/campaign/new.

md-orchestration campaigns live on disk (not the DB); this thin route lets the
GUI scaffold one by calling the campaign reference lib's scaffold_project. The
folder name is the readable slug of the project name (never a hash).
"""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/campaign", tags=["campaign"])

_TEMPLATES = ("blank", "saa_her")


class CampaignCreateRequest(BaseModel):
    name: str
    base: str                       # parent directory (user-chosen location)
    template: str = "blank"


def _campaign_lib():
    """Import the campaign reference lib shipped inside the catgo package."""
    import catgo
    scripts = str(Path(catgo.__file__).resolve().parent
                  / "workflow" / "skills" / "campaign" / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import campaign_lib
    return campaign_lib


@router.post("/new")
def create_campaign(req: CampaignCreateRequest) -> dict:
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    if req.template not in _TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"template must be one of {', '.join(_TEMPLATES)}")
    if not req.base.strip():
        raise HTTPException(status_code=400, detail="base (location) required")
    try:
        cl = _campaign_lib()
        base = Path(req.base).expanduser()
        root = cl.scaffold_project(base / cl.slugify(name), name,
                                   template=req.template)
    except Exception as exc:  # noqa: BLE001 — surface a clean 400 to the UI
        raise HTTPException(status_code=400, detail=f"scaffold failed: {exc}")
    return {"ok": True, "path": str(root), "name": name, "template": req.template}
```

In `server/catgo/routers/__init__.py`, add to the `_ROUTERS` dict (after the
`"skills_router": "skills",` line):

```python
    "campaign_router": "campaign",
```

In `server/main.py`, add `campaign_router,` to the eager import block (inside the
`from catgo.routers import (` ... `)` at lines 93-113, e.g. after `skills_router,`):

```python
    campaign_router,
```

and add the include near the other `app.include_router(..., prefix="/api")` calls
(after `app.include_router(skills_router, prefix="/api")` ~line 494):

```python
app.include_router(campaign_router, prefix="/api")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest tests/test_campaign_router.py -v`
Expected: PASS (4 tests). Also import-smoke main: `cd server && /home/james0001/miniforge3/envs/catgo/bin/python -c "import main; print('main imports OK')"`
Expected: prints `main imports OK` (no import error from the new router wiring).

- [ ] **Step 5: Commit**

```bash
git add server/catgo/routers/campaign.py server/catgo/routers/__init__.py \
        server/main.py server/tests/test_campaign_router.py
git commit -m "feat(campaign): POST /api/campaign/new scaffold route for the GUI"
```

---

### Task 2: Frontend api client `campaign.ts`

**Files:**
- Create: `src/lib/api/campaign.ts`

- [ ] **Step 1: Write the implementation** (no unit test — exercised via the component + backend test)

Create `src/lib/api/campaign.ts`:

```typescript
/**
 * Campaign (md-orchestration) API client — HTTP-only.
 *
 * Unlike project.ts (tri-modal DB routing), an md campaign is a filesystem scaffold
 * performed by the Python backend (where catgo + scaffold_project live), so this
 * always hits the FastAPI route. Requires the backend to be running.
 */
import { API_BASE } from './config'

export interface CampaignCreated {
  ok: boolean
  path: string
  name: string
  template: string
}

export async function create_campaign(
  name: string,
  base: string,
  template = `blank`,
): Promise<CampaignCreated> {
  const response = await fetch(`${API_BASE}/campaign/new`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ name, base, template }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(err.detail || `Request failed: ${response.statusText}`)
  }
  return response.json()
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/api/campaign.ts
git commit -m "feat(campaign): frontend campaign API client (HTTP scaffold)"
```

---

### Task 3: i18n strings (en + zh parity)

**Files:**
- Modify: `src/lib/i18n/en/app.ts`
- Modify: `src/lib/i18n/zh/app.ts`

- [ ] **Step 1: Add the keys**

In `src/lib/i18n/en/app.ts`, add alongside the existing project keys (e.g. near
`new_project`):

```typescript
  campaign_mode_label: `Workflow type`,
  campaign_mode_visual: `Visual workflow`,
  campaign_mode_visual_hint: `DB engine, node graph — fixed pipelines & teaching`,
  campaign_mode_md: `md-orchestration (file-first)`,
  campaign_mode_md_hint: `Agent-driven folder + markdown — exploratory / HPC studies`,
  campaign_location_placeholder: `Project location (folder), e.g. ~/research`,
  campaign_location_required: `Choose a location for the md project`,
  campaign_template_label: `Template`,
  campaign_template_blank: `Blank`,
  campaign_template_saa_her: `SAA HER screening`,
  campaign_created: `Created at {path}`,
  campaign_created_hint: `Agent-driven — drive it with the agent or 'catgo campaign'.`,
  campaign_done: `Done`,
```

In `src/lib/i18n/zh/app.ts`, add the SAME keys (parity):

```typescript
  campaign_mode_label: `工作流类型`,
  campaign_mode_visual: `可视化工作流`,
  campaign_mode_visual_hint: `数据库引擎、节点图 — 固定流程与教学`,
  campaign_mode_md: `md 编排(文件优先)`,
  campaign_mode_md_hint: `agent 驱动的文件夹 + markdown — 探索性 / HPC 研究`,
  campaign_location_placeholder: `项目位置(文件夹),如 ~/research`,
  campaign_location_required: `请为 md 项目选择一个位置`,
  campaign_template_label: `模板`,
  campaign_template_blank: `空白`,
  campaign_template_saa_her: `单原子合金 HER 筛选`,
  campaign_created: `已创建于 {path}`,
  campaign_created_hint: `agent 驱动 — 用 agent 或 'catgo campaign' 推进。`,
  campaign_done: `完成`,
```

(Match the file's existing object syntax — keys are inside the default-exported
object; place them next to the other project keys, keep trailing commas.)

- [ ] **Step 2: Verify parity**

Run: `cd /home/james0001/project/catgo-LRG && /home/james0001/miniforge3/envs/catgo/bin/python -c "
import re,pathlib
def keys(p):
    t=pathlib.Path(p).read_text()
    return set(re.findall(r'campaign_[a-z_]+', t))
en=keys('src/lib/i18n/en/app.ts'); zh=keys('src/lib/i18n/zh/app.ts')
print('en-zh diff:', en^zh)
assert en==zh, 'i18n parity broken'
print('parity OK', len(en), 'campaign keys')
"`
Expected: `parity OK 13 campaign keys` (en == zh).

- [ ] **Step 3: Commit**

```bash
git add src/lib/i18n/en/app.ts src/lib/i18n/zh/app.ts
git commit -m "i18n(campaign): mode-selection strings (en+zh parity)"
```

---

### Task 4: ProjectListView mode toggle

**Files:**
- Modify: `src/lib/workflow/ProjectListView.svelte`

- [ ] **Step 1: Add script state + import + dispatch**

In the `<script lang="ts">` block, after the existing imports (line 3), add:

```typescript
  import * as campaign_api from '$lib/api/campaign'
```

After `let new_description = $state(``)` (line 26), add:

```typescript
  let new_mode = $state<'visual' | 'md'>(`visual`)
  let new_base = $state(``)
  let new_template = $state(`blank`)
  let created_path = $state(``)
```

Replace the whole `create_project()` function (lines 56-70) with:

```typescript
  function reset_create_form() {
    new_name = ``
    new_description = ``
    new_base = ``
    new_template = `blank`
    new_mode = `visual`
    created_path = ``
    show_create_dialog = false
  }

  async function create_project() {
    const name = new_name.trim()
    if (!name) return
    error = ``
    try {
      if (new_mode === `md`) {
        const base = new_base.trim()
        if (!base) {
          error = t('app.campaign_location_required')
          return
        }
        const res = await campaign_api.create_campaign(name, base, new_template)
        created_path = res.path
        return
      }
      const created = await project_api.create_project(name, new_description.trim())
      projects = [created, ...projects]
      reset_create_form()
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }
```

- [ ] **Step 2: Replace the create-dialog markup**

Replace the whole `{#if show_create_dialog}` ... `{/if}` block (lines 128-156) with:

```svelte
  {#if show_create_dialog}
    <div class="create-form">
      {#if created_path}
        <!-- md campaign created: show next-steps -->
        <div class="created-panel">
          <div class="created-title">{t('app.campaign_created', { path: created_path })}</div>
          <div class="created-hint">{t('app.campaign_created_hint')}</div>
        </div>
        <div class="form-actions">
          <button class="primary-btn" onclick={reset_create_form}>{t('app.campaign_done')}</button>
        </div>
      {:else}
        <!-- mode toggle -->
        <div class="mode-row" role="group" aria-label={t('app.campaign_mode_label')}>
          <button
            type="button"
            class="mode-btn"
            class:active={new_mode === `visual`}
            onclick={() => (new_mode = `visual`)}
          >
            <span class="mode-title">{t('app.campaign_mode_visual')}</span>
            <span class="mode-hint">{t('app.campaign_mode_visual_hint')}</span>
          </button>
          <button
            type="button"
            class="mode-btn"
            class:active={new_mode === `md`}
            onclick={() => (new_mode = `md`)}
          >
            <span class="mode-title">{t('app.campaign_mode_md')}</span>
            <span class="mode-hint">{t('app.campaign_mode_md_hint')}</span>
          </button>
        </div>

        <input
          class="form-input"
          bind:value={new_name}
          placeholder={t('app.project_name_placeholder')}
        />

        {#if new_mode === `visual`}
          <input
            class="form-input"
            bind:value={new_description}
            placeholder={t('app.description_optional_placeholder')}
          />
        {:else}
          <input
            class="form-input"
            bind:value={new_base}
            placeholder={t('app.campaign_location_placeholder')}
          />
          <label class="template-row">
            <span class="template-label">{t('app.campaign_template_label')}</span>
            <select class="form-input" bind:value={new_template}>
              <option value="blank">{t('app.campaign_template_blank')}</option>
              <option value="saa_her">{t('app.campaign_template_saa_her')}</option>
            </select>
          </label>
        {/if}

        <div class="form-actions">
          <button
            class="primary-btn"
            onclick={create_project}
            disabled={!new_name.trim() || (new_mode === `md` && !new_base.trim())}
          >
            {t('common.create')}
          </button>
          <button class="secondary-btn" onclick={reset_create_form}>
            {t('common.cancel')}
          </button>
        </div>
      {/if}
    </div>
  {/if}
```

- [ ] **Step 3: Add styles**

Inside the `<style>` block (e.g. after the `.create-form` rule, ~line 328), add:

```css
  .mode-row {
    display: flex;
    gap: 8px;
  }

  .mode-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    background: var(--surface-bg-hover);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .mode-btn:hover {
    color: var(--text-color, #eee);
  }

  .mode-btn.active {
    border-color: var(--accent-color, #3b82f6);
    background: rgba(59, 130, 246, 0.12);
    color: var(--text-color, #eee);
  }

  .mode-title {
    font-size: 13px;
    font-weight: 600;
  }

  .mode-hint {
    font-size: 10px;
    line-height: 1.3;
  }

  .template-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .template-label {
    font-size: 12px;
    color: var(--text-color-muted, #94a3b8);
    white-space: nowrap;
  }

  .created-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .created-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-color, #eee);
    word-break: break-all;
  }

  .created-hint {
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
  }
```

- [ ] **Step 4: Type-check**

Run: `cd /home/james0001/project/catgo-LRG && pnpm check 2>&1 | tail -25`
Expected: no NEW errors referencing `ProjectListView.svelte`, `campaign.ts`, or the
new i18n keys. (Pre-existing unrelated svelte-check warnings/errors elsewhere may
exist — confirm none are in the touched files.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow/ProjectListView.svelte
git commit -m "feat(campaign): mode toggle (visual | md-orchestration) in create dialog"
```

---

### Task 5: end-to-end smoke (backend route)

**Files:** none.

- [ ] **Step 1: Verify the route scaffolds via the running-code path**

Run:
```
cd server && /home/james0001/miniforge3/envs/catgo/bin/python -c "
from fastapi import FastAPI
from fastapi.testclient import TestClient
from catgo.routers.campaign import router
import tempfile, pathlib
app=FastAPI(); app.include_router(router, prefix='/api'); c=TestClient(app)
d=tempfile.mkdtemp()
r=c.post('/api/campaign/new', json={'name':'SAA HER','base':d,'template':'saa_her'})
print(r.status_code, r.json())
root=pathlib.Path(d)/'SAA-HER'
print('plan.md:', (root/'plan.md').is_file(), '| funnel stages:', (root/'calc'/'02-activity-dGH'/'INDEX.md').is_file())
"
```
Expected: `200 {...'ok': True...}` and both `True`.

- [ ] **Step 2: Full backend campaign + cli regression**

Run:
```
cd server && /home/james0001/miniforge3/envs/catgo/bin/python -m pytest \
  tests/test_campaign_router.py catgo/workflow/skills/campaign/scripts tests/cli/test_campaign_cmd.py -q
```
Expected: all green (router 4 + campaign scripts 54 + cli 5).

---

## Self-Review

**1. Coverage:** mode toggle at creation → Task 4. Visual path unchanged → Task 4 (`new_mode==='visual'` keeps `project_api.create_project`). md scaffold → Task 1 (route) + Task 2 (client) + Task 4 (dispatch). i18n parity → Task 3 (+ parity check). md project = folder, not DB → Task 1 returns a path; nothing written to the project DB. ✓

**2. Placeholders:** none; full code for every file. `{path}` is an i18n interpolation token (real), not a plan placeholder. ✓

**3. Consistency:** `create_campaign(name, base, template)` signature matches Task 2 client ↔ Task 4 call ↔ Task 1 request model (`name`/`base`/`template`). i18n keys used in Task 4 (`campaign_mode_*`, `campaign_location_*`, `campaign_template_*`, `campaign_created*`, `campaign_done`) all defined in Task 3 (en+zh). Route path `${API_BASE}/campaign/new` ↔ backend `prefix="/campaign"` + `/new` + `app.include_router(prefix="/api")`. The folder slug (`slugify(name)`) matches the backend test's expected `SAA-HER` / `My-Study`. ✓
```
