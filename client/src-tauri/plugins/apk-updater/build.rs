const COMMANDS: &[&str] = &["background", "sleep", "probe", "local_network"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
