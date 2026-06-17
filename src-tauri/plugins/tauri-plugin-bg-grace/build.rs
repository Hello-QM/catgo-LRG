const COMMANDS: &[&str] = &["set_idle_timer"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
