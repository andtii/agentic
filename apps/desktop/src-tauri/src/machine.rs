//! "This computer" (#846): which machine of which workspace the daemon on
//! this computer is paired as. The daemon's `credentials.json` is found the
//! way `apps/daemon/src/paths.ts` finds it; only the ids leave this module —
//! the machine token never reaches the page.

use crate::Server;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

/// The daemon's config directory for `os` (`std::env::consts::OS` spelling),
/// mirroring `daemonPaths().configDir` in `apps/daemon/src/paths.ts`.
pub fn config_dir(os: &str, env: impl Fn(&str) -> Option<String>, home: &str) -> String {
    let env = |key: &str| env(key).filter(|v| !v.is_empty());
    let sep = if os == "windows" { '\\' } else { '/' };
    let join = |base: &str, parts: &[&str]| {
        let mut out = base.trim_end_matches(sep).to_string();
        for part in parts {
            out.push(sep);
            out.push_str(part);
        }
        out
    };
    if let Some(home_override) = env("AGENTIC_DAEMON_HOME") {
        return home_override;
    }
    match os {
        "windows" => join(
            &env("APPDATA").unwrap_or_else(|| join(home, &["AppData", "Roaming"])),
            &["agentic"],
        ),
        "macos" => join(home, &["Library", "Application Support", "agentic"]),
        _ => join(
            &env("XDG_CONFIG_HOME").unwrap_or_else(|| join(home, &[".config"])),
            &["agentic"],
        ),
    }
}

#[derive(Deserialize)]
struct Credentials {
    url: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    #[serde(rename = "machineId")]
    machine_id: String,
    #[serde(default)]
    name: String,
}

/// What the page is told: the ids and the name, never the token.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LocalMachine {
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "machineId")]
    pub machine_id: String,
    pub name: String,
}

/// The paired machine in `text`, when it was paired against `server` — a
/// daemon paired to another deployment is not this server's machine.
pub fn parse(text: &str, server: &str) -> Option<LocalMachine> {
    let c: Credentials = serde_json::from_str(text).ok()?;
    let paired = crate::server::normalize_server(&c.url).ok()?;
    if paired != server || c.workspace_id.is_empty() || c.machine_id.is_empty() {
        return None;
    }
    Some(LocalMachine {
        workspace_id: c.workspace_id,
        machine_id: c.machine_id,
        name: c.name,
    })
}

fn credentials_file() -> Option<PathBuf> {
    // No home is fine while AGENTIC_DAEMON_HOME is set; without either there is nothing to read.
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let override_set = std::env::var("AGENTIC_DAEMON_HOME").is_ok_and(|v| !v.is_empty());
    if home.is_empty() && !override_set {
        return None;
    }
    let dir = config_dir(std::env::consts::OS, |k| std::env::var(k).ok(), &home);
    Some(PathBuf::from(dir).join("credentials.json"))
}

#[tauri::command]
pub fn local_machine(state: State<'_, Server>) -> Option<LocalMachine> {
    let server = state.get()?;
    let text = std::fs::read_to_string(credentials_file()?).ok()?;
    parse(&text, &server)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string())
    }

    // The same cases as apps/daemon's daemonPaths: the override, then each OS's default.
    #[test]
    fn resolves_like_the_daemon() {
        assert_eq!(
            config_dir("linux", env(&[("AGENTIC_DAEMON_HOME", "/opt/a")]), "/home/u"),
            "/opt/a"
        );
        assert_eq!(
            config_dir("windows", env(&[("AGENTIC_DAEMON_HOME", "D:\\a")]), "C:\\Users\\u"),
            "D:\\a"
        );
        assert_eq!(
            config_dir(
                "windows",
                env(&[("APPDATA", "C:\\Users\\u\\AppData\\Roaming")]),
                "C:\\Users\\u"
            ),
            "C:\\Users\\u\\AppData\\Roaming\\agentic"
        );
        assert_eq!(
            config_dir("windows", env(&[]), "C:\\Users\\u"),
            "C:\\Users\\u\\AppData\\Roaming\\agentic"
        );
        assert_eq!(
            config_dir("macos", env(&[]), "/Users/u"),
            "/Users/u/Library/Application Support/agentic"
        );
        assert_eq!(config_dir("linux", env(&[]), "/home/u"), "/home/u/.config/agentic");
        assert_eq!(
            config_dir("linux", env(&[("XDG_CONFIG_HOME", "/x")]), "/home/u"),
            "/x/agentic"
        );
        // An empty variable counts as unset, as `??` / `||` do in the daemon for these.
        assert_eq!(
            config_dir("linux", env(&[("AGENTIC_DAEMON_HOME", "")]), "/home/u"),
            "/home/u/.config/agentic"
        );
    }

    const CREDS: &str = r#"{"url":"https://a.example","workspaceId":"ws1","machineId":"m1","token":"amt.ws1.m1.secret","name":"desk","pairedAt":1}"#;

    #[test]
    fn reads_the_ids_never_the_token() {
        let m = parse(CREDS, "https://a.example").unwrap();
        assert_eq!(
            m,
            LocalMachine {
                workspace_id: "ws1".into(),
                machine_id: "m1".into(),
                name: "desk".into()
            }
        );
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.contains("amt."), "{json}");
        assert!(!json.contains("token"), "{json}");
    }

    #[test]
    fn only_for_this_server() {
        assert!(parse(CREDS, "https://b.example").is_none());
        assert!(parse(
            &CREDS.replace("https://a.example", "https://a.example/"),
            "https://a.example"
        )
        .is_some());
        assert!(parse("not json", "https://a.example").is_none());
        assert!(parse(
            r#"{"url":"https://a.example","workspaceId":"","machineId":"m1"}"#,
            "https://a.example"
        )
        .is_none());
    }
}
