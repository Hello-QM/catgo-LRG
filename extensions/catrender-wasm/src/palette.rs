//! CPK element palette + CSS named-color resolver.
//!
//! `cpk(z)` returns the CPK hex for atomic number `z` (verbatim from the
//! catrender design spec §"CPK palette", Z 1–105). Z==0 (dummy/`*` centroid)
//! → `#008080`; out-of-bounds (Z>105 or padded 106–119) → `#a0a0a0`.
//!
//! `resolve_color(s)` mirrors xyzrender's `resolve_color`: `"atom"` is a
//! passthrough marker; `#rgb`/`#rrggbb` are normalized to lowercase 6-digit;
//! CSS color names resolve via the verbatim `named_colors.json` table;
//! anything unknown is returned unchanged.

/// CPK hex for atomic number `z`. Verbatim from spec §CPK palette (Z 1–105).
pub fn cpk(z: u32) -> &'static str {
    match z {
        0 => "#008080",
        1 => "#ffffff",
        2 => "#d9ffff",
        3 => "#cc80ff",
        4 => "#c2ff00",
        5 => "#ffb5b5",
        6 => "#909090",
        7 => "#3050f8",
        8 => "#ff0d0d",
        9 => "#90e050",
        10 => "#b3e3f5",
        11 => "#ab5cf2",
        12 => "#8aff00",
        13 => "#bfa6a6",
        14 => "#f0c8a0",
        15 => "#ff8000",
        16 => "#ffff30",
        17 => "#1ff01f",
        18 => "#80d1e3",
        19 => "#8f40d4",
        20 => "#3dff00",
        21 => "#e6e6e6",
        22 => "#bfc2c7",
        23 => "#a6a6ab",
        24 => "#8a99c7",
        25 => "#9c7ac7",
        26 => "#e06633",
        27 => "#f090a0",
        28 => "#50d050",
        29 => "#c88033",
        30 => "#7d80b0",
        31 => "#c28f8f",
        32 => "#668f8f",
        33 => "#bd80e3",
        34 => "#ffa100",
        35 => "#a62929",
        36 => "#5cb8d1",
        37 => "#702eb0",
        38 => "#00ff00",
        39 => "#94ffff",
        40 => "#94e0e0",
        41 => "#73c2c9",
        42 => "#54b5b5",
        43 => "#3b9e9e",
        44 => "#248f8f",
        45 => "#0a7d8c",
        46 => "#006985",
        47 => "#c0c0c0",
        48 => "#ffd98f",
        49 => "#a67573",
        50 => "#668080",
        51 => "#9e63b5",
        52 => "#d47a00",
        53 => "#940094",
        54 => "#429eb0",
        55 => "#57178f",
        56 => "#00c900",
        57 => "#70d4ff",
        58 => "#ffffc7",
        59 => "#d9ffc7",
        60 => "#c7ffc7",
        61 => "#a3ffc7",
        62 => "#8fffc7",
        63 => "#61ffc7",
        64 => "#45ffc7",
        65 => "#30ffc7",
        66 => "#1fffc7",
        67 => "#00ff9c",
        68 => "#00e675",
        69 => "#00d452",
        70 => "#00bf38",
        71 => "#00ab24",
        72 => "#4dc2ff",
        73 => "#4da6ff",
        74 => "#2194d6",
        75 => "#267dab",
        76 => "#266696",
        77 => "#175487",
        78 => "#d0d0e0",
        79 => "#ffd123",
        80 => "#b8b8d0",
        81 => "#a6544d",
        82 => "#575961",
        83 => "#9e4fb5",
        84 => "#ab5c00",
        85 => "#754f45",
        86 => "#428296",
        87 => "#420066",
        88 => "#007d00",
        89 => "#70abfa",
        90 => "#00baff",
        91 => "#00a1ff",
        92 => "#008fff",
        93 => "#0080ff",
        94 => "#006bff",
        95 => "#545cf2",
        96 => "#785ce3",
        97 => "#8a4fe3",
        98 => "#a136d4",
        99 => "#b31fd4",
        100 => "#b31fba",
        101 => "#b30da6",
        102 => "#bd0d87",
        103 => "#c70066",
        104 => "#cc0059",
        105 => "#a0a0a0",
        _ => "#a0a0a0",
    }
}

/// Resolve a color spec to a normalized `#rrggbb` string.
///
/// - `"atom"` → `"atom"` (passthrough marker; per-atom CPK is resolved later).
/// - `#rgb` → expanded `#rrggbb` (lowercase).
/// - `#rrggbb` → lowercased.
/// - CSS color name (case-insensitive) → its hex from `named_colors.json`.
/// - Anything else → returned unchanged (xyzrender behavior).
pub fn resolve_color(s: &str) -> String {
    if s == "atom" {
        return "atom".to_string();
    }
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 3 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            let mut out = String::with_capacity(7);
            out.push('#');
            for c in hex.chars() {
                out.push(c.to_ascii_lowercase());
                out.push(c.to_ascii_lowercase());
            }
            return out;
        }
        if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return s.to_ascii_lowercase();
        }
    }
    if let Some(hex) = named_color(&s.to_ascii_lowercase()) {
        return hex.to_string();
    }
    s.to_string()
}

/// CSS color-name → hex lookup. Verbatim from xyzrender
/// `src/xyzrender/presets/named_colors.json` (148 entries, name + hex
/// lowercased). Name must be pre-lowercased by the caller.
fn named_color(name: &str) -> Option<&'static str> {
    let hex = match name {
        "aliceblue" => "#f0f8ff",
        "antiquewhite" => "#faebd7",
        "aqua" => "#00ffff",
        "aquamarine" => "#7fffd4",
        "azure" => "#f0ffff",
        "beige" => "#f5f5dc",
        "bisque" => "#ffe4c4",
        "black" => "#000000",
        "blanchedalmond" => "#ffebcd",
        "blue" => "#0000ff",
        "blueviolet" => "#8a2be2",
        "brown" => "#a52a2a",
        "burlywood" => "#deb887",
        "cadetblue" => "#5f9ea0",
        "chartreuse" => "#7fff00",
        "chocolate" => "#d2691e",
        "coral" => "#ff7f50",
        "cornflowerblue" => "#6495ed",
        "cornsilk" => "#fff8dc",
        "crimson" => "#dc143c",
        "cyan" => "#00ffff",
        "darkblue" => "#00008b",
        "darkcyan" => "#008b8b",
        "darkgoldenrod" => "#b8860b",
        "darkgray" => "#a9a9a9",
        "darkgreen" => "#006400",
        "darkgrey" => "#a9a9a9",
        "darkkhaki" => "#bdb76b",
        "darkmagenta" => "#8b008b",
        "darkolivegreen" => "#556b2f",
        "darkorange" => "#ff8c00",
        "darkorchid" => "#9932cc",
        "darkred" => "#8b0000",
        "darksalmon" => "#e9967a",
        "darkseagreen" => "#8fbc8f",
        "darkslateblue" => "#483d8b",
        "darkslategray" => "#2f4f4f",
        "darkslategrey" => "#2f4f4f",
        "darkturquoise" => "#00ced1",
        "darkviolet" => "#9400d3",
        "deeppink" => "#ff1493",
        "deepskyblue" => "#00bfff",
        "dimgray" => "#696969",
        "dimgrey" => "#696969",
        "dodgerblue" => "#1e90ff",
        "firebrick" => "#b22222",
        "floralwhite" => "#fffaf0",
        "forestgreen" => "#228b22",
        "fuchsia" => "#ff00ff",
        "gainsboro" => "#dcdcdc",
        "ghostwhite" => "#f8f8ff",
        "gold" => "#ffd700",
        "goldenrod" => "#daa520",
        "gray" => "#808080",
        "green" => "#008000",
        "greenyellow" => "#adff2f",
        "grey" => "#808080",
        "honeydew" => "#f0fff0",
        "hotpink" => "#ff69b4",
        "indianred" => "#cd5c5c",
        "indigo" => "#4b0082",
        "ivory" => "#fffff0",
        "khaki" => "#f0e68c",
        "lavender" => "#e6e6fa",
        "lavenderblush" => "#fff0f5",
        "lawngreen" => "#7cfc00",
        "lemonchiffon" => "#fffacd",
        "lightblue" => "#add8e6",
        "lightcoral" => "#f08080",
        "lightcyan" => "#e0ffff",
        "lightgoldenrodyellow" => "#fafad2",
        "lightgray" => "#d3d3d3",
        "lightgreen" => "#90ee90",
        "lightgrey" => "#d3d3d3",
        "lightpink" => "#ffb6c1",
        "lightsalmon" => "#ffa07a",
        "lightseagreen" => "#20b2aa",
        "lightskyblue" => "#87cefa",
        "lightslategray" => "#778899",
        "lightslategrey" => "#778899",
        "lightsteelblue" => "#b0c4de",
        "lightyellow" => "#ffffe0",
        "lime" => "#00ff00",
        "limegreen" => "#32cd32",
        "linen" => "#faf0e6",
        "magenta" => "#ff00ff",
        "maroon" => "#800000",
        "mediumaquamarine" => "#66cdaa",
        "mediumblue" => "#0000cd",
        "mediumorchid" => "#ba55d3",
        "mediumpurple" => "#9370db",
        "mediumseagreen" => "#3cb371",
        "mediumslateblue" => "#7b68ee",
        "mediumspringgreen" => "#00fa9a",
        "mediumturquoise" => "#48d1cc",
        "mediumvioletred" => "#c71585",
        "midnightblue" => "#191970",
        "mintcream" => "#f5fffa",
        "mistyrose" => "#ffe4e1",
        "moccasin" => "#ffe4b5",
        "navajowhite" => "#ffdead",
        "navy" => "#000080",
        "oldlace" => "#fdf5e6",
        "olive" => "#808000",
        "olivedrab" => "#6b8e23",
        "orange" => "#ffa500",
        "orangered" => "#ff4500",
        "orchid" => "#da70d6",
        "palegoldenrod" => "#eee8aa",
        "palegreen" => "#98fb98",
        "paleturquoise" => "#afeeee",
        "palevioletred" => "#db7093",
        "papayawhip" => "#ffefd5",
        "peachpuff" => "#ffdab9",
        "peru" => "#cd853f",
        "pink" => "#ffc0cb",
        "plum" => "#dda0dd",
        "powderblue" => "#b0e0e6",
        "purple" => "#800080",
        "rebeccapurple" => "#663399",
        "red" => "#ff0000",
        "rosybrown" => "#bc8f8f",
        "royalblue" => "#4169e1",
        "saddlebrown" => "#8b4513",
        "salmon" => "#fa8072",
        "sandybrown" => "#f4a460",
        "seagreen" => "#2e8b57",
        "seashell" => "#fff5ee",
        "sienna" => "#a0522d",
        "silver" => "#c0c0c0",
        "skyblue" => "#87ceeb",
        "slateblue" => "#6a5acd",
        "slategray" => "#708090",
        "slategrey" => "#708090",
        "snow" => "#fffafa",
        "springgreen" => "#00ff7f",
        "steelblue" => "#4682b4",
        "tan" => "#d2b48c",
        "teal" => "#008080",
        "thistle" => "#d8bfd8",
        "tomato" => "#ff6347",
        "turquoise" => "#40e0d0",
        "violet" => "#ee82ee",
        "wheat" => "#f5deb3",
        "white" => "#ffffff",
        "whitesmoke" => "#f5f5f5",
        "yellow" => "#ffff00",
        "yellowgreen" => "#9acd32",
        _ => return None,
    };
    Some(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpk_known() {
        assert_eq!(cpk(1), "#ffffff");
        assert_eq!(cpk(6), "#909090");
        assert_eq!(cpk(8), "#ff0d0d");
        assert_eq!(cpk(26), "#e06633");
        assert_eq!(cpk(0), "#008080");
        assert_eq!(cpk(200), "#a0a0a0");
    }
    #[test]
    fn named_resolves() {
        assert_eq!(resolve_color("black"), "#000000");
        assert_eq!(resolve_color("steelblue"), "#4682b4");
        assert_eq!(resolve_color("#AbC"), "#aabbcc");
        assert_eq!(resolve_color("atom"), "atom");
        assert_eq!(resolve_color("#gg"), "#gg");          // malformed hex: no panic, passthrough
        assert_eq!(resolve_color("#"), "#");              // degenerate, no panic
        assert_eq!(resolve_color("SteelBlue"), "#4682b4"); // case-insensitive name
        assert_eq!(resolve_color("NotAColor"), "NotAColor"); // unknown name preserved unchanged
        assert_eq!(resolve_color("#AABBCC"), "#aabbcc");   // 6-digit hex lowercased
    }
}
