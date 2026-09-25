//! The tray: bring the window back, reconnect, change the server, launch at
//! login, quit. Quitting only happens here (closing the window hides it).

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Agentic", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?,
            &MenuItem::with_id(app, "server", "Change server…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "autostart", "Launch at login", true, autostart, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Agentic", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Agentic")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::show_main(app),
            "reload" => crate::reconnect(app, ""),
            "server" => crate::reconnect(app, "change"),
            "autostart" => {
                let launcher = app.autolaunch();
                let _ = if launcher.is_enabled().unwrap_or(false) {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
            }
            crate::updater::MENU_ID => crate::updater::install(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(crate::updater::TrayMenu(menu));
    Ok(())
}
