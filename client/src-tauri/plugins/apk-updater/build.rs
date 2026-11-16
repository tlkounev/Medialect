const COMMANDS: &[&str] = &["install", "background", "sleep"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
