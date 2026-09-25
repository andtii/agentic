//! The tray: bring the window back, reconnect, change the server, launch at
//! login, quit. Quitting only happens here (closing the window hides it).

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

pub fn build(app: &AppHandle, quick_ask: Option<&str>) -> tauri::Result<()> {
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Agentic", true, None::<&str>)?,
            &MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?,
            &MenuItem::with_id(app, "server", "Change server…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "autostart", "Launch at login", true, autostart, None::<&str>)?,
            &CheckMenuItem::with_id(
                app,
                "quick",
                quick_label(quick_ask),
                true,
                quick_ask.is_some(),
                None::<&str>,
            )?,
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
            "quick" => {
                let menu = app.state::<crate::updater::TrayMenu>();
                let item = menu.0.get("quick").and_then(|i| i.as_check_menuitem().cloned());
                // The click already flipped the check; what it shows now is what was asked for.
                let on = item.as_ref().and_then(|i| i.is_checked().ok()).unwrap_or(false);
                let shortcut = crate::quick::set_enabled(app, on);
                if let Some(item) = item {
                    let _ = item.set_checked(shortcut.is_some());
                    let _ = item.set_text(quick_label(shortcut.as_deref()));
                }
            }
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

/// "Quick ask ⌘⇧Space" when the hotkey is on; its default when off, so the switch says what it would turn on.
fn quick_label(shortcut: Option<&str>) -> String {
    let key = crate::quick::label(
        shortcut.unwrap_or(crate::quick::DEFAULT_SHORTCUT),
        cfg!(target_os = "macos"),
    );
    format!("Quick ask ({key})")
}
