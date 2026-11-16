const COMMANDS: &[&str] = &["background", "sleep", "probe"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
