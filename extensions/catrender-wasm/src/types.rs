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
    #[serde(default = "one")]
    pub order: u8,
}
fn one() -> u8 {
    1
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
        assert_eq!(inp.bonds[0].order, 1);
    }
}
