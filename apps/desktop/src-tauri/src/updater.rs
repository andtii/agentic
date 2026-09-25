//! Self-update (#848). Only in a build whose config has an `updater` section
//! (a pubkey and an endpoint), which the release workflow adds when the repo
//! has a signing key; any other build, dev included, never checks. A
//! release found puts "Install update <version>…" at the top of the tray menu,
//! and clicking it downloads, verifies, installs and restarts.

use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::UpdaterExt;

const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
pub const MENU_ID: &str = "update";

/// The tray's menu, kept so a found update can be offered in it.
pub struct TrayMenu(pub Menu<Wry>);

pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.get("updater").is_some_and(|c| !c.is_null())
}

pub fn start(app: &AppHandle) {
    if !configured(app.config()) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(Some(update)) = check(&app).await {
                offer(&app, &update.version);
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<tauri_plugin_updater::Update>> {
    app.updater()?.check().await
}

fn offer(app: &AppHandle, version: &str) {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return;
    };
    let label = format!("Install update {version}…");
    if let Some(item) = menu.0.get(MENU_ID).and_then(|i| i.as_menuitem().cloned()) {
        let _ = item.set_text(label);
        return;
    }
    if let Ok(item) = MenuItem::with_id(app, MENU_ID, label, true, None::<&str>) {
        let _ = menu.0.insert(&item, 0);
    }
}

/// The tray item's action: fetch the release again (it may have moved on), install it, restart.
pub fn install(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(Some(update)) = check(&app).await {
            if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                app.restart();
            }
        }
    });
}
