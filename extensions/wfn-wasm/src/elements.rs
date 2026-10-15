//! Element symbols.

const SYMBOLS: [&str; 119] = [
    "X", "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S",
    "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge",
    "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
    "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd",
    "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm",
    "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds", "Rg", "Cn",
    "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];

pub fn symbol(z: u32) -> &'static str {
    SYMBOLS.get(z as usize).copied().unwrap_or("X")
}

/// Atomic number from an atom label such as "C", "cl", "Li1" or "O12";
/// 0 (ghost) when unknown.
pub fn atomic_number(label: &str) -> u32 {
    let letters: String = label
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    let norm = |s: &str| -> String {
        let mut c = s.chars();
        match c.next() {
            Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
            None => String::new(),
        }
    };
    if letters.eq_ignore_ascii_case("bq") {
        return 0;
    }
    // Prefer a two-letter match ("Cl"), then one letter ("C" from "CA1" style labels)
    for take in [2usize, 1] {
        if letters.len() >= take {
            let cand = norm(&letters[..take]);
            if let Some(z) = SYMBOLS.iter().skip(1).position(|s| *s == cand) {
                return z as u32 + 1;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(atomic_number("C"), 6);
        assert_eq!(atomic_number("cl"), 17);
        assert_eq!(atomic_number("Li1"), 3);
        assert_eq!(atomic_number("O12"), 8);
        assert_eq!(atomic_number("Bq"), 0);
        assert_eq!(symbol(26), "Fe");
    }
}
