//! Assemble an SVG document from projected atoms/bonds/cell.

use crate::geom::{depth_order, project};
use crate::preset::{GradientMode, Preset};
use crate::types::RenderInput;

fn cpk_color(el: &str) -> &'static str {
    match el {
        "H" => "#ffffff",
        "C" => "#303030",
        "N" => "#3050f8",
        "O" => "#ff0d0d",
        "S" => "#ffff30",
        "P" => "#ff8000",
        "F" => "#90e050",
        "Cl" => "#1ff01f",
        _ => "#b0b0b0",
    }
}

const VIEW: f64 = 600.0;

pub fn render_svg(inp: &RenderInput) -> String {
    let preset: Preset = crate::preset::get(&inp.style.preset);

    // Use explicit bonds if supplied; otherwise perceive by distance.
    let perceived;
    let bonds: &[crate::types::Bond] = if inp.bonds.is_empty() {
        perceived = crate::bonds::perceive(&inp.atoms);
        &perceived
    } else {
        &inp.bonds
    };

    let mut keep: Vec<usize> = Vec::new();
    for (i, a) in inp.atoms.iter().enumerate() {
        if !inp.style.show_h && a.el == "H" {
            continue;
        }
        keep.push(i);
    }
    let pts: Vec<[f64; 3]> = keep.iter().map(|&i| inp.atoms[i].xyz).collect();
    let projected = project(&pts, inp.style.rotation);

    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (xy, _) in &projected {
        minx = minx.min(xy[0]);
        miny = miny.min(xy[1]);
        maxx = maxx.max(xy[0]);
        maxy = maxy.max(xy[1]);
    }
    let span = ((maxx - minx).max(maxy - miny)).max(1e-6);
    let s = (VIEW * 0.8 / span) * inp.style.scale;
    let cx = (minx + maxx) / 2.0;
    let cy = (miny + maxy) / 2.0;
    let to_screen = |xy: [f64; 2]| -> (f64, f64) {
        ((xy[0] - cx) * s + VIEW / 2.0, VIEW / 2.0 - (xy[1] - cy) * s)
    };

    let mut body = String::new();

    let new_of: std::collections::HashMap<usize, usize> =
        keep.iter().enumerate().map(|(n, &o)| (o, n)).collect();
    if preset.bond_width > 0.0 {
        for b in bonds {
            let (Some(&ni), Some(&nj)) = (new_of.get(&b.i), new_of.get(&b.j)) else {
                continue;
            };
            let (x1, y1) = to_screen(projected[ni].0);
            let (x2, y2) = to_screen(projected[nj].0);
            let w = preset.bond_width;
            let n = b.order.max(1) as i32;
            for k in 0..n {
                let off = (k as f64 - (n as f64 - 1.0) / 2.0) * (w * 0.9);
                let (dx, dy) = (y2 - y1, -(x2 - x1));
                let len = (dx * dx + dy * dy).sqrt().max(1e-6);
                let (ox, oy) = (dx / len * off, dy / len * off);
                body.push_str(&format!(
                    "<line x1='{:.1}' y1='{:.1}' x2='{:.1}' y2='{:.1}' stroke='#444' stroke-width='{:.1}' stroke-linecap='round'/>",
                    x1 + ox, y1 + oy, x2 + ox, y2 + oy, w
                ));
            }
        }
    }

    let mut defs = String::new();
    for &n in depth_order(&projected).iter() {
        let a = &inp.atoms[keep[n]];
        if preset.atom_radius_scale <= 0.0 {
            continue;
        }
        let (x, y) = to_screen(projected[n].0);
        let r = crate::bonds::covalent_radius(&a.el) * preset.atom_radius_scale * s;
        let col = cpk_color(&a.el);
        let fill = match preset.gradient {
            GradientMode::Radial => {
                let gid = format!("g{n}");
                defs.push_str(&format!(
                    "<radialGradient id='{gid}' cx='35%' cy='35%' r='65%'>\
                     <stop offset='0%' stop-color='#fff'/>\
                     <stop offset='35%' stop-color='{col}'/>\
                     <stop offset='100%' stop-color='#000'/></radialGradient>"
                ));
                format!("url(#{gid})")
            }
            GradientMode::Flat => col.to_string(),
        };
        let stroke = if preset.outline > 0.0 {
            format!(" stroke='#000' stroke-width='{:.1}'", preset.outline)
        } else {
            String::new()
        };
        body.push_str(&format!(
            "<circle cx='{x:.1}' cy='{y:.1}' r='{r:.1}' fill='{fill}'{stroke}/>"
        ));
    }

    for d in &inp.style.labels.distances {
        if let (Some(&ni), Some(&nj)) = (new_of.get(&d[0]), new_of.get(&d[1])) {
            let pa = inp.atoms[keep[ni]].xyz;
            let pb = inp.atoms[keep[nj]].xyz;
            let dist = ((pa[0] - pb[0]).powi(2)
                + (pa[1] - pb[1]).powi(2)
                + (pa[2] - pb[2]).powi(2))
            .sqrt();
            let (x1, y1) = to_screen(projected[ni].0);
            let (x2, y2) = to_screen(projected[nj].0);
            body.push_str(&format!(
                "<text x='{:.1}' y='{:.1}' font-size='14' fill='#222' text-anchor='middle'>{:.2} Å</text>",
                (x1 + x2) / 2.0,
                (y1 + y2) / 2.0,
                dist
            ));
        }
    }

    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {VIEW} {VIEW}' width='{VIEW}' height='{VIEW}'><defs>{defs}</defs>{body}</svg>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RenderInput;

    fn parse(j: &str) -> RenderInput {
        serde_json::from_str(j).unwrap()
    }

    #[test]
    fn emits_well_formed_svg_with_atom() {
        let inp = parse(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{}}"#);
        let svg = render_svg(&inp);
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("<circle"));
    }

    #[test]
    fn skeletal_emits_no_circle() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert!(!svg.contains("<circle"), "skeletal draws no spheres");
        assert!(svg.contains("<line"), "skeletal still draws bonds");
    }

    #[test]
    fn hidden_hydrogen_is_dropped() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"H","xyz":[1,0,0]}],"style":{"show_h":false}}"#,
        );
        let svg = render_svg(&inp);
        assert_eq!(svg.matches("<circle").count(), 1);
    }

    #[test]
    fn empty_atoms_emits_valid_empty_svg() {
        let inp = parse(r#"{"atoms":[],"style":{}}"#);
        let svg = render_svg(&inp);
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        assert!(!svg.contains("<circle"));
    }

    #[test]
    fn auto_bonds_drawn_when_no_explicit_bonds() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert!(svg.contains("<line"), "auto-perceived bond should render");
    }

    #[test]
    fn double_bond_emits_two_lines() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1,"order":2}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert_eq!(svg.matches("<line").count(), 2);
    }
}
