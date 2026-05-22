pub mod bonds;
pub mod color;
pub mod fog;
pub mod geom;
pub mod orient;
pub mod palette;
mod perceive;
pub mod preset;
pub mod svg;
pub mod types;
pub mod vdw;

use wasm_bindgen::prelude::*;

/// Render molecular SVG from a JSON input string. Pure function — no state.
#[wasm_bindgen]
pub fn render(input_json: &str) -> String {
    console_error_panic_hook::set_once();
    match serde_json::from_str::<types::RenderInput>(input_json) {
        Ok(inp) => svg::render_svg(&inp),
        Err(e) => format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='40'><text x='4' y='24' fill='red' font-size='13'>catrender input error: {}</text></svg>",
            e
        ),
    }
}
