//! Native notifications and the unread badge (#845). The server's pages call
//! `notify` for each new Inbox notification and `set_badge` with the "Needs
//! you" count; clicking a notification brings the window back on the page it
//! points at.

use crate::{show_main, Server, MAIN};
use tauri::{AppHandle, Manager, State};
use url::Url;

/// A notification's link, resolved against the server. Only an in-app path
/// (`/chats/…`) is taken: anything else — another origin, a scheme, a
/// protocol-relative `//host` — is dropped, so a page can never make a
/// notification open something off the server.
pub fn target(server: &str, path: &str) -> Option<Url> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return None;
    }
    let base = Url::parse(server).ok()?;
    let url = base.join(path).ok()?;
    (url.origin() == base.origin()).then_some(url)
}

/// The text a notification shows is capped, so a runaway title cannot fill the screen.
fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max - 1).collect();
    out.push('…');
    out
}

#[tauri::command]
pub fn notify(
    app: AppHandle,
    state: State<'_, Server>,
    title: String,
    body: Option<String>,
    url: Option<String>,
) -> Result<(), String> {
    let server = state.get().ok_or("no server configured")?;
    let open = url.as_deref().and_then(|path| target(&server, path));
    let mut notification = notify_rust::Notification::new();
    notification.summary(&clip(&title, 120));
    if let Some(body) = body.as_deref().filter(|b| !b.trim().is_empty()) {
        notification.body(&clip(body, 400));
    }
    notification.auto_icon();
    identify(&app, &mut notification);
    // `wait_for_action` blocks until the notification is clicked or dismissed.
    std::thread::spawn(move || {
        let Ok(handle) = notification.show() else { return };
        handle.wait_for_action(|action| {
            if action == "__closed" {
                return;
            }
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                if let (Some(window), Some(url)) = (app.get_webview_window(MAIN), open) {
                    let _ = window.navigate(url);
                }
                show_main(&app);
            });
        });
    });
    Ok(())
}

/// Attributes the notification to the app: its bundle id on macOS and its
/// AppUserModelID on Windows, once installed (a dev build has neither).
#[allow(unused_variables)]
fn identify(app: &AppHandle, notification: &mut notify_rust::Notification) {
    let id = app.config().identifier.clone();
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &id });
    }
    #[cfg(windows)]
    {
        if !tauri::is_dev() {
            notification.app_id(&id);
        }
    }
}

#[tauri::command]
pub fn set_badge(app: AppHandle, count: u32) -> Result<(), String> {
    let window = app.get_webview_window(MAIN).ok_or("no window")?;
    #[cfg(not(windows))]
    {
        let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
    }
    #[cfg(windows)]
    {
        let _ = window.set_overlay_icon((count > 0).then(dot));
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip(count)));
    }
    Ok(())
}

pub fn tooltip(count: u32) -> String {
    match count {
        0 => "Agentic".into(),
        1 => "Agentic — 1 needs you".into(),
        n => format!("Agentic — {n} need you"),
    }
}

/// The taskbar overlay on Windows, which has no numeric badge: a red dot.
#[cfg(windows)]
fn dot() -> tauri::image::Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let c = (SIZE as f32 - 1.0) / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let alpha = ((c + 0.5 - d).clamp(0.0, 1.0) * 255.0) as u8;
            rgba.extend_from_slice(&[0xef, 0x44, 0x44, alpha]);
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_stay_on_the_server() {
        let s = "https://a.example";
        assert_eq!(target(s, "/chats/c1").unwrap().as_str(), "https://a.example/chats/c1");
        assert_eq!(
            target(s, "/tasks/t1?x=1#y").unwrap().as_str(),
            "https://a.example/tasks/t1?x=1#y"
        );
        assert!(target(s, "//evil.example/x").is_none());
        assert!(target(s, "https://evil.example/").is_none());
        assert!(target(s, "javascript:alert(1)").is_none());
        assert!(target(s, "chats/c1").is_none());
        assert!(target(s, "/\\evil.example").is_none());
        assert!(target(s, "").is_none());
    }

    #[test]
    fn clips_long_text() {
        assert_eq!(clip("  hi  ", 10), "hi");
        assert_eq!(clip("abcdefghijk", 5), "abcd…");
        assert_eq!(clip("ååååå", 5), "ååååå");
    }

    #[test]
    fn tooltips() {
        assert_eq!(tooltip(0), "Agentic");
        assert_eq!(tooltip(1), "Agentic — 1 needs you");
        assert_eq!(tooltip(3), "Agentic — 3 need you");
    }
}
