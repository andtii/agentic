fn main() {
    // Declaring the app's commands makes each one need an explicit permission
    // (`allow-<command>`), so only the capabilities that name them can call
    // them: the local connect page gets `get_server` / `set_server`
    // (capabilities/local.json), the server's pages what `REMOTE_PERMISSIONS`
    // in src/lib.rs lists.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_server",
            "set_server",
            "notify",
            "set_badge",
        ])),
    )
    .expect("failed to run tauri-build");
}
