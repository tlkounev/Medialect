const COMMANDS: &[&str] = &["background", "sleep", "probe", "local_network", "show_keyboard", "open_link"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
