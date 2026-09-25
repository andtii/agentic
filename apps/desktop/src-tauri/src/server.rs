//! The configured Agentic server and the rules that follow from it: which URL
//! may be stored, which navigations stay in the window, and where the setting
//! lives on disk. Pure functions, so they are unit-tested without a webview.

use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;

/// Hosts a sign-in flow passes through on its way back to the server. They
/// stay in the window so the session cookie lands in the app's webview.
pub const AUTH_HOSTS: &[&str] = &["github.com"];

/// Turns what a person typed into the server's origin (`https://host[:port]`).
/// No scheme means https. Plain http is accepted for loopback only, so a local
/// `pnpm dev` works but a remote server is never reached unencrypted.
pub fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the address of your Agentic server.".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| format!("\"{input}\" is not a valid address."))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a user name or password.".into());
    }
    let host = url.host_str().ok_or_else(|| format!("\"{input}\" has no host."))?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        "http" => return Err("Use https:// — plain http is only allowed for localhost.".into()),
        other => return Err(format!("Unsupported scheme \"{other}\".")),
    }
    Ok(url.origin().ascii_serialization())
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Whether a URL is one of the app's own pages (the connect page).
/// macOS and Linux serve them from `tauri://localhost`, Windows from
/// `http(s)://tauri.localhost`.
pub fn is_local(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn same_origin(url: &Url, origin: &str) -> bool {
    url.origin().ascii_serialization() == origin
}

/// What the main window does with a navigation.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// Load it in the window.
    Stay,
    /// Open it in the system browser and keep the window where it is.
    External,
    /// Drop it (a scheme the app has no business opening).
    Block,
}

pub fn navigation(url: &Url, server: Option<&str>) -> Navigation {
    if is_local(url) || url.as_str() == "about:blank" {
        return Navigation::Stay;
    }
    if server.is_some_and(|origin| same_origin(url, origin)) {
        return Navigation::Stay;
    }
    match url.scheme() {
        "https" if url.host_str().is_some_and(|h| AUTH_HOSTS.contains(&h)) => Navigation::Stay,
        "https" | "http" | "mailto" => Navigation::External,
        _ => Navigation::Block,
    }
}

/// A `window.open` / `target="_blank"` from the page: the server's own pages
/// open as an app window (they need the session cookie), anything else goes
/// to the system browser.
pub fn new_window(url: &Url, server: Option<&str>) -> Navigation {
    if server.is_some_and(|origin| same_origin(url, origin)) {
        return Navigation::Stay;
    }
    match url.scheme() {
        "https" | "http" | "mailto" => Navigation::External,
        _ => Navigation::Block,
    }
}

/// The capability URL pattern that grants the server's pages IPC.
pub fn remote_pattern(origin: &str) -> String {
    format!("{origin}/*")
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    pub server: Option<String>,
}

pub const SETTINGS_FILE: &str = "settings.json";

/// Reads the settings; a missing or unreadable file is "not configured yet",
/// and a stored server that no longer validates is dropped.
pub fn load(dir: &Path) -> Settings {
    let settings: Settings = std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    Settings {
        server: settings.server.and_then(|s| normalize_server(&s).ok()),
    }
}

pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(settings).expect("settings serialize");
    std::fs::write(dir.join(SETTINGS_FILE), text)
}

/// The server a fresh install suggests: `AGENTIC_SERVER_URL` at build time,
/// if it is a valid server address.
pub fn build_default() -> Option<String> {
    option_env!("AGENTIC_SERVER_URL").and_then(|s| normalize_server(s).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn normalizes_to_the_origin() {
        assert_eq!(
            normalize_server("agentic.example.com").unwrap(),
            "https://agentic.example.com"
        );
        assert_eq!(
            normalize_server(" https://a.example/chats/1?x=1 ").unwrap(),
            "https://a.example"
        );
        assert_eq!(
            normalize_server("https://a.example:8443/").unwrap(),
            "https://a.example:8443"
        );
        assert_eq!(normalize_server("HTTPS://A.Example").unwrap(), "https://a.example");
    }

    #[test]
    fn http_only_on_loopback() {
        assert_eq!(
            normalize_server("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_server("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_server("http://a.example").is_err());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(normalize_server("").is_err());
        assert!(normalize_server("   ").is_err());
        assert!(normalize_server("ftp://a.example").is_err());
        assert!(normalize_server("https://user:pw@a.example").is_err());
        assert!(normalize_server("javascript:alert(1)").is_err());
        assert!(normalize_server("file:///etc/passwd").is_err());
    }

    #[test]
    fn server_and_local_pages_stay() {
        let server = Some("https://a.example");
        assert_eq!(navigation(&u("https://a.example/chats/1"), server), Navigation::Stay);
        assert_eq!(navigation(&u("tauri://localhost/index.html"), server), Navigation::Stay);
        assert_eq!(
            navigation(&u("http://tauri.localhost/index.html"), server),
            Navigation::Stay
        );
        assert_eq!(navigation(&u("about:blank"), server), Navigation::Stay);
        assert_eq!(navigation(&u("data:text/html,hi"), server), Navigation::Block);
        // A blob URL carries its creator's origin: the server's own may stay, another's may not.
        assert_eq!(navigation(&u("blob:https://a.example/1"), server), Navigation::Stay);
        assert_eq!(navigation(&u("blob:https://evil.example/1"), server), Navigation::Block);
    }

    #[test]
    fn sign_in_stays_in_the_window() {
        let server = Some("https://a.example");
        assert_eq!(
            navigation(&u("https://github.com/login/oauth/authorize?x=1"), server),
            Navigation::Stay
        );
        assert_eq!(navigation(&u("http://github.com/login"), server), Navigation::External);
    }

    #[test]
    fn other_origins_open_in_the_browser() {
        let server = Some("https://a.example");
        assert_eq!(navigation(&u("https://docs.example/x"), server), Navigation::External);
        assert_eq!(navigation(&u("https://a.example:8443/"), server), Navigation::External);
        assert_eq!(navigation(&u("http://a.example/"), server), Navigation::External);
        assert_eq!(
            navigation(&u("https://evil.example/?https://a.example"), server),
            Navigation::External
        );
        assert_eq!(navigation(&u("mailto:a@b.example"), server), Navigation::External);
        assert_eq!(navigation(&u("file:///etc/passwd"), server), Navigation::Block);
        // Nothing configured yet: only the local pages and sign-in stay.
        assert_eq!(navigation(&u("https://a.example/"), None), Navigation::External);
    }

    #[test]
    fn new_windows() {
        let server = Some("https://a.example");
        assert_eq!(
            new_window(&u("https://a.example/files/chats/c/f"), server),
            Navigation::Stay
        );
        assert_eq!(
            new_window(&u("https://github.com/andtii/agentic"), server),
            Navigation::External
        );
        assert_eq!(
            new_window(&u("tauri://localhost/index.html"), server),
            Navigation::Block
        );
    }

    #[test]
    fn settings_round_trip() {
        let dir = std::env::temp_dir().join(format!("agentic-desktop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load(&dir).server.is_none());
        save(
            &dir,
            &Settings {
                server: Some("https://a.example".into()),
            },
        )
        .unwrap();
        assert_eq!(load(&dir).server.as_deref(), Some("https://a.example"));
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"server":"http://evil.example"}"#).unwrap();
        assert!(load(&dir).server.is_none());
        std::fs::write(dir.join(SETTINGS_FILE), "not json").unwrap();
        assert!(load(&dir).server.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_pattern_covers_the_origin_only() {
        assert_eq!(remote_pattern("https://a.example"), "https://a.example/*");
    }
}
