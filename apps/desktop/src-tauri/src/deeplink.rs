//! `agentic://` links (#847): `agentic://chats/new?env=…` opens `/chats/new?env=…`
//! on the configured server. The link names a path only, never a host: it is
//! resolved against the server and dropped unless it stays on it.

use crate::{notify::target, reconnect, show_main, Server, MAIN};
use tauri::{AppHandle, Manager};
use url::Url;

pub const SCHEME: &str = "agentic";

/// The in-app path (with its query) an `agentic://` link names, or `None`
/// for any other scheme. `agentic://chats/1` and `agentic:///chats/1` are the
/// same link; the fragment is dropped.
pub fn route(link: &Url) -> Option<String> {
    if link.scheme() != SCHEME {
        return None;
    }
    // `agentic://chats/1` parses with host `chats`; `agentic:///chats/1` with none.
    let rest = link.path().trim_start_matches('/');
    let mut path = match link.host_str().filter(|h| !h.is_empty()) {
        Some(host) if rest.is_empty() => format!("/{host}"),
        Some(host) => format!("/{host}/{rest}"),
        None => format!("/{rest}"),
    };
    if let Some(query) = link.query() {
        path.push('?');
        path.push_str(query);
    }
    Some(path)
}

/// Opens a link: straight in the window when it already shows the server,
/// else through the connect page, which probes the server first and then
/// goes to the link's path (`get_server` hands it over once).
pub fn open(app: &AppHandle, link: &Url) {
    let state = app.state::<Server>();
    let Some(path) = route(link) else { return };
    let Some(server) = state.get() else {
        // Not configured yet: the link waits for the first connect.
        *state.pending.lock().unwrap() = Some(path);
        return show_main(app);
    };
    let Some(url) = target(&server, &path) else { return };
    let on_server = app
        .get_webview_window(MAIN)
        .and_then(|w| w.url().ok())
        .is_some_and(|current| current.origin() == url.origin());
    if on_server {
        if let Some(window) = app.get_webview_window(MAIN) {
            let _ = window.navigate(url);
        }
        show_main(app);
    } else {
        *state.pending.lock().unwrap() = Some(path);
        reconnect(app, "");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(s: &str) -> Option<String> {
        route(&Url::parse(s).unwrap())
    }

    #[test]
    fn links_name_a_path() {
        assert_eq!(
            r("agentic://chats/new?env=e1&path=C%3A%5Cx").as_deref(),
            Some("/chats/new?env=e1&path=C%3A%5Cx")
        );
        assert_eq!(r("agentic:///chats/c1").as_deref(), Some("/chats/c1"));
        assert_eq!(r("agentic://machines").as_deref(), Some("/machines"));
        assert_eq!(r("agentic://").as_deref(), Some("/"));
        assert_eq!(r("agentic://tasks/t1#frag").as_deref(), Some("/tasks/t1"));
    }

    #[test]
    fn other_schemes_are_not_links() {
        assert_eq!(r("https://a.example/chats"), None);
        assert_eq!(r("file:///etc/passwd"), None);
    }

    #[test]
    fn a_link_never_leaves_the_server() {
        let server = "https://a.example";
        for link in [
            "agentic://chats/1",
            "agentic:///..//evil.example/x",
            "agentic://evil.example/x",
            "agentic:////evil.example",
        ] {
            let Some(path) = r(link) else { continue };
            if let Some(url) = target(server, &path) {
                assert_eq!(url.origin().ascii_serialization(), server, "{link} -> {url}");
            }
        }
    }
}
