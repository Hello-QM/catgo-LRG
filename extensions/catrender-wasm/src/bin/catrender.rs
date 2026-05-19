//! Native CLI: read render-input JSON from stdin (or argv[1] as a file
//! path), print the SVG to stdout. Shares the exact WASM render core.

use std::io::{Read, Write};

fn main() {
    let arg = std::env::args().nth(1);
    let json = match arg {
        Some(path) => std::fs::read_to_string(&path)
            .unwrap_or_else(|e| { eprintln!("read {path}: {e}"); std::process::exit(2); }),
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).expect("read stdin");
            s
        }
    };
    let svg = match serde_json::from_str::<catrender_wasm::types::RenderInput>(&json) {
        Ok(inp) => catrender_wasm::svg::render_svg(&inp),
        Err(e) => { eprintln!("catrender input error: {e}"); std::process::exit(1); }
    };
    std::io::stdout().write_all(svg.as_bytes()).expect("write stdout");
}
