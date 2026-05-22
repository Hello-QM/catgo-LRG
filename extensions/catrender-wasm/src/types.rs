use serde::Deserialize;

#[derive(Deserialize)]
pub struct Atom {
    pub el: String,
    pub xyz: [f64; 3],
}

#[derive(Deserialize, Clone)]
pub struct Bond {
    pub i: usize,
    pub j: usize,
    /// Raw bond order — float so aromatic (≈1.5) survives, matching
    /// xyzrender `_BondAttrs.order` (the `bond_orders` flag collapses it to
    /// 1.0 at render time, RT8 `nb_from_order`).
    #[serde(default = "one")]
    pub order: f64,
    /// Transition-state bond → rendered DASHED (xyzrender style="dashed",
    /// width `1.2·bw`, dash `1.2·bw,2.2·bw`). Mutually-exclusive with `nci`;
    /// `ts` wins if both set.
    #[serde(default)]
    pub ts: bool,
    /// Non-covalent-interaction bond → rendered DOTTED (xyzrender
    /// style="dotted", width `bw`, dash `0.08·bw,2.0·bw`).
    #[serde(default)]
    pub nci: bool,
}
fn one() -> f64 {
    1.0
}

#[derive(Deserialize, Default)]
pub struct Labels {
    #[serde(default)]
    pub distances: Vec<[usize; 2]>,
    #[serde(default)]
    pub angles: Vec<[usize; 3]>,
}

#[derive(Deserialize)]
pub struct Cell {
    #[serde(default)]
    pub show: bool,
    #[serde(default = "unit_super")]
    pub supercell: [u32; 3],
    /// Periodic *ghost*-image flag — the DISTINCT, deferred concept (tracked
    /// as RT12; see svg.rs z-order loop): opacity-dimmed PBC partner atoms
    /// wrapped across the 26 neighbour cells. Schema-plumbed and resolved
    /// today but no ghost atom is produced until RT12 wires PBC wrap-image
    /// generation. (Supercell replication above is a separate, live concept.)
    #[serde(default)]
    pub pbc_wrap: bool,
}
fn unit_super() -> [u32; 3] {
    [1, 1, 1]
}
// Manual Default so an OMITTED `style.cell` still yields a unit supercell
// (derived Default would give [0,0,0], which the svg.rs replication path
// guards against but the schema contract is "absent == 1×1×1").
impl Default for Cell {
    fn default() -> Self {
        Cell {
            show: false,
            supercell: [1, 1, 1],
            pbc_wrap: false,
        }
    }
}

/// A render-layer atom override (RT9 consumes; RT10/RT11 own the editing UI).
/// `op = "hide"` drops the atom and its incident bonds; `op = "recolor"`
/// sets a per-atom hex used as the atom fill and its gradient base.
#[derive(Deserialize, Clone)]
pub struct AtomOverride {
    pub op: String,
    pub idx: usize,
    #[serde(default)]
    pub hex: Option<String>,
}

#[derive(Deserialize)]
pub struct Style {
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "tru")]
    pub show_h: bool,
    #[serde(default)]
    pub rotation: [f64; 3],
    #[serde(default = "one_f")]
    pub scale: f64,
    #[serde(default = "tru")]
    pub depth_cue: bool,
    #[serde(default)]
    pub fog: f64,
    #[serde(default)]
    pub labels: Labels,
    #[serde(default)]
    pub cell: Cell,
    /// SVG id prefix guard — when set, every `id="`/`url(#`/`href="#`
    /// is prefixed (fixes multi-pane DOM id collisions).
    #[serde(default)]
    pub id_prefix: Option<String>,
    /// Override the preset's PCA auto-orient gate (None = inherit default ON).
    #[serde(default)]
    pub auto_orient: Option<bool>,
    /// Extra intrinsic XYZ rotation (degrees) applied AFTER PCA — the
    /// interactive drag-rotate overlay (RT11 produces this).
    #[serde(default)]
    pub drag_rotation: Option<[f64; 3]>,
    /// Run OpenBabel-style geometry bond-order perception (perceive.rs) before
    /// rendering, overriding supplied single orders. Implies bond-order
    /// rendering. Default off (slabs/ionic crystals should NOT auto-perceive).
    #[serde(default)]
    pub perceive_orders: bool,
    /// Overlay each atom's ORIGINAL index as a small label (editing aid for
    /// setting bond i/j). Default off; turn off for publication figures.
    #[serde(default)]
    pub show_index: bool,
    /// Drop bonds longer than `bond_prune_factor · (rcov_i + rcov_j)` before
    /// rendering — removes spurious over-long bonds from distance-based
    /// connectivity. Default off. Factor read from overrides "bond_prune_factor"
    /// (default 1.3).
    #[serde(default)]
    pub prune_long_bonds: bool,
    /// Hide bonds that cross a periodic-cell boundary (drawn as long lines
    /// spanning the cell to a home-cell partner). Periodic only; default off.
    #[serde(default)]
    pub hide_cross_cell_bonds: bool,
    /// Live UI knob overrides merged onto the resolved preset with
    /// `MergedConfig::apply_overrides` precedence (None/absent = inherit).
    #[serde(default)]
    pub overrides: Option<serde_json::Map<String, serde_json::Value>>,
}
fn default_preset() -> String {
    "default".into()
}
fn tru() -> bool {
    true
}
fn one_f() -> f64 {
    1.0
}

#[derive(Deserialize)]
pub struct RenderInput {
    pub atoms: Vec<Atom>,
    #[serde(default)]
    pub bonds: Vec<Bond>,
    #[serde(default)]
    pub lattice: Option<[[f64; 3]; 3]>,
    /// Render-layer atom overrides (hide / recolor), keyed by atom index.
    #[serde(default)]
    pub atom_overrides: Vec<AtomOverride>,
    pub style: Style,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_input() {
        let j = r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"flat"}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.atoms.len(), 1);
        assert_eq!(inp.style.preset, "flat");
        assert!(inp.style.show_h, "show_h defaults true");
        assert_eq!(inp.bonds.len(), 0);
    }

    #[test]
    fn bond_order_defaults_to_one() {
        let j = r#"{"atoms":[],"bonds":[{"i":0,"j":1}],"style":{}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.bonds[0].order, 1.0);
    }

    // ---- RT10: full live-override schema + Cell supercell + Bond TS/NCI ----

    #[test]
    fn bond_ts_nci_flags_default_false_and_parse() {
        let j = r#"{"atoms":[],"bonds":[
            {"i":0,"j":1},
            {"i":1,"j":2,"ts":true},
            {"i":2,"j":3,"nci":true}],"style":{}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert!(!inp.bonds[0].ts && !inp.bonds[0].nci, "default both false");
        assert!(inp.bonds[1].ts && !inp.bonds[1].nci, "ts flag parses");
        assert!(inp.bonds[2].nci && !inp.bonds[2].ts, "nci flag parses");
    }

    #[test]
    fn cell_supercell_and_pbc_parse() {
        let j = r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],
            "lattice":[[4,0,0],[0,4,0],[0,0,4]],
            "style":{"cell":{"show":true,"supercell":[2,1,1],"pbc_wrap":true}}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.style.cell.supercell, [2, 1, 1]);
        assert!(inp.style.cell.pbc_wrap);
        assert!(inp.lattice.is_some());
    }

    #[test]
    fn cell_supercell_defaults_to_unit() {
        let j = r#"{"atoms":[],"style":{"cell":{"show":true}}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.style.cell.supercell, [1, 1, 1]);
        assert!(!inp.style.cell.pbc_wrap);
    }

    #[test]
    fn open_override_map_passes_arbitrary_default_json_keys() {
        // The override map is an OPEN passthrough: the frontend may set ANY
        // default.json knob (no fixed typed subset). Parse a grab-bag.
        let j = r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{
            "preset":"default",
            "overrides":{
                "atom_scale":3.3,"bond_width":12.0,"fog_strength":0.42,
                "hue_shift_factor":0.55,"cell_color":"navy",
                "some_future_knob_not_yet_typed":true}}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        let ov = inp.style.overrides.expect("overrides present");
        assert_eq!(ov.get("atom_scale").unwrap().as_f64(), Some(3.3));
        assert_eq!(ov.get("bond_width").unwrap().as_f64(), Some(12.0));
        assert!(
            ov.contains_key("some_future_knob_not_yet_typed"),
            "arbitrary unrecognised keys survive the open map"
        );
    }

    #[test]
    fn full_knob_input_parses_and_omitted_style_defaults_populate() {
        // (b) `style` omitting all keys → serde defaults mirror preset path.
        let bare = r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{}}"#;
        let inp: RenderInput = serde_json::from_str(bare).unwrap();
        assert_eq!(inp.style.preset, "default");
        assert!(inp.style.show_h);
        assert!(inp.style.auto_orient.is_none(), "None = inherit preset");
        assert!(inp.style.overrides.is_none());
        assert_eq!(inp.style.cell.supercell, [1, 1, 1]);
        // Full-knob input incl. every Style field + overrides + atom override.
        let full = r##"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
            "bonds":[{"i":0,"j":1,"order":2.0,"ts":true}],
            "lattice":[[5,0,0],[0,5,0],[0,0,5]],
            "atom_overrides":[{"op":"recolor","idx":1,"hex":"#00ff00"}],
            "style":{"preset":"flat","show_h":false,"rotation":[10,0,0],
              "scale":1.2,"depth_cue":true,"fog":0.3,
              "labels":{"distances":[[0,1]],"angles":[]},
              "cell":{"show":true,"supercell":[2,2,1],"pbc_wrap":true},
              "id_prefix":"p1","auto_orient":false,"drag_rotation":[5,5,5],
              "overrides":{"atom_scale":2.0,"bond_orders":true}}}"##;
        let fi: RenderInput = serde_json::from_str(full).unwrap();
        assert_eq!(fi.style.preset, "flat");
        assert!(!fi.style.show_h);
        assert_eq!(fi.style.auto_orient, Some(false));
        assert_eq!(fi.style.drag_rotation, Some([5.0, 5.0, 5.0]));
        assert_eq!(fi.style.cell.supercell, [2, 2, 1]);
        assert!(fi.bonds[0].ts);
        assert_eq!(fi.atom_overrides.len(), 1);
        assert!(fi.style.overrides.unwrap().contains_key("atom_scale"));
    }
}
