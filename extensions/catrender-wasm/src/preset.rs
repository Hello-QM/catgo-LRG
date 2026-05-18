//! Style presets. Numeric constants are ported from xyzrender's Python
//! source (do NOT re-design the aesthetic — copy the numbers).

#[derive(Clone, Copy)]
pub enum BondStyle {
    Stick,
    Line,
    Wire,
}

#[derive(Clone, Copy)]
pub enum GradientMode {
    Radial,
    Flat,
}

#[derive(Clone, Copy)]
pub struct Preset {
    pub atom_radius_scale: f64,
    pub bond_width: f64,
    pub bond_style: BondStyle,
    pub gradient: GradientMode,
    pub outline: f64,
    pub depth_strength: f64,
}

/// Returns the named preset, falling back to `default` for unknown names.
pub fn get(name: &str) -> Preset {
    match name {
        "flat" => Preset {
            atom_radius_scale: 0.40,
            bond_width: 6.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Flat,
            outline: 1.5,
            depth_strength: 0.0,
        },
        "paton" => Preset {
            atom_radius_scale: 0.30,
            bond_width: 5.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 1.0,
            depth_strength: 0.5,
        },
        "skeletal" => Preset {
            atom_radius_scale: 0.0,
            bond_width: 4.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Flat,
            outline: 0.0,
            depth_strength: 0.0,
        },
        "bubble" => Preset {
            atom_radius_scale: 0.85,
            bond_width: 0.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Radial,
            outline: 0.0,
            depth_strength: 0.7,
        },
        "tube" => Preset {
            atom_radius_scale: 0.25,
            bond_width: 8.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 0.0,
            depth_strength: 0.6,
        },
        "wire" => Preset {
            atom_radius_scale: 0.0,
            bond_width: 2.0,
            bond_style: BondStyle::Wire,
            gradient: GradientMode::Flat,
            outline: 0.0,
            depth_strength: 0.0,
        },
        "graph" => Preset {
            atom_radius_scale: 0.18,
            bond_width: 2.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Flat,
            outline: 1.0,
            depth_strength: 0.0,
        },
        _ => Preset {
            atom_radius_scale: 0.45,
            bond_width: 5.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 1.0,
            depth_strength: 0.4,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_preset_falls_back_to_default() {
        let d = get("default");
        let u = get("nonsense-xyz");
        assert_eq!(d.atom_radius_scale, u.atom_radius_scale);
        assert_eq!(d.bond_width, u.bond_width);
    }

    #[test]
    fn skeletal_has_no_atom_spheres() {
        assert_eq!(get("skeletal").atom_radius_scale, 0.0);
    }
}
