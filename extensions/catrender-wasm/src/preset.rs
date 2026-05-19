//! Style presets — the 12 xyzrender preset JSONs embedded **verbatim** plus
//! xyzrender's deep-merge-onto-`default.json` semantics.
//!
//! Ground truth: `src/xyzrender/presets/*.json` + `src/xyzrender/config.py`
//! (`_merge_onto_default`, `load_config`, `build_render_config` key renames,
//! `_PASSTHROUGH_COLORS`). There are exactly 12 preset files (`default` is the
//! base + 11 named override sets). `named_colors.json` is a CSS-name lookup
//! table, not a preset, and is excluded — matching `load_config`'s own glob
//! filter (`p.stem != "named_colors"`).
//!
//! Merge rule (`_merge_onto_default`): deep-copy `default.json`; for each
//! override key, if BOTH `base[k]` and `v` are JSON objects → one-level
//! `base[k].update(v)` (override's inner keys merged in, NOT recursive); else
//! `base[k] = v` (wholesale replace). Unknown preset name → fall back to
//! `default` (xyzrender raises `FileNotFoundError`; per plan RT4 we fall back).
//!
//! After merge we apply `build_render_config`'s JSON-key→field renames
//! (`mo_iso→mo_isovalue`, …, `colors→color_overrides`, `radius_scale`→
//! (selector,factor) list, `regions`→`region_specs`) and run every color-valued
//! field through [`crate::palette::resolve_color`] (skipping the `"atom"`
//! passthrough marker and non-color fields), exactly as config.py does.

use crate::palette::resolve_color;
use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// Embedded preset JSONs — VERBATIM file contents of
// xyzrender `src/xyzrender/presets/<name>.json`.
// ---------------------------------------------------------------------------

pub const DEFAULT_JSON: &str = include_str!("presets/default.json");
pub const FLAT_JSON: &str = include_str!("presets/flat.json");
pub const PATON_JSON: &str = include_str!("presets/paton.json");
pub const SKELETAL_JSON: &str = include_str!("presets/skeletal.json");
pub const BUBBLE_JSON: &str = include_str!("presets/bubble.json");
pub const TUBE_JSON: &str = include_str!("presets/tube.json");
pub const MTUBE_JSON: &str = include_str!("presets/mtube.json");
pub const BTUBE_JSON: &str = include_str!("presets/btube.json");
pub const WIRE_JSON: &str = include_str!("presets/wire.json");
pub const GRAPH_JSON: &str = include_str!("presets/graph.json");
pub const PMOL_JSON: &str = include_str!("presets/pmol.json");
pub const OVERLAY_JSON: &str = include_str!("presets/overlay.json");

/// All built-in preset names (12 total: `default` + 11 override sets),
/// in the same order `sorted(_PRESET_DIR.glob("*.json"))` yields them
/// (alphabetical, `named_colors` excluded).
pub const PRESET_NAMES: &[&str] = &[
    "btube", "bubble", "default", "flat", "graph", "mtube", "overlay", "paton",
    "pmol", "skeletal", "tube", "wire",
];

/// Raw (un-merged, un-renamed) JSON text for a named preset.
fn preset_json(name: &str) -> Option<&'static str> {
    Some(match name {
        "default" => DEFAULT_JSON,
        "flat" => FLAT_JSON,
        "paton" => PATON_JSON,
        "skeletal" => SKELETAL_JSON,
        "bubble" => BUBBLE_JSON,
        "tube" => TUBE_JSON,
        "mtube" => MTUBE_JSON,
        "btube" => BTUBE_JSON,
        "wire" => WIRE_JSON,
        "graph" => GRAPH_JSON,
        "pmol" => PMOL_JSON,
        "overlay" => OVERLAY_JSON,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// MergedConfig — serde_json::Map-backed; the resolved preset bundle the
// `Style` builder consumes.
// ---------------------------------------------------------------------------

/// A fully merged + renamed + color-resolved preset configuration.
///
/// Backed by a `serde_json::Map<String, Value>`; typed getters mirror the
/// fields the renderer / `Style` builder needs.
#[derive(Clone, Debug)]
pub struct MergedConfig {
    map: Map<String, Value>,
}

impl MergedConfig {
    /// Borrow the underlying JSON object.
    pub fn as_map(&self) -> &Map<String, Value> {
        &self.map
    }

    /// Raw value lookup. Supports one level of `"a.b"` dotted access into a
    /// nested object (e.g. `"color_overrides.C"`, `"colors.C"`).
    pub fn get(&self, key: &str) -> Option<&Value> {
        if let Some((head, tail)) = key.split_once('.') {
            // Accept the JSON key alias "colors" for the renamed
            // "color_overrides" so tests/UI can address either.
            let head = if head == "colors" && !self.map.contains_key("colors") {
                "color_overrides"
            } else {
                head
            };
            return self.map.get(head)?.as_object()?.get(tail);
        }
        let key = if key == "colors" && !self.map.contains_key("colors") {
            "color_overrides"
        } else {
            key
        };
        self.map.get(key)
    }

    /// Float getter. Accepts JSON numbers (int or float). Panics if the key is
    /// absent or not numeric — callers use known keys.
    pub fn get_f(&self, key: &str) -> f64 {
        self.get(key)
            .and_then(Value::as_f64)
            .unwrap_or_else(|| panic!("MergedConfig::get_f: {key:?} missing or non-numeric"))
    }

    /// Optional float getter (`None` = absent / null = inherit).
    pub fn get_f_opt(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(Value::as_f64)
    }

    /// Bool getter. Panics if absent or non-bool.
    pub fn get_b(&self, key: &str) -> bool {
        self.get(key)
            .and_then(Value::as_bool)
            .unwrap_or_else(|| panic!("MergedConfig::get_b: {key:?} missing or non-bool"))
    }

    /// Optional bool getter.
    pub fn get_b_opt(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Value::as_bool)
    }

    /// String getter (color/text fields). Panics if absent or non-string.
    pub fn get_s(&self, key: &str) -> &str {
        self.get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("MergedConfig::get_s: {key:?} missing or non-string"))
    }

    /// Optional string getter.
    pub fn get_s_opt(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// Whether a key is present (and not JSON `null`).
    pub fn has(&self, key: &str) -> bool {
        self.get(key).map(|v| !v.is_null()).unwrap_or(false)
    }

    /// Apply a UI/CLI override layer with xyzrender `build_render_config`
    /// precedence: only explicitly-set (non-`None`) values win; `None`/absent
    /// = inherit (dataclass < default.json < preset < explicit slider).
    ///
    /// `null` values in `overrides` are treated as "unset" (inherit), matching
    /// `build_render_config`'s `if v is not None` filter. Color-valued keys are
    /// run through `resolve_color`, and the `colors`/`radius_scale`/`regions`
    /// renames are re-applied so a UI may pass either the JSON key or the
    /// renamed field.
    pub fn apply_overrides(&mut self, overrides: &Map<String, Value>) {
        for (k, v) in overrides {
            if v.is_null() {
                continue; // None = inherit
            }
            self.map.insert(k.clone(), v.clone());
        }
        // normalize is idempotent — safe to re-run after override insert:
        // renames already applied (old keys gone), resolve_color is stable on
        // already-lowercased hex, radius_scale/regions already transformed.
        normalize(&mut self.map);
    }
}

// ---------------------------------------------------------------------------
// load — the public entry point.
// ---------------------------------------------------------------------------

/// Load a built-in preset, merged onto `default.json` with xyzrender
/// `_merge_onto_default` semantics, then renamed + color-resolved.
///
/// - `"default"` → `default.json` as-is (it IS the base).
/// - known name → `_merge_onto_default(overrides)` (one-level object update).
/// - unknown name → falls back to `default` (plan RT4
///   `unknown_falls_back_to_default`).
pub fn load(name: &str) -> MergedConfig {
    let default: Map<String, Value> = serde_json::from_str::<Value>(DEFAULT_JSON)
        .expect("default.json is valid JSON")
        .as_object()
        .expect("default.json is a JSON object")
        .clone();

    let mut merged = if name == "default" {
        default
    } else if let Some(raw) = preset_json(name) {
        let overrides: Map<String, Value> = serde_json::from_str::<Value>(raw)
            .unwrap_or_else(|e| panic!("{name}.json invalid JSON: {e}"))
            .as_object()
            .unwrap_or_else(|| panic!("{name}.json must be a JSON object"))
            .clone();
        merge_onto_default(default, &overrides)
    } else {
        // Unknown name → fall back to default (xyzrender raises; plan RT4
        // requires graceful fallback).
        default
    };

    normalize(&mut merged);
    MergedConfig { map: merged }
}

/// xyzrender `_merge_onto_default`: for each override key, if BOTH `base[k]`
/// and `v` are JSON objects → one-level `base[k].update(v)` (NOT recursive);
/// otherwise `base[k] = v` (wholesale replace, incl. arrays/scalars/null).
fn merge_onto_default(mut base: Map<String, Value>, overrides: &Map<String, Value>) -> Map<String, Value> {
    for (k, v) in overrides {
        let both_objects = v.is_object() && base.get(k).map(Value::is_object).unwrap_or(false);
        if both_objects {
            // One-level dict.update(): override's inner keys merged into the
            // base's inner object; pre-existing base inner keys NOT touched
            // unless the override also names them.
            let dst = base.get_mut(k).unwrap().as_object_mut().unwrap();
            for (ik, iv) in v.as_object().unwrap() {
                dst.insert(ik.clone(), iv.clone());
            }
        } else {
            base.insert(k.clone(), v.clone());
        }
    }
    base
}

// ---------------------------------------------------------------------------
// normalize — config.py `build_render_config` JSON→field renames + color
// resolution. Applied AFTER the merge so it sees the final value of every key.
// ---------------------------------------------------------------------------

/// Color-valued top-level fields (config.py `_color_fields`).
const COLOR_FIELDS: &[&str] = &[
    "background",
    "bond_color",
    "bond_outline_color",
    "ts_color",
    "nci_color",
    "atom_stroke_color",
    "label_color",
    "cmap_unlabeled",
    "cell_color",
    "mo_pos_color",
    "mo_neg_color",
    "dens_color",
    "mol_color",
];

fn resolve_in_place(map: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(s)) = map.get(key) {
        // _PASSTHROUGH_COLORS = {"atom"} left untouched; resolve_color itself
        // also passes "atom" through, so this is doubly safe.
        let resolved = resolve_color(s);
        map.insert(key.to_string(), Value::String(resolved));
    }
}

/// Apply config.py `build_render_config` transforms: key renames, the
/// `colors`→`color_overrides` (resolved) rename, color-field resolution,
/// `axis_colors`/`hull_colors`/`highlight_colors` resolution, `radius_scale`
/// dict→list, `regions`→`region_specs`, nested `overlay` color resolution.
fn normalize(map: &mut Map<String, Value>) {
    // regions → region_specs (extracted before RenderConfig in config.py)
    if let Some(regions) = map.remove("regions") {
        if !regions.is_null() {
            map.insert("region_specs".to_string(), regions);
        }
    }

    // "colors" → "color_overrides", each value through resolve_color
    if let Some(Value::Object(colors)) = map.remove("colors") {
        let mut resolved = Map::new();
        for (sym, c) in colors {
            if let Value::String(cs) = &c {
                resolved.insert(sym, Value::String(resolve_color(cs)));
            } else {
                resolved.insert(sym, c);
            }
        }
        map.insert("color_overrides".to_string(), Value::Object(resolved));
    }

    // JSON key → RenderConfig field renames (config.py rename table)
    for (old, new) in [
        ("mo_iso", "mo_isovalue"),
        ("mo_blur", "mo_blur_sigma"),
        ("mo_upsample", "mo_upsample_factor"),
        ("dens_iso", "dens_isovalue"),
        ("nci_iso", "nci_isovalue"),
    ] {
        if let Some(v) = map.remove(old) {
            map.insert(new.to_string(), v);
        }
    }

    // Resolve top-level color fields
    for f in COLOR_FIELDS {
        resolve_in_place(map, f);
    }

    // nci_mode: a mode name OR a color — resolve only if it's a color
    if let Some(Value::String(m)) = map.get("nci_mode") {
        if !matches!(m.as_str(), "avg" | "pixel" | "uniform") {
            let r = resolve_color(m);
            map.insert("nci_mode".to_string(), Value::String(r));
        }
    }

    // axis_colors: list[str] → resolved (config.py makes a tuple; JSON has no
    // tuple — keep as array of resolved hex)
    if let Some(Value::Array(arr)) = map.get("axis_colors") {
        let resolved: Vec<Value> = arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Value::String(resolve_color(s)),
                other => other.clone(),
            })
            .collect();
        map.insert("axis_colors".to_string(), Value::Array(resolved));
    }

    // hull_colors: list[str] → resolved
    if let Some(Value::Array(arr)) = map.get("hull_colors") {
        let resolved: Vec<Value> = arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Value::String(resolve_color(s)),
                other => other.clone(),
            })
            .collect();
        map.insert("hull_colors".to_string(), Value::Array(resolved));
    }

    // highlight_color (legacy single) → highlight_colors[1]
    if let Some(old) = map.remove("highlight_color") {
        if let Value::String(s) = &old {
            if !map.contains_key("highlight_colors") {
                map.insert(
                    "highlight_colors".to_string(),
                    Value::Array(vec![Value::String(resolve_color(s))]),
                );
            }
        }
    }
    // highlight_colors: list[str] → resolved
    if let Some(Value::Array(arr)) = map.get("highlight_colors") {
        let resolved: Vec<Value> = arr
            .iter()
            .map(|v| match v {
                Value::String(s) => Value::String(resolve_color(s)),
                other => other.clone(),
            })
            .collect();
        map.insert("highlight_colors".to_string(), Value::Array(resolved));
    }

    // radius_scale: JSON dict {"H":1.2,...} → list of [selector, factor] pairs
    if let Some(Value::Object(rs)) = map.get("radius_scale").cloned() {
        let pairs: Vec<Value> = rs
            .into_iter()
            .map(|(sel, factor)| json!([sel, factor]))
            .collect();
        map.insert("radius_scale".to_string(), Value::Array(pairs));
    }

    // overlay block: resolve its color fields (config.py
    // _resolve_color_fields over ("color","atom_stroke_color","bond_color",
    // "bond_outline_color"))
    if let Some(Value::Object(mut ov)) = map.remove("overlay") {
        for f in ["color", "atom_stroke_color", "bond_color", "bond_outline_color"] {
            resolve_in_place(&mut ov, f);
        }
        map.insert("overlay".to_string(), Value::Object(ov));
    }
}

// ---------------------------------------------------------------------------
// Tests — plan RT4 block, adapted to the real accessor names and the REAL
// resolved color values (see discrepancy note in the RT4 report).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_base() {
        let c = load("default");
        assert_eq!(c.get_f("atom_scale"), 2.5);
        assert_eq!(c.get_f("bond_width"), 20.0);
        assert_eq!(c.get_b("gradient"), true);
        // default.json has "colors":{"C":"#AAAAAA"}; config.py runs every
        // color through resolve_color, which LOWERCASES 6-digit hex. The plan
        // wrote "#AAAAAA" but the REAL resolved value (JSON + resolve_color =
        // ground truth) is "#aaaaaa". Asserting the real value.
        assert_eq!(c.get_s("colors.C"), "#aaaaaa"); // resolve_color applied
        assert_eq!(c.get_s("color_overrides.C"), "#aaaaaa"); // renamed field
    }

    #[test]
    fn flat_merges_onto_default() {
        let c = load("flat");
        assert_eq!(c.get_b("gradient"), false); // flat override
        assert_eq!(c.get_f("bond_width"), 20.0); // inherited from default
        // flat also overrides these scalars wholesale
        assert_eq!(c.get_f("vdw_opacity"), 0.3);
        assert_eq!(c.get_f("vdw_gradient_strength"), 0.5);
        // untouched default scalar still present
        assert_eq!(c.get_f("atom_scale"), 2.5);
    }

    #[test]
    fn paton_colors_deep_merge() {
        let c = load("paton");
        // default colors only had C; paton's colors object is one-level
        // dict.update()'d onto it → C replaced, H/N added.
        assert_eq!(c.get_s("colors.C"), "#d9d9d9"); // paton (lowercased)
        assert_eq!(c.get_s("colors.H"), "#fafafa"); // paton-added
        assert_eq!(c.get_s("colors.N"), "#7f7fbf"); // paton-added
        // paton scalar overrides
        assert_eq!(c.get_f("atom_stroke_width"), 3.0);
        assert_eq!(c.get_b("bond_orders"), false);
        // inherited from default
        assert_eq!(c.get_f("bond_width"), 20.0);
        assert_eq!(c.get_b("gradient"), true);
    }

    #[test]
    fn unknown_falls_back_to_default() {
        assert_eq!(
            load("nope").get_f("atom_scale"),
            load("default").get_f("atom_scale")
        );
        assert_eq!(load("nope").get_b("gradient"), load("default").get_b("gradient"));
    }

    #[test]
    fn key_renames_applied() {
        let c = load("default");
        // mo_iso → mo_isovalue, etc. — old keys gone, new present
        assert!(c.get("mo_iso").is_none());
        assert_eq!(c.get_f("mo_isovalue"), 0.05);
        assert_eq!(c.get_f("mo_blur_sigma"), 0.8);
        assert_eq!(c.get_f("mo_upsample_factor"), 3.0);
        assert_eq!(c.get_f("dens_isovalue"), 0.001);
        assert_eq!(c.get_f("nci_isovalue"), 0.3);
    }

    #[test]
    fn color_field_resolution() {
        let c = load("default");
        // "black"/"white"/"gray" CSS names resolved to hex
        assert_eq!(c.get_s("bond_color"), "#000000");
        assert_eq!(c.get_s("background"), "#ffffff");
        assert_eq!(c.get_s("cell_color"), "#808080");
        assert_eq!(c.get_s("label_color"), "#222222"); // already hex, lowercased
        // axis_colors list resolved
        let ax = c.get("axis_colors").unwrap().as_array().unwrap();
        assert_eq!(ax[0].as_str().unwrap(), "#b22222"); // firebrick
    }

    #[test]
    fn graph_atom_passthrough_marker_preserved() {
        let c = load("graph");
        // atom_stroke_color "atom" is a _PASSTHROUGH_COLORS marker — NOT
        // resolved (renderer uses per-element fill).
        assert_eq!(c.get_s("atom_stroke_color"), "atom");
        // graph colors deep-merged onto default's {C} (C replaced + others)
        assert_eq!(c.get_s("colors.C"), "#202124");
        assert_eq!(c.get_s("colors.O"), "#c458a5");
    }

    #[test]
    fn btube_radius_scale_dict_to_list() {
        let c = load("btube");
        let rs = c.get("radius_scale").unwrap().as_array().unwrap();
        assert_eq!(rs.len(), 1);
        let pair = rs[0].as_array().unwrap();
        assert_eq!(pair[0].as_str().unwrap(), "H");
        assert_eq!(pair[1].as_f64().unwrap(), 1.2);
    }

    #[test]
    fn mtube_regions_to_region_specs() {
        let c = load("mtube");
        assert!(c.get("regions").is_none());
        let rs = c.get("region_specs").unwrap().as_object().unwrap();
        let m = rs.get("M").unwrap().as_object().unwrap();
        assert_eq!(m.get("atom_scale").unwrap().as_f64().unwrap(), 4.0);
        assert_eq!(m.get("gradient").unwrap().as_bool().unwrap(), true);
        // mtube scalar override + inherited
        assert_eq!(c.get_f("bond_width"), 50.0);
        assert_eq!(c.get_s("bond_color"), "#606060");
    }

    #[test]
    fn overlay_block_color_resolved() {
        let c = load("overlay");
        let ov = c.get("overlay").unwrap().as_object().unwrap();
        // "teal" → #008080 (overlay block color resolution)
        assert_eq!(ov.get("color").unwrap().as_str().unwrap(), "#008080");
        assert_eq!(ov.get("atom_scale").unwrap().as_f64().unwrap(), 1.2);
        assert_eq!(c.get_b("auto_align"), false);
    }

    #[test]
    fn apply_overrides_precedence_and_inherit() {
        let mut c = load("default");
        let mut ov = serde_json::Map::new();
        ov.insert("atom_scale".to_string(), json!(9.0)); // explicit wins
        ov.insert("bond_width".to_string(), Value::Null); // None = inherit
        c.apply_overrides(&ov);
        assert_eq!(c.get_f("atom_scale"), 9.0);
        assert_eq!(c.get_f("bond_width"), 20.0); // inherited (null skipped)
    }

    #[test]
    fn all_twelve_presets_load() {
        for name in PRESET_NAMES {
            let c = load(name);
            // every preset inherits atom_scale (either default 2.5 or override)
            assert!(c.get_f_opt("atom_scale").is_some(), "{name} missing atom_scale");
        }
        assert_eq!(PRESET_NAMES.len(), 12);
    }

    #[test]
    #[should_panic]
    fn get_f_missing_required_key_panics() {
        let _ = load("default").get_f("definitely_absent_key");
    }

    #[test]
    fn dotted_missing_intermediate_is_none_not_panic() {
        assert!(load("default").get_s_opt("nope.C").is_none());
    }
}
