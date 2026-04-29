# 实施 Prompts Phase 5：工作流节点参数对齐 Structure 界面

**日期:** 2026-03-18
**分支:** `CatGo-PRO`
**原则:** 把 Structure 界面的参数搬到工作流节点的 param_schema，让用户在工作流中也能配置同样丰富的参数

---

## 问题总结

Structure 界面的工具面板有丰富的参数 UI（吸附物预设库、位点可视化、元素周期表选择器、轨道通道选择等），但工作流节点的 param_schema 极其简陋（通常只有 3-5 个参数）。

**对比：**

| 组件 | Structure 界面参数数 | 工作流节点参数数 | 比率 |
|------|---------------------|-----------------|------|
| 吸附物放置 | 13 | 4 | 3:1 |
| 掺杂 | 11 | 5 | 2:1 |
| 切面/Slab | 8 | 4 | 2:1 |
| DOS 分析 | 30+ | 3 | 10:1 |
| 自由能 | 12 | 3 | 4:1 |

## 实施状态

| # | 功能 | 难度 | 状态 |
|---|------|------|------|
| 47 | adsorbate_place 参数扩充 | 中 | 🔲 |
| 48 | doping_gen 参数扩充 | 中 | 🔲 |
| 49 | slab_gen 参数扩充 | 低 | 🔲 |
| 50 | dos_analysis 参数扩充 | 中 | 🔲 |
| 51 | free_energy 参数扩充 | 低 | 🔲 |
| 52 | charge_analysis 参数 | 低 | 🔲 |
| 53 | cohp_analysis 参数 | 低 | 🔲 |
| 54 | md_analysis 参数 | 低 | 🔲 |

---

## Prompt 47: adsorbate_place 参数扩充

```
在 node-definitions.ts 中扩充 adsorbate_place 的 param_schema，
对齐 Structure 界面 AdsorbatePlacementPane 的参数。

## 当前参数（3 个）
- species: string
- site: select (ontop/bridge/fcc/hcp/all)
- mode: select (end-on/side-on)

## 需要增加的参数

```typescript
param_schema: [
  // --- 吸附物选择 ---
  {
    key: `species`, label: `Adsorbate`, type: `select`, default: `OH`, group: `Adsorbate`,
    options: [
      { label: `OH (hydroxyl)`, value: `OH` },
      { label: `O (oxygen)`, value: `O` },
      { label: `OOH (peroxyl)`, value: `OOH` },
      { label: `H (hydrogen)`, value: `H` },
      { label: `H₂O (water)`, value: `H2O` },
      { label: `CO (carbon monoxide)`, value: `CO` },
      { label: `COOH (carboxyl)`, value: `COOH` },
      { label: `N₂ (nitrogen)`, value: `N2` },
      { label: `NH₃ (ammonia)`, value: `NH3` },
      { label: `NO (nitric oxide)`, value: `NO` },
      { label: `Custom`, value: `custom` },
    ],
    help: `Select adsorbate molecule. Choose "Custom" to specify XYZ coordinates manually.`,
  },
  {
    key: `custom_xyz`, label: `Custom XYZ`, type: `text`, default: ``, group: `Adsorbate`,
    show_if: { key: `species`, values: [`custom`] },
    help: `Paste adsorbate XYZ coordinates. Format: "Element x y z" per line.`,
  },
  // --- 位点选择 ---
  {
    key: `site`, label: `Adsorption Site`, type: `select`, default: `all`, group: `Placement`,
    options: [
      { label: `All sites (auto-select best)`, value: `all` },
      { label: `On-top`, value: `ontop` },
      { label: `Bridge`, value: `bridge` },
      { label: `FCC Hollow`, value: `fcc` },
      { label: `HCP Hollow`, value: `hcp` },
    ],
    help: `Site type preference. "All" picks the first available site.`,
  },
  {
    key: `height`, label: `Height Offset (Å)`, type: `number`, default: 2.0, group: `Placement`,
    min: 0.5, max: 5.0, step: 0.1,
    help: `Distance above the surface to place the adsorbate binding atom.`,
  },
  {
    key: `auto_rotate`, label: `Auto-Rotate`, type: `boolean`, default: true, group: `Placement`,
    help: `Automatically orient the adsorbate perpendicular to the surface.`,
  },
  // --- 后处理 ---
  {
    key: `quick_optimize`, label: `Quick Optimize After Placement`, type: `select`, default: `none`, group: `Post-placement`,
    options: [
      { label: `None`, value: `none` },
      { label: `UFF (fast, approximate)`, value: `uff` },
      { label: `xTB (GFN2, semi-empirical)`, value: `xtb` },
    ],
    help: `Optionally run a quick local optimization after placing the adsorbate.`,
  },
],
```

同时更新 batch_adsorbate_place 的 adsorbates 参数，使用同样的预设列表。

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts（adsorbate_place + batch_adsorbate_place 的 param_schema）
```

---

## Prompt 48: doping_gen 参数扩充

```
在 node-definitions.ts 中扩充 doping_gen 的 param_schema。

## 当前参数（4 个）
- dopant, target_element, count, site_strategy

## 需要增加的参数

```typescript
param_schema: [
  {
    key: `dopant`, label: `Dopant Element`, type: `periodic`, default: `Fe`, group: `Doping`,
    help: `Element to substitute into the structure.`,
  },
  {
    key: `target_element`, label: `Host Element`, type: `periodic`, default: ``, group: `Doping`,
    help: `Element to replace. Leave empty to auto-detect (most common non-ligand element).`,
  },
  {
    key: `count`, label: `Number of Substitutions`, type: `number`, default: 1, group: `Doping`,
    min: 1, max: 10, step: 1,
    help: `How many host atoms to replace with dopant.`,
  },
  {
    key: `enumerate`, label: `Enumerate All Configurations`, type: `boolean`, default: false, group: `Doping`,
    help: `Generate all unique doping configurations (combinatorial). Results in multiple structures.`,
  },
  {
    key: `max_configs`, label: `Max Configurations`, type: `number`, default: 50, group: `Doping`,
    min: 1, max: 500, step: 10,
    show_if: { key: `enumerate`, values: [`true`, true] },
    help: `Maximum number of unique configurations to generate.`,
  },
  {
    key: `deduplicate`, label: `Symmetry-Aware Deduplication`, type: `boolean`, default: true, group: `Doping`,
    show_if: { key: `enumerate`, values: [`true`, true] },
    help: `Remove symmetry-equivalent configurations (uses spglib).`,
  },
],
```

注意：`type: 'periodic'` 在 NodeConfigPanel 中已支持 — 它渲染一个元素选择器。

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 49: slab_gen 参数扩充

```
在 node-definitions.ts 中扩充 slab_gen 的 param_schema。

## 当前参数（4 个）
- miller, layers, vacuum, supercell

## 需要增加的参数

```typescript
param_schema: [
  {
    key: `miller`, label: `Miller Indices`, type: `string`, default: `1,0,0`, group: `Slab`,
    help: `Surface orientation as h,k,l (e.g. "1,1,0" or "0,0,1").`,
  },
  {
    key: `layers`, label: `Number of Layers`, type: `number`, default: 4, group: `Slab`,
    min: 2, max: 12, step: 1,
    help: `Number of atomic layers in the slab.`,
  },
  {
    key: `vacuum`, label: `Vacuum (Å)`, type: `number`, default: 15.0, group: `Slab`,
    min: 8.0, max: 30.0, step: 1.0,
    help: `Vacuum layer thickness above the surface.`,
  },
  {
    key: `supercell`, label: `Supercell`, type: `select`, default: `1×1`, group: `Slab`,
    options: [
      { label: `1×1`, value: `1×1` },
      { label: `2×1`, value: `2×1` },
      { label: `2×2`, value: `2×2` },
      { label: `3×3`, value: `3×3` },
    ],
    help: `In-plane supercell expansion.`,
  },
  {
    key: `center_slab`, label: `Center in Cell`, type: `boolean`, default: true, group: `Slab`,
    help: `Center the slab in the cell (vacuum on both sides).`,
  },
  {
    key: `primitive`, label: `Use Primitive Cell`, type: `boolean`, default: true, group: `Slab`,
    help: `Reduce to primitive cell before cutting.`,
  },
  {
    key: `enumerate_terminations`, label: `Enumerate Terminations`, type: `boolean`, default: false, group: `Slab`,
    help: `Generate all possible surface terminations (results in multiple structures with _fan_out).`,
  },
],
```

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 50: dos_analysis 参数扩充

```
在 node-definitions.ts 中扩充 dos_analysis 的 param_schema。
当前只有 3 个参数（source, d_band, atom_indices），需要对齐 DosAnalysisPane。

## 需要增加的参数

```typescript
param_schema: [
  { key: `source`, label: `Data Source`, type: `select`, default: `parent_step`, group: `Analysis`,
    options: [
      { label: `From parent step output`, value: `parent_step` },
      { label: `From remote file`, value: `remote` },
    ],
  },
  // --- 计算参数 ---
  { key: `sigma`, label: `Broadening σ (eV)`, type: `number`, default: 0.05, group: `DOS Parameters`,
    min: 0.001, max: 1.0, step: 0.01,
    help: `Gaussian broadening width for DOS smoothing.`,
  },
  { key: `emin`, label: `Energy Min (eV)`, type: `number`, default: -10, group: `DOS Parameters`,
    min: -30, max: 0, step: 1,
    help: `Lower bound of energy range (relative to Fermi level).`,
  },
  { key: `emax`, label: `Energy Max (eV)`, type: `number`, default: 6, group: `DOS Parameters`,
    min: 0, max: 30, step: 1,
    help: `Upper bound of energy range (relative to Fermi level).`,
  },
  { key: `ngrid`, label: `Grid Points`, type: `number`, default: 2000, group: `DOS Parameters`,
    min: 100, max: 10000, step: 100,
    help: `Number of energy grid points for interpolation.`,
  },
  // --- 原子选择 ---
  { key: `atom_indices`, label: `Atom Indices`, type: `string`, default: ``, group: `Atom Selection`,
    help: `Comma-separated atom indices for PDOS (empty = all atoms). Example: "0,1,2,3"`,
  },
  { key: `element_filter`, label: `Element Filter`, type: `string`, default: ``, group: `Atom Selection`,
    help: `Filter atoms by element (e.g. "Fe" or "Ti,O"). Empty = all elements.`,
  },
  { key: `orbital_channels`, label: `Orbital Channels`, type: `select`, default: `total`, group: `Orbitals`,
    options: [
      { label: `Total`, value: `total` },
      { label: `s`, value: `s` },
      { label: `p`, value: `p` },
      { label: `d`, value: `d` },
      { label: `f`, value: `f` },
      { label: `s+p+d`, value: `s+p+d` },
    ],
    help: `Which orbital channels to project onto.`,
  },
  // --- d-band ---
  { key: `d_band`, label: `Compute d-Band Center`, type: `boolean`, default: true, group: `D-Band`,
    help: `Calculate d-band center, width, and filling for transition metals.`,
  },
  { key: `d_band_occupied_only`, label: `Occupied States Only`, type: `boolean`, default: true, group: `D-Band`,
    show_if: { key: `d_band`, values: [`true`, true] },
    help: `Only include states below Fermi level for d-band center.`,
  },
],
```

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 51: free_energy 参数扩充

```
在 node-definitions.ts 中扩充 free_energy 的 param_schema。
当前只有 3 个参数（temperature, pathway, potential），需要对齐 GibbsCalculator。

## 需要增加的参数

```typescript
param_schema: [
  {
    key: `mode`, label: `Phase`, type: `select`, default: `adsorbed`, group: `Thermo`,
    options: [
      { label: `Adsorbed (surface-bound)`, value: `adsorbed` },
      { label: `Gas Phase (molecule)`, value: `gas` },
    ],
    help: `Treatment of translational/rotational entropy. Adsorbed = vibrational only. Gas = full ideal gas.`,
  },
  {
    key: `temperature`, label: `Temperature (K)`, type: `number`, default: 298.15, group: `Thermo`,
    min: 100, max: 1500, step: 10,
  },
  {
    key: `freq_cutoff`, label: `Frequency Cutoff (cm⁻¹)`, type: `number`, default: 50, group: `Thermo`,
    min: 0, max: 200, step: 10,
    help: `Treat frequencies below this as frustrated translations (replace with cutoff value).`,
  },
  {
    key: `pressure`, label: `Pressure (atm)`, type: `number`, default: 1.0, group: `Thermo`,
    min: 0.001, max: 100, step: 0.1,
    show_if: { key: `mode`, values: [`gas`] },
    help: `Gas pressure for translational entropy (ideal gas).`,
  },
  {
    key: `pathway`, label: `Reaction Pathway`, type: `select`, default: `distal`, group: `Diagram`,
    options: [
      { label: `Distal`, value: `distal` },
      { label: `Alternating`, value: `alternating` },
      { label: `Enzymatic`, value: `enzymatic` },
      { label: `Custom`, value: `custom` },
    ],
  },
  {
    key: `potential`, label: `Applied Potential (V vs RHE)`, type: `number`, default: 0.0, group: `Diagram`,
    min: -2.0, max: 2.0, step: 0.1,
    help: `Applied electrode potential for free energy diagram (CHE model).`,
  },
],
```

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 52: charge_analysis 参数

```
在 node-definitions.ts 中扩充 charge_analysis 的 param_schema。

```typescript
param_schema: [
  {
    key: `method`, label: `Charge Method`, type: `select`, default: `bader`, group: `Charge`,
    options: [
      { label: `Bader (QTAIM)`, value: `bader` },
      { label: `DDEC6`, value: `ddec6` },
    ],
    help: `Bader requires CHGCAR + AECCAR0 + AECCAR2 (set LAECHG=True in parent VASP static calculation).`,
  },
  {
    key: `reference`, label: `Reference Charges`, type: `select`, default: `aeccar`, group: `Charge`,
    options: [
      { label: `AECCAR (all-electron, recommended)`, value: `aeccar` },
      { label: `None (use CHGCAR only)`, value: `none` },
    ],
    show_if: { key: `method`, values: [`bader`] },
    help: `Reference charge density for Bader partitioning. AECCAR = AECCAR0 + AECCAR2.`,
  },
],
```

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 53: cohp_analysis 参数

```
在 node-definitions.ts 中扩充 cohp_analysis 的 param_schema。

```typescript
param_schema: [
  { key: `source`, label: `Data Source`, type: `select`, default: `parent_step`, group: `Analysis`,
    options: [
      { label: `From parent step output`, value: `parent_step` },
      { label: `From remote file`, value: `remote` },
    ],
  },
  { key: `bond_pairs`, label: `Bond Pairs`, type: `string`, default: ``, group: `COHP`,
    help: `Specific bond pairs to analyze (e.g. "Fe-N,Fe-O"). Empty = all pairs.`,
  },
  { key: `include_orbitals`, label: `Include Orbital Decomposition`, type: `boolean`, default: false, group: `COHP`,
    help: `Show orbital-resolved COHP (s-s, p-d, etc.). Increases output size.`,
  },
  { key: `max_bonds`, label: `Max Bonds`, type: `number`, default: 20, group: `COHP`,
    min: 1, max: 100, step: 5,
    help: `Limit the number of bonds to analyze (sorted by distance).`,
  },
],
```

注意：COHP 分析需要 LOBSTER 输出。在 help_text 中说明这一点。

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## Prompt 54: md_analysis 参数

```
在 node-definitions.ts 中扩充 md_analysis 的 param_schema。

```typescript
param_schema: [
  { key: `analyses`, label: `Analysis Types`, type: `string`, default: `rmsd,rdf`, group: `Analysis`,
    help: `Comma-separated: rmsd, rdf, msd, density, hbonds, angles.`,
  },
  { key: `skip_frames`, label: `Skip Initial Frames`, type: `number`, default: 0, group: `Analysis`,
    min: 0, max: 10000, step: 100,
    help: `Number of initial equilibration frames to skip.`,
  },
  // --- RDF 参数 ---
  { key: `rdf_max_dist`, label: `RDF Max Distance (Å)`, type: `number`, default: 10.0, group: `RDF`,
    min: 3, max: 30, step: 1,
    help: `Maximum distance for radial distribution function.`,
  },
  { key: `rdf_bins`, label: `RDF Bins`, type: `number`, default: 100, group: `RDF`,
    min: 50, max: 500, step: 50,
    help: `Number of distance bins for RDF.`,
  },
  { key: `rdf_pairs`, label: `RDF Atom Pairs`, type: `string`, default: ``, group: `RDF`,
    help: `Specific pair types (e.g. "O-H,O-O"). Empty = all pairs.`,
  },
  // --- 密度参数 ---
  { key: `density_axis`, label: `Density Profile Axis`, type: `select`, default: `z`, group: `Density`,
    options: [
      { label: `Z`, value: `z` },
      { label: `X`, value: `x` },
      { label: `Y`, value: `y` },
    ],
    help: `Axis along which to compute density profile.`,
  },
  { key: `density_type`, label: `Density Type`, type: `select`, default: `number`, group: `Density`,
    options: [
      { label: `Number density (atoms/Å³)`, value: `number` },
      { label: `Mass density (g/cm³)`, value: `mass` },
    ],
  },
],
```

## 文件清单
- 修改: src/lib/workflow/node-definitions.ts
```

---

## 执行顺序

所有修改都在一个文件（node-definitions.ts），可以合并为一次提交。

```
全部修改 node-definitions.ts → commit → pnpm check → push
```
