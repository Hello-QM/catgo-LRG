# CatGO CLI — `dos --groups` (multi-group PDOS)

Slice F of the P3 backlog. Builds on Slice E (`feature/catgo-cli-ir-spectrum`,
PR catgo-dev#5); stacked PR base = that branch.

## Goal

Extend `catgo dos <vaspout.h5>` with a `--groups <spec>` flag that
computes a projected DOS for **multiple** atom/orbital groups in a
single pass and overlays them on one publication plot. Existing
single-group behavior (`--atoms` + `--channels`) is unchanged.

## CLI surface

```
catgo dos <vaspout.h5> --groups "atoms1:channels1[:label1];atoms2:channels2[:label2];..."
```

Single-group syntax for the value:

```
<atoms>:<channels>[:<label>]
```

- `<atoms>` — comma-separated 0-based atom indices, OR a contiguous range
  using `-` (e.g. `0-3`), OR the literal `all`. Ranges and comma-lists
  may be mixed: `0-3,5,7`.
- `<channels>` — orbital spec passed verbatim to
  `compute_pdos.parse_orbital_spec` (e.g. `d`, `s`, `dxy`, `spd`).
- `<label>` — optional human-readable name for the plot legend. When
  absent the label is `<channels>@<atoms>` (e.g. `d@0-3`).

Multiple groups separated by `;`. Trailing `;` ignored. Whitespace
trimmed around every token.

Examples:
```
--groups "0-3:d"                          # single d-group on atoms 0..3
--groups "0-3:d; 4,5:p"                   # two groups
--groups "0-3:d:Pt-surface; 4,5:p:O-ads"  # labelled
--groups "all:s; all:p; all:d"            # element-agnostic spd breakdown
```

## Backward compat

When `--groups` is empty (the default) the existing single-group path
runs — `--atoms` (default `all`) + `--channels` (default `spd`)
produce one curve, identical message format to today.

When `--groups` is non-empty, `--atoms` and `--channels` are **ignored**
(they would conflict) and the result message lists the number of groups.

## Architecture

- `catgo.cli.pdos_groups` (new module): pure functions for parsing the
  spec string into the `compute_pdos_groups` input shape, and helpers
  to derive default labels.
- `catgo.cli.ops_analyze.dos` (extend): when `params["groups"]` is
  non-empty, call `compute_pdos_groups`, build one series per result,
  and use `PlotSpec` with multiple `series` entries.
- `catgo_dos.pdos.compute_pdos_groups` — already exists; we reuse it.

### Parsing rules (in detail)

```python
def parse_groups_spec(spec: str, nions: int) -> list[dict]:
    """
    'a1[,a2,...|a-b]:channels[:label][;...]' -> list of dicts
        {"atoms": list[int], "channels": str, "label": str}

    Raises OpError on:
      - missing ':' separator inside any group
      - empty atom or channel field
      - non-integer atom token (other than 'all')
      - out-of-range atom index (< 0 or >= nions)
      - reversed range (a-b with a > b)
    """
```

Atom expansion:
- `"all"` → `list(range(nions))`
- `"0-3"` → `[0, 1, 2, 3]`
- `"0-3,5,7-8"` → `[0, 1, 2, 3, 5, 7, 8]`
- duplicates removed (use set; preserved-order de-dup)

### `ops_analyze.dos` (extended)

```python
groups_spec = params.get("groups", "")
if groups_spec:
    from catgo.cli.pdos_groups import parse_groups_spec
    group_dicts = parse_groups_spec(groups_spec, vdata.nions)
    results = compute_pdos_groups(vdata, group_dicts)
    series = []
    for grp, res in zip(group_dicts, results):
        total = list(res.pdos.sum(axis=0))   # collapse spins
        series.append((grp["label"], total, {}))
    spec = PlotSpec(
        kind="dos", x=list(results[0].grid),
        series=series,
        xlabel="E - E_f (eV)", ylabel="DOS (states/eV)",
        vlines=[0.0])
    out = Path(params["out"]) if params.get("out") else Path("dos.pdf")
    render(spec, out, bool(params.get("edit")), bool(params.get("latex")))
    # d-band center: compute per group only when its channel spec
    # mentions 'd'; surface as an aggregate in the message
    band_msg = _multi_d_band(vdata, group_dicts)
    if params.get("dump"):
        _dump(params["dump"], {
            "energy": list(results[0].grid),
            "groups": [{"label": g["label"], "atoms": g["atoms"],
                        "channels": g["channels"],
                        "pdos": list(r.pdos.sum(axis=0))}
                       for g, r in zip(group_dicts, results)],
        })
    return OpResult(ok=True,
        message=f"{len(group_dicts)} PDOS groups -> {out}{band_msg}",
        artifact=out, structure=None)
```

`_multi_d_band` returns either an empty string or
`"  (d-band centers: lab1=-1.234, lab2=-0.892)"` covering only the
groups whose channels include `d`.

### Group-dict shape passed to `compute_pdos_groups`

The extension expects `atoms`, `channels` (str OK; the extension calls
`parse_orbital_spec` itself), and optional `label`/`normalize`. We
pass `atoms`, `channels=<str>`, `label=<str>`. We do NOT set
`normalize` — keep the integrated-DOS semantics consistent with the
single-group path.

## Tests

```
server/tests/cli/test_pdos_groups.py
    test_parse_atoms_range_and_commas
    test_parse_atoms_all_keyword
    test_parse_atoms_duplicates_dedup
    test_parse_groups_default_label
    test_parse_groups_explicit_label
    test_parse_groups_strips_whitespace
    test_parse_groups_missing_colon_raises
    test_parse_groups_empty_atoms_raises
    test_parse_groups_empty_channels_raises
    test_parse_groups_out_of_range_raises
    test_parse_groups_reversed_range_raises

server/tests/cli/test_ops_analyze.py  (extend)
    test_dos_groups_calls_extension_with_dict_list  # monkeypatch
    test_dos_groups_plots_one_series_per_group
    test_dos_groups_dump_has_groups_array
    test_dos_groups_message_lists_count
    test_dos_no_groups_unchanged                    # backward compat

server/tests/cli/test_argparse.py  (extend)
    test_dos_groups_dash_flag_parses                # registry registration
```

## Out of scope

- Per-group sigma/normalize from the CLI (extension supports per-group,
  CLI exposes only one global sigma — register that as a follow-up if
  asked).
- Multi-line legend formatting (rely on matplotlib defaults).
- Subtracting groups (e.g. anti-bonding states by group A minus B).
- Spin-resolved per-group views (the existing single-group path also
  collapses spins; consistency wins).

## Autonomous design decisions

1. **`:`/`;` separator pair** — `;` between groups (visual break),
   `:` between fields inside one group (compact). Common in DOS plot
   tools (e.g. p4vasp's projector strings). No JSON for now — too
   verbose for a typical 2- to 4-group case.
2. **Atom range with `-`** — terse for the common slab case ("layers
   0..3 are the substrate"); ranges mixed with commas allowed.
3. **`all` keyword** for "every atom" — matches existing
   `--atoms all` in the single-group path.
4. **Default label** `<channels>@<atoms>` — readable in a small legend
   without the user having to think.
5. **`--atoms`/`--channels` ignored when `--groups` is set** — fail
   loud later if needed; simpler than synthesizing a phantom group.
6. **No `normalize` in the CLI spec** — keeps the syntax compact;
   advanced users can call the extension directly.
7. **d-band centers only emitted for groups whose channel string
   contains `d`** — avoids meaningless `nan` rows in the legend.
8. **Dump schema:** top-level `groups: list[dict]` mirroring the input
   spec (label/atoms/channels) + `pdos: list[float]` per group.
   Tools downstream can ingest with one pass.
