use serde::Deserialize;

#[derive(Deserialize)]
pub struct Atom {
    pub el: String,
    pub xyz: [f64; 3],
}

#[derive(Deserialize)]
pub struct Bond {
    pub i: usize,
    pub j: usize,
    /// Raw bond order — float so aromatic (≈1.5) survives, matching
    /// xyzrender `_BondAttrs.order` (the `bond_orders` flag collapses it to
    /// 1.0 at render time, RT8 `nb_from_order`).
    #[serde(default = "one")]
    pub order: f64,
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

#[derive(Deserialize, Default)]
pub struct Cell {
    #[serde(default)]
    pub show: bool,
    #[serde(default = "unit_super")]
    pub supercell: [u32; 3],
    #[serde(default)]
    pub pbc_wrap: bool,
}
fn unit_super() -> [u32; 3] {
    [1, 1, 1]
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
}
