//! The quick-ask window (#849): a global hotkey toggles a small always-on-top
//! window on the server's `/quick` page — pick an agent, type, Enter — which
//! then opens the new chat in the main window and hides itself. The hotkey is
//! off until turned on from the tray, and any accelerator can be put in the
//! settings file (`quickAsk`).

use crate::notify::target;
use crate::{build_window, reconnect, show_main, Server, WindowKind, MAIN};
use tauri::{AppHandle, Manager, State, WebviewUrl};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const QUICK: &str = "quick";
pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

/// The shortcut in effect: registered when set, nothing when off. A shortcut
/// another app holds, or one that does not parse, leaves the hotkey off.
pub fn apply(app: &AppHandle, shortcut: Option<&str>) -> bool {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    match shortcut {
        Some(s) => shortcuts.register(s).is_ok(),
        None => true,
    }
}

/// The hotkey: show the window (built on first use), or hide it when it is up.
pub fn toggle(app: &AppHandle) {
    let Some(server) = app.state::<Server>().get() else {
        // Nothing to ask yet: the main window is where the server is set.
        return reconnect(app, "");
    };
    if let Some(window) = app.get_webview_window(QUICK) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    let Some(url) = target(&server, "/quick") else { return };
    if let Ok(window) = build_window(app, QUICK, WebviewUrl::External(url), WindowKind::Quick) {
        let _ = window.set_focus();
    }
}

/// From the quick-ask page: open `path` (an in-app path) in the main window, bring it up, hide this one.
#[tauri::command]
pub fn open_main(app: AppHandle, state: State<'_, Server>, path: String) -> Result<(), String> {
    let server = state.get().ok_or("no server configured")?;
    let url = target(&server, &path).ok_or("not an in-app path")?;
    if let Some(quick) = app.get_webview_window(QUICK) {
        let _ = quick.hide();
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.navigate(url);
    }
    show_main(&app);
    Ok(())
}

#[tauri::command]
pub fn hide_quick(app: AppHandle) {
    if let Some(quick) = app.get_webview_window(QUICK) {
        let _ = quick.hide();
    }
}

/// The tray's "Quick ask" switch. On: the stored shortcut (else the default), saved only once it is
/// registered. Off: unregistered, and cleared from the settings. Answers the shortcut now in effect.
pub fn set_enabled(app: &AppHandle, on: bool) -> Option<String> {
    let dir = app.path().app_config_dir().ok()?;
    let mut settings = crate::server::load(&dir);
    if !on {
        apply(app, None);
        settings.quick_ask = None;
        let _ = crate::server::save(&dir, &settings);
        return None;
    }
    let shortcut = settings
        .quick_ask
        .clone()
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    if !apply(app, Some(&shortcut)) {
        // Held by another app, or not an accelerator: stays off, and the settings keep what they had.
        return None;
    }
    settings.quick_ask = Some(shortcut.clone());
    let _ = crate::server::save(&dir, &settings);
    Some(shortcut)
}

/// How the tray names a shortcut: `⌘⇧Space` on macOS, `Ctrl+Shift+Space` elsewhere.
pub fn label(shortcut: &str, macos: bool) -> String {
    let keys: Vec<String> = shortcut
        .split('+')
        .map(str::trim)
        .map(|key| {
            let named = match key.to_ascii_lowercase().as_str() {
                "commandorcontrol" | "cmdorctrl" | "commandorctrl" | "cmdorcontrol" => {
                    if macos {
                        "⌘"
                    } else {
                        "Ctrl"
                    }
                }
                "command" | "cmd" | "super" | "meta" => {
                    if macos {
                        "⌘"
                    } else {
                        "Super"
                    }
                }
                "control" | "ctrl" => {
                    if macos {
                        "⌃"
                    } else {
                        "Ctrl"
                    }
                }
                "shift" => {
                    if macos {
                        "⇧"
                    } else {
                        "Shift"
                    }
                }
                "alt" | "option" => {
                    if macos {
                        "⌥"
                    } else {
                        "Alt"
                    }
                }
                _ => return key.to_string(),
            };
            named.to_string()
        })
        .collect();
    if macos {
        keys.concat()
    } else {
        keys.join("+")
    }
}

#[cfg(test)]
mod tests {
    use super::label;

    #[test]
    fn labels() {
        assert_eq!(label("CommandOrControl+Shift+Space", true), "⌘⇧Space");
        assert_eq!(label("CommandOrControl+Shift+Space", false), "Ctrl+Shift+Space");
        assert_eq!(label("Alt+K", true), "⌥K");
        assert_eq!(label("Ctrl + Alt + K", false), "Ctrl+Alt+K");
    }
}
