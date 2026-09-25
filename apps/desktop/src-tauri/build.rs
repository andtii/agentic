fn main() {
    // Declaring the app's commands makes each one need an explicit permission
    // (`allow-<command>`), so only the capabilities that name them can call
    // them. The local connect page gets them; the remote server gets none.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["get_server", "set_server"])),
    )
    .expect("failed to run tauri-build");
}
