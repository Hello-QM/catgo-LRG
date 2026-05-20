# Plan: dos --groups multi-group PDOS (Slice F)

Spec: `docs/superpowers/specs/2026-05-19-catgo-cli-pdos-groups-design.md`.
Branch: `feature/catgo-cli-pdos-groups` (base = `feature/catgo-cli-ir-spectrum`).

Each task: failing test → impl → green → commit.

## Task F1 — atom-spec parser

Test: `test_pdos_groups.py::test_parse_atoms_*` covering:
- single `"0"` → `[0]`
- comma list `"0,2,5"` → `[0, 2, 5]`
- range `"0-3"` → `[0, 1, 2, 3]`
- mixed `"0-3,5,7-8"` → `[0, 1, 2, 3, 5, 7, 8]`
- `"all"` with nions=4 → `[0, 1, 2, 3]`
- duplicates `"0,0,1,1"` → `[0, 1]` (preserved order de-dup)
- whitespace `"  0 , 1-2 "` → `[0, 1, 2]`

Test errors:
- empty string → OpError
- non-integer `"x"` → OpError
- out of range `"-1"` or `"99"` with nions=4 → OpError
- reversed `"3-1"` → OpError

Impl: `catgo/cli/pdos_groups.py::_parse_atom_list(text, nions) -> list[int]`.

Commit: `feat(cli): pdos atom-list parser (ranges/all/dedup) [F1]`

## Task F2 — group-spec parser

Test: `test_parse_groups_default_label` — `"0-3:d"` →
`[{"atoms":[0,1,2,3], "channels":"d", "label":"d@0-3"}]`.
Test: `test_parse_groups_explicit_label` — `"0-3:d:Pt-surf"` →
label `"Pt-surf"`.
Test: `test_parse_groups_two_groups_semicolon` — `"0-3:d; 4,5:p"` →
2 entries.
Test: errors — missing colon, empty atoms field, empty channels field.

Impl: `parse_groups_spec(spec, nions)`:
```python
groups = []
for raw in spec.split(";"):
    s = raw.strip()
    if not s: continue
    parts = s.split(":")
    if len(parts) < 2 or len(parts) > 3:
        raise OpError(f"group spec needs 'atoms:channels[:label]', got '{s}'")
    atoms_field, channels_field = parts[0].strip(), parts[1].strip()
    if not atoms_field: raise OpError(...)
    if not channels_field: raise OpError(...)
    atoms = _parse_atom_list(atoms_field, nions)
    label = parts[2].strip() if len(parts) == 3 else f"{channels_field}@{atoms_field}"
    groups.append({"atoms": atoms, "channels": channels_field, "label": label})
if not groups:
    raise OpError("empty groups spec")
return groups
```

Default label uses the **textual** atoms field (so `"0-3:d"` →
`"d@0-3"`, not `"d@[0, 1, 2, 3]"`). Cleaner for plot legends.

Commit: `feat(cli): pdos group-spec parser [F2]`

## Task F3 — dos --groups single-group code path

Test: `test_ops_analyze.py::test_dos_groups_calls_extension_with_dict_list` —
monkeypatch `catgo_dos.pdos.compute_pdos_groups` to assert called with
the expected list of dicts. Use a fake `read_vaspout_h5` returning a
synthetic VaspData stub (mimics existing `test_dos_subprocess_*` setup
if it exists; else create the smallest stub the new code path touches).

Test: `test_dos_groups_plots_one_series_per_group` — monkeypatch
`catgo.cli.plotting.render` to capture the PlotSpec; assert len(series)
== number of groups; labels match the parsed group labels.

Test: `test_dos_groups_dump_has_groups_array` — `--dump` JSON has
`groups: [{label, atoms, channels, pdos}, ...]` and a top-level
`energy: [...]`.

Test: `test_dos_groups_message_lists_count` — message starts with
`"2 PDOS groups -> ..."` and (when any group has `d` channels) ends
with `"  (d-band centers: ...)"`.

Test: `test_dos_no_groups_unchanged` — old single-group path still
works (message has `d-band center =` form).

Impl: extend `ops_analyze.dos`:
1. After the existing setup (`ensure_extension`, `read_vaspout_h5`),
   check `params.get("groups")`. If non-empty:
   - parse via `parse_groups_spec`
   - call `compute_pdos_groups`
   - build multi-series `PlotSpec`
   - dump w/ groups schema
   - message + per-group d-band centers (only for d-containing channels)
2. Otherwise fall through to the existing code.

Commit: `feat(cli): dos --groups multi-PDOS wiring [F3]`

## Task F4 — registry + dash-flag

Test: `test_argparse.py::test_dos_groups_dash_flag_parses` —
`parse_args(["dos", "x.h5", "--groups", "0-3:d;4,5:p"])` puts the spec
string in `args.groups`.

Impl: add `Param("groups", str, default="", help="multi-group spec
'a1:c1[:l1];a2:c2[:l2];…'")` to the `dos` op.

Commit: `feat(cli): register dos --groups param [F4]`

## Task F5 — final green + shell-prompt adjustment

The shell menu prompts for every Param in order; adding `groups` means
every `dos` interactive test grows one prompt slot. Search for any
existing `dos` shell test; if present, add a blank input.

Commit: `chore(cli): final green for slice F`

## Order

F1 → F2 → F3 → F4 → F5.

Each commit standalone.
