//! HLS color math — xyzrender-exact.
//!
//! Replicates Python `colorsys` HLS conversion plus xyzrender's `Color`
//! `lighten`/`darken`/`blend`/`blend_fog`/`get_gradient_colors`.
//!
//! Fidelity rules (must reproduce Python bit-for-bit):
//! - `to_hls`: `colorsys.rgb_to_hls` returns `(H, L, S)`; xyzrender scales `H` to `0..360`.
//! - `from_hls`: `colorsys.hls_to_rgb((h%360)/360, l, s)` then `int(x*255)` — **floor**, not round.
//! - `blend`: per channel `int(a + t*(b-a))` then clamp 0..255 — floor.
//! - `darken`: lightness `l*(1 - light*str*3)` (note the **×3**), clamp01.
//! - `blend_fog`: `s=min(strength**2, 0.70)`; `(1-s)*rgb + s*fog`; `np.clip(...).astype(int)` — truncate.

/// RGB color, 0-255 per channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Color {
    pub fn new(r: u8, g: u8, b: u8) -> Self {
        Color { r, g, b }
    }

    /// Lowercase `#rrggbb`.
    pub fn hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    /// Parse `#rrggbb` or `#rgb` (also without leading `#`). Pure RGB hex only.
    pub fn from_hex(hex: &str) -> Color {
        let h = hex.trim().trim_start_matches('#');
        if h.len() == 3 {
            let f = |c: char| {
                let v = c.to_digit(16).unwrap_or(0) as u8;
                v * 16 + v
            };
            let mut it = h.chars();
            let r = f(it.next().unwrap_or('0'));
            let g = f(it.next().unwrap_or('0'));
            let b = f(it.next().unwrap_or('0'));
            Color { r, g, b }
        } else {
            let p = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
            Color {
                r: p(0),
                g: p(2),
                b: p(4),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Python colorsys replication
// ---------------------------------------------------------------------------

/// `colorsys.rgb_to_hls` then xyzrender's `H * 360`.
/// Input channels are u8; returns `(hue 0..360, lightness 0..1, saturation 0..1)`.
pub fn rgb_to_hls(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;
    let maxc = r.max(g).max(b);
    let minc = r.min(g).min(b);
    let sumc = maxc + minc;
    let rangec = maxc - minc;
    let l = sumc / 2.0;
    if minc == maxc {
        return (0.0, l, 0.0);
    }
    let s = if l <= 0.5 {
        rangec / sumc
    } else {
        rangec / (2.0 - maxc - minc)
    };
    let rc = (maxc - r) / rangec;
    let gc = (maxc - g) / rangec;
    let bc = (maxc - b) / rangec;
    let mut h = if r == maxc {
        bc - gc
    } else if g == maxc {
        2.0 + rc - bc
    } else {
        4.0 + gc - rc
    };
    h = (h / 6.0).rem_euclid(1.0);
    (h * 360.0, l, s)
}

fn _v(m1: f64, m2: f64, hue: f64) -> f64 {
    let hue = hue.rem_euclid(1.0);
    if hue < 1.0 / 6.0 {
        m1 + (m2 - m1) * hue * 6.0
    } else if hue < 0.5 {
        m2
    } else if hue < 2.0 / 3.0 {
        m1 + (m2 - m1) * (2.0 / 3.0 - hue) * 6.0
    } else {
        m1
    }
}

/// `colorsys.hls_to_rgb((h%360)/360, l, s)` then `int(x*255)` (**floor**, clamped 0..255).
pub fn hls_to_rgb(h: f64, l: f64, s: f64) -> (u8, u8, u8) {
    let h = h.rem_euclid(360.0) / 360.0;
    let floor_u8 = |x: f64| (x * 255.0).clamp(0.0, 255.0).floor() as u8;
    if s == 0.0 {
        let v = floor_u8(l);
        return (v, v, v);
    }
    let m2 = if l <= 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let m1 = 2.0 * l - m2;
    (
        floor_u8(_v(m1, m2, h + 1.0 / 3.0)),
        floor_u8(_v(m1, m2, h)),
        floor_u8(_v(m1, m2, h - 1.0 / 3.0)),
    )
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

impl Color {
    fn from_hls(h: f64, l: f64, s: f64) -> Color {
        let (r, g, b) = hls_to_rgb(h, l, s);
        Color { r, g, b }
    }

    fn to_hls(self) -> (f64, f64, f64) {
        rgb_to_hls(self.r, self.g, self.b)
    }

    /// Lerp toward `other` by `t` (0=self, 1=other); per channel `int(a+t*(b-a))` floor, clamp 0..255.
    pub fn blend(&self, other: &Color, t: f64) -> Color {
        let ch = |a: u8, b: u8| -> u8 {
            let v = (a as f64 + t * (b as f64 - a as f64)) as i64; // `as i64` truncates toward zero
            v.clamp(0, 255) as u8
        };
        Color {
            r: ch(self.r, other.r),
            g: ch(self.g, other.g),
            b: ch(self.b, other.b),
        }
    }

    /// Lighten toward yellow (60°), scaled by `strength`.
    pub fn lighten(
        &self,
        strength: f64,
        hue_shift_factor: f64,
        light_shift_factor: f64,
        saturation_shift_factor: f64,
    ) -> Color {
        let (h, l, s) = self.to_hls();
        let new_l = clamp01(l + light_shift_factor * strength * (1.0 - l));
        let d = ((60.0 - h + 180.0).rem_euclid(360.0)) - 180.0;
        let new_h = (h + d * hue_shift_factor * strength).rem_euclid(360.0);
        let new_s = clamp01(s * (1.0 - saturation_shift_factor * strength));
        Color::from_hls(new_h, new_l, new_s)
    }

    /// Darken toward blue (240°), scaled by `strength`. Note the **×3** on lightness.
    pub fn darken(
        &self,
        strength: f64,
        hue_shift_factor: f64,
        light_shift_factor: f64,
        saturation_shift_factor: f64,
    ) -> Color {
        let (h, l, s) = self.to_hls();
        let new_l = clamp01(l * (1.0 - light_shift_factor * strength * 3.0));
        let d = ((240.0 - h + 180.0).rem_euclid(360.0)) - 180.0;
        let new_h = (h + d * hue_shift_factor * strength).rem_euclid(360.0);
        let new_s = clamp01(s + (1.0 - s) * saturation_shift_factor * strength);
        Color::from_hls(new_h, new_l, new_s)
    }

    /// `(lighten, base, darken)` triplet for radial/linear gradients.
    pub fn get_gradient_colors(
        &self,
        strength: f64,
        hue_shift_factor: f64,
        light_shift_factor: f64,
        saturation_shift_factor: f64,
    ) -> (Color, Color, Color) {
        (
            self.lighten(
                strength,
                hue_shift_factor,
                light_shift_factor,
                saturation_shift_factor,
            ),
            *self,
            self.darken(
                strength,
                hue_shift_factor,
                light_shift_factor,
                saturation_shift_factor,
            ),
        )
    }

    /// Blend toward fog: `s=min(strength^2, 0.70)`; `(1-s)*rgb + s*fog`; truncate to int.
    pub fn blend_fog(&self, fog: (u8, u8, u8), strength: f64) -> Color {
        let s = (strength * strength).min(0.70);
        let mix = |c: u8, f: u8| -> u8 {
            let v = (1.0 - s) * c as f64 + s * f as f64;
            // np.clip(...).astype(int) — clamp then truncate toward zero
            v.clamp(0.0, 255.0) as i64 as u8
        };
        Color {
            r: mix(self.r, fog.0),
            g: mix(self.g, fog.1),
            b: mix(self.b, fog.2),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — every expected value produced by the real cloned xyzrender.
// Clone: /tmp/xyzr_atoms/src/xyzrender/colors.py (github.com/aligfellow/xyzrender)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip_and_short_form() {
        assert_eq!(Color::from_hex("#909090").hex(), "#909090");
        assert_eq!(Color::from_hex("909090"), Color::new(144, 144, 144));
        assert_eq!(Color::from_hex("#abc"), Color::new(0xaa, 0xbb, 0xcc));
    }

    // HLS round-trip exposes the floor truncation in `from_hls` (`int(x*255)`).
    // python: cc=Color.from_hex(hx); h,l,s=cc.to_hls(); print(Color.from_hls(h,l,s).hex)
    #[test]
    fn hls_roundtrip_floor_truncation() {
        // #909090 -> #909090
        let c = Color::from_hex("#909090");
        let (h, l, s) = c.to_hls();
        assert_eq!(Color::from_hls(h, l, s).hex(), "#909090");
        // #ff0d0d -> #fe0d0d   (floor, NOT round: 254 not 255)
        let c = Color::from_hex("#ff0d0d");
        let (h, l, s) = c.to_hls();
        assert_eq!(Color::from_hls(h, l, s), Color::new(254, 13, 13));
        // #3050f8 -> #2f4ff8
        let c = Color::from_hex("#3050f8");
        let (h, l, s) = c.to_hls();
        assert_eq!(Color::from_hls(h, l, s), Color::new(47, 79, 248));
        // #abcdef -> #abccee
        let c = Color::from_hex("#abcdef");
        let (h, l, s) = c.to_hls();
        assert_eq!(Color::from_hls(h, l, s), Color::new(171, 204, 238));
        // #123456 -> #113356
        let c = Color::from_hex("#123456");
        let (h, l, s) = c.to_hls();
        assert_eq!(Color::from_hls(h, l, s), Color::new(17, 51, 86));
    }

    // python: c=Color.from_hex('#909090')
    //   c.lighten(strength=1.0,hue_shift_factor=0.1,light_shift_factor=0.15,saturation_shift_factor=0.15).hex -> '#a0a0a0'
    //   c.darken (strength=1.0,hue_shift_factor=0.1,light_shift_factor=0.15,saturation_shift_factor=0.15).hex -> '#5b4348'
    #[test]
    fn lighten_darken_gray_909090() {
        let c = Color::from_hex("#909090");
        assert_eq!(c.lighten(1.0, 0.1, 0.15, 0.15).hex(), "#a0a0a0");
        assert_eq!(c.darken(1.0, 0.1, 0.15, 0.15), Color::new(91, 67, 72));
    }

    // python: o=Color.from_hex('#ff0d0d')
    //   o.lighten(strength=1.0,hue_shift_factor=0.2,light_shift_factor=0.2,saturation_shift_factor=0.2).hex -> '#eb6f50'
    //   o.darken (strength=1.0,hue_shift_factor=0.2,light_shift_factor=0.2,saturation_shift_factor=0.2).hex -> '#6b002a'
    #[test]
    fn lighten_darken_saturated_red_ff0d0d() {
        let o = Color::from_hex("#ff0d0d");
        assert_eq!(o.lighten(1.0, 0.2, 0.2, 0.2).hex(), "#eb6f50");
        assert_eq!(o.darken(1.0, 0.2, 0.2, 0.2).hex(), "#6b002a");
    }

    // python: n=Color.from_hex('#3050f8')
    //   n.lighten(strength=0.5,hue_shift_factor=0.2,light_shift_factor=0.2,saturation_shift_factor=0.2).hex -> '#4d95ef'
    //   n.darken (strength=0.5,hue_shift_factor=0.2,light_shift_factor=0.2,saturation_shift_factor=0.2).hex -> '#0622c9'
    #[test]
    fn lighten_darken_blue_3050f8_strength_half() {
        let n = Color::from_hex("#3050f8");
        assert_eq!(n.lighten(0.5, 0.2, 0.2, 0.2).hex(), "#4d95ef");
        assert_eq!(n.darken(0.5, 0.2, 0.2, 0.2).hex(), "#0622c9");
    }

    // python: a=Color(100,100,100); b=Color(200,50,255)
    //   a.blend(b,0.5).hex -> '#964bb1' (150,75,177)
    //   a.blend(b,0.3).hex -> '#825592'
    //   a.blend(b,1.5).hex -> '#fa19ff'  (overshoot clamps to 0..255)
    #[test]
    fn blend_floor_and_clamp() {
        let a = Color::new(100, 100, 100);
        let b = Color::new(200, 50, 255);
        assert_eq!(a.blend(&b, 0.5), Color::new(150, 75, 177));
        assert_eq!(a.blend(&b, 0.3).hex(), "#825592");
        assert_eq!(a.blend(&b, 1.5).hex(), "#fa19ff");
    }

    // python (numpy fog):
    //   blend_fog('#ff0d0d', [255,255,255], 1.0) -> '#ffb6b6'  (strength**2=1 capped to 0.70)
    //   blend_fog('#909090', [255,255,255], 0.5) -> '#ababab'  (s=0.25)
    //   blend_fog('#3050f8', [10,20,30],   0.9) -> '#15265f'   (strength**2=0.81 capped to 0.70)
    #[test]
    fn blend_fog_cap_at_070() {
        assert_eq!(
            Color::from_hex("#ff0d0d").blend_fog((255, 255, 255), 1.0).hex(),
            "#ffb6b6"
        );
        assert_eq!(
            Color::from_hex("#909090").blend_fog((255, 255, 255), 0.5).hex(),
            "#ababab"
        );
        assert_eq!(
            Color::from_hex("#3050f8").blend_fog((10, 20, 30), 0.9).hex(),
            "#15265f"
        );
    }

    // python: get_gradient_colors(Color.from_hex('#909090'), RenderConfig(), strength=1.0)
    //   cfg defaults hue/light/sat shift = 0.2 -> ('#a6a6a6', '#909090', '#452e37')
    #[test]
    fn gradient_triplet_gray_909090() {
        let c = Color::from_hex("#909090");
        let (hi, base, lo) = c.get_gradient_colors(1.0, 0.2, 0.2, 0.2);
        assert_eq!(hi.hex(), "#a6a6a6");
        assert_eq!(base.hex(), "#909090");
        assert_eq!(lo.hex(), "#452e37");
    }

    #[test]
    fn from_hex_malformed_no_panic() {
        let _ = Color::from_hex("");
        let _ = Color::from_hex("#xyz");
        let _ = Color::from_hex("#12");
        let _ = Color::from_hex("zzzzzz");
        // contract: graceful degradation, never panics
    }
    #[test]
    fn hls_grayscale_and_extremes_nan_free() {
        assert_eq!(rgb_to_hls(128, 128, 128), (0.0, rgb_to_hls(128,128,128).1, 0.0));
        assert_eq!(rgb_to_hls(0, 0, 0), (0.0, 0.0, 0.0));
        assert_eq!(rgb_to_hls(255, 255, 255), (0.0, 1.0, 0.0));
    }
    #[test]
    fn blend_endpoints_identity() {
        let a = Color { r: 10, g: 20, b: 30 };
        let b = Color { r: 200, g: 100, b: 50 };
        assert_eq!(a.blend(&b, 0.0), a);
        assert_eq!(a.blend(&b, 1.0), b);
    }
}
